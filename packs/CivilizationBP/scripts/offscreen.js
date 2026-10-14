import { S, DIM, loaded, playersNear, markDirty, personName, P, setProp } from "./core.js";
import { TIERS, TOOL_FOR, toolTier, bestCraftable } from "./tools.js";
import { TYPES, getBP } from "./blueprints.js";
import { MAX_POP, popOf, housingOf, chooseNext, count, has, join, eraTick, noteBuilt, newCiv, MAX_CIVS, MAX_COLONIES } from "./society.js";
import { findDrySpot } from "./blocks.js";
import { brainOf, foodCap, remainingCost, RES_NAME } from "./workers.js";
import { glassShort, smeltTick } from "./industry.js";
import { findSafeSpot } from "./nav.js";
import { craftTorches } from "./lights.js";
import { raidOffscreen } from "./bandits.js";
import { planWall } from "./walls.js";
import { note, warLog } from "./journal.js";
import { colonySiteFree } from "./territory.js";

// Поселение «живое», если рядом есть игрок (в пределах симуляции) и чанк центра загружен.
// Дальше — фоновая симуляция по формулам, а результат появляется, когда игрок вернётся.
// Радиус «живой» зоны в блоках — 7 чанков (при симуляции 8 жители там точно обновляются).
// Меняется командой /scriptevent civ:radius <чанки>.
export function activeR() {
  return S.activeChunks * 16;
}

export function isActive(civ) {
  return loaded(DIM(), civ.center) && playersNear(civ.center, activeR()).length > 0;
}

// Скорость работы одного жителя в минуту в зависимости от множителя инструмента m
// (рука 3, дерево 1.6, камень 1, железо 0.7, алмаз 0.5). Числа сняты с «живой» симуляции.
export const RATE = {
  wood: (m) => 560 / (15 + 3.5 * m), // лесоруб: дерево/мин (перемерено: поиск дерева, ходьба, посадка саженцев)
  blocks: (m) => 60 / (1.1 * m + 0.3), // шахтёр: блоков/мин
  food: (m) => 13 / (1.2 * m + 1), // фермер: еда/мин
  hunt: 2, // охотник: еда/мин
  eat: 0.375, // один житель съедает еды/мин
  build: 60, // строитель: блоков/мин
  eff: 0.6, // в фоне работают на 40% медленнее — с запасом на дорогу, ночь и непредвиденное
};

/** Профессии в фоне — по тем же правилам, что и вживую, но от текущего населения. */
function rolesFor(civ, n) {
  const r = { soldier: 0, builder: 0, farmer: 0, hunter: 0, miner: 0, sander: 0, digger: 0, lumberjack: 0 };
  let left = n;
  const give = (role, k) => {
    const g = Math.max(0, Math.min(k, left));
    r[role] += g;
    left -= g;
  };
  const farms = count(civ, (b) => b.t.startsWith("farm"));
  const foodLow = civ.res.food < n * 3 + 5;
  if (civ.war && n >= 2) give("soldier", Math.max(1, Math.floor(n * 0.45)));
  give("builder", n >= 6 ? 2 : 1);
  if ((civ.res.dirt ?? 0) < 30 && n >= 3) give("digger", n >= 10 ? 2 : 1);
  if (farms > 0) give("farmer", Math.min(farms * 2, Math.round(n * 0.25) + (foodLow ? 1 : 0)));
  if (farms === 0 || foodLow) give("hunter", 1);
  give("lumberjack", 1);
  if (n >= 3) give("miner", n >= 8 ? 2 : 1);
  if (civ.era >= 2 && n >= 12) give("miner", 1);
  // Песок — только если песочники уже нашли его у поселения (иначе стекло покупают).
  if (civ.sandAt && glassShort(civ) > 0) give("sander", n >= 14 ? 2 : 1);

  // Дерева с избытком — лишние руки в шахту и на поля (как вживую).
  if (civ.res.wood > 250) {
    give("miner", Math.min(3, Math.ceil(left / 2)));
    if (farms > 0) give("farmer", Math.min(farms * 3 - r.farmer, left));
  }
  give("lumberjack", left);
  return r;
}

