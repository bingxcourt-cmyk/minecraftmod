import { system, world, EntityDamageCause } from "@minecraft/server";
import {
  S, P, DIM, getB, getProp, setProp, dXZ, rnd, pick, markDirty, announce, sound, particle, loaded,
  civName, civColor, personName, deleteCiv, playersNear, isNight,
} from "./core.js";
import { groundAt, standY, waterNear, findDrySpot } from "./blocks.js";
import { TYPES, getBP, dims, doorFront, toWorld } from "./blueprints.js";
import { brainOf, setRole, updateTag, resetTask, remainingCost, fastBuild } from "./workers.js";
import { findSafeSpot, safeTeleport } from "./nav.js";

export const ERAS = [
  { name: "Племя", queue: ["center", "farm_small", "hut", "hut", "well"], next: { pop: 4, stone: 10 } },
  { name: "Деревня", queue: ["house", "smithy", "farm", "house", "barn", "watchtower"], next: { pop: 7, iron: 6 } },
  { name: "Город", queue: ["townhall", "stonehouse", "barracks", "farm", "stonehouse", "watchtower"], next: { pop: 12, iron: 15 } },
  { name: "Королевство", queue: ["castle", "stonehouse", "watchtower", "farm", "barracks", "stonehouse"], next: null },
];
const HOUSE_BY_ERA = ["hut", "house", "stonehouse", "stonehouse"];
const FARM_BY_ERA = ["farm_small", "farm", "farm", "farm"];

// Постройки, уже оплаченные в фоновой симуляции, считаются построенными.
export const allBuilt = (civ) => [...civ.buildings, ...(civ.offQueue ?? []), ...(civ.project?.paid ? [civ.project] : [])];
export const has = (civ, t) => allBuilt(civ).some((b) => b.t === t);
export const count = (civ, pred) => allBuilt(civ).filter(pred).length;

/** Население: вблизи игрока — настоящие жители, вдали — по переписи с учётом рождений и смертей. */
export function popOf(civ) {
  if (civ._active === false && civ.census) return Math.max(0, civ.census.pop + (civ.off?.pop ?? 0));
  return (S.members.get(civ.id) ?? []).length;
}

export function housingOf(civ) {
  let n = 3;
  for (const b of allBuilt(civ)) n += getBP(b.t).beds;
  return n;
}

// ---------- Основание и вступление ----------
export function newCiv(center, parent = null) {
  const civ = {
    id: Date.now().toString(36) + rnd(100, 999),
    name: civName(),
    color: civColor(),
    center: { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) },
    era: 0,
    qi: 0,
    res: { wood: 30, stone: 12, food: 25, iron: 0 },
    buildings: [],
    project: null,
    quarry: null,
    tension: {},
    peace: {},
    war: null,
    colony: null,
    colonyAt: S.clock + 900,
    founded: S.clock,
    parent,
    born: 0,
    deaths: 0,
    kills: 0,
    warLosses: 0,
    waiting: "",
    starving: false,
  };
  S.civs.set(civ.id, civ);
  markDirty(civ);
  return civ;
}

export function join(civ, ent) {
  setProp(ent, P.CIV, civ.id);
  if (!getProp(ent, P.NAME)) setProp(ent, P.NAME, personName());
  if (getProp(ent, P.HUNGER) === undefined) setProp(ent, P.HUNGER, 20);
  const isBaby = !!ent.getComponent("minecraft:is_baby");
  const brain = brainOf(ent, civ.id);
  brain.name = String(getProp(ent, P.NAME));
  resetTask(brain);
  brain.role = "";
  setRole(ent, brain, isBaby ? "child" : ent.typeId === "minecraft:iron_golem" ? "golem" : "lumberjack", civ);
  const list = S.members.get(civ.id) ?? [];
  if (ent.typeId !== "minecraft:iron_golem" && !list.includes(ent)) list.push(ent);
  S.members.set(civ.id, list);
  civ._reassign = true;
}

