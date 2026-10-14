import { world, system } from "@minecraft/server";
import { S, P, DIM, getProp, setProp, isNight, loaded, loadAll, saveAll, markDirty } from "./core.js";
import { brainOf, moveStep, think, resetTask, updateTag, resetPathBudget } from "./workers.js";
import {
  assignRoles, searchTick, mineTick, popOf, hungerTick, growthTick, eraTick, colonyTick, colonyCheck,
  settlerThink, completeProject, collapseCheck, foundingScan, floodCheck, streamBuild,
} from "./society.js";
import { diplomacyTick, soldierThink, warBuffs, golemTick, declareWar } from "./war.js";
import { statusTick, onInteractBlock, onScriptEvent, onItemUse } from "./ui.js";
import { loadRoads, planRoads, layRoads } from "./links.js";
import { loadMarket, marketTick } from "./market.js";
import { catchUp, markRealTime, showReport } from "./offline.js";
import { rescueIfStuck } from "./nav.js";
import { isActive, offscreenTick, materialize, takeCensus } from "./offscreen.js";
import { whTick } from "./wh.js";
import { heldTick, heldCleanup, dropHeld, swinging } from "./held.js";
import { scanThreats, armorTick } from "./defense.js";
import { raidTick, raidCheck, raiderThink, raidPropOf } from "./bandits.js";
import { planWall, layWalls } from "./walls.js";
import { demoTick } from "./territory.js";
import { upkeepTick, repayDebt, UPKEEP } from "./upkeep.js";
import { taxTick } from "./market.js";
import { lifeTick, lifeFx } from "./life.js";
import { scienceTick, husbandryTick } from "./progress.js";
import { siegeTick } from "./siege.js";
import { pactTick } from "./pacts.js";
import { caravanTick, loadCaravans, cleanupCaravanLlamas, setPolyPoint } from "./caravans.js";
import { questTick } from "./quests.js";
import { virtualColony } from "./offscreen.js";
import { waterNear } from "./blocks.js";
import { polyPoint } from "./links.js";
import { smeltTick } from "./industry.js";
import { creditTick, loadLoans, saveLoans } from "./credit.js";
import { lightsTick } from "./lights.js";
import { note, warLog, loadJournal, saveJournal } from "./journal.js";

const hooks = { onComplete: completeProject, soldier: soldierThink, settler: settlerThink, raider: raiderThink };
const ALWAYS_AWAKE = new Set(["soldier", "golem", "settler", "guard", "raider"]);

