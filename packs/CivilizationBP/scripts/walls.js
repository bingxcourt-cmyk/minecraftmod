import { S, DIM, getB, loaded, markDirty, sound, particle } from "./core.js";
import { groundAt, isPassableId } from "./blocks.js";
import { remainingCost } from "./workers.js";
import { deferLight } from "./lights.js";
import { note, warLog } from "./journal.js";

// Защитная стена с эпохи «Город»: 6 блоков каменного кирпича, зубцы-бойницы через блок,
// факелы на зубцах, ворота-калитки на дорогах и посередине каждой стороны.
// Свои проходят через калитки, бандиты и вражеские армии — нет: им приходится минуту ломать стену.
export const WALL_STONE = 7; // камня на один столб стены
const WALL_SPEED = 0.5; // столбов в секунду (каменщики работают и без игрока)
const ROADISH = new Set(["minecraft:stone_bricks", "minecraft:polished_andesite", "minecraft:grass_path", "minecraft:gravel", "minecraft:spruce_planks"]);
const SKIP_TYPES = new Set(["mine", "quarry"]);

export function planWall(civ) {
  if (civ.wall || civ.era < 2) return;
  const bs = civ.buildings.filter((b) => !SKIP_TYPES.has(b.t));
  if (bs.length < 8) return;
  let x1 = civ.center.x - 8;
  let z1 = civ.center.z - 8;
  let x2 = civ.center.x + 8;
  let z2 = civ.center.z + 8;
  for (const b of bs) {
    x1 = Math.min(x1, b.x);
    z1 = Math.min(z1, b.z);
    x2 = Math.max(x2, b.x + b.w);
    z2 = Math.max(z2, b.z + b.d);
  }
  // Отступ 5 блоков от домов, сторона не больше 100 блоков.
  const cx = civ.center.x;
  const cz = civ.center.z;
  x1 = Math.max(Math.floor(x1) - 5, cx - 50);
  z1 = Math.max(Math.floor(z1) - 5, cz - 50);
  x2 = Math.min(Math.ceil(x2) + 5, cx + 50);
  z2 = Math.min(Math.ceil(z2) + 5, cz + 50);
  const n = 2 * (x2 - x1 + (z2 - z1));
  civ.wall = { x1, z1, x2, z2, n, prog: 0, done: "0".repeat(n) };
  markDirty(civ);
  note("build", `${civ.name}: начали строить защитную стену (${n} столбов, ${n * WALL_STONE} камня)`);
}

export const wallLeft = (civ) => (civ.wall ? Math.max(0, civ.wall.n - Math.floor(civ.wall.prog)) : 0);
export const wallShare = (civ) => (civ.wall ? (civ.wall.done.split("1").length - 1) / civ.wall.n : 0);

export function insideWall(civ, x, z) {
  const w = civ.wall;
  return !!w && x > w.x1 && x < w.x2 && z > w.z1 && z < w.z2;
}

function colPos(w, i) {
  const W = w.x2 - w.x1;
  const D = w.z2 - w.z1;
  if (i < W) return { x: w.x1 + i, z: w.z1 };
  if (i < W + D) return { x: w.x2, z: w.z1 + (i - W) };
  if (i < 2 * W + D) return { x: w.x2 - (i - W - D), z: w.z2 };
  return { x: w.x1, z: w.z2 - (i - 2 * W - D) };
}

function isGateIndex(w, i) {
  const W = w.x2 - w.x1;
  const D = w.z2 - w.z1;
  return [Math.floor(W / 2), W + Math.floor(D / 2), W + D + Math.floor(W / 2), 2 * W + D + Math.floor(D / 2)].includes(i);
}

function setIf(b, id) {
  try {
    if (b && b.typeId !== id) b.setType(id);
  } catch {}
}

