import { world } from "@minecraft/server";
import { S, markDirty } from "./core.js";
import { ERAS, popOf, missingQueue } from "./society.js";
import { remainingCost, foodCap } from "./workers.js";
import { note } from "./journal.js";
import { money, fmtCoins, transfer, MIN_PRICE } from "./money.js";
import { COINS_PER_GOLD } from "./mine.js";
import { RATE } from "./offscreen.js";
import { wallLeft, WALL_STONE } from "./walls.js";
import { glassGoal } from "./industry.js";
import { has, START_COINS } from "./society.js";

// Рынок — прямая торговля между поселениями (биржа). Излишки выставляют лотами: товар
// откладывают со склада, монеты продавец получает, только когда кто-то купит. Покупатель берёт
// у самого дешёвого продавца, монеты уходят продавцу. Монеты не берутся из ниоткуда —
// они только переходят из казны в казну.
// Цена: продавец ставит чуть дешевле конкурентов (или по цене последней сделки, если конкурентов нет);
// непроданный лот каждую минуту дешевеет на 10% — нижнего предела нет. Товар нужен, а его нет —
// цена последней сделки растёт на 5% (до ×5 базовой).
export const BASE = { wood: 1, stone: 1, dirt: 0.5, andesite: 1.5, food: 2, coal: 4, saplings: 6, sand: 1.5, glass: 4, iron: 64, diamond: 512 };
const CAP = { wood: 200, stone: 200, dirt: 200, andesite: 120, food: 80, coal: 20, saplings: 10, sand: 128, glass: 160, iron: 10, diamond: 2 };
const LOT_MAX = { wood: 600, stone: 600, dirt: 600, andesite: 300, food: 200, coal: 100, saplings: 40, sand: 400, glass: 400, iron: 40, diamond: 8 };
export const GOOD_NAME = { wood: "дерево", stone: "камень", dirt: "земля", andesite: "андезит", food: "еда", coal: "уголь", saplings: "саженцы", sand: "песок", glass: "стекло", iron: "железо", diamond: "алмазы" };
// С какого излишка (сверх своих нужд) товар выставляют на продажу.
const SELL_FROM = { food: 10, wood: 60, stone: 60, dirt: 60, andesite: 30, coal: 10, saplings: 8, sand: 40, glass: 40, iron: 8, diamond: 2 };
const SOCIAL_SAPLINGS = 20; // бесплатных саженцев в фонде на весь мир
const SOCIAL_PER_CIV = 4; // одному поселению — не больше 4

export function loadMarket() {
  try {
    S.market = JSON.parse(String(world.getDynamicProperty("civ:market") ?? "null"));
  } catch {}
  if (!S.market) S.market = { lots: [], last: {}, prev: {} };
  S.market.last = S.market.last ?? {};
  // Старый рынок с «торговым домом»: его запасы распродаются как лоты без хозяина (монеты за них исчезают).
  if (!S.market.lots) {
    S.market.lots = [];
    for (const [k, q] of Object.entries(S.market.stock ?? {})) {
      if (BASE[k] && q >= 1) S.market.lots.push({ civ: null, k, qty: Math.floor(q), price: BASE[k], t: S.clock });
    }
  }
  delete S.market.stock;
  // Один раз в старом мире: всем поселениям казна доводится до начальной (200 монет).
  if (!S.market.start200) {
    S.market.start200 = true;
    for (const c of S.civs.values()) {
      if ((c.coins ?? 0) < START_COINS) c.coins = START_COINS;
      markDirty(c);
    }
  }
  // Социальный фонд: 20 бесплатных саженцев на весь мир, не пополняется.
  if (S.market.social === undefined) S.market.social = SOCIAL_SAPLINGS;
}

export function saveMarket() {
  try {
    world.setDynamicProperty("civ:market", JSON.stringify(S.market));
  } catch {}
}

const lotsOf = (k, except) => S.market.lots.filter((l) => l.k === k && l.qty > 0 && l.civ !== except).sort((a, b) => a.price - b.price);
export const stockOf = (k) => S.market.lots.reduce((n, l) => n + (l.k === k ? l.qty : 0), 0);