/** Ищет жителей без цивилизации: присоединяет к ближайшей или основывает новую. */
export function foundingScan() {
  const free = S.unclaimed.filter((v) => v.isValid && !v.getComponent("minecraft:is_baby"));
  const used = new Set();
  for (const v of free) {
    if (used.has(v.id)) continue;
    let best;
    let bd = 80;
    for (const civ of S.civs.values()) {
      const d = dXZ(civ.center, v.location);
      if (d < bd) {
        bd = d;
        best = civ;
      }
    }
    if (best) {
      join(best, v);
      used.add(v.id);
      continue;
    }
    const group = free.filter((o) => !used.has(o.id) && dXZ(o.location, v.location) < 24).slice(0, 8);
    if (group.length < 2) continue;
    const c = { x: 0, y: 0, z: 0 };
    for (const o of group) {
      c.x += o.location.x / group.length;
      c.y += o.location.y / group.length;
      c.z += o.location.z / group.length;
    }
    const civ = newCiv(c);
    for (const o of group) {
      join(civ, o);
      used.add(o.id);
    }
    announce(civ, `§a[Цивилизации] §fЖители основали новое племя ${civ.color}§l${civ.name}§r§f!`, 200);
    for (const pl of playersNear(civ.center, 96)) {
      try {
        pl.onScreenDisplay.setTitle(`${civ.color}${civ.name}`, { subtitle: "§7Основано новое племя", fadeInDuration: 10, stayDuration: 50, fadeOutDuration: 10 });
      } catch {}
    }
  }
}

// ---------- Распределение профессий ----------
export function assignRoles(civ) {
  const all = S.members.get(civ.id) ?? [];
  const adults = [];
  for (const e of all) {
    const b = brainOf(e, civ.id);
    if (b.role === "child") {
      if (!e.getComponent("minecraft:is_baby")) setRole(e, b, "lumberjack", civ);
      else continue;
    }
    if (b.role === "settler" && civ.colony) continue;
    adults.push(e);
  }
  const n = adults.length;
  const want = { soldier: 0, guard: 0, builder: 0, farmer: 0, hunter: 0, miner: 0, lumberjack: 0 };
  let left = n;
  const give = (role, k) => {
    const g = Math.max(0, Math.min(k, left));
    want[role] += g;
    left -= g;
  };
  const farms = count(civ, (b) => b.t.startsWith("farm"));
  const foodLow = civ.res.food < n * 3 + 5;
  if (civ.war && n >= 2) give("soldier", Math.max(1, Math.floor(n * 0.45)));
  // Стражники с первой эпохи: 1 на 8 жителей, а при нападении мобов — ополчение до 30% жителей.
  const threats = (civ._threats ?? []).length;
  if (n >= 4) give("guard", Math.max(1, Math.floor(n / 8)) + (threats ? Math.min(threats * 2, Math.floor(n * 0.3)) : 0));
  const building = !!(civ.project || S.search.get(civ.id));
  if (building) give("builder", 1);
  // Стройка стоит без ресурса — первым делом его добывают.
  if (civ.waiting === "камень") give("miner", 1);
  if (civ.waiting === "дерево") give("lumberjack", 1);
  if (farms > 0) give("farmer", 1);
  if (farms === 0 || foodLow) give("hunter", 1);
  // Шахтёры нужны, пока не хватает камня или железа; остальные рубят лес.
  const need = remainingCost(civ);
  const nextEra = ERAS[civ.era].next;
  const ironGoal = (nextEra?.iron ?? 0) + (civ.era >= 2 ? 20 : 5);
  const stoneShort = need.stone - civ.res.stone;
  const wantMiner = civ.res.stone < 60 || stoneShort > 0 || civ.res.iron < ironGoal;
  give("lumberjack", 1);
  if (n >= 3 && wantMiner) give("miner", 1);
  if (building && n >= 6) give("builder", 1);
  if (farms > 0) give("farmer", Math.min(farms * 2, Math.round(n * 0.2) + (foodLow ? 1 : 0)) - 1);
  if (n >= 8 && stoneShort > 60) give("miner", 1);
  if (civ.era >= 2 && n >= 12 && wantMiner) give("miner", 1);
  if (building && n >= 12) give("builder", 1);
  // Дерева с избытком — лишние руки идут в шахту и на поля.
  if (civ.res.wood > 250 + need.wood) {
    give("miner", Math.min(3, Math.ceil(left / 2)));
    if (farms > 0) give("farmer", Math.min(farms * 3 - want.farmer, left));
  }
  give("lumberjack", left);

  const have = {};
  const pool = [];
  for (const e of adults) {
    const b = brainOf(e, civ.id);
    if ((want[b.role] ?? 0) > (have[b.role] ?? 0)) have[b.role] = (have[b.role] ?? 0) + 1;
    else pool.push(e);
  }
  for (const role in want) {
    while ((have[role] ?? 0) < want[role] && pool.length) {
      const e = pool.pop();
      setRole(e, brainOf(e, civ.id), role, civ);
      have[role] = (have[role] ?? 0) + 1;
    }
  }
  for (const e of pool) setRole(e, brainOf(e, civ.id), "lumberjack", civ);
}

