import { S, DIM, getB, markDirty, sound, particle } from "./core.js";
import { groundAt } from "./blocks.js";
import { setTarget, near, wander, remainingCost } from "./workers.js";
import { has, missingQueue } from "./society.js";
import { insideWall } from "./walls.js";
import { getBP } from "./blueprints.js";
import { note } from "./journal.js";

// Индустриализация: песочники копают песок, стекольный завод плавит его в стекло
// (8 стекла на 1 уголь). Нет песка поблизости — стекло и песок покупают на рынке.
const SMELT_RATE = 24; // стекла в минуту на заводе
const SAND = new Set(["minecraft:sand", "minecraft:red_sand"]);

const skyGlass = () => getBP("skyscraper").ops.reduce((n, op) => n + (op.cost?.glass ?? 0), 0);

/** Сколько стекла нужно на текущую стройку и ближайший небоскрёб. */
export function glassGoal(civ) {
  if (civ.era < 4) return 0;
  let goal = remainingCost(civ).glass ?? 0;
  if (civ.project?.t !== "skyscraper" && missingQueue(civ).includes("skyscraper")) goal += skyGlass();
  return goal;
}

/** Не хватает стекла с учётом песка, который переплавят (сейчас или когда построят завод). */
export const glassShort = (civ) => glassGoal(civ) - (civ.res.glass ?? 0) - (civ.res.sand ?? 0);

/** Плавка песка в стекло (вживую и в фоне). minutes — минуты работы. */
export function smeltTick(civ, minutes) {
  if (!has(civ, "glassworks") || !(civ.res.sand > 0)) return;
  civ._sm = Math.min(60, (civ._sm ?? 0) + SMELT_RATE * minutes);
  let n = Math.min(Math.floor(civ._sm), civ.res.sand);
  let fuel = civ.fuel ?? 0;
  while (fuel < n && (civ.res.coal ?? 0) > 0) {
    civ.res.coal--;
    fuel += 8;
  }
  n = Math.min(n, fuel);
  if (n <= 0) return;
  civ._sm -= n;
  civ.fuel = fuel - n;
  civ.res.sand -= n;
  civ.res.glass = (civ.res.glass ?? 0) + n;
  markDirty(civ);
}

// Что и как копают: песочники — песок (до 4 блоков вглубь), землекопы — землю (до 2 блоков,
// чтобы не оставлять ям), не ближе 3 блоков к постройкам и не внутри стены.
const DIRT = new Set(["minecraft:dirt", "minecraft:grass_block", "minecraft:coarse_dirt", "minecraft:podzol", "minecraft:rooted_dirt"]);
const DIG = {
  sand: { ids: SAND, spot: "sandAt", none: "noSand", depth: 4, minR: 16, found: "песочники нашли песок" },
  dirt: { ids: DIRT, spot: "dirtAt", none: "noDirt", depth: 2, minR: 14, found: "землекопы нашли место, где брать землю" },
};

/** Сколько земли не хватает на выравнивание площадки текущей стройки. */
export const dirtShort = (civ) => (civ.project && !civ.project.paid ? civ.project.fill ?? 0 : 0) - (civ.res.dirt ?? 0);

function nearBuilding(civ, x, z, pad) {
  return civ.buildings.some((b) => x >= b.x - pad && x < b.x + b.w + pad && z >= b.z - pad && z < b.z + b.d + pad);
}

function diggable(civ, cfg, dim, x, z, minY) {
  const g = groundAt(dim, x, z);
  if (!g || g.liquid || g.unnatural || (minY !== undefined && g.y < minY)) return null;
  if (!cfg.ids.has(getB(dim, x, g.y, z)?.typeId ?? "")) return null;
  if (insideWall(civ, x, z) || nearBuilding(civ, x, z, 3)) return null;
  return g;
}

/** Поиск места для копки вокруг поселения — понемногу за раз, по расширяющимся кольцам. */
function scanDig(civ, key) {
  const cfg = DIG[key];
  const dim = DIM();
  civ._scan = civ._scan ?? {};
  const sc = (civ._scan[key] = civ._scan[key] ?? { r: cfg.minR, k: 0 });
  for (let t = 0; t < 12; t++) {
    const n = Math.max(8, Math.floor((2 * Math.PI * sc.r) / 6));
    if (sc.k >= n) {
      sc.k = 0;
      sc.r += 6;
      if (sc.r > 100) {
        civ._scan[key] = null;
        civ[cfg.none] = S.clock + 900;
        markDirty(civ);
        return;
      }
      continue;
    }
    const a = (sc.k++ / n) * Math.PI * 2;
    const x = Math.floor(civ.center.x + Math.cos(a) * sc.r);
    const z = Math.floor(civ.center.z + Math.sin(a) * sc.r);
    const g = diggable(civ, cfg, dim, x, z);
    if (!g) continue;
    civ[cfg.spot] = { x, z, y: g.y };
    civ._scan[key] = null;
    markDirty(civ);
    return;
  }
}

/** Клетка для копки рядом с найденным местом (не глубже допустимого от исходной поверхности). */
function digCell(civ, key) {
  const cfg = DIG[key];
  const dim = DIM();
  const sp = civ[cfg.spot];
  for (let r = 0; r <= 4; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    const g = diggable(civ, cfg, dim, sp.x + dx, sp.z + dz, sp.y - cfg.depth);
    if (g) return { x: sp.x + dx, y: g.y, z: sp.z + dz };
  }
  return null;
}

/** Копатель: идёт к месту, копает и несёт на склад. */
function digThink(key, civ, ent, brain, tick) {
  const cfg = DIG[key];
  if (!civ[cfg.spot]) {
    if ((civ[cfg.none] ?? 0) > S.clock) return wander(civ, brain, 8);
    scanDig(civ, key);
    if (!civ[cfg.spot]) return wander(civ, brain, 8);
  }
  if (!brain.dig) {
    brain.dig = digCell(civ, key);
    if (!brain.dig) {
      civ[cfg.spot] = null; // место выкопано — ищем новое
      return;
    }
  }
  const d = brain.dig;
  setTarget(brain, { x: d.x + 0.5, y: d.y + 1, z: d.z + 0.5 }, 2.5, true);
  if (!near(ent, brain.target, 3, true)) return;
  const dim = DIM();
  const b = getB(dim, d.x, d.y, d.z);
  if (b && cfg.ids.has(b.typeId)) {
    try {
      b.setType("minecraft:air");
    } catch {}
    civ.res[key] = (civ.res[key] ?? 0) + 1;
    markDirty(civ);
    sound(dim, key === "sand" ? "dig.sand" : "dig.grass", d);
    particle(dim, "minecraft:basic_smoke_particle", { x: d.x + 0.5, y: d.y + 0.8, z: d.z + 0.5 });
    const flag = key + "Noted";
    if (!civ[flag]) {
      civ[flag] = true;
      note("events", `${civ.name}: ${cfg.found} (${d.x}, ${d.z})`);
    }
  }
  brain.dig = null;
  brain.cd = tick + Math.max(4, Math.round(12 / S.speed));
}

/** Песочник: копает песок для стекла. */
export const sanderThink = (civ, ent, brain, tick) => digThink("sand", civ, ent, brain, tick);
/** Землекоп: копает землю для выравнивания площадок. */
export const diggerThink = (civ, ent, brain, tick) => digThink("dirt", civ, ent, brain, tick);
