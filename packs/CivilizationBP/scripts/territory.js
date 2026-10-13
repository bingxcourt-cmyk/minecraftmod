import { S, DIM, getB, loaded, markDirty } from "./core.js";
import { getBP, TYPES } from "./blueprints.js";
import { razeWall } from "./walls.js";
import { note } from "./journal.js";

// Земля поселений. Постройки разных поселений стоят не ближе 66 блоков друг к другу —
// тогда стены (в 7 блоках от построек) остаются минимум в 50 блоках друг от друга.
// Если поселению некуда расти, потому что мешает сосед, начинается война за территорию:
// победитель разбирает пограничные постройки и стену проигравшего и строит там своё.
export const TERR_GAP = 66;
export const COLONY_GAP = 90; // колонию основывают не ближе 90 блоков от чужих построек

export function rectGap(a, b) {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), 0);
  const dz = Math.max(b.z - (a.z + a.d), a.z - (b.z + b.d), 0);
  return Math.hypot(dx, dz);
}

/** Земля поселения: постройки (и текущая стройка), а пока их нет — площадка вокруг центра. */
export function landOf(civ) {
  const out = civ.buildings.map((b) => ({ x: b.x, z: b.z, w: b.w, d: b.d }));
  if (civ.project && civ.project.x !== undefined) {
    const bp = getBP(civ.project.t);
    const W = civ.project.r % 2 ? bp.d : bp.w;
    const D = civ.project.r % 2 ? bp.w : bp.d;
    out.push({ x: civ.project.x, z: civ.project.z, w: W, d: D });
  }
  if (!out.length) out.push({ x: civ.center.x - 6, z: civ.center.z - 6, w: 12, d: 12 });
  return out;
}

/** Чужое поселение, слишком близкое к этому участку (или undefined). */
export function blockerOf(civ, rect) {
  for (const o of S.civs.values()) {
    if (o === civ) continue;
    if (Math.hypot(o.center.x - rect.x, o.center.z - rect.z) > 260) continue;
    for (const r of landOf(o)) if (rectGap(rect, r) < TERR_GAP) return o;
  }
  return undefined;
}

/** Свободно ли место под новую колонию. */
export function colonySiteFree(p) {
  const pt = { x: p.x - 6, z: p.z - 6, w: 12, d: 12 };
  for (const o of S.civs.values()) {
    if (Math.hypot(o.center.x - p.x, o.center.z - p.z) < 110) return false;
    for (const r of landOf(o)) if (rectGap(pt, r) < COLONY_GAP) return false;
  }
  return true;
}

const SKIP = new Set(["center", "mine", "quarry"]);

function buildingCost(t) {
  const c = {};
  for (const op of getBP(t).ops) for (const k in op.cost ?? {}) c[k] = (c[k] ?? 0) + op.cost[k];
  return c;
}

/** Поставить постройку в очередь на снос (разберут, когда чанк загрузится). */
export function queueBuildingDemolish(b) {
  const h = getBP(b.t).h;
  S.demo = S.demo ?? [];
  S.demo.push({ x: b.x, y: b.y, z: b.z, w: b.w, d: b.d, h, i: 0 });
}

/**
 * Победитель войны за территорию забирает землю: пограничные постройки проигравшего
 * разбирают (половина материалов — победителю), стену проигравшего сносят целиком.
 */
export function takeLand(winner, loser) {
  const wl = landOf(winner);
  const gapTo = (b) => Math.min(...wl.map((r) => rectGap(b, r)));
  const cands = loser.buildings.filter((b) => !SKIP.has(b.t)).sort((a, b) => gapTo(a) - gapTo(b));
  const front = cands.filter((b) => gapTo(b) < TERR_GAP + 40);
  const take = (front.length ? front : cands.slice(0, 1)).slice(0, Math.max(1, Math.ceil(cands.length / 3)));
  const names = [];
  const got = {};
  for (const b of take) {
    loser.buildings.splice(loser.buildings.indexOf(b), 1);
    queueBuildingDemolish(b);
    for (const [k, v] of Object.entries(buildingCost(b.t))) {
      const half = Math.floor(v / 2);
      winner.res[k] = (winner.res[k] ?? 0) + half;
      got[k] = (got[k] ?? 0) + half;
    }
    names.push(TYPES[b.t]?.name ?? b.t);
    // Факелы, ждущие угля на месте снесённой постройки, больше не нужны.
    if (loser.lights) loser.lights = loser.lights.filter((l) => !(l.x >= b.x && l.x < b.x + b.w && l.z >= b.z && l.z < b.z + b.d));
  }
  const cols = razeWall(loser);
  if (cols) {
    winner.res.stone = (winner.res.stone ?? 0) + cols * 3;
    got.stone = (got.stone ?? 0) + cols * 3;
  }
  S.opsCache.delete(loser.id);
  S.cellsCache.delete(loser.id);
  loser.failed = {};
  winner.crowdBy = null;
  winner.failed = {};
  winner.blockedUntil = 0;
  loser._reassign = true;
  markDirty(winner);
  markDirty(loser);
  const parts = [];
  if (names.length) parts.push(`разбирают ${names.join(", ")}`);
  if (cols) parts.push(`сносят стену (${cols} столбов)`);
  const mats = Object.entries(got).filter(([, v]) => v > 0).map(([k, v]) => `${{ wood: "дерево", stone: "камень", iron: "железо", food: "еда", glass: "стекло" }[k] ?? k} ${v}`);
  const text = `${winner.name} забрали землю ${loser.name}: ${parts.join(", ") || "отодвинули границу"}${mats.length ? ` (материалы: ${mats.join(", ")})` : ""}`;
  note("build", text);
  return text;
}

/** Поселение уничтожено в войне за землю — победитель разбирает всё, что от него осталось. */
export function clearRuins(civ) {
  for (const b of civ.buildings) queueBuildingDemolish(b);
  razeWall(civ);
}

/** Раз в секунду: разбор построек в очереди на снос (до 300 блоков за раз). */
export function demoTick() {
  const e = S.demo?.[0];
  if (!e) return;
  const dim = DIM();
  if (!loaded(dim, e) || !loaded(dim, { x: e.x + e.w, z: e.z + e.d })) {
    // Чанк не загружен — пробуем следующую постройку позже.
    S.demo.push(S.demo.shift());
    return;
  }
  const H = e.h + 3;
  const total = e.w * e.d * H;
  let budget = 300;
  while (e.i < total && budget > 0) {
    const layer = Math.floor(e.i / (e.w * e.d));
    const rest = e.i % (e.w * e.d);
    const x = e.x + Math.floor(rest / e.d);
    const z = e.z + (rest % e.d);
    const y = e.y + H - 1 - layer;
    e.i++;
    const b = getB(dim, x, y, z);
    if (!b) continue;
    try {
      if (y === e.y) {
        if (b.typeId !== "minecraft:grass_block") b.setType("minecraft:grass_block");
      } else if (!b.isAir && !b.isLiquid) b.setType("minecraft:air");
    } catch {}
    budget--;
  }
  if (e.i >= total) S.demo.shift();
}