/** Перепись: кто чем занят и какие у кого инструменты — снимается, пока поселение «живое». */
export function takeCensus(civ) {
  const members = S.members.get(civ.id) ?? [];
  const roles = {};
  const sum = {};
  for (const e of members) {
    const role = brainOf(e, civ.id).role;
    roles[role] = (roles[role] ?? 0) + 1;
    const kind = TOOL_FOR[role];
    if (kind) sum[role] = (sum[role] ?? 0) + toolTier(e, kind);
  }
  const tiers = {};
  for (const r in sum) tiers[r] = Math.round(sum[r] / roles[r]);
  civ.census = { pop: members.length, roles, tiers };
}

function offOf(civ) {
  civ.off = civ.off ?? { pop: 0, born: 0, died: 0, mins: 0, got: { wood: 0, stone: 0, iron: 0, diamond: 0, food: 0 }, built: [], frac: {}, hunger: 0, birth: 0, build: 0 };
  return civ.off;
}

// Дробные доли копятся, в запасы идут целые единицы.
function gain(civ, off, k, v) {
  const t = (off.frac[k] ?? 0) + v;
  const whole = Math.floor(t);
  off.frac[k] = t - whole;
  if (whole <= 0) return;
  // В фоне склады не бездонные: лишнее не копится.
  const cap = k === "iron" || k === "diamond" || k === "coal" ? 60 + 40 * civ.era : 400 + 300 * civ.era;
  const add = Math.max(0, Math.min(whole, cap - (civ.res[k] ?? 0)));
  civ.res[k] = (civ.res[k] ?? 0) + add;
  off.got[k] = (off.got[k] ?? 0) + add;
}

const totalCost = (type) => {
  const c = { wood: 0, stone: 0, iron: 0, food: 0 };
  for (const op of getBP(type).ops) for (const k in op.cost ?? {}) c[k] = (c[k] ?? 0) + op.cost[k];
  // Выравнивание площадки: в среднем треть блока земли на клетку (центр задаёт уровень сам).
  const bp = getBP(type);
  c.dirt = type === "center" ? 0 : Math.round(bp.w * bp.d * 0.3);
  return c;
};
// Чего не хватает на постройку — рынок купит это для поселения и вдали от игрока.
const shortOf = (civ, c) => Object.keys(c).find((k) => (civ.res[k] ?? 0) < c[k]);
const affordable = (civ, c) => Object.entries(c).every(([k, v]) => (civ.res[k] ?? 0) >= v);
const pay = (civ, c) => Object.entries(c).forEach(([k, v]) => (civ.res[k] = (civ.res[k] ?? 0) - v));

