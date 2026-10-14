import { S, markDirty, announce } from "./core.js";
import { getBP } from "./blueprints.js";
import { price, GOOD_NAME } from "./market.js";
import { note } from "./journal.js";
import { money, fmtCoins } from "./money.js";

// ---------- Содержание зданий ----------
// Каждые 10 минут РЕАЛЬНОГО времени (по часам устройства, а не по игровым суткам и не по скорости
// симуляции) поселение платит за содержание своих зданий 6% от их стоимости строительства.
// Платят только ресурсами со склада, монеты не трогают.
//
// Все числа — здесь, их можно менять.
export const UPKEEP = {
  RATE: 1.0, // доля стоимости строительства за один период (1.0 = 100%)
  PERIOD_SEC: 600, // длина периода в секундах реального времени
  // Чем платить:
  //  "build" — теми же ресурсами, из которых построены здания, в той же пропорции
  //            (6% каждого ресурса; по рыночным ценам это ровно 6% стоимости);
  //  объект долей, например { wood: 0.5, stone: 0.5 } — стоимость содержания в монетах
  //            (по рыночным ценам) делится по этим долям и переводится обратно в ресурсы.
  MIX: "build",
  MAX_PERIODS: 288, // больше стольких пропущенных периодов разом не начисляют (48 часов)
  REPAY_EVERY_SEC: 10, // как часто долг гасится из новых поступлений
};

const SKIP = new Set(["mine", "quarry"]);
const PERIOD_MS = () => UPKEEP.PERIOD_SEC * 1000;
export const periodOf = (ms) => Math.floor(ms / PERIOD_MS());

/** Стоимость строительства здания по чертежу (ресурсы). */
export function buildCost(t) {
  const c = {};
  for (const op of getBP(t).ops) for (const k in op.cost ?? {}) c[k] = (c[k] ?? 0) + op.cost[k];
  return c;
}

/** Зафиксировать стоимость здания (при постройке; старым зданиям — по чертежу при первом расчёте). */
export function fixCost(b) {
  if (!b.cost) b.cost = buildCost(b.t);
  return b.cost;
}

/**
 * Общая стоимость строительства всех зданий поселения (ресурсы): построенные и те, что уже
 * построены в фоновой симуляции (вдали от игрока) и ещё не появились в мире.
 */
export function totalBuildCost(civ) {
  const sum = {};
  for (const b of [...civ.buildings, ...(civ.offQueue ?? [])]) {
    if (SKIP.has(b.t)) continue;
    for (const [k, v] of Object.entries(fixCost(b))) sum[k] = (sum[k] ?? 0) + v;
  }
  return sum;
}

/** Стоимость в монетах по рыночным ценам (точность 6 знаков). */
export const valueOf = (res) => money(Object.entries(res).reduce((s, [k, v]) => s + v * price(k), 0));

/**
 * Сколько ресурсов составляет содержание за один период (дробные количества).
 * Возвращает { need: {ресурс: количество}, value: стоимость в монетах }.
 */
export function upkeepFor(civ) {
  const cost = totalBuildCost(civ);
  const value = money(valueOf(cost) * UPKEEP.RATE);
  const need = {};
  if (UPKEEP.MIX === "build") {
    for (const [k, v] of Object.entries(cost)) if (v > 0) need[k] = v * UPKEEP.RATE;
  } else {
    // Доли от стоимости: количество = стоимость × доля / цена ресурса.
    const shares = Object.entries(UPKEEP.MIX).filter(([, s]) => s > 0);
    const total = shares.reduce((s, [, x]) => s + x, 0) || 1;
    for (const [k, s] of shares) need[k] = (value * (s / total)) / Math.max(1e-6, price(k));
  }
  return { need, value };
}

function state(civ) {
  civ.upkeep = civ.upkeep ?? { period: undefined, debt: {}, frac: {}, last: null };
  civ.upkeep.debt = civ.upkeep.debt ?? {};
  civ.upkeep.frac = civ.upkeep.frac ?? {};
  return civ.upkeep;
}

