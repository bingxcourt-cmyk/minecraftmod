import { BlockPermutation, EntityDamageCause, system } from "@minecraft/server";
import { S, P, DIM, getB, getProp, setProp, dXZ, rnd, pick, markDirty, sound, particle, cdTicks, loaded } from "./core.js";
import { isLog, isLeaves, isStoneLike, isIronOre, isProtected, isPassableId, isNaturalGround, walkY, standY, strip } from "./blocks.js";
import { makeOps, cropCells, dims } from "./blueprints.js";
import { findPath, findSafeSpot, safeTeleport, rescueIfStuck } from "./nav.js";
import { TOOL_FOR, TIERS, toolLabel, craftNeed, craft, useTool } from "./tools.js";

export const ROLE_NAME = {
  lumberjack: "Лесоруб", miner: "Шахтёр", farmer: "Фермер", hunter: "Охотник", builder: "Строитель",
  soldier: "Воин", settler: "Переселенец", child: "Ребёнок", golem: "Страж", "": "Житель",
};

// ---------- Мозг жителя ----------
export function brainOf(ent, civId) {
  let b = S.brains.get(ent.id);
  if (!b) {
    b = { civId, role: String(getProp(ent, P.ROLE) ?? ""), target: null, reach: 2, cd: 0, name: String(getProp(ent, P.NAME) ?? "") };
    S.brains.set(ent.id, b);
  }
  b.civId = civId;
  b.ent = ent;
  return b;
}

export function resetTask(brain) {
  if (brain.tree) S.claimedTrees.delete(brain.tree.key);
  if (brain.prey) S.claimedPrey.delete(brain.prey.id);
  brain.tree = null;
  brain.prey = null;
  brain.cell = null;
  brain.target = null;
  brain.wander = null;
  brain.sapling = null;
  brain.path = null;
}

export function setRole(ent, brain, role, civ) {
  if (brain.role === role) return;
  resetTask(brain);
  brain.role = role;
  setProp(ent, P.ROLE, role);
  updateTag(ent, brain, civ);
}

export function updateTag(ent, brain, civ) {
  const h = Number(getProp(ent, P.HUNGER) ?? 20);
  const hc = h <= 5 ? "§c" : h <= 12 ? "§e" : "§a";
  const role = brain.role === "soldier" ? "§c" + ROLE_NAME.soldier : "§7" + (ROLE_NAME[brain.role] ?? "Житель");
  const tag = brain.role === "golem"
    ? `${civ.color}Страж ${civ.name}`
    : `${civ.color}${brain.name}§r\n${role} ${hc}Еда:${Math.round(h)}\n${toolLabel(ent, brain.role)}`;
  if (brain.tag === tag) return;
  brain.tag = tag;
  try {
    ent.nameTag = tag;
  } catch {}
}

export function setTarget(brain, pos, reach = 2, ignoreY = false) {
  brain.target = { x: pos.x, y: pos.y, z: pos.z };
  brain.reach = reach;
  brain.ignoreY = ignoreY;
}

export function near(ent, pos, reach, ignoreY) {
  if (!pos) return false;
  const p = ent.location;
  return dXZ(p, pos) <= reach && (ignoreY || Math.abs(p.y - pos.y) < 3.5);
}

// ---------- Ходьба (вызывается каждые 2 тика) ----------
// Поиск пути дорогой, поэтому за один вызов moveAll разрешаем не больше одного.
let pathBudget = 0;
export const resetPathBudget = (n) => (pathBudget = n);

function requestPath(brain, p, t) {
  if (pathBudget <= 0 || (brain.noPathUntil ?? 0) > system.currentTick) return false;
  pathBudget--;
  const pts = findPath(p, t, Math.max(1.2, brain.reach - 0.3));
  if (!pts || !pts.length) {
    brain.noPathUntil = system.currentTick + 60;
    return false;
  }
  brain.path = { pts, i: 0, tx: t.x, tz: t.z };
  return true;
}

