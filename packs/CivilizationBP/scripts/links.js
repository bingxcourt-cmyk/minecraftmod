import { world, system } from "@minecraft/server";
import { S, DIM, getB, loaded, markDirty, dXZ, levelOf } from "./core.js";
import { groundAt, isPassableId, isNatural, findDrySpot } from "./blocks.js";
import { remainingCost, digYield } from "./workers.js";
import { setRoadGates, sideGate, SIDE_DIR, isOwnWall } from "./walls.js";
import { findSafeSpot } from "./nav.js";
import { deferLight } from "./lights.js";
import { note } from "./journal.js";

// ---------- Дороги между поселениями ----------
// У поселения не больше 4 дорог — по одной на каждую сторону света (север, юг, запад, восток).
// Дорога выходит из ворот стены на этой стороне (а пока стены нет — от края поселения),
// идёт прямыми участками под прямым углом и приходит к воротам соседа на противоположной стороне.
// Дорога ложится по кусочкам там, где чанки загружены; работяги постоянно её подправляют,
// а старые кривые дороги разбирают.
const ROAD_MAX = 320; // дальше дорог не строят
const ROAD_SKIP = 0;
const OPP = { E: "W", W: "E", S: "N", N: "S" };

// Отметки «участок положен» хранятся сжато (длины серий 0 и 1): у мира ограничение на размер записи.
const rle = (s) => {
  const out = [];
  let ch = "0";
  let n = 0;
  for (const c of s) {
    if (c === ch) n++;
    else {
      out.push(n);
      ch = c;
      n = 1;
    }
  }
  out.push(n);
  return out.join(".");
};
const unrle = (s) => {
  if (!/^[0-9.]*$/.test(s)) return s; // старое сохранение — строка как есть
  let ch = "0";
  let out = "";
  for (const n of s.split(".")) {
    out += ch.repeat(Number(n) || 0);
    ch = ch === "0" ? "1" : "0";
  }
  return out;
};
const pack = (r) => ({ ...r, done: rle(r.done ?? ""), z: 1 });
const unpack = (r) => (r.z ? { ...r, done: unrle(r.done), z: undefined } : r);

export function loadRoads() {
  try {
    S.roads = JSON.parse(String(world.getDynamicProperty("civ:roads") ?? "[]")).map(unpack);
  } catch {
    S.roads = [];
  }
  try {
    S.roadDemo = JSON.parse(String(world.getDynamicProperty("civ:rdemo") ?? "[]")).map(unpack);
  } catch {
    S.roadDemo = [];
  }
}

export function saveRoads() {
  try {
    world.setDynamicProperty("civ:roads", JSON.stringify((S.roads ?? []).map(pack)));
  } catch (e) {
    console.warn(`[Цивилизации] не удалось сохранить дороги: ${e}`);
  }
  try {
    let demo = (S.roadDemo ?? []).slice(-50).map(pack);
    let text = JSON.stringify(demo);
    while (text.length > 30000 && demo.length) {
      demo = demo.slice(1);
      text = JSON.stringify(demo);
    }
    world.setDynamicProperty("civ:rdemo", text);
  } catch {}
}

export const roadBetween = (a, b) => (S.roads ?? []).find((r) => (r.a === a.id && r.b === b.id) || (r.a === b.id && r.b === a.id));

/** С какой стороны света от a находится b. */
function sideTo(a, b) {
  const dx = b.center.x - a.center.x;
  const dz = b.center.z - a.center.z;
  return Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? "E" : "W") : dz > 0 ? "S" : "N";
}

/** Стороны, уже занятые дорогами этого поселения. */
function usedSides(civ, except) {
  const out = new Set();
  for (const r of S.roads ?? []) {
    if (r === except) continue;
    if (r.a === civ.id && r.sa) out.add(r.sa);
    if (r.b === civ.id && r.sb) out.add(r.sb);
  }
  return out;
}

/** Выход дороги: за воротами стены на этой стороне, а без стены — у края поселения. */
function exitOf(civ, side) {
  const y = levelOf(civ);
  const g = sideGate(civ, side);
  if (g) return { ...g, y };
  const [dx, dz] = SIDE_DIR[side];
  const cx = Math.floor(civ.center.x);
  const cz = Math.floor(civ.center.z);
  let far = 6;
  for (const b of civ.buildings) {
    if (b.t === "mine" || b.t === "quarry") continue;
    far = Math.max(far, dx > 0 ? b.x + b.w - cx : dx < 0 ? cx - b.x : dz > 0 ? b.z + b.d - cz : cz - b.z);
  }
  return { x: cx + dx * (far + 3), z: cz + dz * (far + 3), y };
}