/** Отрицательных запасов не бывает: платят не больше, чем есть. */
function payFrom(civ, k, want) {
  const have = Math.max(0, Math.floor(civ.res[k] ?? 0));
  const paid = Math.min(have, want);
  if (paid > 0) civ.res[k] = (civ.res[k] ?? 0) - paid;
  return paid;
}

const listRes = (o) =>
  Object.entries(o)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${GOOD_NAME[k] ?? k} ${v}`)
    .join(", ");

/** Списание за один период. */
function chargePeriod(civ) {
  const st = state(civ);
  const { need, value } = upkeepFor(civ);
  const due = {};
  // Ресурсы — штучные: дробные доли копятся и доплачиваются в следующих периодах.
  for (const [k, q] of Object.entries(need)) {
    const t = (st.frac[k] ?? 0) + q;
    const whole = Math.floor(t + 1e-9);
    st.frac[k] = Math.max(0, t - whole);
    if (whole > 0) due[k] = whole;
  }
  const paid = {};
  for (const [k, q] of Object.entries(due)) {
    const p = payFrom(civ, k, q);
    if (p) paid[k] = p;
    if (q - p > 0) st.debt[k] = (st.debt[k] ?? 0) + (q - p);
  }
  st.last = { due, paid, value };
  markDirty(civ);
  if (!Object.keys(due).length && !Object.keys(st.debt).length) return; // зданий нет — нечего платить
  const debt = listRes(st.debt);
  note("upkeep", `${civ.name}: содержание зданий ${fmtCoins(value)} мон. — списано: ${listRes(paid) || "ничего"}${debt ? `; §cдолг: ${debt}` : ""}`);
  if (debt) {
    announce(civ, `§c[${civ.name}] Не хватает ресурсов на содержание зданий. Нужно накопить: ${debt}`, 128);
  }
}

/** Гасит долг из того, что появилось на складе. */
export function repayDebt(civ) {
  const st = civ.upkeep;
  if (!st?.debt) return;
  let any = false;
  const got = {};
  for (const [k, q] of Object.entries(st.debt)) {
    if (q <= 0) {
      delete st.debt[k];
      continue;
    }
    const p = payFrom(civ, k, q);
    if (!p) continue;
    st.debt[k] = q - p;
    got[k] = p;
    if (st.debt[k] <= 0) delete st.debt[k];
    any = true;
  }
  if (!any) return;
  markDirty(civ);
  const left = listRes(st.debt);
  note("upkeep", `${civ.name}: погашен долг по содержанию — ${listRes(got)}${left ? `; осталось: ${left}` : " — долг погашен полностью"}`);
}

/**
 * Единый процесс для всех поселений: начисляет все наступившие периоды до момента nowMs.
 * Номер последнего оплаченного периода хранится в самом поселении (вместе с его складом),
 * поэтому после перезапуска один и тот же период второй раз не списывается.
 */
export function upkeepTick(nowMs = Date.now()) {
  const p = periodOf(nowMs);
  for (const civ of S.civs.values()) {
    const st = state(civ);
    if (st.period === undefined || st.period === null) {
      st.period = p; // новое поселение (или первый запуск) — отсчёт с текущего периода
      markDirty(civ);
      continue;
    }
    if (st.period < p - UPKEEP.MAX_PERIODS) st.period = p - UPKEEP.MAX_PERIODS;
    while (st.period < p) {
      st.period++;
      chargePeriod(civ);
    }
  }
}

/** Когда следующее списание (секунд). */
export const secondsToNext = (nowMs = Date.now()) => Math.ceil(((periodOf(nowMs) + 1) * PERIOD_MS() - nowMs) / 1000);

/** Строка для меню поселения. */
export function upkeepInfo(civ) {
  const { need, value } = upkeepFor(civ);
  const per = listRes(Object.fromEntries(Object.entries(need).map(([k, v]) => [k, Math.round(v * 100) / 100])));
  const debt = listRes(civ.upkeep?.debt ?? {});
  const m = Math.floor(secondsToNext() / 60);
  const s = secondsToNext() % 60;
  return `${fmtCoins(value)} мон. раз в 10 мин (${per || "нет зданий"}), следующее через ${m}:${String(s).padStart(2, "0")}${debt ? ` §c— долг: ${debt}§r` : ""}`;
}
