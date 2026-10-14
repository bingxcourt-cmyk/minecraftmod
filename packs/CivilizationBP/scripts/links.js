import { world, system } from "@minecraft/server";
import { S, DIM, getB, loaded, markDirty, dXZ, levelOf } from "./core.js";
import { groundAt, isPassableId, isNatural, findDrySpot } from "./blocks.js";
import { remainingCost, digYield } from "./workers.js";
import { roadGate, setRoadGates, wallShare, wallPaidShare } from "./walls.js";
import { findSafeSpot } from "./nav.js";
import { deferLight } from "./lights.js";
import { note } from "./journal.js";

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

/**
 * Концы дороги: если у поселения есть стена — точка сразу за воротами (ближайший к соседу столб
 * становится воротами), иначе — центр поселения. Высота — уровень поселения.
 */
function endOf(civ, other) {
  const y = levelOf(civ);
  if (civ.wall && wallShare(civ) + wallPaidShare(civ) > 0) {
    const g = roadGate(civ, other.center);
    if (g) return { x: g.x, z: g.z, y, skip: 0, key: g.key };
  }
  return { x: Math.floor(civ.center.x), z: Math.floor(civ.center.z), y, skip: ROAD_SKIP };
}

/** Новая геометрия дороги (оплаченный прогресс сохраняется, участки перекладываются). */
function shape(r, A, B) {
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(B.x - A.x), Math.abs(B.z - A.z))));
  const halfA = Math.ceil((n + 1) / 2);
  Object.assign(r, {
    x1: A.x, z1: A.z, y1: A.y, x2: B.x, z2: B.z, y2: B.y, s1: A.skip, s2: B.skip,
    done: "0".repeat(n + 1), cur: 0, v: 3,
    pa: Math.min(r.pa ?? 0, halfA), pb: Math.min(r.pb ?? 0, n + 1 - halfA),
  });
}

/** Раз в минуту: кто с кем строит дорогу; дороги идут от ворот до ворот и следуют за стенами. */
export function planRoads() {
  S.roads = S.roads ?? [];
  const civs = [...S.civs.values()];
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
      const r = { a: civ.id, b: o.id, pa: 0, pb: 0 };
      shape(r, endOf(civ, o), endOf(o, civ));
      S.roads.push(r);
      note("build", `${civ.name} и ${o.name} начали дорогу друг к другу (${r.done.length} блоков, каждый строит свою половину)`);
    }
  }
  // Дороги к исчезнувшим поселениям доделывать не нужно — но уже положенное остаётся.
  S.roads = S.roads.filter((r) => S.civs.has(r.a) && S.civs.has(r.b));
  // Стена перестроилась (или поселение переехало) — дорогу ведут к новым воротам.
  const gates = new Map();
  for (const r of S.roads) {
    const a = S.civs.get(r.a);
    const b = S.civs.get(r.b);
    const A = endOf(a, b);
    const B = endOf(b, a);
    for (const [c, e] of [[a, A], [b, B]]) if (e.key) gates.set(c.id, [...(gates.get(c.id) ?? []), e.key]);
    const moved = Math.hypot(A.x - r.x1, A.z - r.z1) > 3 || Math.hypot(B.x - r.x2, B.z - r.z2) > 3 || A.y !== r.y1 || B.y !== r.y2;
    if (r.v !== 3 || moved) shape(r, A, B);
  }
  for (const civ of civs) setRoadGates(civ, gates.get(civ.id) ?? []);
  saveRoads();
}

// ---------- Укладка ----------
// Дорога шириной 3: по центру каменный кирпич, по краям полированный андезит, по бокам заборы
// (с проходами каждые 16 блоков), фонари на столбах каждые 12 блоков.
// Дорога ровная: основная часть — на одной высоте (средней между уровнями двух поселений),
// у ворот — плавный подъём или спуск (1 блок на 3 блока длины). Где земля ниже — насыпь или мост
// на опорах, где выше — выемка в холме.
const ROAD_SPEED = 0.25; // блоков дороги в секунду с каждой стороны
// За 1 блок длины: каменный кирпич по центру (из камня), полированный андезит по краям, два забора из дерева.
const ROAD_COST = { stone: 1, andesite: 2, wood: 2 };
const RES_RU = { stone: "камень", andesite: "андезит", wood: "дерево" };
const GRADE = 3; // блоков длины на 1 блок подъёма

/** Высота настила дороги в точке i. */
export function roadHeight(r, i) {
  const n = r.done.length - 1;
  const yA = r.y1 ?? 64;
  const yB = r.y2 ?? 64;
  const H = Math.round((yA + yB) / 2);
  if ((Math.abs(H - yA) + Math.abs(H - yB)) * GRADE > n) return Math.round(yA + ((yB - yA) * i) / Math.max(1, n));
  if (i <= n / 2) return yA + Math.sign(H - yA) * Math.min(Math.abs(H - yA), Math.floor(i / GRADE));
  return yB + Math.sign(H - yB) * Math.min(Math.abs(H - yB), Math.floor((n - i) / GRADE));
}