/** Выход B лежит дальше по направлению стороны A (хотя бы на 4 блока). */
function forward(A, B, side) {
  const [dx, dz] = SIDE_DIR[side];
  return (B.x - A.x) * dx + (B.z - A.z) * dz > 4;
}

/** Ломаная из прямых участков: выход A → поворот посередине → выход B. */
function route(A, B, side) {
  const pts = [[A.x, A.z]];
  if (side === "E" || side === "W") {
    const mx = Math.round((A.x + B.x) / 2);
    pts.push([mx, A.z], [mx, B.z]);
  } else {
    const mz = Math.round((A.z + B.z) / 2);
    pts.push([A.x, mz], [B.x, mz]);
  }
  pts.push([B.x, B.z]);
  return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
}

const pathLen = (pts) => pts.slice(1).reduce((n, p, i) => n + Math.abs(p[0] - pts[i][0]) + Math.abs(p[1] - pts[i][1]), 0);

/** Точка i вдоль дороги и поперечное направление в ней. */
export function polyPoint(r, i) {
  if (!r.pts) {
    // Старая прямая дорога (до версии 2.7).
    const n = r.done.length - 1;
    const x = Math.round(r.x1 + ((r.x2 - r.x1) * i) / n);
    const z = Math.round(r.z1 + ((r.z2 - r.z1) * i) / n);
    const [px, pz] = Math.abs(r.x2 - r.x1) > Math.abs(r.z2 - r.z1) ? [0, 1] : [1, 0];
    return { x, z, px, pz };
  }
  let left = i;
  for (let k = 1; k < r.pts.length; k++) {
    const [x0, z0] = r.pts[k - 1];
    const [x1, z1] = r.pts[k];
    const len = Math.abs(x1 - x0) + Math.abs(z1 - z0);
    if (left <= len || k === r.pts.length - 1) {
      const t = Math.min(left, len);
      const sx = Math.sign(x1 - x0);
      const sz = Math.sign(z1 - z0);
      return { x: x0 + sx * t, z: z0 + sz * t, px: sx ? 0 : 1, pz: sx ? 1 : 0 };
    }
    left -= len;
  }
  const [x, z] = r.pts[r.pts.length - 1];
  return { x, z, px: 1, pz: 0 };
}

/** Старую геометрию дороги — в очередь на разбор (разберут, когда чанки загрузятся). */
function scrapGeometry(r) {
  if (!r.done || !r.done.includes("1")) return;
  S.roadDemo = S.roadDemo ?? [];
  S.roadDemo.push({ pts: r.pts, x1: r.x1, z1: r.z1, x2: r.x2, z2: r.z2, n: r.done.length - 1, done: r.done, i: 0 });
}

/** Новая геометрия дороги (оплаченный прогресс сохраняется, участки перекладываются). */
function shape(r, A, B) {
  scrapGeometry(r);
  const pts = route(A, B, r.sa);
  const n = Math.max(1, pathLen(pts));
  const halfA = Math.ceil((n + 1) / 2);
  Object.assign(r, {
    pts, x1: A.x, z1: A.z, y1: A.y, x2: B.x, z2: B.z, y2: B.y, s1: ROAD_SKIP, s2: ROAD_SKIP,
    done: "0".repeat(n + 1), cur: 0, fix: 0, v: 4, gen: (r.gen ?? 0) + 1,
    pa: Math.min(r.pa ?? 0, halfA), pb: Math.min(r.pb ?? 0, n + 1 - halfA),
  });
}