/** Справочная цена: самый дешёвый лот, а если лотов нет — цена последней сделки. */
export function price(k) {
  const best = lotsOf(k)[0];
  return best ? best.price : S.market.last[k] ?? BASE[k];
}

const sellerName = (l) => (l.civ ? S.civs.get(l.civ)?.name ?? "?" : "старый торговый дом");

/** Выставить товар на продажу: он уходит со склада в лот, монеты — когда купят. */
function post(civ, k, qty) {
  qty = Math.floor(Math.min(qty, civ.res[k] ?? 0));
  if (qty <= 0) return 0;
  let lot = S.market.lots.find((l) => l.civ === civ.id && l.k === k);
  qty = Math.min(qty, LOT_MAX[k] - (lot?.qty ?? 0));
  if (qty <= 0) return 0;
  const rival = lotsOf(k, civ.id)[0];
  const ask = money(Math.max(MIN_PRICE, rival ? rival.price * 0.98 : Math.min(BASE[k] * 5, (S.market.last[k] ?? BASE[k]) * 1.05)));
  civ.res[k] -= qty;
  if (!lot) {
    lot = { civ: civ.id, k, qty: 0, price: ask, t: S.clock };
    S.market.lots.push(lot);
  }
  lot.qty += qty;
  lot.price = Math.min(lot.price, ask);
  return qty;
}

// ---------- Где взять монеты ----------
// Налог: каждый житель приносит казне 0.5 монеты в минуту.
export const TAX_PER_MIN = 0.5;
export function taxTick(civ, minutes) {
  const pop = popOf(civ);
  if (pop > 0) civ.coins = money((civ.coins ?? 0) + pop * TAX_PER_MIN * minutes);
}

/** Важность покупки: чем больше, тем раньше на неё тратят монеты. */
function priorityOf(civ, k) {
  if (k === "food" && civ.starving) return 100;
  if ((civ.upkeep?.debt?.[k] ?? 0) > 0) return 80;
  const map = { дерево: "wood", камень: "stone", железо: "iron", еда: "food", стекло: "glass", песок: "sand", земля: "dirt" };
  if (map[civ.waiting] === k) return 60;
  if (k === "saplings") return 50;
  if (k === "stone" || k === "iron") return 40;
  if (k === "coal") return 30;
  return 20;
}

/** Сколько монет в минуту приносит один шахтёр на золоте (каменная кирка, по формуле фоновой добычи). */
const goldPerMinerMin = () => RATE.blocks(1) * RATE.eff * 0.003 * 2 * COINS_PER_GOLD;

/**
 * Монет не хватает на всё нужное — поселение решает, что выгоднее прямо сейчас:
 * продать излишки, на которые есть спрос (их купят быстро и по рыночной цене),
 * и/или отправить шахтёров за золотом (если есть каменная кирка). Решение — в журнале.
 */
function planCoins(civ, need, spare, deals) {
  let cost = 0;
  for (const k of Object.keys(need)) if (need[k] > 0 && stockOf(k) > 0) cost += price(k) * Math.min(need[k], stockOf(k));
  const gap = money(cost - (civ.coins ?? 0));
  if (gap <= 0) {
    if (civ.coinPlan) civ.coinPlan = "";
    return;
  }
  // Спрос на каждый товар — сколько его не смогли купить другие поселения.
  const demand = {};
  for (const o of S.civs.values()) if (o !== civ) for (const [k, v] of Object.entries(o.unmet ?? {})) demand[k] = (demand[k] ?? 0) + v;
  const offers = Object.keys(spare)
    .filter((r) => spare[r] > 0 && !need[r])
    .map((r) => ({ r, q: Math.min(spare[r], CAP[r], Math.max(demand[r] ?? 0, 0)), all: Math.min(spare[r], CAP[r]) }))
    .map((o) => ({ ...o, income: o.q * price(o.r) }))
    .sort((a, b) => b.income - a.income);
  let sellIncome = 0;
  const sold = [];
  for (const o of offers) {
    if (sellIncome >= gap) break;
    const q = post(civ, o.r, o.q > 0 ? o.q : o.all);
    if (q > 0) {
      spare[o.r] -= q;
      sellIncome += o.q > 0 ? q * price(o.r) : 0;
      sold.push(`${q} ${GOOD_NAME[o.r]}`);
    }
  }
  if (sold.length) deals.push(`выставили на продажу ${sold.join(", ")}`);
  // Продажей не закрыть — выгоднее ли золото? (нужна каменная кирка)
  const gold = (civ.census?.tiers?.miner ?? 0) >= 2 ? goldPerMinerMin() * 2 : 0;
  const left = gap - sellIncome;
  let plan;
  if (left > 0 && gold > 0) {
    civ.goldRush = S.clock + 600;
    plan = `не хватает ${fmtCoins(gap)} мон.: продажа излишков даст ~${fmtCoins(money(sellIncome))}, остальное выгоднее добыть золотом — 2 шахтёра идут за золотом (~${Math.round(gold)} мон./мин)`;
  } else if (left > 0) {
    plan = `не хватает ${fmtCoins(gap)} мон.: продажа излишков даст ~${fmtCoins(money(sellIncome))}, золото пока недоступно (нужна каменная кирка) — копят налогами`;
  } else plan = `не хватает ${fmtCoins(gap)} мон.: выгоднее продать излишки (${sold.join(", ")})`;
  const key = plan.replace(/[0-9.~]+/g, "");
  if (civ.coinPlanKey !== key) {
    civ.coinPlanKey = key;
    note("market", `${civ.name}: ${plan}`);
  }
  civ.coinPlan = plan;
}

