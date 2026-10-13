import { world, system } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { S, dXZ, markDirty, saveAll, deleteCiv, DIM } from "./core.js";
import { TYPES } from "./blueprints.js";
import { projectOps, foodCap, ROLE_NAME, brainOf } from "./workers.js";
import { ERAS, popOf, housingOf, newCiv, join, eraNeed } from "./society.js";
import { declareWar } from "./war.js";
import { whLine, whCommand, showWhForm } from "./wh.js";
import { mineInfo } from "./mine.js";
import { roadInfo, teleportTo } from "./links.js";
import { marketText } from "./market.js";
import { showJournal } from "./journal.js";
import { creditText, repOf, debtOf } from "./credit.js";
import { wallInfo } from "./walls.js";
import { TOOL_FOR, TIERS, toolTier } from "./tools.js";

export function nearestCiv(p, maxDist) {
  let best;
  let bd = maxDist;
  for (const civ of S.civs.values()) {
    const d = dXZ(civ.center, p);
    if (d < bd) {
      bd = d;
      best = civ;
    }
  }
  return best;
}

function projectLine(civ) {
  if (civ.colony) return "§bПереселенцы ищут место для колонии";
  const p = civ.project;
  if (!p) return S.search.get(civ.id) ? "§7Выбирают место для стройки..." : "§7Нет стройки";
  const total = projectOps(civ).length || 1;
  const pct = Math.floor((p.step / total) * 100);
  const wait = civ.waiting ? ` §c(нужно: ${civ.waiting})` : "";
  return `§eСтроят: ${TYPES[p.t].name} ${pct}%${wait}`;
}

export function statusTick() {
  for (const pl of world.getAllPlayers()) {
    if (pl.dimension.id !== "minecraft:overworld") continue;
    const civ = nearestCiv(pl.location, 72);
    const wh = whLine(pl);
    if (!civ) {
      if (wh) {
        try {
          pl.onScreenDisplay.setActionBar(wh);
        } catch {}
      }
      continue;
    }
    const r = civ.res;
    const war = civ.war ? S.civs.get(civ.war.enemy) : undefined;
    const lines = [
      `${civ.color}§l${civ.name}§r §7— ${ERAS[civ.era].name}`,
      `§fЖители: ${popOf(civ)}/${housingOf(civ)}  §6Еда: ${r.food}/${foodCap(civ)}  §2Дерево: ${r.wood}  §7Камень: ${r.stone}  §fЖелезо: ${r.iron}${r.diamond ? `  §bАлмазы: ${r.diamond}` : ""}`,
      projectLine(civ),
    ];
    if (war) lines.push(`§c§lВОЙНА§r§c с ${war.name}`);
    if (civ.starving) lines.push("§c§lГОЛОД!");
    if ((civ._threats ?? []).length) lines.push(`§4Нападение! Врагов рядом: ${civ._threats.length}`);
    const en = eraNeed(civ);
    if (en) lines.push("§7" + en);
    if (wh) lines.push(wh);
    try {
      pl.onScreenDisplay.setActionBar(lines.join("\n"));
    } catch {}
  }
}

