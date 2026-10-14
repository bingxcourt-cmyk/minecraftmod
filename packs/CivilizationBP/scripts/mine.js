import { DIM, getB, markDirty, sound, particle, cdTicks } from "./core.js";
import { canPass, isStoneLike, isIronOre, isProtected, isLog, strip } from "./blocks.js";
import { setTarget, near, updateTag, wander } from "./workers.js";
import { useTool } from "./tools.js";
import { deferLight } from "./lights.js";

// Шахта как у игрока: лестница вниз шириной в 1 блок пролётами по FLIGHT ступенек
// с поворотом на площадке (квадратная винтовая лестница, не уходит далеко от деревни),
// а на нужной глубине — коридор с боковыми штреками.
export const FLIGHT = 12;
const D4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const CORRIDOR = 24;
const BRANCH = 6;

const planCache = new Map();

/**
 * План шахты: список клеток для прохода. y — уровень ног, h — высота выработки,
 * p — индекс клетки, из которой копают эту (-1 — с поверхности).
 */
export function minePlan(m) {
  const key = `${m.x},${m.y},${m.z},${m.d},${m.target}`;
  let plan = planCache.get(key);
  if (plan) return plan;
  const cells = [];
  let x = m.x;
  let z = m.z;
  let feet = m.y + 1;
  let d = m.d;
  let parent = -1;
  // Лестница: каждая ступенька на блок ниже, высотой 3 блока, чтобы проходить не пригибаясь.
  for (let i = 0; feet - 1 >= m.target; i++) {
    x += D4[d][0];
    z += D4[d][1];
    feet -= 1;
    cells.push({ x, y: feet, z, h: 3, p: parent, stair: true });
    parent = cells.length - 1;
    if ((i + 1) % FLIGHT === 0) d = (d + 1) % 4;
  }
  const stairs = cells.length;
  // Коридор с боковыми штреками (ветвистая добыча).
  const [dx, dz] = D4[d];
  const sides = [D4[(d + 3) % 4], D4[(d + 1) % 4]];
  let main = parent;
  for (let k = 1; k <= CORRIDOR; k++) {
    const from = cells[main];
    cells.push({ x: from.x + dx, y: feet, z: from.z + dz, h: 2, p: main });
    main = cells.length - 1;
    if (k % 4 !== 0) continue;
    for (const [bx, bz] of sides) {
      let bp = main;
      for (let j = 1; j <= BRANCH; j++) {
        cells.push({ x: cells[main].x + bx * j, y: feet, z: cells[main].z + bz * j, h: 2, p: bp });
        bp = cells.length - 1;
      }
    }
  }
  plan = { cells, stairs };
  planCache.set(key, plan);
  return plan;
}

const center = (c) => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });

// Где стоит шахтёр, когда копает клетку i.
function standOf(m, plan, i) {
  const p = plan.cells[i].p;
  return p < 0 ? { x: m.x + 0.5, y: m.y + 1, z: m.z + 0.5 } : center(plan.cells[p]);
}

// Цепочка клеток от входа до клетки i.
function chain(plan, i) {
  const out = [];
  for (let k = i; k >= 0; k = plan.cells[k].p) out.push(k);
  return out.reverse();
}

