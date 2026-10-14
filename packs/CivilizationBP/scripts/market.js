import { world } from "@minecraft/server";
import { S, markDirty } from "./core.js";
import { ERAS, popOf, missingQueue } from "./society.js";
import { remainingCost, foodCap } from "./workers.js";
import { note } from "./journal.js";
import { wallLeft, WALL_STONE } from "./walls.js";
import { glassGoal } from "./industry.js";
import { has } from "./society.js";

// Общий рынок с «торговым домом»: поселения продают ему излишки и покупают то, чего не хватает.
// Цена каждого товара зависит от запаса на рынке: товара мало — дорого, много — дёшево.
// price = БАЗА × (ЦЕЛЕВОЙ_ЗАПАС / (запас + 1))^0.6 — нижнего предела нет (рынок есть рынок),
// сверху цена ограничена БАЗА×5, чтобы редкий товар не стал совсем недоступным.
export const BASE = { wood: 1, stone: 1, dirt: 0.5, andesite: 1.5, food: 2, coal: 4, saplings: 6, sand: 1.5, glass: 4, iron: 64, diamond: 512 };
const TARGET = { wood: 600, stone: 600, dirt: 600, andesite: 300, food: 300, coal: 120, saplings: 30, sand: 400, glass: 300, iron: 30, diamond: 4 };
const CAP = { wood: 200, stone: 200, dirt: 200, andesite: 120, food: 80, coal: 20, saplings: 10, sand: 128, glass: 160, iron: 10, diamond: 2 };
export const GOOD_NAME = { wood: "дерево", stone: "камень", dirt: "земля", andesite: "андезит", food: "еда", coal: "уголь", saplings: "саженцы", sand: "песок", glass: "стекло", iron: "железо", diamond: "алмазы" };
const BID = 0.8;
const SOCIAL_SAPLINGS = 20; // бесплатных саженцев в фонде на весь мир
const SOCIAL_PER_CIV = 4; // одному поселению — не больше 4 // рынок покупает дешевле, чем продаёт (его доля)

export function loadMarket() {
  try {
    S.market = JSON.parse(String(world.getDynamicProperty("civ:market") ?? "null"));
  } catch {}
  // Торговцев со стороны нет: на рынке только то, что продали сами поселения. В новом мире рынок пуст.
  if (!S.market) S.market = { stock: Object.fromEntries(Object.keys(TARGET).map((k) => [k, 0])), prev: {} };
  for (const k of Object.keys(TARGET)) if (!Number.isFinite(S.market.stock[k])) S.market.stock[k] = 0;
  // Социальный фонд: 20 бесплатных саженцев на весь мир, не пополняется.
  if (S.market.social === undefined) S.market.social = SOCIAL_SAPLINGS;
}

export function saveMarket() {
  try {
    world.setDynamicProperty("civ:market", JSON.stringify(S.market));
  } catch {}
}

export function price(k) {
  const st = S.market.stock[k] ?? 0;
  const p = BASE[k] * Math.pow(TARGET[k] / (st + 1), 0.6);
  return Math.min(BASE[k] * 5, p);
}

