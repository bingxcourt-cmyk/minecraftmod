import { world, system } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { S } from "./core.js";

// Журнал вместо спама в чате. Открывается компасом → «Журнал».
// Разделы хранятся отдельно (у мира ограничение на размер одной записи).
const CATS = {
  market: { name: "Рынок", max: 60 },
  build: { name: "Стройка и дороги", max: 60 },
  people: { name: "Жители: рождения и смерти", max: 60 },
  events: { name: "События", max: 60 },
};
const MAX_WARS = 8;
const MAX_WAR_LOG = 30;

const plain = (t) => String(t).replace(/§./g, "").replace(/^\[[^\]]*\]\s*/, "");

export function loadJournal() {
  S.journal = {};
  for (const k of [...Object.keys(CATS), "wars"]) {
    try {
      S.journal[k] = JSON.parse(String(world.getDynamicProperty("civ:j:" + k) ?? "[]"));
    } catch {
      S.journal[k] = [];
    }
  }
}

const dirty = new Set();
export function saveJournal() {
  for (const k of dirty) {
    try {
      world.setDynamicProperty("civ:j:" + k, JSON.stringify(S.journal[k] ?? []));
    } catch {}
  }
  dirty.clear();
}

/** Запись в раздел журнала. */
export function note(cat, text) {
  if (!S.journal) return;
  const list = (S.journal[cat] = S.journal[cat] ?? []);
  list.unshift({ t: Date.now(), x: plain(text), off: S.catchingUp ? 1 : undefined });
  if (list.length > (CATS[cat]?.max ?? 60)) list.length = CATS[cat]?.max ?? 60;
  dirty.add(cat);
}

const findWar = (a, b) => (S.journal?.wars ?? []).find((w) => !w.end && ((w.a === a.id && w.b === b.id) || (w.a === b.id && w.b === a.id)));

export function warStart(a, b) {
  const wars = S.journal.wars;
  wars.unshift({ a: a.id, b: b.id, an: a.name, bn: b.name, t: Date.now(), log: [] });
  if (wars.length > MAX_WARS) wars.length = MAX_WARS;
  warLog(a, b, `${a.name} объявили войну ${b.name}`);
}

export function warLog(a, b, text) {
  const w = findWar(a, b);
  if (!w) return;
  w.log.push({ t: Date.now(), x: plain(text) });
  if (w.log.length > MAX_WAR_LOG) w.log.splice(1, 1); // первую строку (объявление) оставляем
  dirty.add("wars");
}

export function warEnd(a, b, result) {
  const w = findWar(a, b);
  if (!w) return;
  w.log.push({ t: Date.now(), x: plain(result) });
  w.end = Date.now();
  w.result = plain(result);
  dirty.add("wars");
}

/** Гибель цивилизации посреди войны — закрываем все её войны. */
export function warEndAll(civ, result) {
  for (const w of S.journal?.wars ?? []) {
    if (w.end || (w.a !== civ.id && w.b !== civ.id)) continue;
    w.log.push({ t: Date.now(), x: plain(result) });
    w.end = Date.now();
    w.result = plain(result);
  }
  dirty.add("wars");
}

function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "только что";
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return `${Math.floor(s / 86400)} дн назад`;
}

const line = (e) => `§8${ago(e.t)}${e.off ? ", без вас" : ""}:§r ${e.x}`;

// ---------- Меню ----------
function show(pl, form, then, tries = 0) {
  form
    .show(pl)
    .then((res) => {
      if (res.canceled && res.cancelationReason === "UserBusy" && tries < 20) {
        system.runTimeout(() => show(pl, form, then, tries + 1), 10);
        return;
      }
      then?.(res);
    })
    .catch(() => {});
}

export function showJournal(pl) {
  const form = new ActionFormData().title("Журнал").body("Что происходило в мире цивилизаций:");
  const keys = ["wars", ...Object.keys(CATS)];
  const active = (S.journal?.wars ?? []).filter((w) => !w.end).length;
  form.button(`Войны${active ? ` §c(идёт: ${active})` : ""}`);
  for (const k of Object.keys(CATS)) form.button(CATS[k].name);
  show(pl, form, (res) => {
    const k = keys[res.selection ?? -1];
    if (k === "wars") showWars(pl);
    else if (k) showList(pl, k);
  });
}

function showList(pl, cat) {
  const list = S.journal?.[cat] ?? [];
  const body = list.length ? list.map(line).join("\n") : "§7Пока пусто.";
  show(pl, new ActionFormData().title(CATS[cat].name).body(body).button("Назад"), (res) => {
    if (res.selection === 0) showJournal(pl);
  });
}

function showWars(pl) {
  const wars = S.journal?.wars ?? [];
  const form = new ActionFormData().title("Войны");
  form.body(wars.length ? "Нажмите на войну, чтобы открыть её летопись." : "§7Войн ещё не было.");
  for (const w of wars) {
    const dur = Math.round(((w.end ?? Date.now()) - w.t) / 60000);
    form.button(w.end ? `${w.an} — ${w.bn}\n§8окончена: ${w.result.slice(0, 40)}` : `§c${w.an} — ${w.bn}\n§4идёт ${dur} мин`);
  }
  form.button("Назад");
  show(pl, form, (res) => {
    const w = wars[res.selection ?? -1];
    if (w) showWar(pl, w);
    else if (res.selection === wars.length) showJournal(pl);
  });
}

function showWar(pl, w) {
  const body = [`§l${w.an} против ${w.bn}§r`, w.end ? `Итог: ${w.result}` : "§cВойна идёт", "", ...w.log.slice().reverse().map(line)].join("\n");
  show(pl, new ActionFormData().title("Летопись войны").body(body).button("Назад"), (res) => {
    if (res.selection === 0) showWars(pl);
  });
}
