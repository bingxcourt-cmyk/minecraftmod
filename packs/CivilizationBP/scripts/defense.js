import { EntityDamageCause } from "@minecraft/server";
import { DIM, d2, sound, particle, cdTicks, getB } from "./core.js";
import { setTarget, near, updateTag, wander } from "./workers.js";
import { TIERS, useTool } from "./tools.js";
import { insideWall, wallShare, wallTop } from "./walls.js";
import { S, getProp, setProp, markDirty } from "./core.js";
import { remainingCost, brainOf } from "./workers.js";
import { ERAS } from "./society.js";
import { note } from "./journal.js";

// Враги, от которых защищаются. Криперов не трогают — взорвутся посреди деревни.
const IGNORE = new Set([
  "minecraft:creeper", "minecraft:enderman", "minecraft:warden", "minecraft:wither", "minecraft:ender_dragon",
  "minecraft:zombie_pigman", "minecraft:piglin", "minecraft:shulker", "minecraft:guardian", "minecraft:elder_guardian",
]);
const THREAT_R = 48;

/** Раз в секунду: какие враги рядом с поселением. */
export function scanThreats(civ) {
  let list = [];
  try {
    list = DIM().getEntities({ location: civ.center, maxDistance: THREAT_R, families: ["monster"] });
  } catch {}
  const dim = DIM();
  // Враги в воде (утопленники в озере) недостижимы — из-за них не поднимаем тревогу.
  civ._threats = list.filter((e) => {
    if (IGNORE.has(e.typeId)) return false;
    const l = e.location;
    const b = getB(dim, Math.floor(l.x), Math.floor(l.y), Math.floor(l.z));
    return !b?.isLiquid;
  });
}

/** Стражник: бьёт ближайшего врага, а если врагов нет — обходит поселение. */
export function guardThink(civ, ent, brain, tick) {
  const threats = (civ._threats ?? []).filter((e) => e.isValid);
  let best;
  let bd = Infinity;
  for (const e of threats) {
    const dd = d2(e.location, ent.location);
    if (dd < bd) {
      bd = dd;
      best = e;
    }
  }
  if (!best) {
    brain.onWall = false;
    return wander(civ, brain, 14);
  }
  // Враг за стеной — стражник поднимается на стену и стреляет из лука.
  if (civ.wall && wallShare(civ) > 0.5 && !insideWall(civ, best.location.x, best.location.z)) {
    const top = wallTop(civ, best.location);
    if (top) {
      if (!brain.onWall || Math.hypot(ent.location.x - top.x, ent.location.z - top.z) > 6) {
        brain.target = null;
        brain.path = null;
        try {
          ent.teleport(top, { facingLocation: best.location });
        } catch {}
        brain.onWall = true;
      }
      if (Math.sqrt(bd) <= 30) {
        try {
          best.applyDamage(4 + Math.floor(civ.era / 2), { cause: EntityDamageCause.projectile, damagingEntity: ent });
          ent.teleport(ent.location, { facingLocation: { x: best.location.x, y: best.location.y + 1, z: best.location.z } });
        } catch {}
        const dim = DIM();
        sound(dim, "random.bow", ent.location);
        particle(dim, "minecraft:critical_hit_emitter", { x: best.location.x, y: best.location.y + 1, z: best.location.z });
      }
      brain.cd = tick + cdTicks(30, brain);
      return;
    }
  }
  brain.onWall = false;
  setTarget(brain, best.location, 1.3);
  if (!near(ent, best.location, 2.4, false)) return;
  const use = useTool(ent, "sword");
  if (use.broke) updateTag(ent, brain, civ);
  const dmg = TIERS[use.tier].dmg + 1 + Math.floor(civ.era / 2);
  try {
    best.applyDamage(dmg, { cause: EntityDamageCause.entityAttack, damagingEntity: ent });
  } catch {}
  const dim = DIM();
  sound(dim, "game.player.attack.strong", best.location);
  particle(dim, "minecraft:critical_hit_emitter", { x: best.location.x, y: best.location.y + 1, z: best.location.z });
  try {
    ent.teleport(ent.location, { facingLocation: { x: best.location.x, y: best.location.y + 1, z: best.location.z } });
  } catch {}
  brain.cd = tick + cdTicks(14, brain);
}

// ---------- Броня ----------
// Железная (24 железа) и алмазная (24 алмаза) броня для воинов и стражников — только из излишков:
// сначала стройка, эпоха и инструменты. Броня даёт сопротивление урону: железо −20%, алмаз −40%.
const ARMOR_ROLES = new Set(["soldier", "guard"]);
export const ARMOR_NAME = ["", "жел. броня", "алм. броня"];

export function armorOf(ent) {
  return Number(getProp(ent, "civ:armor") ?? 0);
}

/** Раз в 10 секунд: обновить броню и её эффект. */
export function armorTick(civ) {
  const fighters = (S.members.get(civ.id) ?? []).filter((e) => ARMOR_ROLES.has(brainOf(e, civ.id).role));
  if (!fighters.length) return;
  const rc = remainingCost(civ);
  const next = ERAS[civ.era].next;
  const ironKeep = Math.max(rc.iron, next?.iron ?? 0) + 20;
  for (const e of fighters) {
    let a = armorOf(e);
    if (a < 2 && (civ.res.diamond ?? 0) >= 24 + 6) {
      civ.res.diamond -= 24;
      a = 2;
      note("events", `${civ.name}: выкована алмазная броня`);
    } else if (a < 1 && (civ.res.iron ?? 0) - 24 >= ironKeep) {
      civ.res.iron -= 24;
      a = 1;
    }
    if (a !== armorOf(e)) {
      setProp(e, "civ:armor", a);
      markDirty(civ);
      brainOf(e, civ.id).tag = null; // обновить подпись
    }
    if (a > 0) {
      try {
        e.addEffect("resistance", 240, { amplifier: a - 1, showParticles: false });
      } catch {}
    }
  }
}
