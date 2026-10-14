import { world } from "@minecraft/server";
import { S, DIM, loaded, markDirty, playersNear, dXZ } from "./core.js";
import { has } from "./society.js";
import { note } from "./journal.js";
import { hasTech } from "./progress.js";

// ---------- Караваны и морская торговля ----------
// Купленный у соседа товар не появляется мгновенно: если поселения связаны дорогой, его везёт
// караван (лама с поклажей идёт по дороге), а если у обоих есть пристань — корабль по морю.
// В пути караван могут ограбить бандиты (на море — пираты). Без дороги и пристаней — как раньше.
const SPEED = 2; // блоков в секунду по дороге
const SEA_SPEED = 4;
const ROBBERY = { land: 0.04, sea: 0.02 };
const NAME = { wood: "дерева", stone: "камня", dirt: "земли", andesite: "андезита", food: "еды", coal: "угля", saplings: "саженцев", sand: "песка", glass: "стекла", iron: "железа", diamond: "алмазов", wool: "шерсти", leather: "кожи" };

export function loadCaravans() {
  try {
    S.caravans = JSON.parse(String(world.getDynamicProperty("civ:caravans") ?? "[]"));
  } catch {
    S.caravans = [];
  }
}

export function saveCaravans() {
  try {
    world.setDynamicProperty("civ:caravans", JSON.stringify((S.caravans ?? []).slice(-60)));
  } catch {}
}

const roadOf = (a, b) => (S.roads ?? []).find((r) => ((r.a === a.id && r.b === b.id) || (r.a === b.id && r.b === a.id)) && r.done && !r.done.includes("0"));

/**
 * Можно ли везти товар от seller к buyer и как долго (секунд). null — доставка мгновенная (нет пути).
 */
export function routeOf(seller, buyer) {
  const r = roadOf(seller, buyer);
  const fast = hasTech(buyer, "logistics") || hasTech(seller, "logistics") ? 2 : 1;
  if (r) return { kind: "land", road: { a: r.a, b: r.b }, dur: Math.ceil(r.done.length / (SPEED * fast)) };
  if (has(seller, "pier") && has(buyer, "pier")) return { kind: "sea", dur: Math.ceil(dXZ(seller.center, buyer.center) / (SEA_SPEED * fast)) };
  return null;
}

/** Сколько товара k уже едет в это поселение. */
export const transitOf = (civ, k) => (S.caravans ?? []).reduce((n, c) => n + (c.to === civ.id && c.k === k ? c.qty : 0), 0);

/** Отправить караван с купленным товаром. */
export function sendCaravan(seller, buyer, k, qty, route) {
  S.caravans = S.caravans ?? [];
  S.caravans.push({ from: seller.id, to: buyer.id, k, qty, kind: route.kind, road: route.road, t0: S.clock, eta: S.clock + route.dur });
}

/** Раз в секунду: караваны в пути, прибытие, грабежи; ламы-караваны видны рядом с игроком. */
export function caravanTick() {
  const list = S.caravans ?? [];
  if (!list.length) return;
  const keep = [];
  for (const c of list) {
    const buyer = S.civs.get(c.to);
    if (!buyer) {
      dropLlama(c);
      continue;
    }
    if (S.clock < c.eta) {
      moveLlama(c);
      keep.push(c);
      continue;
    }
    dropLlama(c);
    const guarded = buyer.techs?.includes("logistics") ? 0.5 : 1;
    if (Math.random() < ROBBERY[c.kind] * guarded) {
      note("market", `${buyer.name}: ${c.kind === "sea" ? "пираты" : "бандиты"} ограбили караван — пропало ${c.qty} ${NAME[c.k] ?? c.k}`);
      continue;
    }
    buyer.res[c.k] = (buyer.res[c.k] ?? 0) + c.qty;
    markDirty(buyer);
  }
  S.caravans = keep;
  if (S.clock % 10 === 0) saveCaravans();
}

// Лама-караван: только для глаз игрока, товар считается по времени, а не по ламе.
const llamas = new Map();
function dropLlama(c) {
  const key = `${c.from}>${c.to}>${c.t0}>${c.k}`;
  const e = llamas.get(key);
  if (e) {
    try {
      e.remove();
    } catch {}
    llamas.delete(key);
  }
}

let polyPointRef = null;
export function setPolyPoint(fn) {
  polyPointRef = fn;
}

function moveLlama(c) {
  if (c.kind !== "land" || !polyPointRef) return;
  const r = (S.roads ?? []).find((x) => x.a === c.road?.a && x.b === c.road?.b);
  if (!r) return;
  const n = r.done.length - 1;
  const t = Math.min(1, (S.clock - c.t0) / Math.max(1, c.eta - c.t0));
  // Идёт от продавца к покупателю.
  const i = Math.round(r.a === c.from ? t * n : (1 - t) * n);
  const p = polyPointRef(r, i);
  const y = (r.y1 + r.y2) / 2;
  const key = `${c.from}>${c.to}>${c.t0}>${c.k}`;
  const dim = DIM();
  const pos = { x: p.x + 0.5, y: Math.round(y) + 1, z: p.z + 0.5 };
  let e = llamas.get(key);
  const near = loaded(dim, pos) && playersNear(pos, 64).length > 0;
  if (!near) {
    if (e) dropLlama(c);
    return;
  }
  try {
    if (!e || !e.isValid) {
      e = dim.spawnEntity("minecraft:llama", pos);
      e.nameTag = `§6Караван: ${c.qty} ${NAME[c.k] ?? c.k}`;
      e.setDynamicProperty("civ:caravan", 1);
      llamas.set(key, e);
    } else e.teleport(pos);
  } catch {}
}

/** Ламы-караваны, оставшиеся от прошлого запуска, убираем. */
export function cleanupCaravanLlamas() {
  try {
    for (const e of DIM().getEntities({ type: "minecraft:llama" })) {
      try {
        if (e.getDynamicProperty("civ:caravan") && ![...llamas.values()].includes(e)) e.remove();
      } catch {}
    }
  } catch {}
}

export function caravanText(civ) {
  const mine = (S.caravans ?? []).filter((c) => c.to === civ.id || c.from === civ.id);
  if (!mine.length) return "нет";
  return mine
    .slice(0, 4)
    .map((c) => `${c.to === civ.id ? "везут сюда" : "везут в " + (S.civs.get(c.to)?.name ?? "?")} ${c.qty} ${NAME[c.k] ?? c.k} (${c.kind === "sea" ? "морем" : "по дороге"}, ${Math.max(0, c.eta - S.clock)} с)`)
    .join("; ");
}