/** Ближайшая уже прокопанная клетка рядом с жителем (или -1). */
function nearestCell(plan, upto, pos) {
  let best = -1;
  let bd = 2.2;
  for (let i = 0; i < upto; i++) {
    const c = plan.cells[i];
    if (Math.abs(c.y - pos.y) > 1.5) continue;
    const d = Math.hypot(c.x + 0.5 - pos.x, c.z + 0.5 - pos.z);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

// Ведёт шахтёра по своей лестнице и штрекам к месту работы — пешком, без телепортов.
function walkTo(m, plan, ent, brain, stand) {
  setTarget(brain, stand, 0.9);
  if (brain.path && brain.path.tx === stand.x && brain.path.tz === stand.z) return;
  const goal = plan.cells[m.idx].p;
  if (goal < 0) return; // копает прямо с поверхности
  const route = chain(plan, goal);
  const here = nearestCell(plan, m.idx, ent.location);
  let pts;
  if (here < 0) {
    // Ещё на поверхности: сначала ко входу, потом вниз по ступенькам.
    const entrance = { x: m.x + 0.5, y: m.y + 1, z: m.z + 0.5 };
    if (!near(ent, entrance, 1.6, false)) {
      setTarget(brain, entrance, 1.2);
      return;
    }
    pts = route.map((i) => center(plan.cells[i]));
  } else {
    // Поднимаемся до общей развилки, потом спускаемся к цели.
    const onRoute = new Set(route);
    const up = [];
    let k = here;
    while (k >= 0 && !onRoute.has(k)) {
      up.push(k);
      k = plan.cells[k].p;
    }
    const down = k < 0 ? route : route.slice(route.indexOf(k) + 1);
    pts = [...up, ...(k >= 0 ? [k] : []), ...down].map((i) => center(plan.cells[i]));
  }
  if (pts.length) brain.path = { pts, i: 0, tx: stand.x, tz: stand.z };
}

const MANMADE = /planks|brick|glass|wool|concrete|door|fence|torch|rail|chest|slab|stairs|furnace|table|bed|carpet|lamp|glowstone|barrel|ladder|lantern|bookshelf|web|spawner|_wall|hay|glazed|polished|sign|banner/;
const isOre = (id) => strip(id).endsWith("_ore");
const isCoalOre = (id) => id === "minecraft:coal_ore" || id === "minecraft:deepslate_coal_ore";
const isDiamondOre = (id) => id === "minecraft:diamond_ore" || id === "minecraft:deepslate_diamond_ore";
const isGoldOre = (id) => id === "minecraft:gold_ore" || id === "minecraft:deepslate_gold_ore";
// Монеты чеканят из золота: одна золотая руда = 100 монет в казну. Других источников денег в мире нет.
export const COINS_PER_GOLD = 100;

function yieldOf(civ, id, tier, deep) {
  // Как у Стива: железо — каменной киркой и лучше, алмазы — железной и лучше.
  if (isCoalOre(id)) {
    civ.res.coal = (civ.res.coal ?? 0) + 1;
  } else if (id === "minecraft:andesite") {
    civ.res.andesite = (civ.res.andesite ?? 0) + 1;
  } else if (isIronOre(id)) {
    if (tier >= 2) civ.res.iron += 1;
  } else if (isDiamondOre(id)) {
    if (tier >= 3) civ.res.diamond = (civ.res.diamond ?? 0) + 1;
  } else if (isGoldOre(id)) {
    // Золото, как у Стива, — только железной киркой и лучше.
    if (tier >= 3) {
      civ.coins = (civ.coins ?? 0) + COINS_PER_GOLD;
      civ.minted = (civ.minted ?? 0) + COINS_PER_GOLD;
    } else civ.res.stone += 1;
  } else if (isStoneLike(id) || isOre(id)) {
    civ.res.stone += 1;
    if (deep && tier >= 2 && Math.random() < 0.02) civ.res.iron += 1;
  } else if (isLog(id)) civ.res.wood += 3;
}

const NEIGH = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// Вскрыли воду или лаву — затыкаем булыжником, как игрок.
function plugLiquids(m, dim, pos) {
  for (const [dx, dy, dz] of NEIGH) {
    const b = getB(dim, pos.x + dx, pos.y + dy, pos.z + dz);
    if (b?.isLiquid) {
      try {
        b.setType("minecraft:cobblestone");
        m.wet = (m.wet ?? 0) + 1;
      } catch {}
    }
  }
}

function findVeins(m, dim, pos) {
  m.veins = m.veins ?? [];
  for (const [dx, dy, dz] of NEIGH) {
    const p = { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
    const b = getB(dim, p.x, p.y, p.z);
    if (b && isOre(b.typeId) && m.veins.length < 24 && !m.veins.some((v) => v.x === p.x && v.y === p.y && v.z === p.z)) m.veins.push(p);
  }
}

function breakBlock(civ, m, ent, brain, b, pos) {
  const dim = DIM();
  const id = b.typeId;
  const use = useTool(ent, "pickaxe");
  if (use.broke) updateTag(ent, brain, civ);
  try {
    b.setType("minecraft:air");
  } catch {
    return 1;
  }
  yieldOf(civ, id, use.tier, pos.y < 40);
  markDirty(civ);
  plugLiquids(m, dim, pos);
  findVeins(m, dim, pos);
  sound(dim, isStoneLike(id) || isOre(id) ? "dig.stone" : "dig.gravel", pos);
  particle(dim, "minecraft:basic_smoke_particle", { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 });
  try {
    ent.teleport(ent.location, { facingLocation: { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 } });
  } catch {}
  return use.mult;
}

export function finishMine(civ) {
  const m = civ.mine;
  if (m) civ.buildings.push({ t: "mine", x: m.x - 1, y: m.y, z: m.z - 1, r: 0, w: 3, d: 3 });
  civ.mine = null;
  civ.minesDone = (civ.minesDone ?? 0) + 1;
  markDirty(civ);
}

/** Один «удар киркой» шахтёра. */
export function minerThink(civ, ent, brain, tick) {
  const m = civ.mine;
  if (!m) return wander(civ, brain, 8);
  const plan = minePlan(m);
  if (m.idx >= plan.cells.length || (m.wet ?? 0) > 12) return finishMine(civ);
  const dim = DIM();
  const cell = plan.cells[m.idx];
  const stand = standOf(m, plan, m.idx);
  if (!near(ent, stand, 1.4, false)) return walkTo(m, plan, ent, brain, stand);
  brain.path = null;

  // Сначала жилы руды рядом.
  while (m.veins?.length) {
    const v = m.veins.pop();
    const b = getB(dim, v.x, v.y, v.z);
    if (!b || !isOre(b.typeId)) continue;
    if (Math.hypot(v.x + 0.5 - ent.location.x, v.y - ent.location.y, v.z + 0.5 - ent.location.z) > 5) continue;
    brain.cd = tick + cdTicks(22 * breakBlock(civ, m, ent, brain, b, v), brain);
    return;
  }

  // Блоки клетки сверху вниз; заодно расчищаем то, что осыпалось (гравий, песок).
  const todo = [];
  if (cell.p >= 0) for (const y of [stand.y + 1, stand.y]) todo.push({ x: Math.floor(stand.x), y, z: Math.floor(stand.z), stand: true });
  for (let k = cell.h - 1; k >= 0; k--) todo.push({ x: cell.x, y: cell.y + k, z: cell.z });
  for (const pos of todo) {
    const b = getB(dim, pos.x, pos.y, pos.z);
    if (!b) return; // чанк не загружен
    if (b.isLiquid) {
      plugLiquids(m, dim, { x: pos.x, y: pos.y - 1, z: pos.z });
      try {
        b.setType("minecraft:cobblestone");
        m.wet = (m.wet ?? 0) + 1;
      } catch {}
      brain.cd = tick + cdTicks(10, brain);
      return;
    }
    if (canPass(b)) continue;
    const id = b.typeId;
    if (id === "minecraft:bedrock" || isProtected(id) || MANMADE.test(strip(id))) {
      // Упёрлись в чужое (постройку, данж) или в бедрок: лестницу заканчиваем, штрек пропускаем.
      if (cell.stair || pos.stand) return finishMine(civ);
      m.idx++;
      markDirty(civ);
      return;
    }
    brain.cd = tick + cdTicks(22 * breakBlock(civ, m, ent, brain, b, pos), brain);
    return;
  }

  // Клетка готова: пол под ногами и факел.
  const floor = getB(dim, cell.x, cell.y - 1, cell.z);
  if (floor && canPass(floor)) {
    try {
      floor.setType("minecraft:cobblestone");
    } catch {}
  }
  // Факел каждые 6 шагов — когда будут факелы (из угля).
  if (m.idx % 6 === 5) deferLight(civ, cell.x, cell.y, cell.z, "minecraft:torch");
  m.idx++;
  markDirty(civ);
  brain.cd = tick + cdTicks(4, brain);
}

/** Текст для меню: как идёт шахта. */
export function mineInfo(civ) {
  const m = civ.mine;
  if (!m) return civ.minesDone ? `выкопано шахт: ${civ.minesDone}` : "ещё не начата";
  const plan = minePlan(m);
  const c = plan.cells[Math.min(m.idx, plan.cells.length - 1)];
  const part = m.idx < plan.stairs ? `лестница, ступенька ${m.idx + 1} из ${plan.stairs}` : "штреки на дне";
  return `глубина Y=${c.y} (цель Y=${m.target}), ${part}`;
}