function roleSummary(civ) {
  const counts = {};
  for (const e of S.members.get(civ.id) ?? []) {
    const r = brainOf(e, civ.id).role;
    counts[r] = (counts[r] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([r, n]) => `${ROLE_NAME[r] ?? r}: ${n}`)
    .join(", ");
}

function toolSummary(civ) {
  const counts = [0, 0, 0, 0, 0];
  let workers = 0;
  for (const e of S.members.get(civ.id) ?? []) {
    const kind = TOOL_FOR[brainOf(e, civ.id).role];
    if (!kind) continue;
    workers++;
    counts[toolTier(e, kind)]++;
  }
  if (!workers) return "—";
  return TIERS.map((t, i) => (counts[i] ? `${i ? t.name : "без инструмента"}: ${counts[i]}` : "")).filter(Boolean).join(", ");
}

function relations(civ) {
  const out = [];
  for (const other of S.civs.values()) {
    if (other === civ) continue;
    const t = civ.tension[other.id];
    if (civ.war?.enemy === other.id) out.push(`§c${other.name}: ВОЙНА`);
    else if (t !== undefined) out.push(`${other.color}${other.name}§r: напряжение ${Math.min(100, t)}%`);
  }
  return out.length ? out.join("\n") : "§7Соседей нет";
}

const DONATE = [
  { test: (id) => id.endsWith("_log") || id.endsWith("_wood"), res: "wood", n: 3 },
  { test: (id) => id.endsWith("_planks"), res: "wood", n: 1 },
  { test: (id) => ["minecraft:cobblestone", "minecraft:stone", "minecraft:cobbled_deepslate", "minecraft:deepslate"].includes(id), res: "stone", n: 1 },
  { test: (id) => ["minecraft:iron_ingot", "minecraft:raw_iron"].includes(id), res: "iron", n: 1 },
  { test: (id) => id === "minecraft:iron_block", res: "iron", n: 9 },
  { test: (id) => ["minecraft:bread", "minecraft:cooked_beef", "minecraft:cooked_porkchop", "minecraft:cooked_mutton", "minecraft:cooked_chicken", "minecraft:baked_potato"].includes(id), res: "food", n: 3 },
  { test: (id) => ["minecraft:wheat", "minecraft:carrot", "minecraft:potato", "minecraft:apple", "minecraft:beef", "minecraft:porkchop", "minecraft:mutton", "minecraft:chicken", "minecraft:beetroot", "minecraft:sweet_berries"].includes(id), res: "food", n: 1 },
];

function donate(pl, civ) {
  const inv = pl.getComponent("minecraft:inventory")?.container;
  if (!inv) return;
  const got = { wood: 0, stone: 0, food: 0, iron: 0 };
  for (let i = 0; i < inv.size; i++) {
    const item = inv.getItem(i);
    if (!item) continue;
    const rule = DONATE.find((r) => r.test(item.typeId));
    if (!rule) continue;
    got[rule.res] += rule.n * item.amount;
    inv.setItem(i, undefined);
  }
  for (const k in got) civ.res[k] += got[k];
  civ.res.food = Math.min(civ.res.food, foodCap(civ));
  markDirty(civ);
  pl.sendMessage(`§a${civ.name} благодарят вас! Получено: дерево ${got.wood}, камень ${got.stone}, еда ${got.food}, железо ${got.iron}.`);
}

export function showCivForm(pl, civ) {
  const r = civ.res;
  const parent = civ.parent ? S.civs.get(civ.parent) : undefined;
  const body = [
    `§lЭпоха:§r ${ERAS[civ.era].name}`,
    `§lЖители:§r ${popOf(civ)} (мест в домах: ${housingOf(civ)})`,
    `§lПрофессии:§r ${roleSummary(civ) || "—"}`,
    `§lПостроек:§r ${civ.buildings.filter((b) => b.t !== "quarry").length}`,
    `§lРесурсы:§r дерево ${r.wood}, камень ${r.stone}, еда ${r.food}/${foodCap(civ)}, железо ${r.iron}, алмазы ${r.diamond ?? 0}, саженцы ${r.saplings ?? 0}`,
    `§lСклад:§r андезит ${r.andesite ?? 0}, уголь ${r.coal ?? 0}, факелы ${r.torches ?? 0}${civ.lights?.length ? ` §e(ждут света: ${civ.lights.length} мест)` : ""}`,
    `§lРепутация:§r ${repOf(civ)}${debtOf(civ) ? `, §cдолг ${debtOf(civ).ln}: ${debtOf(civ).paid}/${debtOf(civ).due}§r` : ""}${civ.marketBan ? " §c(рынок закрыт)" : ""}`,
    `§lСтена:§r ${wallInfo(civ)}`,
    `§lКазна:§r ${Math.floor(civ.coins ?? 0)} монет${civ.needSaplings ? "  §2(ищут саженцы — вокруг нет леса)" : ""}`,
    `§lИнструменты:§r ${toolSummary(civ)}`,
    `§lШахта:§r ${mineInfo(civ)}`,
    eraNeed(civ),
    `§lДороги:§r ${roadInfo(civ)}`,
    (civ.trades ?? []).length ? `§lРынок:§r ${civ.trades.slice(0, 3).join("; ")}` : "",
    `§lРодилось:§r ${civ.born}  §lПогибло:§r ${civ.deaths}  §lПобед в боях:§r ${civ.kills}`,
    parent ? `§lМетрополия:§r ${parent.name}` : "",
    "",
    projectLine(civ),
    "",
    "§lОтношения:§r",
    relations(civ),
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "");
  new ActionFormData()
    .title(`${civ.color}${civ.name}`)
    .body(body.join("\n"))
    .button("Подарить ресурсы из инвентаря")
    .button("ВХ на профессии")
    .button("Телепорт к поселению")
    .button("Закрыть")
    .show(pl)
    .then((res) => {
      if (res.selection === 0) donate(pl, civ);
      if (res.selection === 1) showWhForm(pl);
      if (res.selection === 2) showTpForm(pl);
    })
    .catch(() => {});
}

/** Список всех поселений с телепортом. Открывается компасом, колоколом или /scriptevent civ:tp. */
export function showTpForm(pl, tries = 0) {
  const list = [...S.civs.values()].sort((a, b) => dXZ(a.center, pl.location) - dXZ(b.center, pl.location));
  if (!list.length) return pl.sendMessage("§7Цивилизаций пока нет.");
  const form = new ActionFormData().title("Телепорт к поселению").body("Куда отправиться?");
  for (const c of list) {
    const d = Math.round(dXZ(c.center, pl.location));
    const tag = c.war ? " §c(война)" : c._active === false ? " §8(вдали)" : "";
    form.button(`${c.color}${c.name}§r — ${ERAS[c.era].name}, ${popOf(c)} жит., ${d} бл.${tag}`);
  }
  form
    .show(pl)
    .then((res) => {
      // Если открыт чат, форма не показывается — пробуем ещё раз чуть позже.
      if (res.canceled && res.cancelationReason === "UserBusy" && tries < 20) {
        system.runTimeout(() => showTpForm(pl, tries + 1), 10);
        return;
      }
      if (res.selection === undefined) return;
      const civ = list[res.selection];
      if (civ && S.civs.has(civ.id)) teleportTo(pl, civ);
    })
    .catch(() => {});
}

/** Компас в руке: меню мода (без читов). */
export function onItemUse(ev) {
  if (ev.itemStack?.typeId !== "minecraft:compass") return;
  const pl = ev.source;
  new ActionFormData()
    .title("Цивилизации")
    .button("Журнал: войны, павшие, кредиты, рынок…")
    .button("Телепорт к поселению")
    .button("Рынок: цены и казна")
    .button("Кредиты: долги и репутация")
    .button("ВХ на профессии")
    .button("Закрыть")
    .show(pl)
    .then((res) => {
      if (res.selection === 0) showJournal(pl);
      if (res.selection === 1) showTpForm(pl);
      if (res.selection === 2) showMarketForm(pl);
      if (res.selection === 3) showCreditForm(pl);
      if (res.selection === 4) showWhForm(pl);
    })
    .catch(() => {});
}

export function showCreditForm(pl) {
  new ActionFormData().title("Кредиты").body(creditText()).button("Закрыть").show(pl).catch(() => {});
}

export function showMarketForm(pl) {
  new ActionFormData()
    .title("Рынок")
    .body(marketText())
    .button("Закрыть")
    .show(pl)
    .catch(() => {});
}

const lastForm = new Map();
export function onInteractBlock(ev) {
  if (ev.block.typeId !== "minecraft:bell") return;
  const civ = nearestCiv(ev.block.location, 4);
  if (!civ) return;
  const now = Date.now();
  if (now - (lastForm.get(ev.player.id) ?? 0) < 1500) return;
  lastForm.set(ev.player.id, now);
  showCivForm(ev.player, civ);
}

/** Команды: /scriptevent civ:<команда> [аргумент] (нужны читы). */
export function onScriptEvent(ev) {
  const pl = ev.sourceEntity;
  const say = (m) => (pl && pl.typeId === "minecraft:player" ? pl.sendMessage(m) : world.sendMessage(m));
  const where = pl?.location ?? { x: 0, y: 64, z: 0 };
  switch (ev.id) {
    case "civ:speed": {
      const v = Math.max(0.5, Math.min(10, Number(ev.message) || 1));
      S.speed = v;
      saveAll();
      return say(`§aСкорость работы жителей: x${v}`);
    }
    case "civ:info": {
      if (!S.civs.size) return say("§7Цивилизаций пока нет.");
      for (const civ of S.civs.values()) {
        const c = civ.center;
        say(`${civ.color}${civ.name}§r — ${ERAS[civ.era].name}, жителей ${popOf(civ)}${civ._active === false ? " §7(вдали, фоновая симуляция)§r" : ""}, центр ${c.x} ${c.y} ${c.z}${civ.war ? " §c(война)" : ""}`);
      }
      return;
    }
    case "civ:found": {
      const dim = DIM();
      const vill = dim.getEntities({ type: "minecraft:villager_v2", location: where, maxDistance: 16 });
      if (!vill.length) return say("§cРядом нет жителей (нужен хотя бы один в радиусе 16 блоков).");
      const civ = newCiv(where);
      for (const v of vill) join(civ, v);
      return say(`§aОсновано племя ${civ.color}${civ.name}§a (${vill.length} жит.)`);
    }
    case "civ:war": {
      const list = [...S.civs.values()].sort((a, b) => dXZ(a.center, where) - dXZ(b.center, where));
      if (list.length < 2) return say("§cНужно минимум две цивилизации.");
      if (list[0].war || list[1].war) return say("§cОдна из них уже воюет.");
      return declareWar(list[0], list[1]);
    }
    case "civ:peace": {
      for (const civ of S.civs.values()) {
        civ.war = null;
        civ._reassign = true;
        for (const k in civ.tension) civ.tension[k] = 0;
        markDirty(civ);
      }
      return say("§aВсе войны окончены.");
    }
    case "civ:res": {
      const civ = nearestCiv(where, 200);
      if (!civ) return say("§cРядом нет цивилизации.");
      civ.res.wood += 200;
      civ.res.stone += 200;
      civ.res.iron += 50;
      civ.res.food = foodCap(civ);
      markDirty(civ);
      return say(`§a${civ.name} получили ресурсы.`);
    }
    case "civ:reset": {
      for (const civ of [...S.civs.values()]) deleteCiv(civ);
      saveAll(true);
      return say("§cВсе цивилизации удалены.");
    }
    case "civ:radius": {
      const v = Math.max(2, Math.min(16, Math.round(Number(ev.message) || 7)));
      S.activeChunks = v;
      saveAll();
      return say(`§eЖивая симуляция — ${v} чанков (${v * 16} блоков) вокруг игрока, дальше — фоновая. Ставьте на 1 меньше «Расстояния симуляции» в настройках мира.`);
    }
    case "civ:night": {
      const a = String(ev.message ?? "").trim().toLowerCase();
      if (["rest", "sleep", "спят", "сон", "отдых"].includes(a)) S.nightWork = false;
      else if (["work", "работают", "работа"].includes(a)) S.nightWork = true;
      else S.nightWork = !S.nightWork;
      saveAll();
      return say(S.nightWork ? "§eНочью жители работают." : "§eНочью мирные жители спят (работают только воины).");
    }
    case "civ:log": {
      if (!pl || pl.typeId !== "minecraft:player") return say("§cКоманду должен выполнить игрок.");
      return showJournal(pl);
    }
    case "civ:market": {
      if (!pl || pl.typeId !== "minecraft:player") return say(marketText());
      return showMarketForm(pl);
    }
    case "civ:tp": {
      if (!pl || pl.typeId !== "minecraft:player") return say("§cКоманду должен выполнить игрок.");
      return showTpForm(pl);
    }
    case "civ:wh": {
      if (!pl || pl.typeId !== "minecraft:player") return say("§cКоманду должен выполнить игрок.");
      return whCommand(pl, ev.message);
    }
    default:
      if (ev.id.startsWith("civ:")) say("§7Команды: civ:info, civ:speed <x>, civ:found, civ:war, civ:peace, civ:res, civ:reset, civ:wh <профессия|all|off>, civ:night <work|rest>, civ:tp");
  }
}
