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

/** Поиск песка вокруг поселения — понемногу за раз, по расширяющимся кольцам. */
function scanSand(civ) {
  const dim = DIM();
  const sc = (civ._sandScan = civ._sandScan ?? { r: 16, k: 0 });
  for (let t = 0; t < 12; t++) {
    const n = Math.max(8, Math.floor((2 * Math.PI * sc.r) / 6));
    if (sc.k >= n) {
      sc.k = 0;
      sc.r += 6;
      if (sc.r > 100) {
        civ._sandScan = null;
        civ.noSand = S.clock + 900;
        markDirty(civ);
        return;
      }
      continue;
    }
    const a = (sc.k++ / n) * Math.PI * 2;
    const x = Math.floor(civ.center.x + Math.cos(a) * sc.r);
    const z = Math.floor(civ.center.z + Math.sin(a) * sc.r);
    const g = groundAt(dim, x, z);
    if (!g || g.liquid || g.unnatural) continue;
    if (!SAND.has(getB(dim, x, g.y, z)?.typeId ?? "")) continue;
    if (insideWall(civ, x, z)) continue;
    civ.sandAt = { x, z, y: g.y };
    civ._sandScan = null;
    markDirty(civ);
    return;
  }
}

/** Клетка с песком рядом с найденным местом (не глубже 4 блоков от исходной поверхности). */
function sandCell(civ) {
  const dim = DIM();
  const sp = civ.sandAt;
  for (let r = 0; r <= 4; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    const x = sp.x + dx;
    const z = sp.z + dz;
    const g = groundAt(dim, x, z);
    if (!g || g.liquid || g.y < sp.y - 4) continue;
    if (SAND.has(getB(dim, x, g.y, z)?.typeId ?? "")) return { x, y: g.y, z };
  }
  return null;
}

/** Песочник: идёт к песку, копает и несёт на склад. */
export function sanderThink(civ, ent, brain, tick) {
  if (!civ.sandAt) {
    if ((civ.noSand ?? 0) > S.clock) return wander(civ, brain, 8);
    scanSand(civ);
    if (!civ.sandAt) return wander(civ, brain, 8);
  }
  if (!brain.dig) {
    brain.dig = sandCell(civ);
    if (!brain.dig) {
      civ.sandAt = null; // место выкопано — ищем новое
      return;
    }
  }
  const d = brain.dig;
  setTarget(brain, { x: d.x + 0.5, y: d.y + 1, z: d.z + 0.5 }, 2.5, true);
  if (!near(ent, brain.target, 3, true)) return;
  const dim = DIM();
  const b = getB(dim, d.x, d.y, d.z);
  if (b && SAND.has(b.typeId)) {
    try {
      b.setType("minecraft:air");
    } catch {}
    civ.res.sand = (civ.res.sand ?? 0) + 1;
    markDirty(civ);
    sound(dim, "dig.sand", d);
    particle(dim, "minecraft:basic_smoke_particle", { x: d.x + 0.5, y: d.y + 0.8, z: d.z + 0.5 });
    if (!civ.sandNoted) {
      civ.sandNoted = true;
      note("events", `${civ.name}: песочники нашли песок (${d.x}, ${d.z})`);
    }
  }
  brain.dig = null;
  brain.cd = tick + Math.max(4, Math.round(12 / S.speed));
}
