import { system } from "@minecraft/server";
import { S, DIM, getB, loaded, markDirty, sound, particle, levelOf } from "./core.js";
import { groundAt, isPassableId, isNatural } from "./blocks.js";
import { remainingCost, digYield } from "./workers.js";
import { deferLight } from "./lights.js";
import { note, warLog } from "./journal.js";

// Защитная стена с эпохи «Город»: 6 блоков каменного кирпича, зубцы-бойницы через блок,
// факелы на зубцах, ворота-калитки на дорогах и по четырём сторонам света.
// Стена огибает поселение по контуру — ровно в 7 блоках от крайних построек (а не квадратом).
// Поселение растёт — стену перестраивают под новые границы: новую постройку ставят прямо на месте
// старой стены (там на время появляется брешь), а после стройки возводят стену по новому контуру.
// Свои проходят через калитки, бандиты и вражеские армии — нет: им приходится минуту ломать стену.
export const WALL_STONE = 7; // камня на один столб стены
const WALL_SPEED = 0.5; // столбов в секунду (каменщики работают и без игрока)
const MARGIN = 7; // отступ стены от построек
const ROADISH = new Set(["minecraft:stone_bricks", "minecraft:polished_andesite", "minecraft:grass_path", "minecraft:gravel", "minecraft:spruce_planks"]);
const SKIP_TYPES = new Set(["mine", "quarry"]);

// Состояние столба: 0 — не оплачен, p — оплачен (ждёт кладки или ремонта), 1 — стоит,
// x — снесён под новую постройку (не восстанавливают, ждут перестройки контура).
const enc = (v) => v.toString(36).padStart(2, "0");

function wallRects(civ) {
  const out = civ.buildings.filter((b) => !SKIP_TYPES.has(b.t)).map((b) => ({ x: b.x, z: b.z, w: b.w, d: b.d }));
  return out;
}

/** Расстояние от точки до прямоугольника постройки. */
function rectDist(r, x, z) {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
  const dz = Math.max(r.z - z, 0, z - (r.z + r.d));
  return Math.hypot(dx, dz);
}

/**
 * Контур стены: клетки в пределах 7 блоков от построек, без «дыр» внутри.
 * Столбы — крайние клетки этой области. Если рядом чужое поселение, граница идёт посередине.
 */
function computeCols(civ) {
  const rs = wallRects(civ);
  if (!rs.length) return null;
  const PAD = MARGIN + 2;
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const r of rs) {
    x0 = Math.min(x0, r.x);
    z0 = Math.min(z0, r.z);
    x1 = Math.max(x1, r.x + r.w);
    z1 = Math.max(z1, r.z + r.d);
  }
  x0 = Math.floor(x0) - PAD;
  z0 = Math.floor(z0) - PAD;
  x1 = Math.ceil(x1) + PAD;
  z1 = Math.ceil(z1) + PAD;
  const W = x1 - x0 + 1;
  const D = z1 - z0 + 1;
  if (W > 1200 || D > 1200) return null;
  const others = [];
  for (const o of S.civs.values()) {
    if (o === civ) continue;
    for (const b of o.buildings) {
      if (b.x + b.w + PAD * 2 < x0 || b.x - PAD * 2 > x1 || b.z + b.d + PAD * 2 < z0 || b.z - PAD * 2 > z1) continue;
      others.push(b);
    }
  }
  const g = new Uint8Array(W * D); // 1 — внутри
  for (const r of rs) {
    const ax = Math.max(0, Math.floor(r.x - MARGIN - 1) - x0);
    const az = Math.max(0, Math.floor(r.z - MARGIN - 1) - z0);
    const bx = Math.min(W - 1, Math.ceil(r.x + r.w + MARGIN + 1) - x0);
    const bz = Math.min(D - 1, Math.ceil(r.z + r.d + MARGIN + 1) - z0);
    for (let i = ax; i <= bx; i++) for (let j = az; j <= bz; j++) {
      if (g[i * D + j]) continue;
      const cx = x0 + i + 0.5;
      const cz = z0 + j + 0.5;
      const d = rectDist(r, cx, cz);
      if (d > MARGIN + 0.5) continue;
      // Чужие постройки ближе — это их земля.
      if (others.some((o) => rectDist(o, cx, cz) < d + 1)) continue;
      g[i * D + j] = 1;
    }
  }
  // Внешняя область — заливка от края; всё, что не достигнуто, считается внутренним (без дыр).
  const out = new Uint8Array(W * D);
  const stack = [];
  for (let i = 0; i < W; i++) for (const j of [0, D - 1]) stack.push(i * D + j);
  for (let j = 0; j < D; j++) for (const i of [0, W - 1]) stack.push(i * D + j);
  while (stack.length) {
    const k = stack.pop();
    if (out[k] || g[k]) continue;
    out[k] = 1;
    const i = Math.floor(k / D);
    const j = k % D;
    if (i > 0) stack.push(k - D);
    if (i < W - 1) stack.push(k + D);
    if (j > 0) stack.push(k - 1);
    if (j < D - 1) stack.push(k + 1);
  }
  const cols = [];
  for (let i = 1; i < W - 1; i++) for (let j = 1; j < D - 1; j++) {
    const k = i * D + j;
    if (out[k]) continue;
    // Крайняя клетка: рядом (в том числе по диагонали) есть внешняя — стена сплошная, без щелей.
    let edge = false;
    for (let di = -1; di <= 1 && !edge; di++) for (let dj = -1; dj <= 1; dj++) if (out[k + di * D + dj]) edge = true;
    if (edge) cols.push({ x: x0 + i, z: z0 + j });
  }
  const cx = civ.center.x;
  const cz = civ.center.z;
  cols.sort((a, b) => Math.atan2(a.z - cz, a.x - cx) - Math.atan2(b.z - cz, b.x - cx));
  return { ox: x0, oz: z0, cols };
}