/** Раз в минуту: кто с кем строит дорогу; дороги следуют за воротами стен. */
export function planRoads() {
  S.roads = (S.roads ?? []).filter((r) => {
    if (S.civs.has(r.a) && S.civs.has(r.b)) return true;
    return false; // дорога к исчезнувшему поселению: уже положенное остаётся
  });
  // Старые дороги: назначаем стороны; если сторона уже занята — лишнюю (дальнюю) дорогу разбирают.
  const byLen = [...S.roads].sort((p, q) => (p.done?.length ?? 0) - (q.done?.length ?? 0));
  for (const r of byLen) {
    if (r.sa && r.sb) continue;
    const a = S.civs.get(r.a);
    const b = S.civs.get(r.b);
    const sa = sideTo(a, b);
    const sb = OPP[sa];
    if (usedSides(a, r).has(sa) || usedSides(b, r).has(sb)) {
      scrapGeometry(r);
      r.dead = true;
      continue;
    }
    r.sa = sa;
    r.sb = sb;
  }
  S.roads = S.roads.filter((r) => !r.dead);
  const civs = [...S.civs.values()];
  for (const civ of civs) {
    if (civ.era < 1) continue;
    const targets = [];
    const parent = civ.parent ? S.civs.get(civ.parent) : undefined;
    if (parent) targets.push(parent);
    for (const o of civs.filter((o) => o !== civ).sort((p, q) => dXZ(p.center, civ.center) - dXZ(q.center, civ.center))) targets.push(o);
    for (const o of targets) {
      if (roadBetween(civ, o) || dXZ(o.center, civ.center) > ROAD_MAX) continue;
      const sa = sideTo(civ, o);
      const sb = OPP[sa];
      // У каждого поселения — не больше одной дороги на сторону света (всего до 4).
      if (usedSides(civ).has(sa) || usedSides(o).has(sb)) continue;
      const A = exitOf(civ, sa);
      const B = exitOf(o, sb);
      if (!forward(A, B, sa)) continue; // выходы «смотрят» мимо друг друга — дорога пошла бы назад через поселение
      const r = { a: civ.id, b: o.id, sa, sb, pa: 0, pb: 0 };
      shape(r, A, B);
      S.roads.push(r);
      note("build", `${civ.name} и ${o.name} начали дорогу друг к другу (${r.done.length} блоков, каждый строит свою половину)`);
    }
  }
  // Стена перестроилась или ворота сдвинулись — дорогу ведут к новым воротам, старую разбирают.
  for (const r of S.roads) {
    const A = exitOf(S.civs.get(r.a), r.sa);
    const B = exitOf(S.civs.get(r.b), r.sb);
    const moved = Math.hypot(A.x - r.x1, A.z - r.z1) > 3 || Math.hypot(B.x - r.x2, B.z - r.z2) > 3 || A.y !== r.y1 || B.y !== r.y2;
    if (!forward(A, B, r.sa)) {
      // Поселения выросли так, что дорога пошла бы назад сквозь них, — разбираем её.
      scrapGeometry(r);
      r.dead = true;
      continue;
    }
    if (r.v !== 4 || moved) shape(r, A, B);
  }
  S.roads = S.roads.filter((r) => !r.dead);
  // Ворота под дороги теперь — только по сторонам света.
  for (const civ of civs) setRoadGates(civ, []);
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
  const { x, z, px, pz } = polyPoint(r, i);
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
    // Постройки и стены (свои и чужие) не трогаем; остатки старых дорог — перекладываем.
    if (g.unnatural && g.y > y + 1 && (protectedColumn(cx, cz) || !ROAD_BLOCKS.has(getB(dim, cx, g.y, cz)?.typeId ?? ""))) continue;
    const edge = Math.abs(o) === 2;
    // Выемка: срезаем холм над дорогой (грунт — на склад того, чья это половина).
    for (let k = 1; k <= 5; k++) {
      const b = getB(dim, cx, y + k, cz);
      if (b && CUTTABLE(b)) {
        if (owner && !isPassableId(b.typeId)) digYield(owner, b.typeId);
        setIf(b, "minecraft:air");
      } else if (b && ROAD_BLOCKS.has(b.typeId) && !(edge && k <= 3)) {
        // Остатки старой дороги выше нового настила убирают.
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

const laying = new Set(); // дороги, которые сейчас кладёт фоновая задача

/** Раз в секунду: прогресс растёт, а построенные участки появляются там, где загружены чанки. */
export function layRoads() {
  const dim = DIM();
  progressRoads(1);
  let budget = 16;
  let changed = false;
  for (const r of S.roads ?? []) {
    if (r.v !== 4) continue; // старую дорогу переложат по-новому при ближайшем планировании
    const n = r.done.length - 1;
    if (!r.done.includes("0")) {
      if (budget <= 0) continue;
      // Дорога готова — работяги обходят её и исправляют сломанное (по 2 участка в секунду).
      for (let k = 0; k < 2; k++) {
        r.fix = ((r.fix ?? 0) + 1) % (n + 1);
        if (layRoadPoint(dim, r, r.fix)) budget--;
      }
      continue;
    }
    // Всё оплаченное появляется сразу, как только чанки загружены: фоновая задача кладёт
    // все готовые участки подряд (по 8 за шаг, чтобы не было рывков).
    if (laying.has(r)) continue;
    laying.add(r);
    changed = true;
    system.runJob(
      (function* () {
        try {
          const gen = r.gen;
          for (let i = 0; i <= n; i++) {
            if (r.gen !== gen) break; // дорогу переложили — новая задача начнёт заново
            if (r.done[i] === "1") continue;
            if (i >= (r.pa ?? 0) && i <= n - (r.pb ?? 0)) continue; // ещё не оплачено
            if (!layRoadPoint(DIM(), r, i)) continue;
            r.done = r.done.slice(0, i) + "1" + r.done.slice(i + 1);
            if (i % 8 === 7) yield;
          }
        } finally {
          laying.delete(r);
        }
      })(),
    );
  }
  scrapTick(dim);
  if ((changed || (S.roads ?? []).length) && S.clock % 10 === 0) saveRoads();
}

// ---------- Разбор старых кривых дорог ----------
const ROAD_BLOCKS = new Set(["minecraft:stone_bricks", "minecraft:polished_andesite", "minecraft:cobblestone", "minecraft:oak_fence", "minecraft:lantern", "minecraft:spruce_planks", "minecraft:spruce_fence", "minecraft:torch"]);

/** Под ногами чужие или свои постройки/стены — такой столб не трогаем. */
function protectedColumn(x, z) {
  for (const c of S.civs.values()) {
    if (c.wall && isOwnWall(c, x, z)) return true;
    for (const b of c.buildings) if (x >= b.x - 1 && x <= b.x + b.w && z >= b.z - 1 && z <= b.z + b.d) return true;
  }
  return false;
}

/** На новой дороге столб не разбирают. */
function onLiveRoad(x, z) {
  for (const r of S.roads ?? []) {
    if (!r.pts) continue;
    for (let k = 1; k < r.pts.length; k++) {
      const [x0, z0] = r.pts[k - 1];
      const [x1, z1] = r.pts[k];
      if (x >= Math.min(x0, x1) - 2 && x <= Math.max(x0, x1) + 2 && z >= Math.min(z0, z1) - 2 && z <= Math.max(z0, z1) + 2) return true;
    }
  }
  return false;
}

/** Разбирает поперечный срез старой дороги: дорожные блоки сверху вниз, на месте настила — трава. */
function scrapColumn(dim, x, z) {
  if (protectedColumn(x, z) || onLiveRoad(x, z)) return;
  // Фонари, которые ещё ждали факелов на этом месте, больше не нужны.
  for (const c of S.civs.values()) if (c.lights?.length) c.lights = c.lights.filter((l) => l.x !== x || l.z !== z);
  const g = groundAt(dim, x, z);
  if (!g) return;
  let y = g.y + 4;
  let lowest;
  for (let k = 0; k < 48; k++, y--) {
    const b = getB(dim, x, y, z);
    if (!b) break;
    if (b.isAir) continue;
    if (!ROAD_BLOCKS.has(b.typeId)) break;
    setIf(b, "minecraft:air");
    lowest = y;
  }
  if (lowest === undefined) return;
  const below = getB(dim, x, lowest - 1, z);
  if (below && !below.isAir && !below.isLiquid && isNatural(below.typeId)) setIf(getB(dim, x, lowest, z), "minecraft:grass_block");
}

function scrapTick(dim) {
  const q = S.roadDemo?.[0];
  if (!q) return;
  let budget = 30;
  while (q.i <= q.n && budget > 0) {
    const i = q.i;
    if (q.done[i] !== "1") {
      q.i++;
      continue;
    }
    const { x, z, px, pz } = polyPoint({ ...q, done: q.done }, i);
    let ok = true;
    for (let o = -2; o <= 2; o++) if (!loaded(dim, { x: x + px * o, z: z + pz * o })) ok = false;
    if (!ok) {
      // Участок далеко — разберут, когда игрок окажется рядом; пока берём следующую дорогу.
      S.roadDemo.push(S.roadDemo.shift());
      return;
    }
    for (let o = -2; o <= 2; o++) scrapColumn(dim, x + px * o, z + pz * o);
    q.i++;
    budget--;
  }
  if (q.i > q.n) S.roadDemo.shift();
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