/** Чего поселению реально не хватает прямо сейчас (а не «на всякий случай»). */
function needsOf(civ) {
  const need = {};
  const rc = remainingCost(civ);
  const map = { дерево: "wood", камень: "stone", железо: "iron", еда: "food", стекло: "glass", песок: "sand", земля: "dirt" };
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
  // Дорога встала из-за материала.
  if (civ.roadNeed) need[civ.roadNeed] = Math.max(need[civ.roadNeed] ?? 0, 40);
  // Есть места под факелы и фонари, а факелов нет — нужен уголь (1 уголь = 4 факела).
  const lights = civ.lights?.length ?? 0;
  if (lights > (civ.res.torches ?? 0) && !(civ.res.coal > 0)) need.coal = Math.ceil((lights - (civ.res.torches ?? 0)) / 4);
  // Индустриализация: стекло на небоскрёб. Есть завод, но нет песка рядом — покупают песок
  // (он дешевле), иначе сразу стекло; для плавки нужен уголь.
  const gShort = glassGoal(civ) - (civ.res.glass ?? 0);
  if (gShort > 0 && !need.glass) {
    if (has(civ, "glassworks") && !civ.sandAt) need.sand = Math.max(0, gShort - (civ.res.sand ?? 0));
    else if (!has(civ, "glassworks")) need.glass = gShort;
  }
  if (has(civ, "glassworks") && (civ.res.sand ?? 0) > 0 && !(civ.res.coal > 0)) need.coal = Math.max(need.coal ?? 0, Math.ceil(civ.res.sand / 8));
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
    // Стена важнее продажи излишков: камень на неё не продают.
    stone: Math.max(rc.stone, next.stone ?? 0) + 60 + Math.min(2000, wallLeft(civ) * WALL_STONE),
    food: pop * 4 + 10,
    saplings: 4,
    andesite: civ.era >= 1 ? 60 : 0,
    coal: Math.ceil((civ.lights?.length ?? 0) / 4) + 4,
    iron: Math.max(rc.iron, next.iron ?? 0) + 8,
    glass: glassGoal(civ),
    dirt: (rc.dirt ?? 0) + 40, // запас земли на выравнивание следующих площадок
    sand: has(civ, "glassworks") ? 1e9 : 0, // песок с заводом идёт в плавку
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


function sell(civ, k, qty) {
  if (qty <= 0) return 0;
  const got = Math.floor(price(k) * BID * qty);
  if (got <= 0) return 0; // за бесценок не продают
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
    civ._short = 0;
    civ.unmet = {};
    // Попросили скидку по кредиту — рынок для них закрыт до полной выплаты.
    if (civ.marketBan) {
      for (const k in need) if (need[k] > 0) civ.unmet[k] = need[k];
      continue;
    }
    // Нет леса — сначала бесплатные саженцы из социального фонда (по 4 на поселение, пока фонд не кончится).
    if (need.saplings > 0 && (S.market.social ?? 0) > 0 && (civ.socialTaken ?? 0) < SOCIAL_PER_CIV) {
      const q = Math.min(need.saplings, SOCIAL_PER_CIV - (civ.socialTaken ?? 0), S.market.social);
      S.market.social -= q;
      civ.socialTaken = (civ.socialTaken ?? 0) + q;
      civ.res.saplings = (civ.res.saplings ?? 0) + q;
      need.saplings -= q;
      deals.push(`получили ${q} саженцев из социального фонда бесплатно (в фонде осталось ${S.market.social})`);
    }
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
      // Не смогли купить всё нужное: нет денег — повод взять кредит; нет товара — повод воевать.
      if (b.qty < need[k]) {
        civ.unmet[k] = need[k] - b.qty;
        const stock = Math.floor(S.market.stock[k] ?? 0);
        if (stock > b.qty) civ._short += Math.ceil(price(k) * Math.min(need[k] - b.qty, stock - b.qty));
      }
    }
    // Склады ломятся — продают часть излишков (кроме камня, нужного на стену).
    for (const k of ["wood", "stone", "dirt", "andesite", "food", "sand", "glass"]) {
      if (k === "stone" && wallLeft(civ) > 0) continue;
      if (spare[k] > 400) {
        const q = Math.min(CAP[k], Math.floor(spare[k] / 6));
        const got = sell(civ, k, q);
        if (got > 0) deals.push(`продали излишки: ${q} ${GOOD_NAME[k]} за ${got} мон.`);
      }
    }
    if (deals.length) {
      const text = deals.join("; ");
      log(civ, text);
      note("market", `${civ.name}: ${text}`);
    }
    markDirty(civ);
  }
  saveMarket();
}

/** Продать излишки, чтобы набрать нужную сумму (для выплаты долга). Возвращает вырученное. */
export function raiseCoins(civ, amount) {
  if (civ.marketBan) return 0;
  const spare = spareOf(civ);
  let got = 0;
  for (const r of Object.keys(spare).sort((a, b) => spare[b] * price(b) - spare[a] * price(a))) {
    if (got >= amount || spare[r] <= 0) continue;
    const q = Math.min(spare[r], Math.ceil((amount - got) / (price(r) * BID)), CAP[r]);
    got += sell(civ, r, q);
  }
  return got;
}

/** Текст для меню рынка. */
export function marketText() {
  const lines = ["§lЦены (монет за 1 шт.)§r — растут, когда товара мало:"];
  for (const k of Object.keys(BASE)) {
    const p = price(k);
    const prev = S.market.prev?.[k] ?? p;
    const arrow = p > prev * 1.01 ? "§cдорожает" : p < prev * 0.99 ? "§aдешевеет" : "";
    lines.push(`${GOOD_NAME[k]}: §e${p < 1 ? p.toFixed(2) : p < 10 ? p.toFixed(1) : Math.round(p)}§r ${arrow}§r  §8(на рынке ${Math.floor(S.market.stock[k] ?? 0)})`);
  }
  lines.push(`§8Торговцев со стороны нет: товар появляется, только когда его продаст поселение.§r`);
  lines.push(`Социальный фонд саженцев: §e${S.market.social ?? 0}§r (бесплатно, по ${SOCIAL_PER_CIV} на поселение)`);
  lines.push("", "§lКазна поселений:§r");
  for (const c of S.civs.values()) lines.push(`${c.color}${c.name}§r: ${Math.floor(c.coins ?? 0)} мон.`);
  return lines.join("\n");
}
