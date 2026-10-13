import { world, EntityDamageCause } from "@minecraft/server";
import { S, DIM, d2, dXZ, rnd, markDirty, sound, particle, loaded, playersNear, cdTicks } from "./core.js";
import { standY } from "./blocks.js";
import { setTarget, near, updateTag } from "./workers.js";
import { TIERS, useTool } from "./tools.js";
import { abstractBattle } from "./offscreen.js";
import { has, popOf } from "./society.js";

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

export function declareWar(a, b) {
  a.war = { enemy: b.id, since: S.clock, startPop: popOf(a) };
  b.war = { enemy: a.id, since: S.clock, startPop: popOf(b) };
  a.warLosses = 0;
  b.warLosses = 0;
  a._reassign = true;
  b._reassign = true;
  markDirty(a);
  markDirty(b);
  world.sendMessage(`§c[Война] ${a.color}§l${a.name}§r§c объявили войну ${b.color}§l${b.name}§r§c!`);
  title([a, b], "§cВОЙНА!", `${a.color}${a.name} §7против ${b.color}${b.name}`);
  sound(DIM(), "raid.horn", a.center, 1);
  sound(DIM(), "raid.horn", b.center, 1);
}

function makePeace(a, b, msg) {
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
  world.sendMessage(msg);
  title([a, b], "§aМир", `${a.color}${a.name} §7и ${b.color}${b.name}`);
}

function surrender(loser, winner) {
  const loot = {};
  for (const k in loser.res) {
    loot[k] = Math.floor(loser.res[k] * 0.4);
    loser.res[k] -= loot[k];
    winner.res[k] = (winner.res[k] ?? 0) + loot[k];
  }
  makePeace(
    loser,
    winner,
    `§6[Война] ${loser.color}${loser.name}§6 сдались и заплатили дань ${winner.color}${winner.name}§6: ` +
      `дерево ${loot.wood}, камень ${loot.stone}, еда ${loot.food}, железо ${loot.iron}.`
  );
}

/** Раз в 30 секунд: растёт напряжение между соседями, объявляются войны и заключается мир. */
export function diplomacyTick() {
  const civs = [...S.civs.values()];
  for (let i = 0; i < civs.length; i++) for (let j = i + 1; j < civs.length; j++) {
    const a = civs[i];
    const b = civs[j];
    const dist = dXZ(a.center, b.center);
    if (dist > WAR_DIST) continue;
    if ((a.peace[b.id] ?? 0) > S.clock || a.war || b.war) continue;
    // Враждуют только окрепшие поселения.
    if (popOf(a) < 4 || popOf(b) < 4 || a.buildings.length < 3 || b.buildings.length < 3) continue;
    let t = (a.tension[b.id] ?? 0) + 1 + rnd(0, 2);
    if (dist < 100) t += 1;
    if (a.starving || b.starving) t += 8;
    if (a.era !== b.era) t += 1;
    a.tension[b.id] = t;
    b.tension[a.id] = t;
    markDirty(a);
    markDirty(b);
    if (t >= 100) {
      // Нападает голодный или более сильный.
      const attacker = a.starving && !b.starving ? a : b.starving && !a.starving ? b : popOf(a) >= popOf(b) ? a : b;
      declareWar(attacker, attacker === a ? b : a);
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
    if (civ.id > enemy.id) continue;
    // Хотя бы одна армия далеко от игрока — сражение считается по формуле.
    if (civ._active === false || enemy._active === false) abstractBattle(civ, enemy);
    const needA = Math.max(3, Math.ceil((civ.war.startPop ?? 4) * 0.5));
    const needB = Math.max(3, Math.ceil((enemy.war?.startPop ?? 4) * 0.5));
    if (civ.warLosses >= needA && popOf(civ) > 0) surrender(civ, enemy);
    else if (enemy.warLosses >= needB && popOf(enemy) > 0) surrender(enemy, civ);
    else if (S.clock - civ.war.since > 600) {
      makePeace(civ, enemy, `§a[Мир] ${civ.color}${civ.name}§a и ${enemy.color}${enemy.name}§a устали от войны и заключили мир.`);
    }
  }
}

// Урон воина зависит от меча (как у Стива) и от казарм/эпохи.
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
    for (const pl of playersNear(civ.center, 80)) pl.sendMessage(`§f[${civ.name}] Выкован железный страж.`);
  } catch {}
}
