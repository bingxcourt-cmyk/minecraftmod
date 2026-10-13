import { world, system } from "@minecraft/server";
import { S, DIM, getB, loaded, markDirty, playersNear, dXZ } from "./core.js";
import { groundAt, isPassableId, findDrySpot } from "./blocks.js";
import { remainingCost } from "./workers.js";
import { findSafeSpot } from "./nav.js";
import { deferLight } from "./lights.js";

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

const placedShare = (r) => (r.done.split("1").length - 1) / r.done.length;
export const roadBetween = (a, b) => (S.roads ?? []).find((r) => (r.a === a.id && r.b === b.id) || (r.a === b.id && r.b === a.id));

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
      S.roads.push({ a: civ.id, b: o.id, x1: civ.center.x, z1: civ.center.z, x2: o.center.x, z2: o.center.z, done: "0".repeat(n + 1), cur: 0, pa: 0, pb: 0, v: 2 });
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

// ---------- Укладка ----------
// Дорога шириной 3: по центру каменный кирпич, по краям полированный андезит, по бокам заборы
// (с проходами каждые 16 блоков), фонари на столбах каждые 12 блоков, через воду — мост с перилами.
const ROAD_SPEED = 0.25; // блоков дороги в секунду с каждой стороны
// За 1 блок длины: каменный кирпич по центру (из камня), полированный андезит по краям, два забора из дерева.
const ROAD_COST = { stone: 1, andesite: 2, wood: 2 };
const RES_RU = { stone: "камень", andesite: "андезит", wood: "дерево" };

const SOFT_ABOVE = (b) => {
  const id = b.typeId;
  return !b.isAir && !b.isLiquid && (isPassableId(id) || id.endsWith("leaves") || id.endsWith("_log") || id === "minecraft:snow_layer");
};

function setIf(b, id) {
  try {
    if (b && b.typeId !== id) b.setType(id);
  } catch {}
}

function clearAbove(dim, x, y, z, h) {
  for (let k = 1; k <= h; k++) {
    const b = getB(dim, x, y + k, z);
    if (b && SOFT_ABOVE(b)) setIf(b, "minecraft:air");
  }
}

/** Кладёт поперечный срез дороги в точке i. false — чанк ещё не загружен. */
function layRoadPoint(dim, r, i) {
  const n = r.done.length - 1;
  const x = Math.round(r.x1 + ((r.x2 - r.x1) * i) / n);
  const z = Math.round(r.z1 + ((r.z2 - r.z1) * i) / n);
  const [px, pz] = Math.abs(r.x2 - r.x1) > Math.abs(r.z2 - r.z1) ? [0, 1] : [1, 0];
  for (let o = -2; o <= 2; o++) if (!loaded(dim, { x: x + px * o, z: z + pz * o })) return false;
  let bridge = false;
  for (let o = -2; o <= 2; o++) {
    const cx = x + px * o;
    const cz = z + pz * o;
    const g = groundAt(dim, cx, cz);
    if (!g) return false;
    if (g.unnatural) continue; // постройки и чужое не трогаем
    const b = getB(dim, cx, g.y, cz);
    if (!b) return false;
    const edge = Math.abs(o) === 2;
    if (g.liquid) {
      // Мост: настил на уровне воды, по краям перила.
      bridge = true;
      if (b.typeId === "minecraft:water") setIf(b, "minecraft:spruce_planks");
      if (edge) setIf(getB(dim, cx, g.y + 1, cz), "minecraft:spruce_fence");
      continue;
    }
    clearAbove(dim, cx, g.y, cz, 4);
    if (!edge) {
      setIf(b, o === 0 ? "minecraft:stone_bricks" : "minecraft:polished_andesite");
      continue;
    }
    // Забор по краю, проход каждые 16 блоков, фонарный столб каждые 12.
    if (i % 16 === 8) continue;
    const post = getB(dim, cx, g.y + 1, cz);
    if (!post?.isAir) continue;
    setIf(post, "minecraft:oak_fence");
    if (i % 12 === 0) {
      const p2 = getB(dim, cx, g.y + 2, cz);
      const p3 = getB(dim, cx, g.y + 3, cz);
      if (p2?.isAir && p3?.isAir) {
        setIf(p2, "minecraft:oak_fence");
        // Фонарь повесит то поселение, чья это половина дороги, — когда будут факелы и железо.
        const owner = S.civs.get(i <= n / 2 ? r.a : r.b);
        if (owner) deferLight(owner, cx, g.y + 3, cz, "minecraft:lantern");
      }
    }
  }
  void bridge;
  return true;
}

