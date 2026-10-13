import { world, system } from "@minecraft/server";
import { S, DIM, getB, loaded, markDirty, playersNear, dXZ } from "./core.js";
import { groundAt, isPassableId, strip, findDrySpot } from "./blocks.js";
import { ERAS, popOf } from "./society.js";
import { remainingCost, foodCap } from "./workers.js";
import { findSafeSpot } from "./nav.js";

// ---------- Дороги между поселениями ----------
// С эпохи «Деревня» поселение прокладывает дорогу к ближайшему соседу и к своей метрополии.
// Дорога ложится по кусочкам там, где чанки загружены, и её видно, пока вы путешествуете.
const ROAD_MAX = 320; // дальше дорог не строят
const ROAD_SKIP = 5; // у центров дорогу не кладём — там своя площадка

export function loadRoads() {
  try {
    S.roads = JSON.parse(String(world.getDynamicProperty("civ:roads") ?? "[]"));
  } catch {
    S.roads = [];
  }
}

export function saveRoads() {
  try {
    world.setDynamicProperty("civ:roads", JSON.stringify(S.roads ?? []));
  } catch {}
}

const roadBetween = (a, b) => (S.roads ?? []).find((r) => (r.a === a.id && r.b === b.id) || (r.a === b.id && r.b === a.id));

/** Раз в минуту: кто с кем строит дорогу. */
export function planRoads() {
  S.roads = S.roads ?? [];
  const civs = [...S.civs.values()];
  // Поселение перенесло центр (затопление, колония встала на сушу) — дорогу ведём к новому месту,
  // если её ещё почти не начали класть на самом деле.
  for (const r of S.roads) {
    const a = S.civs.get(r.a);
    const b = S.civs.get(r.b);
    if (!a || !b) continue;
    const moved = Math.hypot(a.center.x - r.x1, a.center.z - r.z1) > 10 || Math.hypot(b.center.x - r.x2, b.center.z - r.z2) > 10;
    if (!moved || placedShare(r) > 0.5) continue;
    const n = Math.ceil(Math.max(Math.abs(b.center.x - a.center.x), Math.abs(b.center.z - a.center.z)));
    Object.assign(r, { x1: a.center.x, z1: a.center.z, x2: b.center.x, z2: b.center.z, done: "0".repeat(n + 1), cur: 0 });
  }
  for (const civ of civs) {
    if (civ.era < 1) continue;
    const targets = [];
    const parent = civ.parent ? S.civs.get(civ.parent) : undefined;
    if (parent) targets.push(parent);
    let nearest;
    let bd = ROAD_MAX;
    for (const o of civs) {
      if (o === civ) continue;
      const d = dXZ(o.center, civ.center);
      if (d < bd) {
        bd = d;
        nearest = o;
      }
    }
    if (nearest) targets.push(nearest);
    for (const o of targets) {
      if (roadBetween(civ, o) || dXZ(o.center, civ.center) > ROAD_MAX) continue;
      const n = Math.ceil(Math.max(Math.abs(o.center.x - civ.center.x), Math.abs(o.center.z - civ.center.z)));
      S.roads.push({ a: civ.id, b: o.id, x1: civ.center.x, z1: civ.center.z, x2: o.center.x, z2: o.center.z, done: "0".repeat(n + 1), cur: 0, pa: 0, pb: 0 });
      const told = new Set();
      for (const pl of [...playersNear(civ.center, 200), ...playersNear(o.center, 200)]) {
        if (told.has(pl.id)) continue;
        told.add(pl.id);
        pl.sendMessage(`§6[Дороги] ${civ.color}${civ.name}§6 начали прокладывать дорогу к ${o.color}${o.name}§6.`);
      }
    }
  }
  // Дороги к исчезнувшим поселениям доделывать не нужно — но уже положенное остаётся.
  S.roads = S.roads.filter((r) => S.civs.has(r.a) && S.civs.has(r.b));
  saveRoads();
}

const DIRT = new Set(["grass_block", "dirt", "coarse_dirt", "podzol", "mycelium", "rooted_dirt", "grass_path", "dirt_path", "snow"]);