/** Фоновая симуляция поселения за dt секунд. */
export function offscreenTick(civ, dt) {
  // Поселение ещё ни разу не было рядом с игроком — перепись по тем жителям, что известны.
  if (!civ.census && (S.members.get(civ.id) ?? []).length) takeCensus(civ);
  const c = civ.census;
  if (!c) return;
  const pop = popOf(civ);
  if (pop <= 0) return;
  const off = offOf(civ);
  const k = (dt / 60) * S.speed; // минут работы
  off.mins += dt / 60;
  const R = rolesFor(civ, pop);
  const T = c.tiers;
  const mult = (role) => TIERS[T[role] ?? 0].mult;

  // Добыча.
  const wood = (R.lumberjack ?? 0) * RATE.wood(mult("lumberjack")) * RATE.eff * k;
  gain(civ, off, "wood", wood);
  if ((civ.res.saplings ?? 0) < 64) gain(civ, off, "saplings", wood / 30); // примерно 1 саженец с двух деревьев
  const blocks = (R.miner ?? 0) * RATE.blocks(mult("miner")) * RATE.eff * k;
  // В камне попадаются андезит и уголь — их откладывают отдельно.
  gain(civ, off, "stone", blocks * 0.85);
  gain(civ, off, "andesite", blocks * 0.1);
  gain(civ, off, "coal", blocks * 0.015);
  if ((T.miner ?? 0) >= 2) gain(civ, off, "iron", blocks * 0.008); // железо — с каменной кирки
  if ((T.miner ?? 0) >= 3) gain(civ, off, "diamond", blocks * 0.0006); // алмазы — с железной
  // Песок копают руками (лопат у жителей нет): ~40 блоков в минуту.
  gain(civ, off, "sand", (R.sander ?? 0) * 40 * RATE.eff * k);
  // Земля: землекопы (~40 в минуту) и то, что срезают при выравнивании и проходке шахты.
  gain(civ, off, "dirt", ((R.digger ?? 0) * 40 + blocks * 0.05) * RATE.eff * k);
  smeltTick(civ, k);

  // Еда и голод.
  const farms = count(civ, (b) => b.t.startsWith("farm")) + (civ.offQueue ?? []).filter((q) => q.t.startsWith("farm")).length;
  const farmers = Math.min(R.farmer ?? 0, farms * 2);
  const food = (farmers * RATE.food(mult("farmer")) + (R.hunter ?? 0) * RATE.hunt) * RATE.eff * k - pop * RATE.eat * k;
  const f = civ.res.food + food + (off.frac.food ?? 0);
  civ.res.food = Math.max(0, Math.min(foodCap(civ), Math.floor(f)));
  off.frac.food = f > 0 ? f - Math.floor(f) : 0;
  off.got.food += food;
  if (f <= 0) {
    // Голодают: каждые 2 минуты без еды умирает один житель.
    civ.starving = true;
    off.hunger += k;
    while (off.hunger >= 2 && popOf(civ) > 0) {
      off.hunger -= 2;
      off.pop--;
      off.died++;
      civ.deaths++;
    }
  } else {
    civ.starving = false;
    off.hunger = Math.max(0, off.hunger - k);
    // Рождения: раз в 20 секунд, если есть еда и свободные кровати (до 100 жителей).
    off.birth += k;
    while (off.birth >= 0.35) {
      off.birth -= 0.35;
      const p = popOf(civ);
      if (civ.res.food < 10 + p || p >= housingOf(civ) || p >= MAX_POP) {
        off.birth = 0;
        break;
      }
      {
        off.pop++;
        off.born++;
        civ.born++;
        civ.res.food -= 8;
      }
    }
  }

  // Инструменты: делают лучшие, если хватает ресурсов на всех работников профессии.
  const reserve = remainingCost(civ);
  for (const role in TOOL_FOR) {
    const n = R[role] ?? 0;
    if (!n) continue;
    const t = bestCraftable(civ, reserve);
    if (t <= (T[role] ?? 0)) continue;
    const cost = {};
    for (const [r, v] of Object.entries(TIERS[t].cost)) cost[r] = v * n;
    if (!affordable(civ, cost)) continue;
    pay(civ, cost);
    T[role] = t;
  }

  // Стройка: строители ставят ~60 блоков в минуту, если ресурсов хватает на всю постройку.
  const builders = Math.max(R.builder ?? 0, pop >= 3 ? 1 : 0);
  off.build = Math.min(3000, off.build + builders * RATE.build * RATE.eff * k);
  civ.offQueue = civ.offQueue ?? [];
  const p = civ.project;
  if (p && !p.paid) {
    const ops = remainingCost(civ);
    const left = getBP(p.t).ops.length;
    const miss = shortOf(civ, ops);
    civ.waiting = miss ? RES_NAME[miss] ?? miss : "";
    if (off.build >= left && !miss) {
      pay(civ, ops);
      off.build -= left;
      // Место уже выбрано — блоки поставят, когда игрок придёт.
      civ.offQueue.push({ t: p.t, x: p.x, y: p.y, z: p.z, r: p.r });
      if (p.fromQueue) civ.qi++;
      civ.project = null;
      off.built.push(TYPES[p.t].name);
    }
  } else if (!p) {
    const next = chooseNext(civ);
    if (next) {
      const cost = totalCost(next.t);
      const n = getBP(next.t).ops.length;
      const miss = shortOf(civ, cost);
      civ.waiting = miss ? RES_NAME[miss] ?? miss : "";
      if (off.build >= n && !miss) {
        pay(civ, cost);
        off.build -= n;
        civ.offQueue.push({ t: next.t });
        noteBuilt(civ, next.t);
        if (next.fromQueue) civ.qi++;
        off.built.push(TYPES[next.t].name);
      }
    }
  }
  craftTorches(civ);
  raidOffscreen(civ, off, k);
  planWall(civ);
  eraTick(civ);
  colonyOffscreen(civ, pop);
  markDirty(civ);
}

