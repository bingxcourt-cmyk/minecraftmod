// Деньги и цены с точностью до 6 знаков после запятой (0.000001 монеты).
// Всё, что касается монет, округляется одной функцией — так при переводе от покупателя к продавцу
// ни одна доля монеты не появляется и не пропадает: обе стороны получают одно и то же число.
export const MONEY_DP = 6;
const SCALE = 10 ** MONEY_DP;
export const MIN_PRICE = 1 / SCALE; // самая маленькая цена — 0.000001 монеты

/** Округление суммы до 6 знаков (точно для сумм до миллиардов монет). */
export const money = (x) => Math.round((Number(x) || 0) * SCALE) / SCALE;

/** Перевод монет: списывается и зачисляется одно и то же округлённое число. */
export function transfer(from, to, amount) {
  const a = money(amount);
  from.coins = money((from.coins ?? 0) - a);
  if (to) to.coins = money((to.coins ?? 0) + a);
  return a;
}

/** Запись числа без лишних нулей: 0.000012, 0.0015, 125.123456, 42. */
export function fmtCoins(x) {
  const v = money(x);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(MONEY_DP).replace(/0+$/, "").replace(/\.$/, "");
}
