import { world } from "@minecraft/server";
import { S, markDirty, playersNear } from "./core.js";
import { ERAS, popOf, missingQueue } from "./society.js";
import { remainingCost, foodCap } from "./workers.js";

// Общий рынок с «торговым домом»: поселения продают ему излишки и покупают то, чего не хватает.
// Цена каждого товара зависит от запаса на рынке: товара мало — дорого, много — дёшево.
// price = БАЗА × (ЦЕЛЕВОЙ_ЗАПАС / (запас + 1))^0.6, но не дешевле БАЗА/4 и не дороже БАЗА×5.
export const BASE = { wood: 1, stone: 1, food: 2, saplings: 6, iron: 64, diamond: 512 };
const TARGET = { wood: 600, stone: 600, food: 300, saplings: 30, iron: 30, diamond: 4 };
const CAP = { wood: 200, stone: 200, food: 80, saplings: 10, iron: 10, diamond: 2 };
export const GOOD_NAME = { wood: "дерево", stone: "камень", food: "еда", saplings: "саженцы", iron: "железо", diamond: "алмазы" };
const BID = 0.8; // рынок покупает дешевле, чем продаёт (его доля)

export function loadMarket() {
  try {
    S.market = JSON.parse(String(world.getDynamicProperty("civ:market") ?? "null"));
  } catch {}
  if (!S.market) S.market = { stock: Object.fromEntries(Object.keys(TARGET).map((k) => [k, Math.round(TARGET[k] / 2)])), prev: {} };
}

export function saveMarket() {
  try {
    world.setDynamicProperty("civ:market", JSON.stringify(S.market));
  } catch {}
}

export function price(k) {
  const st = S.market.stock[k] ?? 0;
  const p = BASE[k] * Math.pow(TARGET[k] / (st + 1), 0.6);
  return Math.max(BASE[k] / 4, Math.min(BASE[k] * 5, p));
}

/** Чего поселению реально не хватает прямо сейчас (а не «на всякий случай»). */
function needsOf(civ) {
  const need = {};
  const rc = remainingCost(civ);
  const map = { дерево: "wood", камень: "stone", железо: "iron", еда: "food" };
  // Стройка встала из-за ресурса.
  const w = map[civ.waiting];
  if (w) need[w] = Math.max(1, rc[w] - (civ.res[w] ?? 0));
  // Для новой эпохи всё построено, не хватает только камня/железа.
  const next = ERAS[civ.era].next;
  if (next && !missingQueue(civ).length) {
    for (const k of ["stone", "iron"]) {
      const short = (next[k] ?? 0) - (civ.res[k] ?? 0);
      if (short > 0) need[k] = Math.max(need[k] ?? 0, short);
    }
  }
  // Голод.
  const pop = popOf(civ);
  if (civ.res.food < pop * 2) need.food = Math.min(foodCap(civ) - civ.res.food, pop * 4 - civ.res.food);
  // Нет леса — нужны саженцы.
  if (civ.needSaplings) need.saplings = Math.max(0, 8 - (civ.res.saplings ?? 0));
  for (const k in need) need[k] = Math.min(CAP[k], Math.ceil(need[k]));
  return need;
}

/** Что можно продать, не урезая собственные нужды. */
function spareOf(civ) {
  const rc = remainingCost(civ);
  /** @type {{stone?: number, iron?: number}} */
  const next = ERAS[civ.era].next ?? {};
  const pop = popOf(civ);
  const keep = {
    wood: rc.wood + 80,
    stone: Math.max(rc.stone, next.stone ?? 0) + 60,
    food: pop * 4 + 10,
    saplings: 4,
    iron: Math.max(rc.iron, next.iron ?? 0) + 8,
    diamond: 0,
  };
  const spare = {};
  for (const k in keep) spare[k] = Math.max(0, Math.floor((civ.res[k] ?? 0) - keep[k]));
  return spare;
}

function log(civ, text) {
  civ.trades = [text, ...(civ.trades ?? [])].slice(0, 5);
  markDirty(civ);
}

function tell(civ, text) {
  for (const pl of playersNear(civ.center, 160)) pl.sendMessage(text);
}

function sell(civ, k, qty) {
  if (qty <= 0) return 0;
  const got = Math.floor(price(k) * BID * qty);
  civ.res[k] -= qty;
  civ.coins = (civ.coins ?? 0) + got;
  S.market.stock[k] = (S.market.stock[k] ?? 0) + qty;
  return got;
}