/**
 * Колония без игрока: 4 жителя уходят на 70–100 блоков и основывают новое поселение.
 * Рельеф там неизвестен — точное место (суша, высота) уточнится, когда игрок придёт.
 */
function colonyOffscreen(civ, pop) {
  if (civ.war || civ.era < 1 || pop < 15 || civ.res.food < 30 || S.clock < (civ.colonyAt ?? 0)) return;
  if ((civ.coloniesFounded ?? 0) >= MAX_COLONIES) return;
  civ.colonyAt = S.clock + Math.round(1500 / S.speed);
  if (S.civs.size >= MAX_CIVS) return;
  let dest;
  for (let i = 0; i < 16 && !dest; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 130 + Math.random() * 40;
    const p = { x: Math.floor(civ.center.x + Math.cos(a) * d), y: civ.center.y, z: Math.floor(civ.center.z + Math.sin(a) * d) };
    // Подальше от чужих земель: стены поселений должны быть минимум в 50 блоках друг от друга.
    if (!colonySiteFree(p)) continue;
    // Колонию не основывают прямо рядом с игроком — там её бы увидели «из ниоткуда».
    if (playersNear(p, activeR() + 16).length) continue;
    dest = p;
  }
  if (!dest) return;
  civ.coloniesFounded = (civ.coloniesFounded ?? 0) + 1;
  virtualColony(civ, dest, 4, true);
}

/**
 * Колония, основанная вдали от игрока: живёт по формулам, рельеф уточнится, когда чанк загрузится.
 * offscreen — переселенцы «списываются» из фоновой переписи (вживую их сущности убирают отдельно).
 */
export function virtualColony(civ, dest, n, offscreen) {
  const colony = newCiv({ x: dest.x, y: dest.y ?? civ.center.y, z: dest.z }, civ.id);
  colony._active = false;
  colony.virtualCenter = true;
  colony.census = { pop: n, roles: {}, tiers: { ...(civ.census?.tiers ?? {}) } };
  offOf(colony);
  const give = { wood: Math.min(60, civ.res.wood), stone: Math.min(25, civ.res.stone), food: Math.min(40, civ.res.food), saplings: Math.min(4, civ.res.saplings ?? 0) };
  for (const k in give) civ.res[k] = (civ.res[k] ?? 0) - give[k];
  colony.res = { ...give, iron: 0 };
  const coins = Math.min(40, civ.coins ?? 0);
  civ.coins = (civ.coins ?? 0) - coins;
  colony.coins = coins;
  if (offscreen) {
    offOf(civ).pop -= n;
    offOf(civ).colonies = (offOf(civ).colonies ?? 0) + 1;
  }
  civ.tension[colony.id] = 35;
  colony.tension[civ.id] = 35;
  markDirty(colony);
  markDirty(civ);
  note("events", `Переселенцы из ${civ.name} основали колонию ${colony.name} (координаты ${dest.x}, ${dest.z})`);
  return colony;
}

// Центр колонии, основанной вдали, ставим на настоящую сушу, когда чанк загрузился.
function fixCenter(civ) {
  if (!civ.virtualCenter) return;
  const dry = findDrySpot(DIM(), civ.center.x, civ.center.z, 64);
  if (dry) civ.center = dry;
  civ.virtualCenter = false;
}