// Дорожники работают за счёт поселения: на каждый блок длины — камень и дерево из запасов,
// но только из излишков (стройка и эпоха важнее).
function payRoad(civ) {
  if (!civ) return false;
  const rc = remainingCost(civ);
  for (const [k, v] of Object.entries(ROAD_COST)) {
    if ((civ.res[k] ?? 0) - v < (rc[k] ?? 0) + (k === "andesite" ? 0 : 30)) {
      // Не хватает — купят на рынке (андезит, камень, дерево).
      if (civ.roadNeed !== k) {
        civ.roadNeed = k;
        markDirty(civ);
      }
      return false;
    }
  }
  for (const [k, v] of Object.entries(ROAD_COST)) civ.res[k] -= v;
  civ.roadNeed = null;
  markDirty(civ);
  return true;
}

export const roadNeedName = (civ) => (civ.roadNeed ? RES_RU[civ.roadNeed] : "");

/** Рост прогресса дорог за dt секунд (вживую, в фоне и при «догонялках» за время вне игры). */
export function progressRoads(dt) {
  for (const r of S.roads ?? []) {
    const n = r.done.length - 1;
    const a = S.civs.get(r.a);
    const b = S.civs.get(r.b);
    if (!a || !b || (a.war && a.war.enemy === r.b)) continue;
    for (const [civ, key] of [[a, "pa"], [b, "pb"]]) {
      if (civ.era < 1 && !civ.parent) continue;
      // Каждое поселение строит ровно свою половину — до середины.
      const half = key === "pa" ? Math.ceil((n + 1) / 2) : n + 1 - Math.ceil((n + 1) / 2);
      let left = ROAD_SPEED * S.speed * dt;
      while (left > 0 && (r[key] ?? 0) < half) {
        const step = Math.min(1, left);
        const before = Math.floor(r[key] ?? 0);
        const after = Math.floor((r[key] ?? 0) + step);
        if (after > before && !payRoad(civ)) break;
        r[key] = (r[key] ?? 0) + step;
        left -= step;
      }
    }
  }
}

/** Раз в секунду: прогресс растёт, а построенные участки появляются там, где загружены чанки. */
export function layRoads() {
  const dim = DIM();
  progressRoads(1);
  let budget = 16;
  let changed = false;
  for (const r of S.roads ?? []) {
    // Старые узкие дороги (до версии 2.0) перекладываем красиво, уже оплаченный прогресс сохраняется.
    if (r.v !== 2) {
      r.v = 2;
      r.done = "0".repeat(r.done.length);
      r.pa = r.pa ?? r.done.length / 2;
      r.pb = r.pb ?? r.done.length / 2;
    }
    if (budget <= 0 || !r.done.includes("0")) continue;
    const n = r.done.length - 1;
    const chars = r.done.split("");
    for (let k = 0; k < 60 && budget > 0; k++) {
      const i = (r.cur + k) % (n + 1);
      if (chars[i] === "1") continue;
      if (i >= (r.pa ?? 0) && i <= n - (r.pb ?? 0)) continue; // ещё не построено
      if (i < ROAD_SKIP || i > n - ROAD_SKIP) {
        chars[i] = "1";
        continue;
      }
      if (!layRoadPoint(dim, r, i)) continue;
      chars[i] = "1";
      budget--;
      changed = true;
    }
    r.cur = (r.cur + 60) % (n + 1);
    r.done = chars.join("");
  }
  if ((changed || (S.roads ?? []).length) && S.clock % 10 === 0) saveRoads();
}

export function roadInfo(civ) {
  const list = (S.roads ?? []).filter((r) => r.a === civ.id || r.b === civ.id);
  if (!list.length) return civ.era < 1 ? "с эпохи «Деревня»" : "пока нет";
  const wait = civ.roadNeed ? ` §c(нужен ${RES_RU[civ.roadNeed]})§r` : "";
  return wait + list
    .map((r) => {
      const o = S.civs.get(r.a === civ.id ? r.b : r.a);
      const n = r.done.length;
      const mine = r.a === civ.id ? r.pa ?? 0 : r.pb ?? 0;
      const half = r.a === civ.id ? Math.ceil(n / 2) : n - Math.ceil(n / 2);
      const total = Math.min(100, Math.round((((r.pa ?? 0) + (r.pb ?? 0)) / n) * 100));
      return `к ${o?.name ?? "?"} — всего ${total}%, своя половина ${Math.min(100, Math.round((mine / Math.max(1, half)) * 100))}%`;
    })
    .join(", ");
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