function layPoint(dim, x, z, side) {
  const g = groundAt(dim, x, z);
  if (!g) return false; // чанк не загружен — вернёмся позже
  if (g.unnatural) return true; // постройки не трогаем
  const b = getB(dim, x, g.y, z);
  const above = getB(dim, x, g.y + 1, z);
  if (!b || !above) return false;
  try {
    if (g.liquid) {
      // Мост через воду.
      if (b.typeId === "minecraft:water") b.setType("minecraft:spruce_planks");
      return true;
    }
    if (!above.isAir && isPassableId(above.typeId)) above.setType("minecraft:air");
    const id = strip(b.typeId);
    if (id === "grass_path") return true;
    if (DIRT.has(id)) b.setType("minecraft:grass_path");
    else if (above.isAir || isPassableId(above.typeId)) b.setType("minecraft:gravel");
    // Фонарный столб вдоль дороги.
    if (side) {
      const post = getB(dim, x, g.y + 1, z);
      const top = getB(dim, x, g.y + 2, z);
      if (post?.isAir && top?.isAir) {
        post.setType("minecraft:oak_fence");
        top.setType("minecraft:torch");
      }
    }
  } catch {}
  return true;
}

const placedShare = (r) => (r.done.split("1").length - 1) / r.done.length;

// Скорость дорожников: блоков в секунду с каждой стороны (каждое поселение ведёт дорогу навстречу).
const ROAD_SPEED = 0.25;

/**
 * Раз в секунду. Дорогу строят всегда, даже без игрока: прогресс pa/pb растёт с обоих концов.
 * Блоки ставятся только там, где чанк загружен, — построенное без вас появляется, когда вы рядом.
 */
export function layRoads() {
  const dim = DIM();
  let budget = 24;
  let changed = false;
  for (const r of S.roads ?? []) {
    const n = r.done.length - 1;
    const a = S.civs.get(r.a);
    const b = S.civs.get(r.b);
    // Пока поселение живо и не воюет с соседом, его дорожники работают.
    const peace = !(a?.war && a.war.enemy === r.b);
    if (a && peace) r.pa = Math.min(n + 1, (r.pa ?? 0) + ROAD_SPEED * S.speed);
    if (b && peace) r.pb = Math.min(n + 1, (r.pb ?? 0) + ROAD_SPEED * S.speed);
    if (budget <= 0 || !r.done.includes("0")) continue;
    const chars = r.done.split("");
    for (let k = 0; k < 60 && budget > 0; k++) {
      const i = (r.cur + k) % (n + 1);
      if (chars[i] === "1") continue;
      if (i >= (r.pa ?? 0) && i <= n - (r.pb ?? 0)) continue; // этот участок ещё не построен
      if (i < ROAD_SKIP || i > n - ROAD_SKIP) {
        chars[i] = "1";
        continue;
      }
      const x = Math.round(r.x1 + ((r.x2 - r.x1) * i) / n);
      const z = Math.round(r.z1 + ((r.z2 - r.z1) * i) / n);
      if (!loaded(dim, { x, z })) continue;
      // Ширина 2: вторая полоса сбоку по основной оси дороги.
      const wide = Math.abs(r.x2 - r.x1) > Math.abs(r.z2 - r.z1) ? [x, z + 1, x, z + 2] : [x + 1, z, x + 2, z];
      const ok = layPoint(dim, x, z, false) && layPoint(dim, wide[0], wide[1], false);
      if (i % 24 === 12) layPoint(dim, wide[2], wide[3], true);
      if (!ok) continue;
      chars[i] = "1";
      budget--;
      changed = true;
    }
    r.cur = (r.cur + 60) % (n + 1);
    r.done = chars.join("");
  }
  // Прогресс дорожников сохраняем всегда, даже если блоки пока не ставились.
  if ((changed || (S.roads ?? []).length) && S.clock % 10 === 0) saveRoads();
}

export function roadInfo(civ) {
  const list = (S.roads ?? []).filter((r) => r.a === civ.id || r.b === civ.id);
  if (!list.length) return civ.era < 1 ? "с эпохи «Деревня»" : "пока нет";
  return list
    .map((r) => {
      const o = S.civs.get(r.a === civ.id ? r.b : r.a);
      const n = r.done.length;
      const pct = Math.min(100, Math.round((((r.pa ?? 0) + (r.pb ?? 0)) / n) * 100));
      return `к ${o?.name ?? "?"} — ${pct}%`;
    })
    .join(", ");
}

// ---------- Торговля ----------
// Цены в «единицах»: 1 железо = 64 дерева, 1 алмаз = 512 дерева.
export const VALUE = { wood: 1, stone: 1, food: 2, iron: 64, diamond: 512 };
const CAP = { wood: 200, stone: 200, food: 60, iron: 8 };
const RES = { wood: "дерева", stone: "камня", food: "еды", iron: "железа", diamond: "алмазов" };

function wants(civ) {
  const rc = remainingCost(civ);
  /** @type {{stone?: number, iron?: number}} */
  const next = ERAS[civ.era].next ?? {};
  return {
    wood: rc.wood + 40,
    stone: Math.max(rc.stone, next.stone ?? 0) + 30,
    iron: Math.max(rc.iron, next.iron ?? 0) + 6,
    food: popOf(civ) * 3 + 10,
    diamond: 0,
  };
}

