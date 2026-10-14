import { ItemStack } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { S, dXZ, markDirty } from "./core.js";
import { ERAS, popOf, deficitOf, missingQueue, HOUSE_TYPES } from "./society.js";
import { TYPES } from "./blueprints.js";
import { note } from "./journal.js";
import { declareWar, makePeace } from "./war.js";
import { foodCap } from "./workers.js";

// ---------- Задания поселений для игрока ----------
// Поселение с дефицитом просит игрока принести ресурс. Награда — изумруды и уважение;
// с уважением 20+ игрок может стать правителем поселения и отдавать приказы.
const ITEMS = {
  wood: { ids: (id) => id.endsWith("_log") || id.endsWith("_planks"), per: (id) => (id.endsWith("_log") ? 4 : 1), give: "minecraft:oak_log", name: "брёвна/доски" },
  stone: { ids: (id) => ["minecraft:cobblestone", "minecraft:stone", "minecraft:andesite", "minecraft:diorite", "minecraft:granite", "minecraft:cobbled_deepslate"].includes(id), per: () => 1, name: "булыжник/камень" },
  iron: { ids: (id) => id === "minecraft:iron_ingot" || id === "minecraft:raw_iron", per: () => 1, name: "железные слитки" },
  food: { ids: (id) => ["minecraft:bread", "minecraft:wheat", "minecraft:carrot", "minecraft:potato", "minecraft:baked_potato", "minecraft:cooked_beef", "minecraft:cooked_porkchop", "minecraft:apple"].includes(id), per: (id) => (id === "minecraft:wheat" ? 1 : 3), name: "еда (хлеб, мясо, овощи)" },
  coal: { ids: (id) => id === "minecraft:coal" || id === "minecraft:charcoal", per: () => 1, name: "уголь" },
  dirt: { ids: (id) => id === "minecraft:dirt" || id === "minecraft:grass_block", per: () => 1, name: "земля" },
  sand: { ids: (id) => id === "minecraft:sand", per: () => 1, name: "песок" },
  glass: { ids: (id) => id === "minecraft:glass", per: () => 1, name: "стекло" },
  andesite: { ids: (id) => id === "minecraft:andesite" || id === "minecraft:polished_andesite", per: () => 1, name: "андезит" },
};
const QTY = { wood: 64, stone: 64, iron: 16, food: 32, coal: 24, dirt: 64, sand: 48, glass: 32, andesite: 32 };

/** Раз в минуту: новое задание, если есть дефицит и старого нет. */
export function questTick(civ) {
  if (civ.quest && civ.quest.until > S.clock) return;
  if (civ.quest) civ.quest = null;
  if ((civ.questAt ?? 0) > S.clock) return;
  const k = deficitOf(civ);
  if (!k || !ITEMS[k]) return;
  civ.quest = { k, qty: QTY[k], until: S.clock + 1800, reward: Math.max(2, Math.round(QTY[k] / 8)) };
  civ.questAt = S.clock + 900;
  markDirty(civ);
  note("events", `${civ.name} просят игрока принести: ${ITEMS[k].name} ×${QTY[k]} (награда — ${civ.quest.reward} изумр.)`);
}

export const playerRep = (civ, pl) => civ.playerRep?.[pl.name] ?? 0;

function addRep(civ, pl, v) {
  civ.playerRep = civ.playerRep ?? {};
  civ.playerRep[pl.name] = Math.min(100, (civ.playerRep[pl.name] ?? 0) + v);
}