const encode = (ox, oz, cols) => cols.map((c) => enc(c.x - ox) + enc(c.z - oz)).join("");

/** Расшифровка стены (кэшируется до следующей перестройки). */
function geo(civ) {
  const w = civ.wall;
  if (!w) return null;
  if (civ._wg?.c === w.c && civ._wg.rg === (w.rg ?? "")) return civ._wg;
  const cols = [];
  for (let i = 0; i < w.c.length; i += 4) cols.push({ x: w.ox + parseInt(w.c.slice(i, i + 2), 36), z: w.oz + parseInt(w.c.slice(i + 2, i + 4), 36) });
  const idx = new Map(cols.map((c, i) => [`${c.x},${c.z}`, i]));
  // Ворота по четырём сторонам света — самый дальний столб на луче от центра.
  const gates = new Set();
  const cx = Math.floor(civ.center.x);
  const cz = Math.floor(civ.center.z);
  const side = {};
  for (const [dx, dz, nm] of [[1, 0, "E"], [-1, 0, "W"], [0, 1, "S"], [0, -1, "N"]]) {
    let best = -1;
    let bd = -1;
    cols.forEach((c, i) => {
      const along = (c.x - cx) * dx + (c.z - cz) * dz;
      const side = Math.abs((c.x - cx) * dz - (c.z - cz) * dx);
      if (along > 0 && side <= 0 && along > bd) {
        bd = along;
        best = i;
      }
    });
    if (best >= 0) {
      gates.add(best);
      side[nm] = best;
    }
  }
  // Ворота, к которым подходят дороги от соседей.
  for (const k of (w.rg ?? "").split(";")) {
    const i = idx.get(k);
    if (i !== undefined) gates.add(i);
  }
  // Сетка «внутри/снаружи» для проверки, за стеной ли точка.
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const c of cols) {
    x0 = Math.min(x0, c.x - 1);
    z0 = Math.min(z0, c.z - 1);
    x1 = Math.max(x1, c.x + 1);
    z1 = Math.max(z1, c.z + 1);
  }
  const W = x1 - x0 + 1;
  const D = z1 - z0 + 1;
  const grid = new Uint8Array(Math.max(0, W * D)); // 0 — внутри, 1 — снаружи, 2 — стена
  for (const c of cols) grid[(c.x - x0) * D + (c.z - z0)] = 2;
  const stack = [];
  for (let i = 0; i < W; i++) for (const j of [0, D - 1]) stack.push(i * D + j);
  for (let j = 0; j < D; j++) for (const i of [0, W - 1]) stack.push(i * D + j);
  while (stack.length) {
    const k = stack.pop();
    if (grid[k]) continue;
    grid[k] = 1;
    const i = Math.floor(k / D);
    const j = k % D;
    if (i > 0) stack.push(k - D);
    if (i < W - 1) stack.push(k + D);
    if (j > 0) stack.push(k - 1);
    if (j < D - 1) stack.push(k + 1);
  }
  civ._wg = { c: w.c, rg: w.rg ?? "", cols, idx, gates, side, x0, z0, W, D, grid };
  return civ._wg;
}