// ---------- Голод ----------
export function hungerTick(civ) {
  let starving = false;
  // Ночью спящие жители тратят меньше сил.
  const rate = isNight() && !S.nightWork ? 0.5 : 1;
  for (const e of S.members.get(civ.id) ?? []) {
    if (!e.isValid) continue;
    const brain = brainOf(e, civ.id);
    let h = Number(getProp(e, P.HUNGER) ?? 20);
    h -= (brain.role === "soldier" ? 1.5 : 1) * rate;
    if (h <= 12 && civ.res.food >= 1) {
      civ.res.food -= 1;
      h = Math.min(20, h + 8);
      markDirty(civ);
    }
    if (h <= 0) {
      h = 0;
      try {
        e.applyDamage(2, { cause: EntityDamageCause.starve });
      } catch {}
      particle(DIM(), "minecraft:villager_angry", { x: e.location.x, y: e.location.y + 2, z: e.location.z });
    }
    if (h <= 3) starving = true;
    brain.hungry = h <= 5;
    setProp(e, P.HUNGER, h);
    updateTag(e, brain, civ);
  }
  if (starving && !civ.starving) announce(civ, `§c[${civ.name}] Голод! Жителям не хватает еды.`, 120);
  civ.starving = starving;
}

// ---------- Рост населения ----------
export const MAX_POP = 50;
export function growthTick(civ) {
  const pop = popOf(civ);
  if (civ.starving || pop >= MAX_POP || pop < 1) return;
  if (pop >= housingOf(civ) || civ.res.food < 10 + pop) return;
  const dim = DIM();
  const homes = civ.buildings.filter((b) => getBP(b.t).beds > 0);
  const door = homes.length ? doorFront(pick(homes)) : civ.center;
  // Новорождённый появляется только на свободном месте, а не внутри стены.
  const spot = findSafeSpot(dim, door.x + 0.5, (standY(dim, door.x + 0.5, door.z + 0.5) ?? door.y + 1), door.z + 0.5, 4);
  if (!spot) return;
  const y = spot.y;
  let v;
  try {
    v = dim.spawnEntity("minecraft:villager_v2", spot);
  } catch {
    return;
  }
  civ.res.food -= 8;
  civ.born++;
  join(civ, v);
  particle(dim, "minecraft:heart_particle", { x: spot.x, y: y + 1.5, z: spot.z });
  for (const pl of playersNear(civ.center, 64)) pl.sendMessage(`§d[${civ.name}] Родился новый житель: ${getProp(v, P.NAME)}`);
}

// ---------- Эпохи ----------
/** Что осталось сделать до следующей эпохи (для подсказки игроку). */
/**
 * Каких построек эпохи (текущей и прошлых) не хватает — по тому, что реально стоит.
 * Разрушенное или пропущенное снова попадает в список и будет достроено.
 */
export function missingQueue(civ) {
  const have = {};
  for (const b of allBuilt(civ)) have[b.t] = (have[b.t] ?? 0) + 1;
  const seen = {};
  const out = [];
  for (let e = 0; e <= civ.era; e++) {
    for (const t of ERAS[e].queue) {
      seen[t] = (seen[t] ?? 0) + 1;
      if ((have[t] ?? 0) < seen[t]) out.push(t);
    }
  }
  return out;
}

