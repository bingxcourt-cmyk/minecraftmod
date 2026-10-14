import { EntityDamageCause } from "@minecraft/server";
import { S, DIM, d2, dXZ, rnd, markDirty, sound, particle, loaded, playersNear, cdTicks } from "./core.js";
import { standY } from "./blocks.js";
import { setTarget, near, updateTag } from "./workers.js";
import { TIERS, useTool } from "./tools.js";
import { abstractBattle } from "./offscreen.js";
import { splitDebtLoot, cancelDebt, debtOf } from "./credit.js";
import { has, popOf, count } from "./society.js";
import { note, warStart, warEnd } from "./journal.js";
import { takeLand } from "./territory.js";

const WAR_DIST = 170;

function title(civs, text, sub) {
  const seen = new Set();
  for (const civ of civs) {
    for (const pl of playersNear(civ.center, 200)) {
      if (seen.has(pl.id)) continue;
      seen.add(pl.id);
      try {
        pl.onScreenDisplay.setTitle(text, { subtitle: sub, fadeInDuration: 10, stayDuration: 70, fadeOutDuration: 15 });
      } catch {}
    }
  }
}

// Названия ресурсов для причин войны.
const RES_RU = { wood: "дерево", stone: "камень", food: "еду", iron: "железо", coal: "уголь", andesite: "андезит", saplings: "саженцы", diamond: "алмазы", coins: "монеты", torches: "факелы", sand: "песок", glass: "стекло", dirt: "грунт", land: "землю" };

export function declareWar(a, b, opts = {}) {
  const reason = opts.reason ?? "соперничество";
  a.war = { enemy: b.id, since: S.clock, startPop: popOf(a), reason, res: opts.res, loan: opts.loan };
  b.war = { enemy: a.id, since: S.clock, startPop: popOf(b), reason, res: opts.res, defending: true };
  a.warLosses = 0;
  b.warLosses = 0;
  a._reassign = true;
  b._reassign = true;
  markDirty(a);
  markDirty(b);
  warStart(a, b, reason);
  title([a, b], "§cВОЙНА!", `${a.color}${a.name} §7против ${b.color}${b.name}`);
  sound(DIM(), "raid.horn", a.center, 1);
  sound(DIM(), "raid.horn", b.center, 1);
}

function makePeace(a, b, msg) {
  warEnd(a, b, msg);
  for (const c of [a, b]) {
    // Союзники в войне за долг тоже расходятся.
    for (const o of S.civs.values()) {
      if (o.war?.ally === c.id) {
        o.war = null;
        o._reassign = true;
      }
    }
  }
  a.war = null;
  b.war = null;
  a.tension[b.id] = 0;
  b.tension[a.id] = 0;
  a.peace[b.id] = S.clock + 900;
  b.peace[a.id] = S.clock + 900;
  a._reassign = true;
  b._reassign = true;
  markDirty(a);
  markDirty(b);
  title([a, b], "§aМир", `${a.color}${a.name} §7и ${b.color}${b.name}`);
}

function surrender(loser, winner) {
  // Война за долг: всё, что успели забрать, делят 50/50 кредитор и союзники.
  const debt = splitDebtLoot(loser, winner);
  if (debt) return makePeace(loser, winner, `${loser.name} сдались; ${debt}`);
  if (winner.war?.reason === "долг") cancelDebt(winner, loser);
  // Война за территорию: победитель забирает землю — разбирает пограничные постройки и стену.
  if (winner.war?.res === "land") return makePeace(loser, winner, `${loser.name} сдались; ${takeLand(winner, loser)}`);
  // Обычная война — забирают в первую очередь то, ради чего воевали.
  const want = winner.war?.res;
  const loot = {};
  for (const k in loser.res) {
    loot[k] = Math.floor(loser.res[k] * (k === want ? 0.6 : 0.25));
    loser.res[k] -= loot[k];
    winner.res[k] = (winner.res[k] ?? 0) + loot[k];
  }
  let coins = 0;
  if (want === "coins") {
    coins = Math.floor((loser.coins ?? 0) * 0.5);
    loser.coins -= coins;
    winner.coins = (winner.coins ?? 0) + coins;
  }
  const got = Object.entries(loot).filter(([, v]) => v > 0).map(([k, v]) => `${RES_RU[k] ?? k} ${v}`);
  if (coins) got.unshift(`монеты ${coins}`);
  makePeace(loser, winner, `${loser.name} сдались и заплатили дань ${winner.name}: ${got.join(", ") || "нечего было взять"}`);
}

/**
 * Зачем a воевать с b? Только из-за дефицита: не хватает чего-то, что не купить на рынке
 * (нет товара или рынок закрыт), а у соседа этого много; голод; пустая казна у бедных при богатом соседе.
 */
function motive(a, b) {
  // Некуда расти: сосед занял землю, на которой можно было бы строиться.
  if (a.crowdBy === b.id && (a.crowdUntil ?? 0) > S.clock) return { reason: "территория — за землю", res: "land" };
  if (a.starving && (b.res.food ?? 0) > popOf(b) * 4 + 20) return { reason: "голод — за еду", res: "food" };
  for (const k of Object.keys(a.unmet ?? {})) {
    if (k === "saplings") continue;
    if ((b.res[k] ?? 0) > (a.unmet[k] ?? 0) * 2 + 20) return { reason: `дефицит — за ${RES_RU[k] ?? k}`, res: k };
  }
  if ((a.coins ?? 0) < 20 && (b.coins ?? 0) > 600 && !debtOf(a)) return { reason: "бедность — за монеты", res: "coins" };
  return null;
}