export function moveStep(brain) {
  const ent = brain.ent;
  const t = brain.target;
  if (!t || !ent || !ent.isValid) return;
  const p = ent.location;
  if (near(ent, t, brain.reach, brain.ignoreY)) {
    brain.path = null;
    return;
  }
  const dim = DIM();
  // Идём по найденному пути (в обход стен, через двери), если он есть.
  let goal = t;
  const path = brain.path;
  let advanced = false;
  if (path) {
    if (Math.hypot(path.tx - t.x, path.tz - t.z) > 2.5) brain.path = null;
    else {
      while (path.i < path.pts.length && dXZ(p, path.pts[path.i]) < 0.4) {
        path.i++;
        advanced = true;
      }
      if (path.i >= path.pts.length) brain.path = null;
      else goal = path.pts[path.i];
    }
  }
  const dx = goal.x - p.x;
  const dz = goal.z - p.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.05) return;
  const sp = (brain.role === "soldier" ? 0.36 : 0.3) * (brain.hungry ? 0.6 : 1);
  const step = Math.min(sp, dist);
  // Следим за продвижением: если житель долго не приближается к цели, он перебирается к ней.
  const td = dXZ(p, t);
  const pr = brain.prog;
  if (!pr || Math.hypot(t.x - pr.tx, t.z - pr.tz) > 3) {
    brain.prog = { tx: t.x, tz: t.z, best: td, n: 0 };
  } else if (td < pr.best - 0.1 || advanced) {
    pr.best = Math.min(pr.best, td);
    pr.n = 0;
  } else {
    pr.n++;
    if (pr.n === 12 && !brain.path) requestPath(brain, p, t);
    if (pr.n > 50) {
      pr.n = 0;
      pr.best = td;
      brain.path = null;
      unstick(ent, brain, dim, t);
      return;
    }
  }
  const allowDrop = t.y < p.y - 2;
  let nx = p.x + (dx / dist) * step;
  let nz = p.z + (dz / dist) * step;
  let ny = walkY(dim, nx, nz, p.y, allowDrop);
  if (ny === undefined && !brain.path && requestPath(brain, p, t)) return;
  if (ny === undefined) {
    for (const s of brain.side === -1 ? [-1, 1] : [1, -1]) {
      const ax = p.x + (-dz / dist) * s * step;
      const az = p.z + (dx / dist) * s * step;
      ny = walkY(dim, ax, az, p.y, allowDrop);
      if (ny !== undefined) {
        nx = ax;
        nz = az;
        brain.side = s;
        break;
      }
    }
  }
  if (ny === undefined) return;
  try {
    ent.teleport({ x: nx, y: ny, z: nz }, { facingLocation: { x: goal.x, y: ny + 1.5, z: goal.z } });
  } catch {}
}

function unstick(ent, brain, dim, t) {
  if (!loaded(dim, t)) return;
  // Перебирается на свободное место рядом с целью — не в стену, не в дерево.
  const y = brain.ignoreY ? standY(dim, t.x, t.z) ?? t.y : t.y;
  const spot = findSafeSpot(dim, t.x, y, t.z, 4);
  if (!spot) return;
  try {
    ent.teleport(spot);
    particle(dim, "minecraft:basic_smoke_particle", { x: spot.x, y: spot.y + 0.5, z: spot.z });
  } catch {}
}

function wander(civ, brain, r = 10) {
  if (!brain.wander || near(brain.ent, brain.wander, 1.5, true)) {
    const a = Math.random() * Math.PI * 2;
    const d = rnd(2, r);
    const x = civ.center.x + Math.cos(a) * d;
    const z = civ.center.z + Math.sin(a) * d;
    const y = standY(DIM(), x, z);
    brain.wander = y === undefined ? null : { x, y, z };
  }
  if (brain.wander) setTarget(brain, brain.wander, 1.2);
}

