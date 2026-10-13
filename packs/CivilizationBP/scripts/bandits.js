import { S, DIM, rnd, markDirty, sound, playersNear } from "./core.js";
import { findDrySpot } from "./blocks.js";
import { setTarget, near } from "./workers.js";
import { popOf } from "./society.js";
import { note } from "./journal.js";
import { insideWall } from "./walls.js";

// Бандиты — разбойники и поборники Minecraft. Нападают на поселения, ломают стену (минуту),
// грабят склад, если доберутся до центра. Стражники с ополчением и лучники на стене отбиваются.
const TYPES = ["minecraft:pillager", "minecraft:vindicator"];
const RAID_PROP = "civ:raid";

/** Раз в минуту для поселения рядом с игроком: может начаться набег. */
export function raidTick(civ) {
  if (civ.raid || civ.era < 1 || popOf(civ) < 6) return;
  civ.raidAt = civ.raidAt ?? S.clock + rnd(900, 1800);
  if (S.clock < civ.raidAt) return;
  civ.raidAt = S.clock + Math.round(rnd(1200, 2400) / S.speed);
  if (Math.random() > 0.6) return;
  const dim = DIM();
  const a = Math.random() * Math.PI * 2;
  // Появляются за стеной (если она есть) и не ближе 40 блоков от центра.
  const w = civ.wall;
  const r = w ? Math.hypot(w.x2 - w.x1, w.z2 - w.z1) / 2 : 0;
  const d = Math.max(rnd(40, 55), r + 15);
  const spot = findDrySpot(dim, civ.center.x + Math.cos(a) * d, civ.center.z + Math.sin(a) * d, 8);
  if (!spot || insideWall(civ, spot.x, spot.z)) return;
  const n = Math.min(8, 3 + Math.floor(popOf(civ) / 10));
  const ids = [];
  for (let i = 0; i < n; i++) {
    try {
      const e = dim.spawnEntity(TYPES[i % 2], { x: spot.x + rnd(-2, 2) + 0.5, y: spot.y, z: spot.z + rnd(-2, 2) + 0.5 });
      e.setDynamicProperty(RAID_PROP, civ.id);
      e.nameTag = "§4Бандит";
      ids.push(e.id);
    } catch {}
  }
  if (!ids.length) return;
  civ.raid = { ids, since: S.clock, n: ids.length };
  markDirty(civ);
  note("events", `${civ.name}: набег бандитов (${ids.length}) с ${dirName(a)}`);
  for (const pl of playersNear(civ.center, 96)) {
    try {
      pl.onScreenDisplay.setTitle("§4Набег бандитов!", { subtitle: `${civ.color}${civ.name}`, fadeInDuration: 10, stayDuration: 50, fadeOutDuration: 10 });
    } catch {}
  }
  sound(dim, "raid.horn", civ.center, 1);
}

const dirName = (a) => ["востока", "юго-востока", "юга", "юго-запада", "запада", "северо-запада", "севера", "северо-востока"][((Math.round((a / (Math.PI * 2)) * 8) % 8) + 8) % 8];

export const raidPropOf = (e) => {
  try {
    return e.getDynamicProperty(RAID_PROP);
  } catch {
    return undefined;
  }
};

/** «Мозг» бандита: идёт к центру поселения, у центра грабит склад и уходит. */
export function raiderThink(civ, ent, brain) {
  if (brain.fled) {
    if (S.clock - brain.fled > 30) {
      try {
        ent.remove();
      } catch {}
    }
    return;
  }
  setTarget(brain, civ.center, 3);
  if (!near(ent, civ.center, 4, true)) return;
  // Добрались до центра — грабят 10% дерева, еды и монет и убегают.
  const loot = { wood: Math.floor((civ.res.wood ?? 0) * 0.1), food: Math.floor((civ.res.food ?? 0) * 0.1), coins: Math.floor((civ.coins ?? 0) * 0.1) };
  civ.res.wood -= loot.wood;
  civ.res.food -= loot.food;
  civ.coins = (civ.coins ?? 0) - loot.coins;
  markDirty(civ);
  note("events", `${civ.name}: бандит прорвался к центру и унёс ${loot.wood} дерева, ${loot.food} еды, ${loot.coins} мон.`);
  brain.fled = S.clock;
  const a = Math.random() * Math.PI * 2;
  setTarget(brain, { x: civ.center.x + Math.cos(a) * 60, y: civ.center.y, z: civ.center.z + Math.sin(a) * 60 }, 3, true);
}

/** Раз в секунду: набег закончился? */
export function raidCheck(civ) {
  const r = civ.raid;
  if (!r) return;
  const alive = r.ids.filter((id) => S.brains.get(id)?.ent?.isValid);
  if (alive.length && S.clock - r.since < 420) return;
  // Затянулся набег — оставшиеся уходят сами.
  for (const id of alive) {
    try {
      S.brains.get(id)?.ent?.remove();
    } catch {}
  }
  const killed = civ.raidKills ?? 0;
  note("events", killed >= r.n ? `${civ.name}: набег отбит, все ${r.n} бандитов убиты` : `${civ.name}: бандиты ушли (убито ${killed} из ${r.n})`);
  civ.raid = null;
  civ.raidKills = 0;
  markDirty(civ);
}

/** Набег вдали от игрока — по формуле: стена и стражники против бандитов. */
export function raidOffscreen(civ, off, k) {
  if (civ.era < 1 || popOf(civ) < 6) return;
  if (Math.random() > k / 35) return; // в среднем раз в 35 минут
  const share = civ.wall ? (civ.wall.done.split("1").length - 1) / civ.wall.n : 0;
  const prog = civ.wall ? civ.wall.prog / civ.wall.n : 0;
  const defense = Math.max(share, prog) * 0.7 + Math.min(0.3, popOf(civ) / 100);
  if (Math.random() < defense) {
    note("events", `${civ.name}: набег бандитов отбит (без вас)`);
    return;
  }
  const lost = rnd(1, 2);
  off.pop -= lost;
  off.died += lost;
  civ.deaths += lost;
  civ.causes = civ.causes ?? {};
  civ.causes.raid = (civ.causes.raid ?? 0) + lost;
  civ.res.wood = Math.floor(civ.res.wood * 0.85);
  civ.res.food = Math.floor(civ.res.food * 0.85);
  markDirty(civ);
  note("events", `${civ.name}: бандиты разграбили поселение (без вас), погибло ${lost}`);
}