/** Ставит один столб стены. false — чанк не загружен. */
function placeColumn(civ, i) {
  const dim = DIM();
  const w = civ.wall;
  const { x, z } = colPos(w, i);
  if (!loaded(dim, { x, z })) return false;
  const g = groundAt(dim, x, z);
  if (!g) return false;
  if (g.liquid) return true;
  const top = getB(dim, x, g.y, z);
  if (!top) return false;
  const road = ROADISH.has(top.typeId);
  if (g.unnatural && !road) return true; // дом или чужая постройка — обходим
  const gate = road || isGateIndex(w, i);
  // Расчистка: трава, листва, брёвна.
  for (let k = 1; k <= 8; k++) {
    const b = getB(dim, x, g.y + k, z);
    if (b && !b.isAir && (isPassableId(b.typeId) || b.typeId.endsWith("leaves") || b.typeId.endsWith("_log"))) setIf(b, "minecraft:air");
  }
  for (let k = 1; k <= 6; k++) {
    const b = getB(dim, x, g.y + k, z);
    if (!b) continue;
    if (gate && k === 1) setIf(b, "minecraft:spruce_fence_gate");
    else if (gate && k === 2) setIf(b, "minecraft:air");
    else setIf(b, "minecraft:stone_bricks");
  }
  // Зубцы-бойницы через столб, факел на каждом четвёртом зубце.
  if (i % 2 === 0) {
    setIf(getB(dim, x, g.y + 7, z), "minecraft:stone_bricks");
    if (i % 8 === 0) deferLight(civ, x, g.y + 8, z, "minecraft:torch");
  }
  return true;
}

/** Рост стены: каменщики кладут столбы за камень со склада (и без игрока). */
export function progressWalls(dt) {
  for (const civ of S.civs.values()) {
    const w = civ.wall;
    if (!w || w.prog >= w.n) continue;
    let left = WALL_SPEED * S.speed * dt;
    while (left > 0 && w.prog < w.n) {
      const step = Math.min(1, left);
      if (Math.floor(w.prog + step) > Math.floor(w.prog)) {
        const keep = (remainingCost(civ).stone ?? 0) + 20;
        if ((civ.res.stone ?? 0) - WALL_STONE < keep) break;
        civ.res.stone -= WALL_STONE;
        markDirty(civ);
      }
      w.prog += step;
      left -= step;
    }
    if (w.prog >= w.n && !w.noted) {
      w.noted = true;
      note("build", `${civ.name}: защитная стена достроена`);
    }
  }
}

/** Раз в секунду: столбы, за которые уже заплатили, появляются в загруженных чанках. */
export function layWalls() {
  progressWalls(1);
  for (const civ of S.civs.values()) {
    const w = civ.wall;
    if (!w || (w.repairAt ?? 0) > S.clock) continue;
    const chars = w.done.split("");
    let budget = 6;
    const upto = Math.min(w.n, Math.floor(w.prog));
    for (let k = 0; k < 80 && budget > 0; k++) {
      const i = ((w.cur ?? 0) + k) % w.n;
      if (i >= upto || chars[i] === "1") continue;
      if (!placeColumn(civ, i)) continue;
      chars[i] = "1";
      budget--;
    }
    w.cur = ((w.cur ?? 0) + 80) % w.n;
    w.done = chars.join("");
  }
}

export function wallInfo(civ) {
  const w = civ.wall;
  if (!w) return civ.era < 2 ? "с эпохи «Город»" : "ещё не начата";
  return `оплачено ${Math.min(100, Math.round((w.prog / w.n) * 100))}%, стоит ${Math.round(wallShare(civ) * 100)}%`;
}

/** Ближайший столб стены к точке. */
export function nearestColumn(civ, pos) {
  const w = civ.wall;
  if (!w) return null;
  let best = null;
  let bd = Infinity;
  for (let i = 0; i < w.n; i++) {
    const p = colPos(w, i);
    const d = Math.hypot(p.x + 0.5 - pos.x, p.z + 0.5 - pos.z);
    if (d < bd) {
      bd = d;
      best = { i, ...p, d };
    }
  }
  return best;
}