export function eraNeed(civ) {
  const era = ERAS[civ.era];
  if (!era.next) return "";
  const left = missingQueue(civ).map((t) => TYPES[t].name);
  const need = [];
  if (left.length) need.push(`построить: ${left.join(", ")}`);
  const n = era.next;
  if (popOf(civ) < (n.pop ?? 0)) need.push(`жителей ${popOf(civ)}/${n.pop}`);
  if (civ.res.stone < (n.stone ?? 0)) need.push(`камня ${civ.res.stone}/${n.stone}`);
  if (civ.res.iron < (n.iron ?? 0)) need.push(`железа ${civ.res.iron}/${n.iron}`);
  return `До эпохи «${ERAS[civ.era + 1].name}»: ${need.length ? need.join("; ") : "вот-вот"}`;
}

export function eraTick(civ) {
  const era = ERAS[civ.era];
  if (!era.next || missingQueue(civ).length) return;
  const n = era.next;
  if (popOf(civ) < (n.pop ?? 0) || civ.res.stone < (n.stone ?? 0) || civ.res.iron < (n.iron ?? 0)) return;
  civ.era++;
  civ.qi = 0;
  markDirty(civ);
  const name = ERAS[civ.era].name;
  announce(civ, `§6[${civ.name}] Наступила новая эпоха: §l${name}§r§6!`, 250);
  for (const pl of playersNear(civ.center, 96)) {
    try {
      pl.onScreenDisplay.setTitle(`§6${name}`, { subtitle: `${civ.color}${civ.name}`, fadeInDuration: 10, stayDuration: 60, fadeOutDuration: 10 });
    } catch {}
  }
  sound(DIM(), "random.levelup", civ.center, 1);
}

// ---------- Выбор и размещение построек ----------
export const noteBuilt = (civ, t) => (civ.lastHouse = HOUSE_BY_ERA.includes(t));

export function chooseNext(civ) {
  if ((civ.blockedUntil ?? 0) > S.clock) return null;
  const pop = popOf(civ);
  // Постройки эпохи, для которых сейчас не нашлось места, пробуем снова через 2 минуты.
  const miss = missingQueue(civ).filter((t) => (civ.failed?.[t] ?? 0) <= S.clock);
  if (miss[0] === "center" || !has(civ, "center")) return { t: "center", fromQueue: true };
  const farms = count(civ, (b) => b.t.startsWith("farm"));
  if (farms > 0 && farms * 6 < pop && (civ.starving || civ.res.food < pop * 2)) return { t: FARM_BY_ERA[civ.era], fromQueue: false };
  // Дома и постройки эпохи чередуются, иначе рождения съедают всю стройку.
  if (pop >= housingOf(civ) && pop < MAX_POP && !(civ.lastHouse && miss.length)) return { t: HOUSE_BY_ERA[civ.era], fromQueue: false };
  if (miss.length) return { t: miss[0], fromQueue: true };
  if (farms * 5 < pop) return { t: FARM_BY_ERA[civ.era], fromQueue: false };
  return null;
}

function rects(skipCiv) {
  const out = [];
  for (const civ of S.civs.values()) {
    for (const b of civ.buildings) out.push(b);
    if (civ.project) {
      const { W, D } = dims(civ.project.t, civ.project.r);
      out.push({ x: civ.project.x, z: civ.project.z, w: W, d: D });
    }
    if (civ.quarry) out.push({ x: civ.quarry.x, z: civ.quarry.z, w: 5, d: 5 });
    if (civ.mine) {
      // Вход и первые ступеньки — у поверхности, над ними не строим.
      const m = civ.mine;
      const dx = [1, 0, -1, 0][m.d];
      const dz = [0, 1, 0, -1][m.d];
      const x2 = m.x + dx * 6;
      const z2 = m.z + dz * 6;
      out.push({ x: Math.min(m.x, x2) - 1, z: Math.min(m.z, z2) - 1, w: Math.abs(x2 - m.x) + 3, d: Math.abs(z2 - m.z) + 3 });
    }
    if (civ !== skipCiv && civ.buildings.length === 0) out.push({ x: civ.center.x - 6, z: civ.center.z - 6, w: 12, d: 12 });
  }
  return out;
}

