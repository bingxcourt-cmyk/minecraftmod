import { S, DIM, markDirty, rnd, pick, sound, particle, playersNear, personName, announce, loaded } from "./core.js";
import { popOf, housingOf, has } from "./society.js";
import { note } from "./journal.js";
import { hasTech } from "./progress.js";

// ---------- Настроение, праздники, бунты, болезни, правители ----------
// Всё считается и вживую, и в фоне (minutes — минуты симуляции за вызов).

const TRAITS = {
  warrior: { name: "воинственный", hint: "армия сильнее, ссоры с соседами чаще" },
  trader: { name: "торговец", hint: "налоги выше на 50%" },
  builder: { name: "строитель", hint: "стройка быстрее на 30%" },
};
const TITLES = ["Вождь", "Староста", "Князь", "Король", "Президент"];
export const titleOf = (civ) => TITLES[Math.min(civ.era, TITLES.length - 1)];
export const traitOf = (civ) => civ.ruler?.trait ?? null;

function newRuler(civ, heir) {
  const trait = pick(Object.keys(TRAITS));
  civ.ruler = { name: personName(), trait, since: S.clock, life: rnd(3600, 7200), heir: !!heir };
  markDirty(civ);
}

/** Правитель стареет и умирает; наследник иногда получает трон через смуту. */
function rulerTick(civ) {
  if (!civ.ruler) {
    newRuler(civ, false);
    note("events", `${civ.name}: правителем стал ${titleOf(civ).toLowerCase()} ${civ.ruler.name} (${TRAITS[civ.ruler.trait].name})`);
    return;
  }
  if (S.clock - civ.ruler.since < civ.ruler.life) return;
  const old = civ.ruler.name;
  newRuler(civ, true);
  if (Math.random() < 0.3) {
    // Смута: споры о троне, стройка встаёт на 3 минуты, настроение падает.
    civ.mood = Math.max(0, (civ.mood ?? 60) - 25);
    civ.blockedUntil = S.clock + 180;
    note("events", `${civ.name}: умер ${old}, смута за трон — победил ${civ.ruler.name} (${TRAITS[civ.ruler.trait].name})`);
  } else note("events", `${civ.name}: умер ${old}, трон унаследовал ${civ.ruler.name} (${TRAITS[civ.ruler.trait].name})`);
}

/** Куда стремится настроение: сытость, долги, война, голод, чудо света. */
function moodTarget(civ) {
  const pop = popOf(civ);
  let t = 55;
  if ((civ.res.food ?? 0) >= pop * 3) t += 20;
  if (civ.starving) t -= 40;
  if (Object.values(civ.upkeep?.debt ?? {}).some((v) => v > 0)) t -= 20;
  if (civ.war) t -= 15;
  if (civ.marketBan) t -= 10;
  if (civ._epidemic > S.clock) t -= 15;
  if (has(civ, "wonder")) t += 15;
  if ((civ.festUntil ?? 0) > S.clock) t += 15;
  return Math.max(0, Math.min(100, t));
}

export function moodText(civ) {
  const m = Math.round(civ.mood ?? 60);
  return `${m >= 75 ? "§aрадостное" : m >= 40 ? "§eспокойное" : m >= 20 ? "§6недовольное" : "§cбунтарское"}§r (${m})`;
}

/** Праздник: фейерверки над центром, рождения вдвое чаще 3 минуты. */
function festival(civ) {
  civ.festUntil = S.clock + 180;
  civ.festAt = S.clock + 2400;
  civ.res.food -= Math.min(civ.res.food, popOf(civ));
  markDirty(civ);
  note("events", `${civ.name}: праздник! Жители пируют, рождается больше детей`);
  const dim = DIM();
  if (loaded(dim, civ.center) && playersNear(civ.center, 96).length) {
    for (let i = 0; i < 4; i++) {
      try {
        dim.spawnEntity("minecraft:fireworks_rocket", { x: civ.center.x + rnd(-6, 6), y: civ.center.y + 2, z: civ.center.z + rnd(-6, 6) });
      } catch {}
    }
    sound(dim, "random.levelup", civ.center, 1);
    announce(civ, `§d[${civ.name}] Праздник!`, 96);
  }
}

