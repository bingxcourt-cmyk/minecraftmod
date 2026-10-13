import { getB, DIM, particle } from "./core.js";
import { canPass, canStandOn, walkY, standY, strip, isPassableId } from "./blocks.js";

// Блоки ниже полного роста или «дырявые»: стоять в них можно, задохнуться — нет.
const PARTIAL = [
  "bed", "slab", "stairs", "grass_path", "dirt_path", "farmland", "chest", "composter", "lectern", "anvil",
  "_wall", "fence", "pane", "bars", "ladder", "door", "campfire", "cake", "lantern", "bell", "flower_pot",
  "candle", "carpet", "snow_layer", "hopper", "cauldron", "brewing", "enchanting", "grindstone", "stonecutter",
  "scaffolding", "chain", "rod", "pointed", "pickle", "egg", "conduit", "skull", "head", "button", "lever",
  "rail", "torch", "leaves", "glass", "sapling", "propagule", "cactus", "bamboo", "dripleaf", "soul_sand", "mud",
  "honey", "daylight", "trapdoor", "sign", "banner", "web", "vine", "kelp", "seagrass", "azalea",
];

export function isFullSolid(b) {
  if (!b || b.isAir || b.isLiquid) return false;
  const n = strip(b.typeId);
  if (isPassableId(b.typeId)) return false;
  return !PARTIAL.some((p) => n.includes(p));
}

/** Можно ли встать в клетку (ноги и голова свободны, под ногами опора). */
export function standable(dim, x, y, z) {
  return canPass(getB(dim, x, y, z)) && canPass(getB(dim, x, y + 1, z)) && canStandOn(getB(dim, x, y - 1, z));
}

/** Ищет ближайшее безопасное место рядом с точкой (по спирали и вверх). */
export function findSafeSpot(dim, x, y, z, radius = 4) {
  const fx = Math.floor(x);
  const fz = Math.floor(z);
  const fy = Math.floor(y);
  for (let r = 0; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      for (const dy of [0, 1, -1, 2, 3, -2, 4, 5, 6]) {
        if (standable(dim, fx + dx, fy + dy, fz + dz)) return { x: fx + dx + 0.5, y: fy + dy, z: fz + dz + 0.5 };
      }
    }
  }
  const sy = standY(dim, fx, fz);
  return sy === undefined ? undefined : { x: fx + 0.5, y: sy, z: fz + 0.5 };
}

/** Безопасная телепортация: только на свободное место. */
export function safeTeleport(ent, pos, radius = 4) {
  const dim = DIM();
  const spot = findSafeSpot(dim, pos.x, pos.y, pos.z, radius);
  if (!spot) return false;
  try {
    ent.teleport(spot);
    return true;
  } catch {
    return false;
  }
}

/** Если существо оказалось внутри блока — выталкивает его на свободное место. */
export function rescueIfStuck(ent) {
  const dim = DIM();
  const l = ent.location;
  const x = Math.floor(l.x);
  const z = Math.floor(l.z);
  const head = getB(dim, x, Math.floor(l.y + 1.4), z);
  const feet = getB(dim, x, Math.floor(l.y + 0.2), z);
  if (!isFullSolid(head) && !isFullSolid(feet)) return false;
  const spot = findSafeSpot(dim, l.x, Math.floor(l.y) + 1, l.z, 5);
  if (!spot) return false;
  try {
    ent.teleport(spot);
    particle(dim, "minecraft:basic_smoke_particle", { x: spot.x, y: spot.y + 0.5, z: spot.z });
  } catch {}
  return true;
}

// ---------- Поиск пути (A*) по клеткам, с подъёмом/спуском на 1 блок ----------
class Heap {
  constructor() {
    this.a = [];
  }
  push(n) {
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Ищет путь от точки до цели. Возвращает список клеток (центры) или undefined.
 * Если цель недостижима за maxNodes шагов — путь до ближайшей найденной клетки.
 */
export function findPath(from, to, reach = 1.5, maxNodes = 300) {
  const dim = DIM();
  const sx = Math.floor(from.x);
  const sz = Math.floor(from.z);
  const sy = Math.floor(from.y + 0.01);
  const tx = to.x;
  const tz = to.z;
  const h = (x, z) => Math.hypot(x + 0.5 - tx, z + 0.5 - tz);
  const start = { x: sx, y: sy, z: sz, g: 0, f: h(sx, sz), parent: null };
  const open = new Heap();
  open.push(start);
  const seen = new Map([[`${sx},${sy},${sz}`, 0]]);
  let best = start;
  let bestH = h(sx, sz);
  let expanded = 0;
  while (open.size && expanded < maxNodes) {
    const cur = open.pop();
    expanded++;
    const ch = h(cur.x, cur.z);
    if (ch < bestH) {
      best = cur;
      bestH = ch;
    }
    if (ch <= reach) {
      best = cur;
      break;
    }
    for (const [dx, dz] of DIRS) {
      const nx = cur.x + dx;
      const nz = cur.z + dz;
      const ny = walkY(dim, nx + 0.5, nz + 0.5, cur.y, false);
      if (ny === undefined) continue;
      // При подъёме нужен простор над головой.
      if (ny > cur.y && !canPass(getB(dim, cur.x, cur.y + 2, cur.z))) continue;
      const k = `${nx},${ny},${nz}`;
      const g = cur.g + 1 + (ny !== cur.y ? 0.5 : 0);
      if ((seen.get(k) ?? Infinity) <= g) continue;
      seen.set(k, g);
      open.push({ x: nx, y: ny, z: nz, g, f: g + h(nx, nz) * 1.2, parent: cur });
    }
  }
  if (best === start) return undefined;
  const path = [];
  for (let n = best; n && n !== start; n = n.parent) path.push({ x: n.x + 0.5, y: n.y, z: n.z + 0.5 });
  return path.reverse();
}