/** Раз в секунду пересобирает списки жителей по цивилизациям. */
function regroup() {
  const dim = DIM();
  let villagers = [];
  let golems = [];
  try {
    villagers = dim.getEntities({ type: "minecraft:villager_v2" });
    golems = dim.getEntities({ type: "minecraft:iron_golem" });
  } catch {}
  let raiders = [];
  try {
    raiders = [...dim.getEntities({ type: "minecraft:pillager" }), ...dim.getEntities({ type: "minecraft:vindicator" })];
  } catch {}
  S.members = new Map();
  S.golems = new Map();
  S.unclaimed = [];
  const seen = new Set();
  for (const v of villagers) {
    const cid = getProp(v, P.CIV);
    // Переселенец, который уже «ушёл» в колонию вдали (его учли там), — в старом поселении не появляется.
    if (typeof cid === "string" && S.civs.get(cid)?.goneIds?.includes(v.id)) {
      try {
        v.remove();
      } catch {}
      continue;
    }
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
  // Бандиты, напавшие на поселение.
  for (const r of raiders) {
    const cid = raidPropOf(r);
    if (typeof cid !== "string") continue;
    // Набег уже закончился (или поселения нет) — отставшие бандиты исчезают, а не грабят снова.
    if (!S.civs.has(cid) || !S.civs.get(cid).raid?.ids?.includes(r.id)) {
      try {
        r.remove();
      } catch {}
      continue;
    }
    brainOf(r, cid).role = "raider";
    seen.add(r.id);
  }
  for (const [id, b] of S.brains) {
    if (!seen.has(id)) {
      resetTask(b);
      dropHeld(b);
      S.brains.delete(id);
      swinging.delete(id);
    }
  }
}

// Вживую: бунтовщики уходят (их сущности исчезают), больные умирают.
const LIVE_HOOKS = {
  liveRemove: (civ, n) => {
    const list = (S.members.get(civ.id) ?? []).filter((e) => !["guard", "soldier", "golem"].includes(brainOf(e, civ.id).role)).slice(0, n);
    for (const e of list) {
      S.brains.delete(e.id);
      try {
        e.remove();
      } catch {}
    }
  },
  foundRebels: (civ, dest, n) => virtualColony(civ, dest, n, false),
  kill: (civ) => {
    const list = S.members.get(civ.id) ?? [];
    const e = list[Math.floor(Math.random() * list.length)];
    if (!e) return;
    civ.deaths++;
    civ.causes = civ.causes ?? {};
    civ.causes.disease = (civ.causes.disease ?? 0) + 1;
    note("people", `${civ.name}: умер от болезни — ${S.brains.get(e.id)?.name ?? "житель"}`);
    S.brains.delete(e.id);
    try {
      e.remove();
    } catch {}
  },
};

function everySecond() {
  if (S.catchingUp) return; // идёт пересчёт времени, пока вас не было
  S.clock++;
  regroup();
  const slow = Math.max(5, Math.round(30 / S.speed));
  for (const civ of [...S.civs.values()]) {
    try {
      const wasActive = civ._active;
      civ._active = isActive(civ);
      if (collapseCheck(civ)) continue;
      // Защита от «битых» чисел (NaN) в запасах и казне — например, из старого сохранения.
      if (S.clock % 10 === 1) {
        for (const k in civ.res) if (!Number.isFinite(civ.res[k])) civ.res[k] = 0;
        if (!Number.isFinite(civ.coins ?? 0)) civ.coins = 0;
      }
      // Факелы и фонари расставляются везде, где чанки загружены (и вблизи, и в зоне прорисовки).
      lightsTick(civ);
      civ.peakPop = Math.max(civ.peakPop ?? 0, popOf(civ));
      if (S.clock % 30 === 3) planWall(civ);
      if (!civ._active) {
        // Далеко от игрока — фоновая симуляция раз в 10 секунд.
        civ._activeFor = 0;
        if (S.clock % 10 === 0) offscreenTick(civ, 10);
        // Но если чанки поселения загружены (в зоне прорисовки) — оплаченное появляется сразу.
        if (!civ.virtualCenter && loaded(DIM(), civ.center)) streamBuild(civ);
        continue;
      }
      if (wasActive === false) civ._activeFor = 0;
      civ._activeFor = (civ._activeFor ?? 0) + 1;
      // Игрок вернулся: ждём, пока подгрузятся жители, и применяем итоги фоновой симуляции.
      if (civ.off && ((S.members.get(civ.id) ?? []).length > 0 && civ._activeFor >= 3 || civ._activeFor >= 15)) materialize(civ);
      if (civ.off) continue;
      if (S.clock % 5 === 0) takeCensus(civ);
      // Напали мобы — сразу собираем ополчение.
      const hadThreat = (civ._threats ?? []).length > 0;
      scanThreats(civ);
      if (S.clock % 30 === 7) floodCheck(civ);
      if (hadThreat !== civ._threats.length > 0) civ._reassign = true;
      if (civ._reassign || S.clock % 5 === 0) {
        civ._reassign = false;
        assignRoles(civ);
      }
      searchTick(civ);
      streamBuild(civ);
      mineTick(civ);
      colonyCheck(civ);
      if (S.clock % 20 === 0) hungerTick(civ);
      // Рождения — вдвое чаще прочих событий (раз в 15 с при обычной скорости).
      if (S.clock % Math.max(3, Math.round(15 / S.speed)) === 0) growthTick(civ);
      if (S.clock % slow === 0) {
        colonyTick(civ);
        golemTick(civ);
      }
      raidCheck(civ);
      if (S.clock % 60 === 33) raidTick(civ);
      lifeFx(civ);
      if (S.clock % 10 === 0) {
        lifeTick(civ, (10 / 60) * S.speed, LIVE_HOOKS);
        scienceTick(civ, (10 / 60) * S.speed);
        husbandryTick(civ, (10 / 60) * S.speed);
        siegeTick(civ);
        armorTick(civ);
        smeltTick(civ, (10 / 60) * S.speed);
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
    if (S.clock % 60 === 15) planRoads();
    if (S.clock % 30 === 20) marketTick();
    if (S.clock % 60 === 50) creditTick(declareWar);
    layRoads();
    layWalls();
    demoTick();
    // Содержание зданий — по часам устройства (реальное время), один общий процесс для всех поселений.
    caravanTick();
    if (S.clock % 60 === 25) pactTick();
    if (S.clock % 60 === 40) for (const civ of S.civs.values()) if (civ._active) questTick(civ);
    // Приморское ли поселение (для пристани) — проверяем изредка, пока чанки загружены.
    if (S.clock % 300 === 17) for (const civ of S.civs.values()) if (civ._active) civ.coastal = waterNear(DIM(), Math.floor(civ.center.x), Math.floor(civ.center.z), 40);
    upkeepTick(Date.now());
    // Налог: 0.5 монеты в минуту с каждого жителя (раз в 10 секунд).
    if (S.clock % 10 === 0) for (const civ of S.civs.values()) taxTick(civ, 10 / 60);
    if (S.clock % UPKEEP.REPAY_EVERY_SEC === 0) for (const civ of S.civs.values()) repayDebt(civ);
    if (S.clock % 5 === 0) foundingScan();
    statusTick();
  } catch (e) {
    console.warn(`[Цивилизации] ${e}`);
  }
  if (S.clock % 5 === 0) {
    saveAll();
    saveJournal();
    if (S.clock % 30 === 0) saveLoans();
    markRealTime();
    showReport();
  }
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
    // Поселения вдали от игрока считаются по формулам, их жители стоят.
    if (!civ || civ._active === false || civ.off) continue;
    if (night && !S.nightWork && !ALWAYS_AWAKE.has(b.role)) {
      // Режим «ночью спят»: мирные жители отдыхают.
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

// Застрял в блоке (саженец вырос, стена достроилась, телепорт неудачный) — выталкиваем, пока не задохнулся.
function rescueAll() {
  for (const b of S.brains.values()) {
    const e = b.ent;
    if (!e || !e.isValid) continue;
    try {
      if (rescueIfStuck(e)) b.path = null;
    } catch {}
  }
}

function moveAll() {
  resetPathBudget(system.currentTick % 4 === 0 ? 1 : 0);
  for (const b of S.brains.values()) {
    if (b.target && !b.resting && S.civs.get(b.civId)?._active !== false) moveStep(b);
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
  dropHeld(brain);
  const civ = S.civs.get(brain.civId);
  if (!civ) return;
  // Убит бандит — считаем для итогов набега.
  if (brain.role === "raider") {
    civ.raidKills = (civ.raidKills ?? 0) + 1;
    return;
  }
  civ.deaths++;
  civ.causes = civ.causes ?? {};
  markDirty(civ);
  const killer = ev.damageSource.damagingEntity;
  let kb;
  let ktype = "";
  try {
    kb = killer ? S.brains.get(killer.id) : undefined;
    ktype = killer?.typeId ?? "";
  } catch {}
  const name = brain.role === "golem" ? "Железный страж" : brain.name;
  const enemy = kb ? S.civs.get(kb.civId) : undefined;
  // Враг — любая цивилизация, которая воюет с этой (в том числе союзники кредитора).
  if (enemy && enemy !== civ && (enemy.war?.enemy === civ.id || civ.war?.enemy === enemy.id)) {
    civ.warLosses++;
    civ.causes.war = (civ.causes.war ?? 0) + 1;
    enemy.kills++;
    markDirty(enemy);
    warLog(civ, enemy, `гибель в бою: ${name} (${civ.name})`);
    if (enemy.war?.ally) {
      const lender = S.civs.get(enemy.war.ally);
      if (lender) warLog(lender, civ, `${enemy.name} (союзник) убили ${name}`);
    }
  } else if (kb?.role === "raider" || ktype === "minecraft:pillager" || ktype === "minecraft:vindicator") {
    civ.causes.raid = (civ.causes.raid ?? 0) + 1;
    note("people", `${civ.name}: убит бандитами — ${name}`);
  } else if (ev.damageSource.cause === "starve") {
    civ.causes.starve = (civ.causes.starve ?? 0) + 1;
    note("people", `${civ.name}: смерть от голода — ${name}`);
  } else {
    civ.causes.mob = (civ.causes.mob ?? 0) + 1;
    note("people", `${civ.name}: гибель — ${name}`);
  }
}

let started = false;
function start() {
  if (started) return;
  started = true;
  loadAll();
  loadRoads();
  loadMarket();
  loadLoans();
  loadJournal();
  loadCaravans();
  setPolyPoint(polyPoint);
  system.runTimeout(() => cleanupCaravanLlamas(), 100);
  catchUp();
  system.runInterval(moveAll, 2);
  system.runInterval(thinkAll, 10);
  system.runInterval(everySecond, 20);
  system.runInterval(rescueAll, 10);
  system.runInterval(() => {
    try {
      heldTick();
    } catch {}
  }, 2);
  system.runInterval(() => {
    try {
      heldCleanup();
    } catch {}
  }, 100);
  system.runInterval(() => {
    try {
      whTick();
    } catch {}
  }, 10);
  world.afterEvents.entityDie.subscribe(onDeath, { entityTypes: ["minecraft:villager_v2", "minecraft:iron_golem", "minecraft:pillager", "minecraft:vindicator"] });
  world.afterEvents.playerInteractWithBlock.subscribe(onInteractBlock);
  world.afterEvents.itemUse.subscribe(onItemUse);
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