/** Старая квадратная стена (версия 2.3) → контурная запись. */
function migrate(civ) {
  const w = civ.wall;
  if (!w || w.c !== undefined) return;
  const cols = [];
  const W = w.x2 - w.x1;
  const D = w.z2 - w.z1;
  for (let i = 0; i < w.n; i++) {
    if (i < W) cols.push({ x: w.x1 + i, z: w.z1 });
    else if (i < W + D) cols.push({ x: w.x2, z: w.z1 + (i - W) });
    else if (i < 2 * W + D) cols.push({ x: w.x2 - (i - W - D), z: w.z2 });
    else cols.push({ x: w.x1, z: w.z2 - (i - 2 * W - D) });
  }
  const ox = w.x1 - 1;
  const oz = w.z1 - 1;
  let s = "";
  for (let i = 0; i < cols.length; i++) s += w.done[i] === "1" ? "1" : i < Math.floor(w.prog) ? "p" : "0";
  civ.wall = { ox, oz, c: encode(ox, oz, cols), s, cur: 0, noted: w.noted, repairAt: w.repairAt };
  markDirty(civ);
}

export function planWall(civ) {
  migrate(civ);
  if (civ.wall || civ.era < 2) return;
  if (wallRects(civ).length < 8) return;
  const r = computeCols(civ);
  if (!r || !r.cols.length) return;
  civ.wall = { ox: r.ox, oz: r.oz, c: encode(r.ox, r.oz, r.cols), s: "0".repeat(r.cols.length), cur: 0 };
  markDirty(civ);
  note("build", `${civ.name}: начали строить защитную стену (${r.cols.length} столбов, ${r.cols.length * WALL_STONE} камня)`);
}

/** Поселение выросло — стену перестраивают под новые границы. */
export function replanWall(civ) {
  migrate(civ);
  if (!civ.wall) return planWall(civ);
  const old = geo(civ);
  const r = computeCols(civ);
  if (!r) return;
  const st = civ.wall.s;
  const keep = new Set();
  let s = "";
  let added = 0;
  for (const c of r.cols) {
    const i = old.idx.get(`${c.x},${c.z}`);
    if (i !== undefined) {
      keep.add(i);
      s += st[i] === "x" ? "0" : st[i];
    } else {
      s += "0";
      added++;
    }
  }
  // Лишние куски старой стены разбирают, камень возвращается на склад.
  const removed = [];
  let refund = 0;
  old.cols.forEach((c, i) => {
    if (keep.has(i)) return;
    if (st[i] === "1") removed.push(c);
    if (st[i] !== "0") refund += st[i] === "1" ? WALL_STONE - 2 : WALL_STONE;
  });
  if (!added && !removed.length && s === st) return;
  civ.res.stone = (civ.res.stone ?? 0) + refund;
  civ.wall = { ox: r.ox, oz: r.oz, c: encode(r.ox, r.oz, r.cols), s, cur: 0, repairAt: civ.wall.repairAt, rg: civ.wall.rg };
  if (removed.length) queueDemolish(removed);
  markDirty(civ);
  note("build", `${civ.name}: перестраивают стену под новые границы (+${added} столбов, разобрано ${removed.length})`);
}

/** Новая постройка встаёт на месте стены — этот кусок сносят (брешь до перестройки контура). */
export function clearWallFor(civ, rect) {
  migrate(civ);
  const g = geo(civ);
  if (!g) return 0;
  const chars = civ.wall.s.split("");
  const gone = [];
  g.cols.forEach((c, i) => {
    if (c.x < rect.x - 1 || c.x > rect.x + rect.w || c.z < rect.z - 1 || c.z > rect.z + rect.d) return;
    if (chars[i] === "1") gone.push(c);
    if (chars[i] !== "0") civ.res.stone = (civ.res.stone ?? 0) + (chars[i] === "1" ? WALL_STONE - 2 : WALL_STONE);
    chars[i] = "x";
  });
  if (!gone.length && chars.join("") === civ.wall.s) return 0;
  civ.wall.s = chars.join("");
  if (gone.length) {
    clearColumns(gone);
    note("build", `${civ.name}: разобрали ${gone.length} столбов стены под новую постройку`);
  }
  markDirty(civ);
  return gone.length;
}

/** Есть ли в этой клетке своя стена (на её месте можно строить — стену подвинут). */
export function isOwnWall(civ, x, z) {
  const g = geo(civ);
  return !!g && g.idx.has(`${x},${z}`);
}