/** Сдать задание: забирает из инвентаря нужное, даёт изумруды. Возвращает текст результата. */
export function deliverQuest(pl, civ) {
  const q = civ.quest;
  if (!q) return "Заданий нет.";
  const inv = pl.getComponent("minecraft:inventory")?.container;
  if (!inv) return "Нет инвентаря.";
  const rule = ITEMS[q.k];
  let got = 0;
  for (let i = 0; i < inv.size && got < q.qty; i++) {
    const it = inv.getItem(i);
    if (!it || !rule.ids(it.typeId)) continue;
    const per = rule.per(it.typeId);
    const need = Math.ceil((q.qty - got) / per);
    const take = Math.min(it.amount, need);
    got += take * per;
    if (take >= it.amount) inv.setItem(i, undefined);
    else {
      it.amount -= take;
      inv.setItem(i, it);
    }
  }
  if (!got) return `Нужно: ${rule.name} — в инвентаре нет.`;
  civ.res[q.k] = (civ.res[q.k] ?? 0) + got;
  if (q.k === "food") civ.res.food = Math.min(civ.res.food, foodCap(civ));
  q.qty -= Math.min(q.qty, got);
  let text = `Принято ${got}.`;
  if (q.qty <= 0) {
    try {
      inv.addItem(new ItemStack("minecraft:emerald", q.reward));
    } catch {}
    addRep(civ, pl, 10);
    text += ` Задание выполнено! Награда: ${q.reward} изумр., уважение ${playerRep(civ, pl)}.`;
    note("events", `${pl.name} выполнил задание поселения ${civ.name}`);
    civ.quest = null;
  } else text += ` Осталось принести ${q.qty}.`;
  markDirty(civ);
  return text;
}

export function questText(civ) {
  const q = civ.quest;
  if (!q) return "нет";
  return `принести ${ITEMS[q.k].name} ×${q.qty} — награда ${q.reward} изумр. (ещё ${Math.ceil((q.until - S.clock) / 60)} мин)`;
}

// ---------- Игрок-правитель ----------
export function showRuleForm(pl, civ) {
  const mine = civ.playerRuler === pl.name;
  const rep = playerRep(civ, pl);
  if (!mine) {
    const ok = rep >= 20 && !civ.playerRuler;
    new ActionFormData()
      .title(`${civ.color}${civ.name}`)
      .body(civ.playerRuler ? `Поселением уже правит ${civ.playerRuler}.` : `Ваше уважение: ${rep}. Чтобы стать правителем, нужно 20 (выполняйте задания).`)
      .button(ok ? "Стать правителем" : "Закрыть")
      .show(pl)
      .then((r) => {
        if (ok && r.selection === 0) {
          civ.playerRuler = pl.name;
          markDirty(civ);
          note("events", `${pl.name} стал правителем поселения ${civ.name}`);
          showRuleForm(pl, civ);
        }
      })
      .catch(() => {});
    return;
  }
  const neighbors = [...S.civs.values()].filter((c) => c !== civ && dXZ(c.center, civ.center) < 260);
  new ActionFormData()
    .title(`Правление: ${civ.name}`)
    .body(`Вы — правитель. Приказы выполняются сразу.${civ.order ? `\nСледующая постройка: ${TYPES[civ.order]?.name}` : ""}`)
    .button("Что строить следующим")
    .button("Бросить силы на ресурс (10 мин)")
    .button("Устроить праздник")
    .button("Объявить войну соседу")
    .button("Заключить мир")
    .button("Отречься от власти")
    .show(pl)
    .then((r) => {
      if (r.selection === 0) pickBuild(pl, civ);
      if (r.selection === 1) pickFocus(pl, civ);
      if (r.selection === 2) {
        if ((civ.res.food ?? 0) < popOf(civ) * 2) return pl.sendMessage("§cДля праздника не хватает еды.");
        civ.festAt = 0;
        civ.mood = Math.max(civ.mood ?? 60, 80);
        civ.res.food = Math.max(civ.res.food, popOf(civ) * 4);
        pl.sendMessage("§dПраздник начнётся в ближайшие секунды.");
      }
      if (r.selection === 3) pickWar(pl, civ, neighbors);
      if (r.selection === 4 && civ.war) {
        const e = S.civs.get(civ.war.enemy);
        if (e) makePeace(civ, e, `${civ.name} и ${e.name} заключили мир по приказу правителя ${pl.name}`);
      }
      if (r.selection === 5) {
        civ.playerRuler = null;
        markDirty(civ);
        pl.sendMessage("§7Вы отреклись от власти.");
      }
    })
    .catch(() => {});
}