function tryTrade(buyer, seller) {
  const wb = wants(buyer);
  const ws = wants(seller);
  for (const k of ["iron", "food", "stone", "wood"]) {
    const need = Math.max(0, wb[k] - (buyer.res[k] ?? 0));
    const spare = Math.max(0, (seller.res[k] ?? 0) - ws[k] - 10);
    let qty = Math.min(need, spare, CAP[k]);
    if (qty < 1) continue;
    // Платят тем, чего у покупателя больше всего лишнего.
    const pay = Object.keys(VALUE)
      .filter((r) => r !== k)
      .map((r) => ({ r, spare: Math.max(0, (buyer.res[r] ?? 0) - wb[r] - 10) }))
      .filter((p) => p.spare * VALUE[p.r] >= VALUE[k])
      .sort((a, b) => b.spare * VALUE[b.r] - a.spare * VALUE[a.r])[0];
    if (!pay) continue;
    qty = Math.min(qty, Math.floor((pay.spare * VALUE[pay.r]) / VALUE[k]));
    if (qty < 1) continue;
    const price = Math.ceil((qty * VALUE[k]) / VALUE[pay.r]);
    buyer.res[pay.r] -= price;
    seller.res[pay.r] = (seller.res[pay.r] ?? 0) + price;
    seller.res[k] -= qty;
    buyer.res[k] = (buyer.res[k] ?? 0) + qty;
    if (k === "food") buyer.res.food = Math.min(buyer.res.food, foodCap(buyer));
    // Торговля сближает: напряжение падает.
    buyer.tension[seller.id] = Math.max(0, (buyer.tension[seller.id] ?? 0) - 5);
    seller.tension[buyer.id] = Math.max(0, (seller.tension[buyer.id] ?? 0) - 5);
    const text = `${buyer.name} купили у ${seller.name} ${qty} ${RES[k]} за ${price} ${RES[pay.r]}`;
    for (const c of [buyer, seller]) {
      c.trades = [text, ...(c.trades ?? [])].slice(0, 5);
      markDirty(c);
    }
    const msg = `§a[Торговля] ${buyer.color}${buyer.name}§a купили у ${seller.color}${seller.name}§a: ${qty} ${RES[k]} за ${price} ${RES[pay.r]}.`;
    const seen = new Set();
    for (const pl of [...playersNear(buyer.center, 160), ...playersNear(seller.center, 160)]) {
      if (seen.has(pl.id)) continue;
      seen.add(pl.id);
      pl.sendMessage(msg);
    }
    return true;
  }
  return false;
}

/** Раз в минуту: соседи с эпохи «Деревня», которые не воюют друг с другом, обмениваются товарами. */
export function tradeTick() {
  const civs = [...S.civs.values()].filter((c) => c.era >= 1 && popOf(c) > 0);
  for (let i = 0; i < civs.length; i++) for (let j = i + 1; j < civs.length; j++) {
    const a = civs[i];
    const b = civs[j];
    if (a.war?.enemy === b.id) continue;
    if (!roadBetween(a, b) && dXZ(a.center, b.center) > ROAD_MAX) continue;
    if (!tryTrade(a, b)) tryTrade(b, a);
  }
}

// ---------- Телепорт к поселению ----------
export function teleportTo(pl, civ) {
  const c = civ.center;
  const far = civ.virtualCenter;
  const pos = { x: c.x + 2.5, y: far ? 200 : c.y + 1, z: c.z + 2.5 };
  try {
    if (far) pl.addEffect("slow_falling", 400, { amplifier: 0, showParticles: false });
    pl.teleport(pos, { dimension: DIM() });
  } catch {
    return;
  }
  pl.sendMessage(`§b[Телепорт] Вы у поселения ${civ.color}${civ.name}§b.`);
  // Когда чанк загрузится — ставим на свободное место (если поселение перестроилось или там что-то выросло).
  system.runTimeout(() => {
    try {
      if (!pl.isValid) return;
      const dim = DIM();
      const l = pl.location;
      const head = getB(dim, Math.floor(l.x), Math.floor(l.y + 1.5), Math.floor(l.z));
      if (head && !head.isAir && !head.isLiquid && !isPassableId(head.typeId)) {
        const spot = findSafeSpot(dim, l.x, l.y + 1, l.z, 6) ?? findDrySpot(dim, l.x, l.z, 16);
        if (spot) pl.teleport(spot);
      }
    } catch {}
  }, 40);
}
