import { world, system } from "@minecraft/server";
import { S, saveAll } from "./core.js";
import { offscreenTick } from "./offscreen.js";
import { diplomacyTick } from "./war.js";
import { progressRoads, planRoads } from "./links.js";
import { marketTick } from "./market.js";
import { popOf } from "./society.js";
import { ERAS } from "./society.js";

// Время телефона: пока вас нет в игре, жизнь продолжается.
// При заходе считаем, сколько реального времени прошло, и прогоняем фоновую симуляцию за этот срок.
const MAX_HOURS = 48;
const STEP = 60; // секунд симуляции за шаг

export function markRealTime() {
  try {
    world.setDynamicProperty("civ:real", Date.now());
  } catch {}
}

let report = null;

export function catchUp(onDone) {
  let last = 0;
  try {
    last = Number(world.getDynamicProperty("civ:real") ?? 0);
  } catch {}
  const now = Date.now();
  markRealTime();
  if (!last || !(now > last)) return onDone?.();
  const seconds = Math.min((now - last) / 1000, MAX_HOURS * 3600);
  if (seconds < 120) return onDone?.();
  const before = new Map([...S.civs.values()].map((c) => [c.id, { pop: popOf(c), era: c.era, built: c.buildings.length + (c.offQueue?.length ?? 0) }]));
  const namesBefore = new Set(S.civs.keys());
  for (const c of S.civs.values()) c._active = false;
  S.catchingUp = true;
  const steps = Math.floor(seconds / STEP);
  function* job() {
    for (let s = 0; s < steps; s++) {
      S.clock += STEP;
      for (const civ of [...S.civs.values()]) {
        try {
          offscreenTick(civ, STEP);
        } catch {}
        yield;
      }
      progressRoads(STEP);
      if (s % 5 === 0) planRoads();
      try {
        diplomacyTick();
        diplomacyTick(); // раз в 30 секунд — два раза за минуту
        marketTick();
        marketTick();
      } catch {}
      yield;
    }
    // Итоги для игрока.
    const lines = [];
    for (const c of S.civs.values()) {
      const b = before.get(c.id);
      if (!b) {
        if (popOf(c) > 0) lines.push(`${c.color}${c.name}§r — новая колония, ${popOf(c)} жит.`);
        continue;
      }
      const parts = [];
      const dp = popOf(c) - b.pop;
      if (dp) parts.push(`${dp > 0 ? "+" : ""}${dp} жит.`);
      if (c.era > b.era) parts.push(`эпоха «${ERAS[c.era].name}»`);
      const db = c.buildings.length + (c.offQueue?.length ?? 0) - b.built;
      if (db > 0) parts.push(`+${db} построек`);
      if (c.war) parts.push("§cвоюет§r");
      if (parts.length) lines.push(`${c.color}${c.name}§r: ${parts.join(", ")}`);
    }
    for (const id of namesBefore) if (!S.civs.has(id)) lines.push("§4Одна из цивилизаций пала§r");
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    report = [`§b§lПока вас не было в игре (${h ? `${h} ч ` : ""}${m} мин):`, ...(lines.length ? lines : ["§7ничего заметного не произошло"])];
    S.catchingUp = false;
    saveAll(true);
    onDone?.();
    showReport();
  }
  system.runJob(job());
}

export function showReport() {
  if (!report) return;
  const players = world.getAllPlayers();
  if (!players.length) return;
  for (const pl of players) for (const l of report) pl.sendMessage(l);
  report = null;
}