/** Купить у самых дешёвых продавцов. */
function buy(civ, k, qty) {
  let got = 0;
  let cost = 0;
  const from = [];
  for (const l of lotsOf(k, civ.id)) {
    if (got >= qty) break;
    // Цена и суммы — с точностью до 0.000001 монеты; покупатель платит ровно столько, сколько получает продавец.
    let q = Math.min(qty - got, l.qty, Math.floor(money(civ.coins ?? 0) / l.price + 1e-9));
    while (q > 0 && money(q * l.price) > money(civ.coins ?? 0)) q--;
    if (q <= 0) break;
    const seller = l.civ ? S.civs.get(l.civ) : undefined;
    const c = transfer(civ, seller, q * l.price); // лот «старого торгового дома» — монеты уходят из оборота
    l.qty -= q;
    got += q;
    cost = money(cost + c);
    S.market.last[k] = l.price;
    if (seller) {
      markDirty(seller);
      const text = `продали ${q} ${GOOD_NAME[k]} поселению ${civ.name} за ${fmtCoins(c)} мон.`;
      log(seller, text);
      note("market", `${seller.name}: ${text}`);
    }
    from.push(`${q} у ${sellerName(l)}`);
  }
  civ.res[k] = (civ.res[k] ?? 0) + got;
  if (k === "food") civ.res.food = Math.min(civ.res.food, foodCap(civ));
  return { qty: got, cost, from: from.join(", ") };
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
  // Долг по содержанию зданий — недостающие ресурсы докупают на рынке за монеты.
  for (const [k, v] of Object.entries(civ.upkeep?.debt ?? {})) if (v > 0 && CAP[k]) need[k] = Math.max(need[k] ?? 0, v);
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


/**
 * Раз в 30 секунд для каждого поселения: торгуют только по нужде.
 * Не хватает денег — продают свои излишки; склады переполнены — продают часть лишнего.
 */
export function marketTick() {
  S.market.prev = Object.fromEntries(Object.keys(BASE).map((k) => [k, price(k)]));
  for (const civ of S.civs.values()) {
    if (popOf(civ) <= 0) continue;
    civ.coins = civ.coins ?? START_COINS;
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
    // Свой лот с товаром, который теперь нужен самим, — снимают с продажи.
    // (ниже — план, где взять монеты, если их не хватает на всё нужное)
    for (const l of S.market.lots) {
      if (l.civ !== civ.id || !(need[l.k] > 0) || l.qty <= 0) continue;
      const q = Math.min(l.qty, need[l.k]);
      l.qty -= q;
      civ.res[l.k] = (civ.res[l.k] ?? 0) + q;
      need[l.k] -= q;
    }
    planCoins(civ, need, spare, deals);
    // Покупают по важности: еда при голоде, долг по содержанию, стройка, новая эпоха, остальное.
    for (const k of Object.keys(need).sort((a, b) => priorityOf(civ, b) - priorityOf(civ, a))) {
      if (need[k] <= 0) continue;
      const cost = Math.ceil(price(k) * need[k]);
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
      if (b.qty > 0) deals.push(`купили ${GOOD_NAME[k]}: ${b.from} — за ${fmtCoins(b.cost)} мон.`);
      // Не смогли купить всё нужное: нет денег — повод взять кредит; нет товара — повод воевать.
      if (b.qty < need[k]) {
        civ.unmet[k] = need[k] - b.qty;
        const stock = stockOf(k);
        if (stock > 0) civ._short += Math.ceil(price(k) * Math.min(need[k] - b.qty, stock));
        // Товара нет совсем — он дорожает.
        else S.market.last[k] = money(Math.min(BASE[k] * 5, (S.market.last[k] ?? BASE[k]) * 1.05));
      }
    }
    // Излишки сверх своего запаса выставляют на продажу (кроме камня, пока строится стена).
    // Порог небольшой: еду, например, продают, как только её больше, чем нужно своим на 4 приёма.
    for (const k of Object.keys(SELL_FROM)) {
      if (k === "stone" && wallLeft(civ) > 0) continue;
      if (spare[k] >= SELL_FROM[k]) {
        const q = post(civ, k, Math.min(CAP[k], Math.ceil(spare[k] / 2)));
        if (q > 0) deals.push(`выставили излишки: ${q} ${GOOD_NAME[k]}`);
      }
    }
    if (deals.length) {
      const text = deals.join("; ");
      log(civ, text);
      note("market", `${civ.name}: ${text}`);
    }
    markDirty(civ);
  }
  // Непроданное дешевеет; лоты исчезнувших поселений пропадают.
  for (const l of S.market.lots) {
    if (S.clock - (l.t ?? 0) >= 60) {
      l.price = money(Math.max(MIN_PRICE, l.price * 0.9));
      l.t = S.clock;
    }
  }
  S.market.lots = S.market.lots.filter((l) => l.qty > 0 && (l.civ === null || S.civs.has(l.civ)));
  saveMarket();
}

/** Выставить излишки, чтобы набрать нужную сумму (для выплаты долга). Монеты придут, когда купят. */
export function raiseCoins(civ, amount) {
  if (civ.marketBan) return 0;
  const spare = spareOf(civ);
  let worth = 0;
  for (const r of Object.keys(spare).sort((a, b) => spare[b] * price(b) - spare[a] * price(a))) {
    if (worth >= amount || spare[r] <= 0) continue;
    const q = post(civ, r, Math.min(spare[r], Math.ceil((amount - worth) / Math.max(0.01, price(r))), CAP[r]));
    worth += q * price(r);
  }
  return 0;
}

/** Текст для меню рынка. */
export function marketText() {
  const lines = ["§lБиржа (монет за 1 шт.)§r — самый дешёвый продавец:"];
  for (const k of Object.keys(BASE)) {
    const p = price(k);
    const prev = S.market.prev?.[k] ?? p;
    const arrow = p > prev * 1.01 ? "§cдорожает" : p < prev * 0.99 ? "§aдешевеет" : "";
    const best = lotsOf(k)[0];
    const who = best ? ` у ${sellerName(best)}` : " §8(нет в продаже)";
    lines.push(`${GOOD_NAME[k]}: §e${fmtCoins(p)}§r${who}§r ${arrow}§r  §8(всего ${stockOf(k)})`);
  }
  lines.push(`§8Торгуют только поселения между собой: монеты переходят от покупателя к продавцу.§r`);
  lines.push(`Социальный фонд саженцев: §e${S.market.social ?? 0}§r (бесплатно, по ${SOCIAL_PER_CIV} на поселение)`);
  lines.push("", "§lКазна поселений:§r");
  for (const c of S.civs.values()) lines.push(`${c.color}${c.name}§r: ${fmtCoins(c.coins ?? 0)} мон.`);
  return lines.join("\n");
}

/** Покупка у самых дешёвых продавцов (для проверок и других модулей). */
export const marketBuy = (civ, k, qty) => buy(civ, k, qty);