function genCands(civ, type, rMin) {
  const out = [];
  const off = (civ.id.charCodeAt(0) % 10) / 3;
  for (let rad = rMin; rad <= 64; rad += 3) {
    const n = rad === 0 ? 1 : Math.max(6, Math.floor((2 * Math.PI * rad) / 5));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + off + rad * 0.7;
      const px = civ.center.x + Math.cos(a) * rad;
      const pz = civ.center.z + Math.sin(a) * rad;
      const vx = civ.center.x - px;
      const vz = civ.center.z - pz;
      let r = 0;
      if (rad > 0) r = Math.abs(vx) > Math.abs(vz) ? (vx > 0 ? 1 : 3) : vz > 0 ? 2 : 0;
      const { W, D } = dims(type, r);
      out.push({ x: Math.round(px - W / 2), z: Math.round(pz - D / 2), r, W, D });
    }
  }
  return out;
}

function validate(civ, c, gap = 2) {
  for (const b of rects(civ)) {
    if (c.x < b.x + b.w + gap && b.x < c.x + c.W + gap && c.z < b.z + b.d + gap && b.z < c.z + c.D + gap) return undefined;
  }
  const dim = DIM();
  if (!loaded(dim, c) || !loaded(dim, { x: c.x + c.W, z: c.z + c.D })) return undefined;
  let min = 1e9;
  let max = -1e9;
  let sum = 0;
  for (let x = 0; x < c.W; x++) for (let z = 0; z < c.D; z++) {
    const g = groundAt(dim, c.x + x, c.z + z);
    if (!g || g.liquid || g.unnatural) return undefined;
    min = Math.min(min, g.y);
    max = Math.max(max, g.y);
    sum += g.y;
  }
  if (max - min > (c.W * c.D > 120 ? 4 : 3)) return undefined;
  // Рядом с водой не строим: выровняют площадку ниже уровня воды — и всё затопит.
  for (let x = -2; x <= c.W + 1; x++) for (let z = -2; z <= c.D + 1; z++) {
    if (x >= 0 && x < c.W && z >= 0 && z < c.D) continue;
    const g = groundAt(dim, c.x + x, c.z + z);
    if (g?.liquid) return undefined;
  }
  return { base: Math.round(sum / (c.W * c.D)), max };
}

export function searchTick(civ, paidOnly = false) {
  if (civ.project) return;
  if (paidOnly && !civ.offQueue?.length && !S.search.get(civ.id)) return;
  let s = S.search.get(civ.id);
  // Сначала возводим то, что уже оплачено в фоновой симуляции.
  const q = civ.offQueue?.[0];
  if (q && !s) {
    if (q.x !== undefined) {
      civ.offQueue.shift();
      civ.project = { t: q.t, x: q.x, y: q.y, z: q.z, r: q.r, step: 0, fromQueue: false, paid: true };
      markDirty(civ);
      return;
    }
    s = { t: q.t, fromQueue: false, paid: true, cands: genCands(civ, q.t, q.t === "center" ? 0 : 7), i: 0 };
    S.search.set(civ.id, s);
    civ._reassign = true;
  }
  if (!s) {
    const next = chooseNext(civ);
    if (!next) return;
    s = { t: next.t, fromQueue: next.fromQueue, cands: genCands(civ, next.t, next.t === "center" ? 0 : 7), i: 0 };
    S.search.set(civ.id, s);
    civ._reassign = true;
  }
  for (let k = 0; k < 4 && s.i < s.cands.length; k++) {
    const c = s.cands[s.i++];
    const v = validate(civ, c);
    if (!v) continue;
    civ.project = { t: s.t, x: c.x, y: v.base, z: c.z, r: c.r, step: 0, fromQueue: s.fromQueue, paid: !!s.paid };
    if (!s.paid) noteBuilt(civ, s.t);
    if (s.paid) civ.offQueue.shift();
    S.search.delete(civ.id);
    markDirty(civ);
    for (const pl of playersNear(civ.center, 96)) pl.sendMessage(`§7[${civ.name}] Начали строить: ${TYPES[s.t].name}`);
    return;
  }
  if (s.i >= s.cands.length) {
    S.search.delete(civ.id);
    if (s.paid) civ.offQueue.shift();
    // Места не нашлось — не забываем постройку, а пробуем позже (за это время могут вырубить лес и т.п.).
    civ.failed = civ.failed ?? {};
    civ.failed[s.t] = S.clock + 120;
    if (!s.fromQueue) civ.blockedUntil = S.clock + 90;
    markDirty(civ);
  }
}

