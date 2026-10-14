import { S, DIM, markDirty, rnd, setProp, getProp, P } from "./core.js";
import { has, popOf, join } from "./society.js";
import { note, warLog } from "./journal.js";
import { findSafeSpot } from "./nav.js";
import { money } from "./money.js";

// ---------- Осада и наёмники ----------
// Таран: поселение с кузницей на войне строит таран (40 дерева, 10 железа) — его воины ломают
// вражескую стену втрое быстрее. Кипяток: у защитников с кузницей лучники на стене бьют сильнее
// тех, кто ломает стену. Наёмники: богатое поселение, которое проигрывает войну, нанимает
// троих воинов у соседа за 400 монет; после войны наёмники уходят.
const RAM_COST = { wood: 40, iron: 10 };
const MERC_PRICE = 400;
const MERC_PROP = "civ:merc";

export const hasRam = (civ) => !!civ?.war?.ram;
export const hasBoilingOil = (civ) => has(civ, "smithy");

export function siegeTick(civ) {
  if (!civ.war) {
    dismissMercs(civ);
    return;
  }
  const enemy = S.civs.get(civ.war.enemy);
  if (!enemy) return;
  // Таран — только если у врага есть стена, а у нас кузница.
  if (!civ.war.ram && enemy.wall && has(civ, "smithy") && Object.entries(RAM_COST).every(([k, v]) => (civ.res[k] ?? 0) >= v + 20)) {
    for (const [k, v] of Object.entries(RAM_COST)) civ.res[k] -= v;
    civ.war.ram = true;
    markDirty(civ);
    warLog(civ, enemy, `${civ.name} построили таран`);
  }
  // Наёмники — когда своих потерь заметно больше, а денег много.
  if (!civ.war.mercs && (civ.coins ?? 0) >= MERC_PRICE + 300 && (civ.warLosses ?? 0) > (enemy.warLosses ?? 0) + 1) {
    // Нанимают у самого большого мирного соседа; если такого нет — вольный отряд (монеты уходят из мира).
    const from = [...S.civs.values()].filter((c) => c !== civ && c !== enemy && !c.war && popOf(c) >= 8).sort((a, b) => popOf(b) - popOf(a))[0];
    civ.coins = money(civ.coins - MERC_PRICE);
    if (from) {
      from.coins = money((from.coins ?? 0) + MERC_PRICE);
      markDirty(from);
    }
    civ.war.mercs = 3;
    markDirty(civ);
    spawnMercs(civ, 3);
    warLog(civ, enemy, `${civ.name} наняли троих воинов ${from ? `у ${from.name}` : "из вольного отряда"} за ${MERC_PRICE} мон.`);
  }
}

function spawnMercs(civ, n) {
  const dim = DIM();
  for (let i = 0; i < n; i++) {
    const spot = findSafeSpot(dim, civ.center.x + rnd(-3, 3), civ.center.y, civ.center.z + rnd(-3, 3), 4);
    if (!spot) continue;
    try {
      const v = dim.spawnEntity("minecraft:villager_v2", spot);
      setProp(v, P.NAME, "Наёмник");
      setProp(v, MERC_PROP, 1);
      join(civ, v);
    } catch {}
  }
}

/** После войны наёмники уходят. */
function dismissMercs(civ) {
  for (const e of S.members.get(civ.id) ?? []) {
    if (!getProp(e, MERC_PROP)) continue;
    S.brains.delete(e.id);
    try {
      e.remove();
    } catch {}
  }
}

/** Сколько секунд враг ломает стену: таран быстрее, каменная кладка защитников — дольше. */
export function breakTime(attacker, defender) {
  let t = 60;
  if (defender?.techs?.includes("masonry")) t += 30;
  if (hasRam(attacker)) t = Math.round(t / 3);
  return t;
}

export const isMerc = (e) => !!getProp(e, MERC_PROP);
export { note };