/** Игрок вернулся: появляются родившиеся, исчезают умершие, выводится сводка. */
export function materialize(civ) {
  const off = civ.off;
  if (!off) return;
  fixCenter(civ);
  const target = Math.max(0, (civ.census?.pop ?? 0) + off.pop);
  civ.off = null;
  const members = S.members.get(civ.id) ?? [];
  const dim = DIM();
  // Сколько жителей должно быть по фоновой симуляции против тех, что есть на самом деле.
  const diff = target - members.length;
  if (diff > 0) {
    for (let i = 0; i < Math.min(diff, 40); i++) {
      const spot = findSafeSpot(dim, civ.center.x + (Math.random() * 6 - 3), civ.center.y, civ.center.z + (Math.random() * 6 - 3), 5);
      if (!spot) break;
      try {
        const v = dim.spawnEntity("minecraft:villager_v2", spot);
        setProp(v, P.NAME, personName());
        join(civ, v);
      } catch {}
    }
  } else if (diff < 0) {
    const victims = members.filter((e) => brainOf(e, civ.id).role !== "golem").slice(0, -diff);
    for (const e of victims) {
      S.brains.delete(e.id);
      try {
        e.remove();
      } catch {}
    }
  }
  const g = off.got;
  const parts = [];
  if (off.born) parts.push(`родилось ${off.born}`);
  if (off.died) parts.push(`умерло ${off.died}`);
  if (off.colonies) parts.push(`ушли основывать колонии: ${off.colonies * 4} жит.`);
  parts.push(`добыто: дерево ${g.wood}, камень ${g.stone}, железо ${g.iron}${g.diamond ? `, алмазы ${g.diamond}` : ""}`);
  if (off.built.length) parts.push(`построено: ${off.built.join(", ")} (появится по мере возведения)`);
  const msg = `§b[${civ.name}] Пока вас не было (${Math.round(off.mins)} мин): ${parts.join("; ")}.`;
  void msg;
  note("events", `${civ.name} — пока вас не было (${Math.round(off.mins)} мин): ${parts.join("; ")}`);
  civ._reassign = true;
  markDirty(civ);
}

// ---------- Война вдали от игрока ----------
function army(civ) {
  const pop = popOf(civ);
  const soldiers = Math.max(1, Math.floor(pop * 0.45));
  const tier = civ.census?.tiers?.soldier ?? civ.census?.tiers?.hunter ?? 1;
  let power = soldiers * (TIERS[tier].dmg + Math.floor(civ.era / 2) + (has(civ, "barracks") ? 1 : 0));
  if (has(civ, "watchtower")) power *= 1.2;
  return { power, soldiers };
}

function lose(civ, enemy, n) {
  if (n <= 0) return;
  if (civ._active) {
    // Поселение рядом с игроком: гибнут настоящие воины.
    const members = (S.members.get(civ.id) ?? []).slice().sort((a, b) => Number(brainOf(b, civ.id).role === "soldier") - Number(brainOf(a, civ.id).role === "soldier"));
    for (const e of members.slice(0, n)) {
      S.brains.delete(e.id);
      try {
        e.kill();
      } catch {}
    }
  } else offOf(civ).pop -= n;
  civ.deaths += n;
  civ.warLosses += n;
  enemy.kills += n;
  markDirty(civ);
  markDirty(enemy);
}

/** Раунд сражения, если хотя бы одна сторона далеко от игрока (раз в 30 секунд). */
export function abstractBattle(a, b) {
  const A = army(a);
  const B = army(b);
  // Каждые 20 единиц силы армии за раунд убивают в среднем одного врага (±50% удачи).
  const lossB = Math.min(B.soldiers, Math.floor((A.power / 20) * (0.5 + Math.random())));
  const lossA = Math.min(A.soldiers, Math.floor((B.power / 20) * (0.5 + Math.random())));
  lose(a, b, lossA);
  lose(b, a, lossB);
  if (lossA || lossB) warLog(a, b, `бой вдали: ${a.name} потеряли ${lossA}, ${b.name} потеряли ${lossB}`);
}