/** Раз в 30 секунд: напряжение растёт только при реальной причине, иначе спадает. */
export function diplomacyTick() {
  const civs = [...S.civs.values()];
  for (let i = 0; i < civs.length; i++) for (let j = i + 1; j < civs.length; j++) {
    const a = civs[i];
    const b = civs[j];
    const dist = dXZ(a.center, b.center);
    if (dist > WAR_DIST) continue;
    if ((a.peace[b.id] ?? 0) > S.clock || a.war || b.war) continue;
    // Враждуют только окрепшие поселения.
    if (popOf(a) < 4 || popOf(b) < 4 || count(a, () => true) < 3 || count(b, () => true) < 3) continue;
    const ma = motive(a, b);
    const mb = motive(b, a);
    let t = a.tension[b.id] ?? 0;
    if (ma || mb) t += 6 + rnd(0, 4) + (dist < 100 ? 2 : 0);
    else t = Math.max(0, t - 2);
    a.tension[b.id] = t;
    b.tension[a.id] = t;
    markDirty(a);
    markDirty(b);
    if (t >= 100) {
      const attacker = ma ? a : b;
      const target = attacker === a ? b : a;
      const m = ma ?? mb;
      declareWar(attacker, target, m);
    }
  }
  for (const civ of civs) {
    if (!civ.war) continue;
    const enemy = S.civs.get(civ.war.enemy);
    if (!enemy) {
      civ.war = null;
      civ._reassign = true;
      continue;
    }
    // Пара обрабатывается один раз; союзники — отдельной парой против должника.
    const mutual = enemy.war?.enemy === civ.id;
    if (mutual && civ.id > enemy.id) continue;
    // Хотя бы одна армия далеко от игрока — сражение считается по формуле.
    if (civ._active === false || enemy._active === false) abstractBattle(civ, enemy);
    if (!mutual) continue; // союзник: сдачу решает пара «кредитор — должник»
    const needA = Math.max(3, Math.ceil((civ.war.startPop ?? 4) * 0.5));
    const needB = Math.max(3, Math.ceil((enemy.war?.startPop ?? 4) * 0.5));
    if (civ.warLosses >= needA && popOf(civ) > 0) surrender(civ, enemy);
    else if (enemy.warLosses >= needB && popOf(enemy) > 0) surrender(enemy, civ);
    else if (S.clock - civ.war.since > (civ.war.reason === "долг" ? 1200 : 600)) {
      if (civ.war.reason === "долг") {
        const lender = civ.war.defending ? enemy : civ;
        cancelDebt(lender === civ ? enemy : civ, lender);
      }
      makePeace(civ, enemy, `${civ.name} и ${enemy.name} устали от войны и заключили мир`);
    }
  }
}

function damageOf(civ, brain, ent) {
  if (brain.role === "golem") return 10;
  const use = useTool(ent, "sword");
  if (use.broke) updateTag(ent, brain, civ);
  return TIERS[use.tier].dmg + Math.floor(civ.era / 2) + (has(civ, "barracks") ? 1 : 0);
}

export function soldierThink(civ, ent, brain, tick) {
  const enemy = civ.war ? S.civs.get(civ.war.enemy) : undefined;
  if (!enemy) {
    brain.target = null;
    return;
  }
  const dim = DIM();
  const foes = [...(S.members.get(enemy.id) ?? []), ...(S.golems.get(enemy.id) ?? [])];
  let best;
  let bd = 28 * 28;
  for (const f of foes) {
    if (!f.isValid) continue;
    const dd = d2(f.location, ent.location);
    if (dd < bd) {
      bd = dd;
      best = f;
    }
  }
  if (best) {
    setTarget(brain, best.location, 1.3);
    if (near(ent, best.location, 2.3, false)) {
      try {
        best.applyDamage(damageOf(civ, brain, ent), { cause: EntityDamageCause.entityAttack, damagingEntity: ent });
      } catch {}
      sound(dim, "game.player.attack.strong", best.location);
      particle(dim, "minecraft:critical_hit_emitter", { x: best.location.x, y: best.location.y + 1, z: best.location.z });
      brain.cd = tick + cdTicks(brain.role === "golem" ? 24 : 16, brain);
    }
    return;
  }
  // Врагов рядом нет — идут к вражескому поселению (если оно загружено), иначе охраняют своё.
  const goal = loaded(dim, enemy.center) ? enemy.center : civ.center;
  setTarget(brain, goal, 6, true);
}

/** Бонусы защитникам: башни дают сопротивление, казармы — регенерацию воинам. */
export function warBuffs(civ) {
  if (!civ.war) return;
  const tower = has(civ, "watchtower");
  const barracks = has(civ, "barracks");
  for (const e of S.members.get(civ.id) ?? []) {
    try {
      if (tower) e.addEffect("resistance", 220, { amplifier: 0, showParticles: false });
      if (barracks && S.brains.get(e.id)?.role === "soldier") e.addEffect("regeneration", 220, { amplifier: 0, showParticles: false });
    } catch {}
  }
}

/** В эпоху королевства с замком цивилизация содержит железных стражей. */
export function golemTick(civ) {
  if (civ.era < 3 || !has(civ, "castle")) return;
  if ((S.golems.get(civ.id) ?? []).length >= 2 || civ.res.iron < 15) return;
  const dim = DIM();
  const x = civ.center.x + 3.5;
  const z = civ.center.z + 3.5;
  const y = standY(dim, x, z);
  if (y === undefined) return;
  try {
    const g = dim.spawnEntity("minecraft:iron_golem", { x, y, z });
    civ.res.iron -= 15;
    g.setDynamicProperty("civ:id", civ.id);
    g.setDynamicProperty("civ:role", "golem");
    g.nameTag = `${civ.color}Страж ${civ.name}`;
    markDirty(civ);
    note("events", `${civ.name}: выкован железный страж`);
  } catch {}
}