// Место под вход в шахту. Старый открытый карьер (из прошлой версии) оставляем как есть.
export function mineTick(civ) {
  if (civ.quarry) {
    const q = civ.quarry;
    civ.buildings.push({ t: "quarry", x: q.x, y: q.top, z: q.z, r: 0, w: 5, d: 5 });
    civ.quarry = null;
    markDirty(civ);
  }
  if (civ.mine) return;
  if (!(S.members.get(civ.id) ?? []).some((e) => brainOf(e, civ.id).role === "miner")) return;
  let s = S.qsearch.get(civ.id);
  if (!s) {
    s = { cands: genCands(civ, "quarry", 12), i: 0 };
    S.qsearch.set(civ.id, s);
  }
  for (let k = 0; k < 3 && s.i < s.cands.length; k++) {
    const c = s.cands[s.i++];
    const v = validate(civ, c, 3);
    if (!v) continue;
    const x = c.x + 2;
    const z = c.z + 2;
    const g = groundAt(DIM(), x, z);
    if (!g || g.liquid) continue;
    // Лестница начинается в сторону от центра поселения.
    const vx = x - civ.center.x;
    const vz = z - civ.center.z;
    const d = Math.abs(vx) > Math.abs(vz) ? (vx > 0 ? 0 : 2) : vz > 0 ? 1 : 3;
    // Первая шахта — до железа (Y≈16), каждая вторая — глубокая, за алмазами.
    const deep = (civ.minesDone ?? 0) % 2 === 1;
    const target = deep ? -54 : Math.min(16, g.y - 12);
    civ.mine = { x, y: g.y, z, d, target, idx: 0, veins: [], wet: 0 };
    S.qsearch.delete(civ.id);
    markDirty(civ);
    return;
  }
  if (s.i >= s.cands.length) S.qsearch.delete(civ.id);
}

export function completeProject(civ) {
  const p = civ.project;
  if (!p) return;
  const { W, D } = dims(p.t, p.r);
  const b = { t: p.t, x: p.x, y: p.y, z: p.z, r: p.r, w: W, d: D };
  civ.buildings.push(b);
  if (p.fromQueue) civ.qi++;
  if (p.t === "center") {
    const bp = getBP("center");
    const [x, z] = toWorld(p, p.r, bp.w, bp.d, 2, 2);
    civ.center = { x, y: p.y + 1, z };
  }
  civ.project = null;
  civ.waiting = "";
  S.opsCache.delete(civ.id);
  S.cellsCache.delete(civ.id);
  civ._reassign = true;
  markDirty(civ);
  const dim = DIM();
  const mid = { x: p.x + W / 2, y: p.y + 2, z: p.z + D / 2 };
  sound(dim, "random.levelup", mid, 0.8);
  for (let i = 0; i < 6; i++) particle(dim, "minecraft:villager_happy", { x: mid.x + rnd(-2, 2), y: mid.y + rnd(0, 2), z: mid.z + rnd(-2, 2) });
  announce(civ, `§e[${civ.name}] Построено: §l${TYPES[p.t].name}`, 160);
  if (p.t !== "center") layRoad(civ.center, doorFront(b));
}

/** Тропинка от центра до входа в постройку. */
function layRoad(from, to) {
  const dim = DIM();
  function* job() {
    const n = Math.ceil(Math.max(Math.abs(to.x - from.x), Math.abs(to.z - from.z)));
    for (let i = 0; i <= n; i++) {
      const x = Math.round(from.x + ((to.x - from.x) * i) / Math.max(1, n));
      const z = Math.round(from.z + ((to.z - from.z) * i) / Math.max(1, n));
      for (const [ox, oz] of [[0, 0], [1, 0]]) {
        const g = groundAt(dim, x + ox, z + oz);
        if (!g || g.liquid) continue;
        const b = getB(dim, x + ox, g.y, z + oz);
        const above = getB(dim, x + ox, g.y + 1, z + oz);
        if (!b || !above) continue;
        if (["minecraft:grass_block", "minecraft:dirt", "minecraft:coarse_dirt", "minecraft:podzol", "minecraft:mycelium"].includes(b.typeId)) {
          try {
            if (!above.isAir && above.typeId !== "minecraft:grass_path") above.setType("minecraft:air");
            b.setType("minecraft:grass_path");
          } catch {}
        }
      }
      yield;
    }
  }
  try {
    system.runJob(job());
  } catch {}
}