// ---------- Ресурсы ----------
export function foodCap(civ) {
  let cap = 60;
  for (const b of civ.buildings) {
    if (b.t === "barn") cap += 80;
    else if (b.t.startsWith("farm")) cap += 15;
    else if (b.t === "townhall" || b.t === "castle") cap += 40;
  }
  return cap;
}

export function addFood(civ, n) {
  civ.res.food = Math.min(foodCap(civ), civ.res.food + n);
  markDirty(civ);
}

function insideBuildings(civ, x, z, pad = 1) {
  for (const b of civ.buildings) {
    if (x >= b.x - pad && x < b.x + b.w + pad && z >= b.z - pad && z < b.z + b.d + pad) return true;
  }
  const p = civ.project;
  if (p) {
    const { W, D } = dims(p.t, p.r);
    if (x >= p.x - pad && x < p.x + W + pad && z >= p.z - pad && z < p.z + D + pad) return true;
  }
  return false;
}

// ---------- Лесоруб ----------
function findTree(civ) {
  const dim = DIM();
  const R = Math.min(64, 32 + civ.buildings.length * 2);
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = rnd(5, R);
    const x = Math.floor(civ.center.x + Math.cos(a) * d);
    const z = Math.floor(civ.center.z + Math.sin(a) * d);
    if (insideBuildings(civ, x, z, 2)) continue;
    let top;
    try {
      top = dim.getTopmostBlock({ x, z });
    } catch {
      continue;
    }
    if (!top || !(isLeaves(top.typeId) || isLog(top.typeId))) continue;
    let y = top.location.y;
    let found = -1;
    for (let k = 0; k < 24; k++, y--) {
      const b = getB(dim, x, y, z);
      if (!b) break;
      if (isLog(b.typeId)) found = y;
      else if (found >= 0) {
        // Под стволом должна быть земля — значит это живое дерево, а не постройка.
        if (isNaturalGround(b.typeId)) {
          const key = `${x},${found},${z}`;
          if (S.claimedTrees.has(key)) break;
          return { x, y: found, z, key, logId: getB(dim, x, found, z)?.typeId ?? "minecraft:oak_log" };
        }
        break;
      } else if (!(isLeaves(b.typeId) || b.isAir || isPassableId(b.typeId))) break;
    }
  }
  return undefined;
}

