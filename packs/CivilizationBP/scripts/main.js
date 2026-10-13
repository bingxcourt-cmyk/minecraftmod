import { world, system } from "@minecraft/server";
import { S, P, DIM, getProp, setProp, loaded, isNight, loadAll, saveAll, markDirty } from "./core.js";
import { brainOf, moveStep, think, resetTask, updateTag } from "./workers.js";
import {
  assignRoles, searchTick, quarryTick, hungerTick, growthTick, eraTick, colonyTick, colonyCheck,
  settlerThink, completeProject, collapseCheck, foundingScan,
} from "./society.js";
import { diplomacyTick, soldierThink, warBuffs, golemTick } from "./war.js";
import { statusTick, onInteractBlock, onScriptEvent } from "./ui.js";

const hooks = { onComplete: completeProject, soldier: soldierThink, settler: settlerThink };
const ALWAYS_AWAKE = new Set(["soldier", "golem", "settler"]);

/** Раз в секунду пересобирает списки жителей по цивилизациям. */
function regroup() {
  const dim = DIM();
  let villagers = [];
  let golems = [];
  try {
    villagers = dim.getEntities({ type: "minecraft:villager_v2" });
    golems = dim.getEntities({ type: "minecraft:iron_golem" });
  } catch {}
  S.members = new Map();
  S.golems = new Map();
  S.unclaimed = [];
  const seen = new Set();
  for (const v of villagers) {
    const cid = getProp(v, P.CIV);
    if (typeof cid === "string" && S.civs.has(cid)) {
      if (!S.members.has(cid)) S.members.set(cid, []);
      S.members.get(cid).push(v);
      brainOf(v, cid);
      seen.add(v.id);
    } else {
      if (cid !== undefined) {
        // Цивилизация исчезла — житель снова свободен.
        setProp(v, P.CIV, undefined);
        setProp(v, P.ROLE, undefined);
        try {
          v.nameTag = "";
        } catch {}
      }
      if (!v.nameTag) S.unclaimed.push(v);
    }
  }
  for (const g of golems) {
    const cid = getProp(g, P.CIV);
    if (typeof cid !== "string" || !S.civs.has(cid)) continue;
    if (!S.golems.has(cid)) S.golems.set(cid, []);
    S.golems.get(cid).push(g);
    brainOf(g, cid).role = "golem";
    seen.add(g.id);
  }
  for (const [id, b] of S.brains) {
    if (!seen.has(id)) {
      resetTask(b);
      S.brains.delete(id);
    }
  }
}

function everySecond() {
  S.clock++;
  regroup();
  const dim = DIM();
  const slow = Math.max(5, Math.round(30 / S.speed));
  for (const civ of [...S.civs.values()]) {
    try {
      if (collapseCheck(civ)) continue;
      if (!loaded(dim, civ.center)) continue;
      if (civ._reassign || S.clock % 5 === 0) {
        civ._reassign = false;
        assignRoles(civ);
      }
      searchTick(civ);
      quarryTick(civ);
      colonyCheck(civ);
      if (S.clock % 20 === 0) hungerTick(civ);
      if (S.clock % slow === 0) {
        growthTick(civ);
        colonyTick(civ);
        golemTick(civ);
      }
      if (S.clock % 10 === 0) {
        eraTick(civ);
        warBuffs(civ);
        for (const e of S.members.get(civ.id) ?? []) updateTag(e, brainOf(e, civ.id), civ);
      }
    } catch (e) {
      console.warn(`[Цивилизации] ${civ.name}: ${e}`);
    }
  }
  try {
    if (S.clock % 30 === 0) diplomacyTick();
    if (S.clock % 5 === 0) foundingScan();
    statusTick();
  } catch (e) {
    console.warn(`[Цивилизации] ${e}`);
  }
  if (S.clock % 5 === 0) saveAll();
}

// За один вызов «думают» не больше 40 жителей — остальные в следующий раз (бережём FPS).
const THINK_BUDGET = 40;
let thinkOffset = 0;

function thinkAll() {
  const tick = system.currentTick;
  const night = isNight();
  const all = [...S.brains.values()];
  let budget = THINK_BUDGET;
  const n = all.length;
  const start = thinkOffset % Math.max(1, n);
  for (let i = 0; i < n && budget > 0; i++) {
    const b = all[(start + i) % n];
    thinkOffset = start + i + 1;
    const e = b.ent;
    if (!e || !e.isValid) continue;
    const civ = S.civs.get(b.civId);
    if (!civ) continue;
    if (night && !ALWAYS_AWAKE.has(b.role)) {
      // Ночью мирные жители отдыхают.
      b.target = null;
      b.resting = true;
      continue;
    }
    b.resting = false;
    if (b.role === "golem" && !civ.war) {
      b.target = null;
      continue;
    }
    if (b.cd > tick) continue;
    budget--;
    try {
      think(civ, e, b, tick, hooks);
    } catch (err) {
      console.warn(`[Цивилизации] ${b.role}: ${err}`);
    }
  }
}

function moveAll() {
  for (const b of S.brains.values()) {
    if (b.target && !b.resting) moveStep(b);
  }
}

function onDeath(ev) {
  const dead = ev.deadEntity;
  let id;
  try {
    id = dead.id;
  } catch {
    return;
  }
  const brain = S.brains.get(id);
  if (!brain) return;
  S.brains.delete(id);
  resetTask(brain);
  const civ = S.civs.get(brain.civId);
  if (!civ) return;
  civ.deaths++;
  markDirty(civ);
  const killer = ev.damageSource.damagingEntity;
  let kb;
  try {
    kb = killer ? S.brains.get(killer.id) : undefined;
  } catch {}
  const name = brain.role === "golem" ? "Железный страж" : brain.name;
  if (kb && civ.war && kb.civId === civ.war.enemy) {
    civ.warLosses++;
    const enemy = S.civs.get(kb.civId);
    if (enemy) {
      enemy.kills++;
      markDirty(enemy);
    }
    world.sendMessage(`§c[Война] ${civ.color}${name}§c (${civ.name}) пал в бою.`);
  } else if (ev.damageSource.cause === "starve") {
    world.sendMessage(`§4[${civ.name}] ${name} умер от голода.`);
  }
}

let started = false;
function start() {
  if (started) return;
  started = true;
  loadAll();
  system.runInterval(moveAll, 2);
  system.runInterval(thinkAll, 10);
  system.runInterval(everySecond, 20);
  world.afterEvents.entityDie.subscribe(onDeath, { entityTypes: ["minecraft:villager_v2", "minecraft:iron_golem"] });
  world.afterEvents.playerInteractWithBlock.subscribe(onInteractBlock);
  system.afterEvents.scriptEventReceive.subscribe(onScriptEvent, { namespaces: ["civ"] });
  console.warn("[Цивилизации] Мод загружен");
}

world.afterEvents.worldLoad.subscribe(() => start());
// На случай перезагрузки скриптов (/reload), когда мир уже загружен.
system.runTimeout(() => {
  try {
    start();
  } catch {
    started = false;
  }
}, 60);