// ---------- Колонии ----------
// Больше цивилизаций не основывается — бережём производительность телефона.
export const MAX_CIVS = 20;
// Одно поселение отправляет не больше 3 колоний, не чаще раза в 25 минут, при 15+ жителях.
export const MAX_COLONIES = 3;

export function colonyTick(civ) {
  if (civ.colony) return;
  const members = S.members.get(civ.id) ?? [];
  if (civ.war || civ.era < 1 || members.length < 15 || civ.res.food < 30 || S.clock < civ.colonyAt) return;
  if ((civ.coloniesFounded ?? 0) >= MAX_COLONIES) return;
  const dim = DIM();
  let dest;
  for (let i = 0; i < 12 && !dest; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = rnd(70, 100);
    const p = { x: Math.floor(civ.center.x + Math.cos(a) * d), z: Math.floor(civ.center.z + Math.sin(a) * d) };
    if (!loaded(dim, p)) continue;
    if (S.civs.size >= MAX_CIVS || [...S.civs.values()].some((c) => dXZ(c.center, p) < 60)) continue;
    const g = groundAt(dim, p.x, p.z);
    if (!g || g.liquid || waterNear(dim, p.x, p.z, 8)) continue;
    dest = { x: p.x, y: g.y + 1, z: p.z };
  }
  civ.colonyAt = S.clock + Math.round(1500 / S.speed);
  markDirty(civ);
  if (!dest) return;
  const settlers = members.filter((e) => ["lumberjack", "hunter", "miner", "farmer"].includes(brainOf(e, civ.id).role)).slice(0, 4);
  if (settlers.length < 4) return;
  civ.colony = { ...dest, ids: settlers.map((e) => e.id), since: S.clock };
  civ.coloniesFounded = (civ.coloniesFounded ?? 0) + 1;
  for (const e of settlers) setRole(e, brainOf(e, civ.id), "settler", civ);
  announce(civ, `§b[${civ.name}] Переселенцы отправились основать новую колонию!`, 160);
}

export function settlerThink(civ, ent, brain) {
  const c = civ.colony;
  if (!c) return setRole(ent, brain, "lumberjack", civ);
  brain.target = { x: c.x + rnd(-2, 2), y: c.y, z: c.z + rnd(-2, 2) };
  brain.reach = 3;
  brain.ignoreY = true;
}

export function colonyCheck(civ) {
  const c = civ.colony;
  if (!c) return;
  const settlers = (S.members.get(civ.id) ?? []).filter((e) => c.ids.includes(e.id) && e.isValid);
  const elapsed = S.clock - c.since;
  const arrived = settlers.length > 0 && settlers.every((e) => dXZ(e.location, c) < 8);
  if (settlers.length === 0 || elapsed > 240) {
    civ.colony = null;
    civ._reassign = true;
    for (const e of settlers) setRole(e, brainOf(e, civ.id), "lumberjack", civ);
    markDirty(civ);
    return;
  }
  if (!arrived && elapsed < 150) return;
  if (!loaded(DIM(), c)) return;
  const colony = newCiv(c, civ.id);
  const give = { wood: Math.min(60, civ.res.wood), stone: Math.min(25, civ.res.stone), food: Math.min(40, civ.res.food), saplings: Math.min(4, civ.res.saplings ?? 0) };
  for (const k in give) civ.res[k] -= give[k];
  colony.res = { ...give, iron: 0 };
  const coins = Math.min(40, civ.coins ?? 0);
  civ.coins = (civ.coins ?? 0) - coins;
  colony.coins = coins;
  civ.colony = null;
  civ._reassign = true;
  for (const e of settlers) {
    try {
      if (dXZ(e.location, c) > 10) safeTeleport(e, c, 4);
    } catch {}
    const list = S.members.get(civ.id) ?? [];
    const i = list.indexOf(e);
    if (i >= 0) list.splice(i, 1);
    join(colony, e);
  }
  civ.tension[colony.id] = 35;
  colony.tension[civ.id] = 35;
  markDirty(civ);
  announce(colony, `§b[Цивилизации] Жители ${civ.name} основали колонию ${colony.color}§l${colony.name}§r§b!`, 250);
}