/** Чья стена мешает этому врагу (бандиту — стена атакуемого поселения, воину — стена противника). */
export function hostileWallCiv(brain) {
  const own = S.civs.get(brain.civId);
  const civ = brain.role === "raider" ? own : brain.role === "soldier" && own?.war ? S.civs.get(own.war.enemy) : undefined;
  return civ?.wall && wallShare(civ) >= 0.3 ? civ : undefined;
}

/** Точка снаружи у ближайшего столба стены — сюда враг подходит, чтобы ломать. */
export function outsidePoint(civ, pos) {
  const c = nearestColumn(civ, pos);
  if (!c) return null;
  const w = civ.wall;
  const dx = c.x === w.x1 ? -2 : c.x === w.x2 ? 2 : 0;
  const dz = c.z === w.z1 ? -2 : c.z === w.z2 ? 2 : 0;
  return { x: c.x + dx + 0.5, z: c.z + dz + 0.5 };
}

/** Точка на гребне стены (для лучников). */
export function wallTop(civ, pos) {
  const c = nearestColumn(civ, pos);
  if (!c || civ.wall.done[c.i] !== "1") return null;
  const g = groundAt(DIM(), c.x, c.z);
  return g ? { x: c.x + 0.5, y: g.y + 7, z: c.z + 0.5 } : null;
}

/**
 * Враг (бандит или вражеский воин) упёрся в стену: ломает её минуту, потом пробивает брешь в 3 столба.
 * Возвращает true, если он сейчас занят стеной.
 */
export function tryBreakWall(brain) {
  const ent = brain.ent;
  const own = S.civs.get(brain.civId);
  const civ = brain.role === "raider" ? own : own?.war ? S.civs.get(own.war.enemy) : undefined;
  if (!civ?.wall || wallShare(civ) < 0.3 || insideWall(civ, ent.location.x, ent.location.z)) return false;
  const c = nearestColumn(civ, ent.location);
  if (!c || c.d > 3.5) return false;
  // Рядом уже брешь — ломать нечего, идут внутрь.
  if (civ.wall.done[c.i] !== "1") {
    brain.breakStart = null;
    return false;
  }
  brain.breakStart = brain.breakStart ?? S.clock;
  const dim = DIM();
  if (S.clock % 2 === 0) {
    sound(dim, "dig.stone", { x: c.x, y: ent.location.y + 1, z: c.z });
    particle(dim, "minecraft:basic_smoke_particle", { x: c.x + 0.5, y: ent.location.y + 1.5, z: c.z + 0.5 });
  }
  if (S.clock - brain.breakStart < 60) return true;
  brain.breakStart = null;
  const w = civ.wall;
  const chars = w.done.split("");
  for (const j of [c.i - 1, c.i, c.i + 1]) {
    const i = (j + w.n) % w.n;
    const p = colPos(w, i);
    const g = groundAt(dim, p.x, p.z);
    if (!g) continue;
    // Сверху (зубец, факел) вниз до настоящей земли.
    for (let y = g.y + 1; y > g.y - 10; y--) {
      const b = getB(dim, p.x, y, p.z);
      if (!b) break;
      const id = b.typeId;
      if (b.isAir) continue;
      if (id === "minecraft:stone_bricks" || id.includes("fence_gate") || id === "minecraft:torch") setIf(b, "minecraft:air");
      else break;
    }
    chars[i] = "0";
  }
  w.done = chars.join("");
  w.repairAt = S.clock + 180; // чинить начнут через 3 минуты
  brain.path = null;
  brain.prog = null; // заново ищут путь — уже через брешь
  markDirty(civ);
  sound(dim, "random.explode", { x: c.x, y: ent.location.y, z: c.z }, 0.6);
  const who = brain.role === "raider" ? "бандиты" : own?.name;
  if (brain.role === "raider") note("events", `${civ.name}: бандиты пробили брешь в стене`);
  else if (own) warLog(own, civ, `${who} пробили брешь в стене ${civ.name}`);
  return true;
}