function setIf(b, id) {
  try {
    if (b && b.typeId !== id) b.setType(id);
  } catch {}
}

const CUTTABLE = (b) => !b.isAir && !b.isLiquid && (isNatural(b.typeId) || b.typeId === "minecraft:snow_layer");

/** Кладёт поперечный срез дороги в точке i. false — чанк ещё не загружен. */
function layRoadPoint(dim, r, i) {
  const n = r.done.length - 1;
  const x = Math.round(r.x1 + ((r.x2 - r.x1) * i) / n);
  const z = Math.round(r.z1 + ((r.z2 - r.z1) * i) / n);
  const [px, pz] = Math.abs(r.x2 - r.x1) > Math.abs(r.z2 - r.z1) ? [0, 1] : [1, 0];
  for (let o = -2; o <= 2; o++) if (!loaded(dim, { x: x + px * o, z: z + pz * o })) return false;
  const owner = S.civs.get(i <= n / 2 ? r.a : r.b);
  let y = roadHeight(r, i);
  // Над водой настил не ниже её поверхности.
  for (let o = -2; o <= 2; o++) {
    const g = groundAt(dim, x + px * o, z + pz * o);
    if (g?.liquid) y = Math.max(y, g.y + 1);
  }
  let extra = 0;
  for (let o = -2; o <= 2; o++) {
    const cx = x + px * o;
    const cz = z + pz * o;
    const g = groundAt(dim, cx, cz);
    if (!g) return false;
    // Чужие постройки (не наша дорога и не наши опоры) не трогаем.
    if (g.unnatural && g.y > y + 1) continue;
    const edge = Math.abs(o) === 2;
    // Выемка: срезаем холм над дорогой (грунт — на склад того, чья это половина).
    for (let k = 1; k <= 5; k++) {
      const b = getB(dim, cx, y + k, cz);
      if (b && CUTTABLE(b)) {
        if (owner && !isPassableId(b.typeId)) digYield(owner, b.typeId);
        setIf(b, "minecraft:air");
      }
    }
    // Насыпь (до 3 блоков) или опоры моста (каждые 8 блоков по краям).
    if (g.y < y - 1 || g.liquid) {
      const shallow = !g.liquid && y - g.y <= 4;
      if (shallow || (edge && i % 8 === 0)) {
        for (let yy = y - 1; yy > y - 40; yy--) {
          const b = getB(dim, cx, yy, cz);
          if (!b || !(b.isAir || b.isLiquid || isPassableId(b.typeId))) break;
          setIf(b, shallow ? "minecraft:cobblestone" : "minecraft:stone_bricks");
          extra++;
        }
      }
    }
    const deck = getB(dim, cx, y, cz);
    if (!deck) return false;
    if (!edge) setIf(deck, o === 0 ? "minecraft:stone_bricks" : "minecraft:polished_andesite");
    else if (deck.isAir || deck.isLiquid || isPassableId(deck.typeId)) setIf(deck, "minecraft:cobblestone");
    if (!edge) continue;
    // Забор по краю, проход каждые 16 блоков, фонарный столб каждые 12.
    if (i % 16 === 8) continue;
    const post = getB(dim, cx, y + 1, cz);
    if (!post?.isAir) continue;
    setIf(post, "minecraft:oak_fence");
    if (i % 12 === 0) {
      const p2 = getB(dim, cx, y + 2, cz);
      const p3 = getB(dim, cx, y + 3, cz);
      if (p2?.isAir && p3?.isAir) {
        setIf(p2, "minecraft:oak_fence");
        // Фонарь повесит то поселение, чья это половина дороги, — когда будут факелы и железо.
        if (owner) deferLight(owner, cx, y + 3, cz, "minecraft:lantern");
      }
    }
  }
  // Насыпь и опоры — из камня того, чья это половина (сколько есть).
  if (owner && extra) {
    owner.res.stone = Math.max(0, (owner.res.stone ?? 0) - extra);
    markDirty(owner);
  }
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
    if (r.v !== 3) continue; // старую дорогу переложат по-новому при ближайшем планировании
    if (budget <= 0 || !r.done.includes("0")) continue;
    const n = r.done.length - 1;
    const chars = r.done.split("");
    for (let k = 0; k < 60 && budget > 0; k++) {
      const i = (r.cur + k) % (n + 1);
      if (chars[i] === "1") continue;
      if (i >= (r.pa ?? 0) && i <= n - (r.pb ?? 0)) continue; // ещё не построено
      if (i < (r.s1 ?? ROAD_SKIP) || i > n - (r.s2 ?? ROAD_SKIP)) {
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