// ---------- Мгновенная стройка ----------
/**
 * Постройки, оплаченные в фоне, появляются целиком, как только их чанки загружены
 * (в пределах прорисовки, даже если поселение далеко).
 */
export function streamBuild(civ) {
  if (!civ.project && civ.offQueue?.length) searchTick(civ, true);
  const p = civ.project;
  if (!p?.paid || civ._fastJob) return;
  civ._fastJob = true;
  function* job() {
    for (;;) {
      if (civ.project !== p || !S.civs.has(civ.id)) break;
      const r = fastBuild(civ, 120);
      if (r === "done") {
        completeProject(civ);
        break;
      }
      if (r === "wait") break;
      yield;
    }
    civ._fastJob = false;
  }
  system.runJob(job());
}

// ---------- Затопление ----------
/** Раз в 30 секунд: если центр поселения залило водой — переносим поселение на сушу. */
export function floodCheck(civ) {
  const dim = DIM();
  const g = groundAt(dim, Math.floor(civ.center.x), Math.floor(civ.center.z));
  if (!g || !g.liquid) return;
  const dry = findDrySpot(dim, civ.center.x, civ.center.z, 64);
  if (!dry) return;
  // Затопленные постройки больше не считаются: их отстроят заново на суше.
  const before = civ.buildings.length;
  civ.buildings = civ.buildings.filter((b) => {
    const c = groundAt(dim, Math.floor(b.x + b.w / 2), Math.floor(b.z + b.d / 2));
    return !c?.liquid;
  });
  if (civ.project) {
    const { W, D } = dims(civ.project.t, civ.project.r);
    const c = groundAt(dim, Math.floor(civ.project.x + W / 2), Math.floor(civ.project.z + D / 2));
    if (c?.liquid) civ.project = null;
  }
  civ.center = dry;
  S.search.delete(civ.id);
  S.opsCache.delete(civ.id);
  S.cellsCache.delete(civ.id);
  civ._reassign = true;
  markDirty(civ);
  announce(civ, `§9[${civ.name}] Поселение затопило! Жители переносят центр на сушу (${dry.x}, ${dry.z}), потеряно построек: ${before - civ.buildings.length}.`, 200);
}

// ---------- Гибель цивилизации ----------
export function collapseCheck(civ) {
  const dim = DIM();
  // Вдали от игрока цивилизация гибнет, когда по фоновой симуляции не осталось жителей.
  const farDead = civ._active === false && civ.census && popOf(civ) <= 0 && !civ.colony;
  const active = loaded(dim, civ.center) && playersNear(civ.center, S.activeChunks * 16).length > 0;
  if (!farDead && (!active || popOf(civ) > 0 || civ.colony)) {
    S.emptyTicks.delete(civ.id);
    return false;
  }
  const n = (S.emptyTicks.get(civ.id) ?? 0) + 1;
  S.emptyTicks.set(civ.id, n);
  // Ждём 40 секунд: после загрузки мира жители появляются не сразу.
  if (!farDead && n < 40) return false;
  S.emptyTicks.delete(civ.id);
  const enemy = civ.war ? S.civs.get(civ.war.enemy) : undefined;
  if (enemy) {
    for (const k in civ.res) enemy.res[k] = (enemy.res[k] ?? 0) + Math.floor(civ.res[k] / 2);
    enemy.war = null;
    enemy._reassign = true;
    markDirty(enemy);
    world.sendMessage(`§4[Цивилизации] ${enemy.color}${enemy.name}§4 уничтожили ${civ.color}${civ.name}§4 и забрали их богатства!`);
  } else {
    world.sendMessage(`§4[Цивилизации] Цивилизация ${civ.color}${civ.name}§4 пала.`);
  }
  deleteCiv(civ);
  return true;
}