const countOf = (s, ch) => s.split(ch).length - 1;
export const wallLeft = (civ) => (civ.wall?.s ? countOf(civ.wall.s, "0") : 0);
export const wallShare = (civ) => (civ.wall?.s ? countOf(civ.wall.s, "1") / Math.max(1, civ.wall.s.length) : 0);
export const wallPaidShare = (civ) => (civ.wall?.s ? (civ.wall.s.length - countOf(civ.wall.s, "0")) / Math.max(1, civ.wall.s.length) : 0);

/** Примерный радиус стены (для бандитов: появляются снаружи). */
export function wallRadius(civ) {
  const g = geo(civ);
  if (!g) return 0;
  let r = 0;
  for (const c of g.cols) r = Math.max(r, Math.hypot(c.x - civ.center.x, c.z - civ.center.z));
  return r;
}

export function insideWall(civ, x, z) {
  const g = civ.wall?.s && geo(civ);
  if (!g) return false;
  const i = Math.floor(x) - g.x0;
  const j = Math.floor(z) - g.z0;
  if (i < 0 || j < 0 || i >= g.W || j >= g.D) return false;
  return g.grid[i * g.D + j] === 0;
}

function setIf(b, id) {
  try {
    if (b && b.typeId !== id) b.setType(id);
  } catch {}
}

/**
 * Ставит один столб стены. Низ стены — на уровне поселения: в низине под стену кладут фундамент
 * из каменного кирпича (камень со склада), на холме грунт срезают. false — пока нельзя (чанк не
 * загружен или не хватает камня на фундамент).
 */
function placeColumn(civ, g, i) {
  const dim = DIM();
  const { x, z } = g.cols[i];
  if (!loaded(dim, { x, z })) return false;
  const gr = groundAt(dim, x, z);
  if (!gr) return false;
  if (gr.liquid) return true; // в воде стену не ставят
  const top = getB(dim, x, gr.y, z);
  if (!top) return false;
  const base = levelOf(civ);
  // Дорога на уровне поселения — здесь калитка; верх уже стоящей стены дорогой не считается.
  const road = ROADISH.has(top.typeId) && gr.y <= base + 1;
  const ownWall = top.typeId === "minecraft:stone_bricks" && gr.y > base + 1;
  if (gr.unnatural && !road && !ownWall) return true; // дом или чужая постройка — обходим
  if (gr.y < base - 12 || gr.y > base + 12) return true; // обрыв или скала — столб пропускают
  const gate = road || g.gates.has(i);
  // Фундамент до уровня поселения.
  const found = Math.max(0, base - gr.y);
  if (found > 0) {
    if ((civ.res.stone ?? 0) < found) return false;
    civ.res.stone -= found;
    for (let y = gr.y + 1; y <= base; y++) setIf(getB(dim, x, y, z), "minecraft:stone_bricks");
  }
  // Срезаем всё выше уровня поселения (грунт — на склад), расчищаем траву, листву, брёвна.
  for (let y = base + 1; y <= Math.max(base + 8, gr.y + 1); y++) {
    const b = getB(dim, x, y, z);
    if (!b || b.isAir) continue;
    if (b.isLiquid) continue;
    if (isPassableId(b.typeId) || b.typeId.endsWith("leaves") || b.typeId.endsWith("_log") || isNatural(b.typeId)) {
      if (!isPassableId(b.typeId)) digYield(civ, b.typeId);
      setIf(b, "minecraft:air");
    }
  }
  for (let k = 1; k <= 6; k++) {
    const b = getB(dim, x, base + k, z);
    if (!b) continue;
    if (gate && k === 1) setIf(b, "minecraft:spruce_fence_gate");
    else if (gate && k === 2) setIf(b, "minecraft:air");
    else setIf(b, "minecraft:stone_bricks");
  }
  // Зубцы-бойницы через блок, факел примерно на каждом восьмом столбе.
  if ((x + z) % 2 === 0) {
    setIf(getB(dim, x, base + 7, z), "minecraft:stone_bricks");
    if (i % 8 === 0) deferLight(civ, x, base + 8, z, "minecraft:torch");
  }
  markDirty(civ);
  return true;
}