function collectTree(civ, base) {
  const dim = DIM();
  const seen = new Set([`${base.x},${base.y},${base.z}`]);
  const queue = [{ x: base.x, y: base.y, z: base.z }];
  const logs = [];
  let leaves = false;
  while (queue.length && logs.length < 64) {
    const c = queue.shift();
    logs.push(c);
    for (let dx = -1; dx <= 1; dx++) for (let dy = 0; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
      const k = `${n.x},${n.y},${n.z}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (Math.abs(n.x - base.x) > 5 || Math.abs(n.z - base.z) > 5) continue;
      if (insideBuildings(civ, n.x, n.z, 0)) continue;
      const b = getB(dim, n.x, n.y, n.z);
      if (!b) continue;
      if (isLog(b.typeId)) queue.push(n);
      else if (isLeaves(b.typeId)) leaves = true;
    }
  }
  return leaves ? logs : [];
}

const SAPLING = (logId) => {
  const n = strip(logId).replace("_log", "");
  if (n === "mangrove") return "minecraft:mangrove_propagule";
  return `minecraft:${n}_sapling`;
};

// Выросшее дерево на месте саженца: ствол и шапка листвы.
function growTree(dim, sp) {
  const b = getB(dim, sp.x, sp.y, sp.z);
  if (!b || !(b.typeId.endsWith("_sapling") || b.typeId.endsWith("_propagule"))) return false;
  const kind = strip(b.typeId).replace("_sapling", "").replace("_propagule", "");
  const log = `minecraft:${kind}_log`;
  const leaves = `minecraft:${kind}_leaves`;
  const h = rnd(4, 6);
  try {
    for (let y = 0; y < h; y++) getB(dim, sp.x, sp.y + y, sp.z)?.setType(log);
    for (let y = h - 2; y <= h + 1; y++) {
      const r = y >= h ? 1 : 2;
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r && r === 2) continue;
        const lb = getB(dim, sp.x + dx, sp.y + y, sp.z + dz);
        if (lb?.isAir) lb.setType(leaves);
      }
    }
  } catch {
    return false;
  }
  particle(dim, "minecraft:crop_growth_emitter", { x: sp.x + 0.5, y: sp.y + 1, z: sp.z + 0.5 });
  // Если кто-то стоял на месте саженца — выталкиваем из ствола.
  try {
    for (const e of dim.getEntities({ location: { x: sp.x + 0.5, y: sp.y + 1, z: sp.z + 0.5 }, maxDistance: 3 })) rescueIfStuck(e);
  } catch {}
  return true;
}

function forester(civ, ent, brain, tick) {
  const list = civ.saplings ?? [];
  const ready = list.filter((sp) => S.clock >= sp.at);
  if (!ready.length) return false;
  let sp = brain.sapling && list.includes(brain.sapling) ? brain.sapling : undefined;
  if (!sp) {
    sp = ready[Math.floor(Math.random() * ready.length)];
    brain.sapling = sp;
  }
  setTarget(brain, { x: sp.x + 0.5, y: sp.y, z: sp.z + 0.5 }, 2.3, true);
  if (!near(ent, brain.target, 2.6, true)) return true;
  growTree(DIM(), sp);
  list.splice(list.indexOf(sp), 1);
  brain.sapling = null;
  markDirty(civ);
  brain.cd = tick + cdTicks(30, brain);
  return true;
}

function lumberjack(civ, ent, brain, tick) {
  const dim = DIM();
  if (!brain.tree) {
    const t = findTree(civ);
    if (!t) {
      // Леса рядом нет — ухаживают за саженцами, пока те не станут деревьями.
      if (forester(civ, ent, brain, tick)) return;
      return wander(civ, brain, 16);
    }
    S.claimedTrees.add(t.key);
    brain.tree = { ...t, logs: null };
  }
  const tree = brain.tree;
  setTarget(brain, { x: tree.x + 0.5, y: tree.y, z: tree.z + 0.5 }, 2.3, true);
  if (!near(ent, brain.target, 2.6, true)) return;
  if (!tree.logs) tree.logs = collectTree(civ, tree);
  const pos = tree.logs.shift();
  if (!pos) {
    // Сажает новое дерево на месте срубленного.
    const ground = getB(dim, tree.x, tree.y - 1, tree.z);
    const spot = getB(dim, tree.x, tree.y, tree.z);
    if (ground && spot?.isAir && isNaturalGround(ground.typeId)) {
      try {
        spot.setType(SAPLING(tree.logId));
        civ.saplings = civ.saplings ?? [];
        if (civ.saplings.length < 40) civ.saplings.push({ x: tree.x, y: tree.y, z: tree.z, at: S.clock + Math.round(240 / S.speed) });
        markDirty(civ);
      } catch {}
    }
    S.claimedTrees.delete(tree.key);
    brain.tree = null;
    brain.cd = tick + cdTicks(20, brain);
    return;
  }
  const b = getB(dim, pos.x, pos.y, pos.z);
  let mult = 1;
  if (b && isLog(b.typeId)) {
    const use = useTool(ent, "axe");
    mult = use.mult;
    if (use.broke) updateTag(ent, brain, civ);
    try {
      b.setType("minecraft:air");
      civ.res.wood += 3;
      if (Math.random() < 0.08) addFood(civ, 1); // нашли яблоко
      markDirty(civ);
      sound(dim, "dig.wood", pos);
      particle(dim, "minecraft:villager_happy", { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 });
    } catch {}
  }
  try {
    ent.teleport(ent.location, { facingLocation: { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 } });
  } catch {}
  brain.cd = tick + cdTicks(14 * mult, brain);
}

// ---------- Шахтёр ----------
const isDiamondOre = (id) => id === "minecraft:diamond_ore" || id === "minecraft:deepslate_diamond_ore";

function miner(civ, ent, brain, tick) {
  const q = civ.quarry;
  if (!q) return wander(civ, brain, 8);
  const dim = DIM();
  const mid = { x: q.x + 2.5, y: q.y + 1, z: q.z + 2.5 };
  setTarget(brain, mid, 3.5, true);
  if (!near(ent, mid, 3.8, true)) return;
  // Спускается в яму к текущему слою.
  if (Math.abs(ent.location.y - (q.y + 1)) > 2.5) safeTeleport(ent, { x: mid.x, y: q.y + 1, z: mid.z }, 2);
  let mult = 1;
  for (let checks = 0; checks < 30; checks++) {
    if (q.ci >= 25) {
      q.y--;
      q.ci = 0;
      q.depth++;
      markDirty(civ);
      if (q.depth > 18 || q.y < -50) return finishQuarry(civ);
      continue;
    }
    const x = q.x + (q.ci % 5);
    const z = q.z + Math.floor(q.ci / 5);
    const b = getB(dim, x, q.y, z);
    if (!b) return;
    const id = b.typeId;
    if (b.isAir || isPassableId(id)) {
      q.ci++;
      continue;
    }
    if (b.isLiquid || id.includes("lava") || id.includes("water") || id === "minecraft:bedrock") return finishQuarry(civ);
    if (isProtected(id)) {
      q.ci++;
      continue;
    }
    try {
      b.setType("minecraft:air");
    } catch {
      q.ci++;
      continue;
    }
    q.ci++;
    // Как у Стива: железо — только каменной киркой и лучше, алмазы — железной и лучше.
    const use = useTool(ent, "pickaxe");
    mult = use.mult;
    if (use.broke) updateTag(ent, brain, civ);
    if (isIronOre(id)) {
      if (use.tier >= 2) civ.res.iron += 1;
    } else if (isDiamondOre(id)) {
      if (use.tier >= 3) civ.res.diamond = (civ.res.diamond ?? 0) + 1;
    } else if (isStoneLike(id)) {
      civ.res.stone += 1;
      // Глубоко в камне попадаются железные жилы.
      if (use.tier >= 2 && q.depth >= 4 && Math.random() < 0.03) civ.res.iron += 1;
    } else if (isLog(id)) civ.res.wood += 3;
    markDirty(civ);
    sound(dim, "dig.stone", { x, y: q.y, z });
    particle(dim, "minecraft:basic_smoke_particle", { x: x + 0.5, y: q.y + 0.5, z: z + 0.5 });
    try {
      ent.teleport(ent.location, { facingLocation: { x: x + 0.5, y: q.y + 0.5, z: z + 0.5 } });
    } catch {}
    break;
  }
  brain.cd = tick + cdTicks(22 * mult, brain);
}

function finishQuarry(civ) {
  const q = civ.quarry;
  if (q) civ.buildings.push({ t: "quarry", x: q.x, y: q.top, z: q.z, r: 0, w: 5, d: 5 });
  civ.quarry = null;
  markDirty(civ);
}

// ---------- Фермер ----------
function farmCells(civ) {
  let cells = S.cellsCache.get(civ.id);
  if (!cells) {
    cells = [];
    for (const b of civ.buildings) if (b.t.startsWith("farm")) cells.push(...cropCells(b));
    S.cellsCache.set(civ.id, cells);
  }
  return cells;
}

function farmer(civ, ent, brain, tick) {
  const cells = farmCells(civ);
  if (!cells.length) return hunter(civ, ent, brain, tick);
  if (!brain.cell) {
    brain.ci = ((brain.ci ?? rnd(0, cells.length)) + 1 + rnd(0, 2)) % cells.length;
    brain.cell = cells[brain.ci];
  }
  setTarget(brain, { x: brain.cell.x + 0.5, y: brain.cell.y, z: brain.cell.z + 0.5 }, 1.6);
  if (!near(ent, brain.target, 2, false)) return;
  const dim = DIM();
  const c = brain.cell;
  brain.cell = null;
  const below = getB(dim, c.x, c.y - 1, c.z);
  const b = getB(dim, c.x, c.y, c.z);
  if (!b || !below) return;
  const use = useTool(ent, "hoe");
  if (use.broke) updateTag(ent, brain, civ);
  try {
    if (below.typeId !== "minecraft:farmland") {
      if (!isNaturalGround(below.typeId)) return;
      below.setPermutation(BlockPermutation.resolve("minecraft:farmland", { moisturized_amount: 7 }));
    }
    if (b.typeId === "minecraft:wheat") {
      const g = Number(b.permutation.getState("growth") ?? 0);
      if (g >= 7) {
        b.setPermutation(BlockPermutation.resolve("minecraft:wheat", { growth: 0 }));
        addFood(civ, 2);
        sound(dim, "block.composter.fill_success", c);
        particle(dim, "minecraft:villager_happy", { x: c.x + 0.5, y: c.y + 0.6, z: c.z + 0.5 });
      } else if (Math.random() < 0.75) {
        b.setPermutation(BlockPermutation.resolve("minecraft:wheat", { growth: g + 1 }));
        particle(dim, "minecraft:crop_growth_emitter", { x: c.x + 0.5, y: c.y + 0.3, z: c.z + 0.5 });
      }
    } else if (b.isAir || isPassableId(b.typeId)) {
      b.setPermutation(BlockPermutation.resolve("minecraft:wheat", { growth: 0 }));
    }
  } catch {}
  brain.cd = tick + cdTicks(24 * use.mult, brain);
}

// ---------- Охотник ----------
const PREY = {
  "minecraft:cow": 4, "minecraft:pig": 4, "minecraft:sheep": 3, "minecraft:chicken": 2,
  "minecraft:rabbit": 2, "minecraft:mooshroom": 4, "minecraft:goat": 3,
};

function findPrey(civ) {
  let list = [];
  try {
    list = DIM().getEntities({ location: civ.center, maxDistance: 48 });
  } catch {
    return undefined;
  }
  const counts = {};
  const cands = [];
  for (const e of list) {
    if (!(e.typeId in PREY)) continue;
    counts[e.typeId] = (counts[e.typeId] ?? 0) + 1;
    if (e.nameTag || S.claimedPrey.has(e.id)) continue;
    if (e.getComponent("minecraft:is_tamed") || e.getComponent("minecraft:is_baby")) continue;
    cands.push(e);
  }
  // Последних двух животных каждого вида не трогают — пусть размножаются.
  const ok = cands.filter((e) => counts[e.typeId] > 2);
  return ok.length ? pick(ok) : undefined;
}

function hunter(civ, ent, brain, tick) {
  if (brain.prey && !brain.prey.isValid) {
    S.claimedPrey.delete(brain.preyId);
    brain.prey = null;
  }
  if (!brain.prey) {
    const prey = findPrey(civ);
    if (!prey) {
      // Животных нет — собирают ягоды и коренья, это даёт мало еды.
      wander(civ, brain, 20);
      if (brain.wander && near(ent, brain.wander, 1.6, true)) {
        if (Math.random() < 0.3) addFood(civ, 1);
        brain.wander = null;
        brain.cd = tick + cdTicks(60, brain);
      }
      return;
    }
    brain.prey = prey;
    brain.preyId = prey.id;
    S.claimedPrey.add(prey.id);
  }
  const prey = brain.prey;
  setTarget(brain, prey.location, 1.4);
  if (!near(ent, prey.location, 2.2, false)) return;
  const value = PREY[prey.typeId] ?? 2;
  const use = useTool(ent, "sword");
  if (use.broke) updateTag(ent, brain, civ);
  try {
    prey.applyDamage(TIERS[use.tier].dmg + 1, { cause: EntityDamageCause.entityAttack, damagingEntity: ent });
  } catch {}
  sound(DIM(), "game.player.attack.strong", prey.location);
  const hp = prey.isValid ? prey.getComponent("minecraft:health") : undefined;
  if (!prey.isValid || !hp || hp.currentValue <= 0) {
    addFood(civ, value);
    S.claimedPrey.delete(brain.preyId);
    brain.prey = null;
  }
  brain.cd = tick + cdTicks(16, brain);
}

// ---------- Строитель ----------
export function projectOps(civ) {
  const p = civ.project;
  if (!p) return [];
  const key = `${p.t}:${p.x},${p.y},${p.z},${p.r}`;
  let c = S.opsCache.get(civ.id);
  if (!c || c.key !== key) {
    c = { key, ops: makeOps(p.t, p, p.r) };
    S.opsCache.set(civ.id, c);
  }
  return c.ops;
}

/** Сколько ресурсов ещё нужно, чтобы достроить текущую постройку. */
export function remainingCost(civ) {
  const p = civ.project;
  const need = { wood: 0, stone: 0, iron: 0, food: 0 };
  if (!p) return need;
  const ops = projectOps(civ);
  for (let i = p.step; i < ops.length; i++) {
    const c = ops[i].cost;
    if (c) for (const k in c) need[k] += c[k];
  }
  return need;
}

const RES_NAME = { wood: "дерево", stone: "камень", iron: "железо", food: "еда" };

function canPay(civ, cost) {
  for (const k in cost) if ((civ.res[k] ?? 0) < cost[k]) return k;
  return null;
}

function placeOp(dim, op) {
  const b = getB(dim, op.x, op.y, op.z);
  if (!b) return false;
  try {
    if (op.st) b.setPermutation(BlockPermutation.resolve(op.id, op.st));
    else b.setType(op.id);
  } catch {
    try {
      b.setType(op.id);
    } catch {
      return false;
    }
  }
  if (!isPassableId(op.id) && !op.id.includes("water")) liftOut(dim, op);
  if (op.pair) {
    const h = getB(dim, op.pair.x, op.pair.y, op.pair.z);
    try {
      h?.setPermutation(BlockPermutation.resolve(op.id, op.pair.st));
    } catch {}
  }
  return true;
}

// Если блок поставили «в» существо, поднимаем его наверх, чтобы не задохнулось.
function liftOut(dim, op) {
  let list = [];
  try {
    list = dim.getEntities({ location: { x: op.x + 0.5, y: op.y + 0.5, z: op.z + 0.5 }, maxDistance: 2 });
  } catch {
    return;
  }
  for (const e of list) {
    const l = e.location;
    if (Math.floor(l.x) !== op.x || Math.floor(l.z) !== op.z) continue;
    const fy = Math.floor(l.y);
    if (fy !== op.y && fy !== op.y - 1) continue;
    const spot = findSafeSpot(dim, l.x, op.y + 1, l.z, 3);
    try {
      if (spot) e.teleport(spot);
    } catch {}
  }
}

/** Выполняет шаги стройки. Возвращает true, если стройка завершена. */
export function buildStep(civ) {
  const p = civ.project;
  const ops = projectOps(civ);
  const dim = DIM();
  let changes = 0;
  for (let checks = 0; checks < 120 && p.step < ops.length; checks++) {
    const op = ops[p.step];
    const b = getB(dim, op.x, op.y, op.z);
    if (!b) return false;
    const id = b.typeId;
    if (op.k === "c") {
      if (b.isAir || isProtected(id)) {
        p.step++;
        continue;
      }
      try {
        b.setType("minecraft:air");
      } catch {}
      if (isLog(id)) civ.res.wood += 2;
      p.step++;
      if (++changes >= 4) break;
      continue;
    }
    if (op.k === "f") {
      if (b.isAir || b.isLiquid || isPassableId(id)) {
        try {
          b.setType("minecraft:dirt");
        } catch {}
        changes++;
      }
      p.step++;
      if (changes >= 4) break;
      continue;
    }
    if (id === op.id && !op.pair) {
      p.step++;
      continue;
    }
    const missing = canPay(civ, op.cost);
    if (missing) {
      civ.waiting = RES_NAME[missing] ?? missing;
      return false;
    }
    for (const k in op.cost) civ.res[k] -= op.cost[k];
    civ.waiting = "";
    placeOp(dim, op);
    p.step++;
    sound(dim, op.id.includes("planks") || op.id.includes("log") ? "dig.wood" : "dig.stone", op);
    break;
  }
  markDirty(civ);
  return p.step >= ops.length;
}

function builder(civ, ent, brain, tick, onComplete) {
  if (!civ.project) return lumberjack(civ, ent, brain, tick);
  const ops = projectOps(civ);
  const op = ops[Math.min(civ.project.step, ops.length - 1)];
  if (!op) return;
  setTarget(brain, { x: op.x + 0.5, y: op.y, z: op.z + 0.5 }, 4, true);
  if (!near(ent, brain.target, 5, true)) return;
  try {
    ent.teleport(ent.location, { facingLocation: { x: op.x + 0.5, y: op.y + 0.5, z: op.z + 0.5 } });
  } catch {}
  if (buildStep(civ)) onComplete(civ);
  brain.cd = tick + cdTicks(civ.waiting ? 40 : 10, brain);
}

// ---------- Диспетчер ----------
// Житель идёт к верстаку в центре поселения и делает себе инструмент из общих запасов.
// Остаток ресурсов на стройку пересчитываем не чаще раза в секунду.
function reserveOf(civ) {
  const c = civ._reserve;
  if (c && system.currentTick - c.at < 20) return c.need;
  const need = remainingCost(civ);
  // Пока нет центра, бережём стартовые запасы на него.
  if (!civ.buildings.length) {
    need.stone = Math.max(need.stone, 12);
    need.wood = Math.max(need.wood, 12);
  }
  civ._reserve = { at: system.currentTick, need };
  return need;
}

function crafting(civ, ent, brain, tick) {
  const reserve = reserveOf(civ);
  const kind = craftNeed(civ, ent, brain.role, reserve);
  if (!kind) {
    brain.crafting = false;
    return false;
  }
  if (civ.buildings.some((b) => b.t === "center")) {
    if (!brain.crafting) resetTask(brain);
    brain.crafting = true;
    setTarget(brain, civ.center, 2.5, true);
    if (!near(ent, civ.center, 3.2, true)) return true;
  }
  craft(civ, ent, kind, reserve);
  brain.crafting = false;
  updateTag(ent, brain, civ);
  brain.cd = tick + cdTicks(30, brain);
  return true;
}

export function think(civ, ent, brain, tick, hooks) {
  if (TOOL_FOR[brain.role] && crafting(civ, ent, brain, tick)) return;
  switch (brain.role) {
    case "lumberjack": return lumberjack(civ, ent, brain, tick);
    case "miner": return miner(civ, ent, brain, tick);
    case "farmer": return farmer(civ, ent, brain, tick);
    case "hunter": return hunter(civ, ent, brain, tick);
    case "builder": return builder(civ, ent, brain, tick, hooks.onComplete);
    case "soldier":
    case "golem": return hooks.soldier(civ, ent, brain, tick);
    case "settler": return hooks.settler(civ, ent, brain, tick);
    case "child": return wander(civ, brain, 6);
    default: return wander(civ, brain, 8);
  }
}
