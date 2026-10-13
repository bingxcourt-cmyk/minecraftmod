import { EntityDamageCause } from "@minecraft/server";
import { DIM, d2, sound, particle, cdTicks, getB } from "./core.js";
import { setTarget, near, updateTag, wander } from "./workers.js";
import { TIERS, useTool } from "./tools.js";

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
  if (!best) return wander(civ, brain, 14);
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