/** Дорога от соседа подходит к стене: ближайший к соседу столб становится воротами. Возвращает точку снаружи. */
export function roadGate(civ, toward) {
  migrate(civ);
  const g = geo(civ);
  if (!g || !g.cols.length) return null;
  let best = -1;
  let bd = Infinity;
  g.cols.forEach((c, i) => {
    const d = Math.hypot(c.x - toward.x, c.z - toward.z);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  const c = g.cols[best];
  let dx = c.x - civ.center.x;
  let dz = c.z - civ.center.z;
  const l = Math.hypot(dx, dz) || 1;
  dx /= l;
  dz /= l;
  return { x: Math.round(c.x + dx * 2), z: Math.round(c.z + dz * 2), key: `${c.x},${c.z}` };
}

export const SIDE_DIR = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };

/** Ворота стены на стороне света (E, W, S, N): точка дороги сразу за ними, или null. */
export function sideGate(civ, side) {
  migrate(civ);
  const g = civ.wall?.s && geo(civ);
  const i = g?.side?.[side];
  if (i === undefined) return null;
  const c = g.cols[i];
  const [dx, dz] = SIDE_DIR[side];
  return { x: c.x + dx * 2, z: c.z + dz * 2 };
}

/** Ворота под дороги: ровно те столбы, к которым сейчас подходят дороги. */
export function setRoadGates(civ, keys) {
  const w = civ.wall;
  if (!w?.s) return;
  const rg = [...new Set(keys)].sort().join(";");
  if ((w.rg ?? "") === rg) return;
  const g = geo(civ);
  const old = new Set((w.rg ?? "").split(";"));
  const chars = w.s.split("");
  // Новые ворота и бывшие ворота перекладывают (столб уже стоит — кладут заново).
  for (const k of new Set([...keys, ...old])) {
    if (!k || keys.includes(k) === old.has(k)) continue;
    const i = g.idx.get(k);
    if (i !== undefined && chars[i] === "1") chars[i] = "p";
  }
  w.s = chars.join("");
  w.rg = rg;
  markDirty(civ);
}

/** Разбор столбов сверху вниз до настоящей земли. */
function clearColumn(dim, p) {
  const g = groundAt(dim, p.x, p.z);
  if (!g) return false;
  for (let y = g.y + 1; y > g.y - 10; y--) {
    const b = getB(dim, p.x, y, p.z);
    if (!b) break;
    const id = b.typeId;
    if (b.isAir) continue;
    if (id === "minecraft:stone_bricks" || id.includes("fence_gate") || id === "minecraft:torch") setIf(b, "minecraft:air");
    else break;
  }
  return true;
}

function clearColumns(list) {
  const dim = DIM();
  const later = [];
  for (const p of list) if (!loaded(dim, p) || !clearColumn(dim, p)) later.push(p);
  if (later.length) queueDemolish(later);
}

// Столбы, которые надо разобрать, когда их чанк загрузится (старый контур, захваченная стена).
function queueDemolish(cols) {
  S.wallDemo = S.wallDemo ?? [];
  for (const c of cols) S.wallDemo.push({ x: c.x, z: c.z });
  if (S.wallDemo.length > 4000) S.wallDemo.splice(0, S.wallDemo.length - 4000);
}

/** Вся стена поселения уходит под снос (землю захватил победитель). Возвращает число столбов. */
export function razeWall(civ) {
  migrate(civ);
  const g = geo(civ);
  if (!g) return 0;
  const placed = g.cols.filter((c, i) => civ.wall.s[i] === "1");
  queueDemolish(placed);
  civ.wall = null;
  civ._wg = null;
  markDirty(civ);
  return placed.length;
}

/** Рост стены: каменщики кладут столбы за камень со склада (и без игрока). */
export function progressWalls(dt) {
  for (const civ of S.civs.values()) {
    migrate(civ);
    const w = civ.wall;
    if (!w?.s) continue;
    w.pay = (w.pay ?? 0) + WALL_SPEED * S.speed * dt;
    if (w.pay < 1) continue;
    const chars = w.s.split("");
    let changed = false;
    for (let i = 0; i < chars.length && w.pay >= 1; i++) {
      if (chars[i] !== "0") continue;
      const keep = (remainingCost(civ).stone ?? 0) + 20;
      if ((civ.res.stone ?? 0) - WALL_STONE < keep) break;
      civ.res.stone -= WALL_STONE;
      chars[i] = "p";
      w.pay -= 1;
      changed = true;
    }
    w.pay = Math.min(w.pay, 3);
    if (changed) {
      w.s = chars.join("");
      markDirty(civ);
    }
    if (!w.s.includes("0") && !w.s.includes("x") && !w.noted) {
      w.noted = true;
      note("build", `${civ.name}: защитная стена достроена`);
    }
    if (w.s.includes("0")) w.noted = false;
  }
}

/** Раз в секунду: столбы, за которые уже заплатили, появляются в загруженных чанках. */
export function layWalls() {
  progressWalls(1);
  const dim = DIM();
  if (S.wallDemo?.length) {
    let budget = 20;
    S.wallDemo = S.wallDemo.filter((p) => {
      if (budget <= 0 || !loaded(dim, p)) return true;
      budget--;
      return !clearColumn(dim, p);
    });
  }
  for (const civ of S.civs.values()) {
    const w = civ.wall;
    if (!w?.s || (w.repairAt ?? 0) > S.clock || civ._wallJob || !w.s.includes("p")) continue;
    // Всё оплаченное появляется сразу, как только чанки загружены: фоновая задача ставит столбы
    // подряд, порциями по 12 за шаг (без рывков), пока не поставит все, до каких может дотянуться.
    civ._wallJob = true;
    system.runJob(
      (function* () {
        try {
          const g = geo(civ);
          for (let i = 0; i < g.cols.length; i++) {
            if (!civ.wall?.s || civ.wall.c !== g.c) break; // стену перестроили или снесли — начнём заново
            if (civ.wall.s[i] !== "p") continue;
            if (placeColumn(civ, g, i)) civ.wall.s = civ.wall.s.slice(0, i) + "1" + civ.wall.s.slice(i + 1);
            if (i % 12 === 11) yield;
          }
        } finally {
          civ._wallJob = false;
        }
      })(),
    );
  }
}

export function wallInfo(civ) {
  migrate(civ);
  const w = civ.wall;
  if (!w) return civ.era < 2 ? "с эпохи «Город»" : "ещё не начата";
  const breach = countOf(w.s, "x") ? `, §cбрешь под стройку (${countOf(w.s, "x")})§r` : "";
  return `${w.s.length} столбов: оплачено ${Math.round(wallPaidShare(civ) * 100)}%, стоит ${Math.round(wallShare(civ) * 100)}%${breach}`;
}

/** Ближайший столб стены к точке. */
export function nearestColumn(civ, pos) {
  const g = geo(civ);
  if (!g) return null;
  let best = null;
  let bd = Infinity;
  g.cols.forEach((p, i) => {
    const d = Math.hypot(p.x + 0.5 - pos.x, p.z + 0.5 - pos.z);
    if (d < bd) {
      bd = d;
      best = { i, ...p, d };
    }
  });
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
  let dx = c.x - civ.center.x;
  let dz = c.z - civ.center.z;
  const l = Math.hypot(dx, dz) || 1;
  dx /= l;
  dz /= l;
  for (let k = 2; k <= 4; k++) {
    const p = { x: c.x + 0.5 + dx * k, z: c.z + 0.5 + dz * k };
    if (!insideWall(civ, p.x, p.z) && !isOwnWall(civ, Math.floor(p.x), Math.floor(p.z))) return p;
  }
  return { x: c.x + 0.5 + dx * 3, z: c.z + 0.5 + dz * 3 };
}

/** Точка на гребне стены (для лучников). */
export function wallTop(civ, pos) {
  const c = nearestColumn(civ, pos);
  if (!c || civ.wall.s[c.i] !== "1") return null;
  // Верх столба — сам кирпич (groundAt считает его «землёй»), встаём на него.
  const g = groundAt(DIM(), c.x, c.z);
  return g ? { x: c.x + 0.5, y: g.y + 1, z: c.z + 0.5 } : null;
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
  if (civ.wall.s[c.i] !== "1") {
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
  const g = geo(civ);
  const chars = w.s.split("");
  // Брешь — сам столб и два соседних по контуру (ближайшие к нему).
  const near3 = g.cols
    .map((p, i) => ({ i, p, d: Math.hypot(p.x - c.x, p.z - c.z) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3);
  for (const { i, p } of near3) {
    clearColumn(dim, p);
    if (chars[i] === "1") chars[i] = "p"; // починят бесплатно
  }
  w.s = chars.join("");
  w.repairAt = S.clock + 180; // чинить начнут через 3 минуты
  brain.path = null;
  brain.prog = null; // заново ищут путь — уже через брешь
  markDirty(civ);
  sound(dim, "random.explode", { x: c.x, y: ent.location.y, z: c.z }, 0.6);
  if (brain.role === "raider") note("events", `${civ.name}: бандиты пробили брешь в стене`);
  else if (own) warLog(own, civ, `${own.name} пробили брешь в стене ${civ.name}`);
  return true;
}