function buy(civ, k, qty) {
  const stock = Math.floor(S.market.stock[k] ?? 0);
  qty = Math.min(qty, stock, Math.floor((civ.coins ?? 0) / price(k)));
  if (qty <= 0) return { qty: 0, cost: 0 };
  const cost = Math.ceil(price(k) * qty);
  civ.coins -= cost;
  civ.res[k] = (civ.res[k] ?? 0) + qty;
  if (k === "food") civ.res.food = Math.min(civ.res.food, foodCap(civ));
  S.market.stock[k] = stock - qty;
  return { qty, cost };
}

/**
 * Раз в 30 секунд для каждого поселения: торгуют только по нужде.
 * Не хватает денег — продают свои излишки; склады переполнены — продают часть лишнего.
 */
export function marketTick() {
  S.market.prev = Object.fromEntries(Object.keys(BASE).map((k) => [k, price(k)]));
  for (const civ of S.civs.values()) {
    if (popOf(civ) <= 0) continue;
    civ.coins = civ.coins ?? 50;
    const need = needsOf(civ);
    const spare = spareOf(civ);
    const deals = [];
    for (const k of Object.keys(need)) {
      if (need[k] <= 0) continue;
      const cost = Math.ceil(price(k) * need[k]);
      // Денег не хватает: сначала продают то, чего у них лишнее (самое дорогое лишнее — первым).
      if (civ.coins < cost) {
        for (const r of Object.keys(spare).sort((a, b) => spare[b] * price(b) - spare[a] * price(a))) {
          if (r === k || need[r] || civ.coins >= cost) continue;
          const want = Math.ceil((cost - civ.coins) / (price(r) * BID));
          const q = Math.min(spare[r], want, CAP[r]);
          const got = sell(civ, r, q);
          if (got > 0) {
            spare[r] -= q;
            deals.push(`продали ${q} ${GOOD_NAME[r]} за ${got} мон.`);
          }
        }
      }
      // Колонии без денег помогает метрополия: переселенцы возвращаются за ресурсами.
      const parent = civ.parent ? S.civs.get(civ.parent) : undefined;
      if (civ.coins < cost && parent && (parent.coins ?? 0) > cost && (k === "saplings" || k === "food")) {
        const gift = Math.min(parent.coins - 20, cost - civ.coins + 10);
        if (gift > 0) {
          parent.coins -= gift;
          civ.coins += gift;
          markDirty(parent);
          deals.push(`переселенцы сходили в ${parent.name} и принесли ${gift} мон.`);
        }
      }
      const b = buy(civ, k, need[k]);
      if (b.qty > 0) deals.push(`купили ${b.qty} ${GOOD_NAME[k]} за ${b.cost} мон.`);
    }
    // Склады ломятся — продают четверть излишков (только дерево/камень/еду).
    for (const k of ["wood", "stone", "food"]) {
      if (spare[k] > 400) {
        const q = Math.min(CAP[k], Math.floor(spare[k] / 6));
        const got = sell(civ, k, q);
        if (got > 0) deals.push(`продали излишки: ${q} ${GOOD_NAME[k]} за ${got} мон.`);
      }
    }
    if (deals.length) {
      const text = deals.join("; ");
      log(civ, text);
      tell(civ, `§a[Рынок] ${civ.color}${civ.name}§a: ${text}.`);
    }
    markDirty(civ);
  }
  // Рынок понемногу сам пополняется/расходует запасы (торговцы со стороны) — цены не застывают.
  for (const k of Object.keys(TARGET)) {
    const st = S.market.stock[k] ?? 0;
    S.market.stock[k] = st + (TARGET[k] / 2 - st) * 0.06;
  }
  saveMarket();
}

/** Текст для меню рынка. */
export function marketText() {
  const lines = ["§lЦены (монет за 1 шт.)§r — растут, когда товара мало:"];
  for (const k of Object.keys(BASE)) {
    const p = price(k);
    const prev = S.market.prev?.[k] ?? p;
    const arrow = p > prev * 1.01 ? "§cдорожает" : p < prev * 0.99 ? "§aдешевеет" : "";
    lines.push(`${GOOD_NAME[k]}: §e${p < 10 ? p.toFixed(1) : Math.round(p)}§r ${arrow}§r  §8(на рынке ${Math.floor(S.market.stock[k] ?? 0)})`);
  }
  lines.push("", "§lКазна поселений:§r");
  for (const c of S.civs.values()) lines.push(`${c.color}${c.name}§r: ${Math.floor(c.coins ?? 0)} мон.`);
  return lines.join("\n");
}