function pickBuild(pl, civ) {
  const opts = [...new Set([...missingQueue(civ), HOUSE_TYPES[civ.era], "farm", "watchtower"])].filter((t) => TYPES[t]);
  const f = new ActionFormData().title("Что строить следующим");
  for (const t of opts) f.button(TYPES[t].name);
  f.show(pl)
    .then((r) => {
      if (r.selection === undefined) return;
      civ.order = opts[r.selection];
      civ.blockedUntil = 0;
      markDirty(civ);
      pl.sendMessage(`§aСледующей построят: ${TYPES[civ.order].name}`);
    })
    .catch(() => {});
}

const FOCUS = [["wood", "Дерево"], ["stone", "Камень"], ["iron", "Железо"], ["food", "Еда"], ["dirt", "Земля"]];
function pickFocus(pl, civ) {
  const f = new ActionFormData().title("На какой ресурс бросить силы");
  for (const [, n] of FOCUS) f.button(n);
  f.show(pl)
    .then((r) => {
      if (r.selection === undefined) return;
      civ._def = { res: FOCUS[r.selection][0], until: S.clock + 600, forced: true };
      civ._reassign = true;
      pl.sendMessage(`§aДо 40% жителей 10 минут добывают: ${FOCUS[r.selection][1].toLowerCase()}`);
    })
    .catch(() => {});
}

function pickWar(pl, civ, neighbors) {
  if (civ.war) return pl.sendMessage("§cПоселение уже воюет.");
  if (!neighbors.length) return pl.sendMessage("§7Рядом нет соседей.");
  const f = new ActionFormData().title("Объявить войну");
  for (const c of neighbors) f.button(`${c.color}${c.name}§r — ${ERAS[c.era].name}, ${popOf(c)} жит.`);
  f.show(pl)
    .then((r) => {
      const t = neighbors[r.selection];
      if (!t || civ.war || t.war) return;
      declareWar(civ, t, { reason: `приказ правителя ${pl.name}`, res: "coins" });
    })
    .catch(() => {});
}

// ---------- Карта мира ----------
/** Схема: поселения буквами, дороги точками, @ — вы. */
export function mapText(pl) {
  const civs = [...S.civs.values()];
  if (!civs.length) return "Поселений пока нет.";
  const pts = [...civs.map((c) => c.center), pl.location];
  let x0 = Math.min(...pts.map((p) => p.x)) - 20;
  let x1 = Math.max(...pts.map((p) => p.x)) + 20;
  let z0 = Math.min(...pts.map((p) => p.z)) - 20;
  let z1 = Math.max(...pts.map((p) => p.z)) + 20;
  const W = 28;
  const H = 16;
  const sx = Math.max(1, (x1 - x0) / W);
  const sz = Math.max(1, (z1 - z0) / H);
  const grid = Array.from({ length: H }, () => Array(W).fill("§8·"));
  const put = (x, z, ch) => {
    const i = Math.floor((x - x0) / sx);
    const j = Math.floor((z - z0) / sz);
    if (i >= 0 && i < W && j >= 0 && j < H) grid[j][i] = ch;
  };
  for (const r of S.roads ?? []) for (const [x, z] of r.pts ?? []) put(x, z, "§7+");
  const legend = [];
  civs.forEach((c, n) => {
    const ch = String.fromCharCode(65 + (n % 26));
    put(c.center.x, c.center.z, `${c.color}§l${ch}§r`);
    legend.push(`${c.color}${ch}§r ${c.name} — ${ERAS[c.era].name}, ${popOf(c)} жит.${c.war ? ` §c(война с ${S.civs.get(c.war.enemy)?.name ?? "?"})§r` : ""}`);
  });
  put(pl.location.x, pl.location.z, "§e§l@§r");
  return `Север сверху. Клетка ≈ ${Math.round(sx)} бл.\n${grid.map((row) => row.join("")).join("\n")}\n\n${legend.join("\n")}`;
}