/** Бунт: недовольные (четверть жителей, минимум 3) уходят и основывают своё поселение. */
function riot(civ, liveRemove, foundRebels) {
  const pop = popOf(civ);
  const n = Math.max(3, Math.floor(pop * 0.25));
  civ.riotAt = S.clock + 3600;
  civ.mood = 45;
  note("events", `${civ.name}: бунт! ${n} недовольных жителей ушли и основали своё поселение`);
  const a = Math.random() * Math.PI * 2;
  const d = rnd(120, 160);
  const dest = { x: Math.floor(civ.center.x + Math.cos(a) * d), y: civ.center.y, z: Math.floor(civ.center.z + Math.sin(a) * d) };
  liveRemove(civ, n);
  const rebels = foundRebels(civ, dest, n);
  if (rebels) {
    rebels.tension[civ.id] = 70;
    civ.tension[rebels.id] = 70;
    rebels.peace = {};
  }
}

/** Эпидемия: в тесноте без знахарской болеют и умирают чаще. */
function diseaseTick(civ, minutes, kill) {
  const pop = popOf(civ);
  let k = (has(civ, "herbalist") ? 0.3 : 1) * (hasTech(civ, "medicine") ? 0.5 : 1);
  if ((civ._epidemic ?? 0) > S.clock) {
    civ._sick = (civ._sick ?? 0) + minutes * 0.6 * k;
    while (civ._sick >= 1) {
      civ._sick -= 1;
      kill(civ);
    }
    return;
  }
  if (pop < 15 || pop / Math.max(1, housingOf(civ)) < 0.8) return;
  if (Math.random() < 0.02 * minutes * k) {
    civ._epidemic = S.clock + 240;
    civ._sick = 0;
    note("events", `${civ.name}: эпидемия!${has(civ, "herbalist") ? " Знахари лечат больных." : " Без знахарской будет много жертв."}`);
  }
}

/**
 * Раз в 10 секунд вживую или раз в шаг фоновой симуляции.
 * hooks.liveRemove(civ, n) — убрать n жителей (ушли бунтовщики),
 * hooks.foundRebels(civ, dest, n) — основать поселение бунтовщиков,
 * hooks.kill(civ) — один житель умер от болезни.
 */
export function lifeTick(civ, minutes, hooks) {
  if (popOf(civ) <= 0) return;
  rulerTick(civ);
  const target = moodTarget(civ);
  const m = civ.mood ?? 60;
  civ.mood = m + Math.sign(target - m) * Math.min(Math.abs(target - m), 4 * minutes);
  // Праздник раз в 40 минут, если все довольны и еды вдоволь.
  if (civ.mood >= 75 && (civ.res.food ?? 0) >= popOf(civ) * 4 && (civ.festAt ?? 0) <= S.clock) festival(civ);
  // Бунт, если недовольство держится 5 минут.
  if (civ.mood < 20 && popOf(civ) >= 12) {
    civ.angry = (civ.angry ?? 0) + minutes;
    if (civ.angry >= 5 && (civ.riotAt ?? 0) <= S.clock && S.civs.size < 30) {
      civ.angry = 0;
      riot(civ, hooks.liveRemove, hooks.foundRebels);
    }
  } else civ.angry = 0;
  diseaseTick(civ, minutes, hooks.kill);
  markDirty(civ);
}

export { TRAITS, newRuler };

/** Для частиц праздника и болезни вживую (вызывается раз в секунду рядом с игроком). */
export function lifeFx(civ) {
  const dim = DIM();
  if ((civ._epidemic ?? 0) > S.clock && S.clock % 3 === 0) {
    for (const e of (S.members.get(civ.id) ?? []).slice(0, 4)) particle(dim, "minecraft:villager_angry", { x: e.location.x, y: e.location.y + 2, z: e.location.z });
  }
  if ((civ.festUntil ?? 0) > S.clock && S.clock % 20 === 0) {
    try {
      dim.spawnEntity("minecraft:fireworks_rocket", { x: civ.center.x + rnd(-6, 6), y: civ.center.y + 2, z: civ.center.z + rnd(-6, 6) });
    } catch {}
  }
}

