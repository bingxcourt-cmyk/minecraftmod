import { DIM, getB, loaded, markDirty, particle, sound } from "./core.js";

// Факелы только из угля: 1 уголь + 1 дерево (палка) = 4 факела, как в игре.
// Фонарь = факел + железо. Если факелов нет, постройку всё равно ставят, а место под свет
// запоминают — и расставляют факелы, как только появится уголь.
export const isLight = (id) => id === "minecraft:torch" || id === "minecraft:lantern";
const LIGHT_COST = { "minecraft:torch": { torches: 1 }, "minecraft:lantern": { torches: 1, iron: 1 } };
const MAX_PENDING = 150;

/** Запомнить место под факел/фонарь. */
export function deferLight(civ, x, y, z, id) {
  civ.lights = civ.lights ?? [];
  if (civ.lights.length >= MAX_PENDING) return;
  if (civ.lights.some((l) => l.x === x && l.y === y && l.z === z)) return;
  civ.lights.push({ x, y, z, id });
  markDirty(civ);
}

/** Крафт факелов из угля, пока их меньше нужного. */
export function craftTorches(civ) {
  const want = Math.min(32, (civ.lights?.length ?? 0) + 8);
  let made = false;
  while ((civ.res.torches ?? 0) < want && (civ.res.coal ?? 0) >= 1 && (civ.res.wood ?? 0) >= 1) {
    civ.res.coal--;
    civ.res.wood--;
    civ.res.torches = (civ.res.torches ?? 0) + 4;
    made = true;
  }
  if (made) markDirty(civ);
}

const canPay = (civ, c) => Object.entries(c).every(([k, v]) => (civ.res[k] ?? 0) >= v);

/** Раз в секунду: расставляем отложенные факелы и фонари там, где чанки загружены. */
export function lightsTick(civ) {
  if (!civ.lights?.length) return;
  craftTorches(civ);
  const dim = DIM();
  let placed = 0;
  const before = civ.lights.length;
  for (let i = 0; i < civ.lights.length && placed < 3; i++) {
    const l = civ.lights[i];
    if (!loaded(dim, l)) continue;
    const cost = LIGHT_COST[l.id] ?? { torches: 1 };
    // Нечем зажечь этот (например, фонарь без железа) — пропускаем, а факелы дальше ставим.
    if (!canPay(civ, cost)) continue;
    const b = getB(dim, l.x, l.y, l.z);
    if (!b) continue;
    civ.lights.splice(i--, 1);
    if (!b.isAir) continue; // место уже занято — свет там не нужен
    try {
      b.setType(l.id);
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(cost)) civ.res[k] -= v;
    particle(dim, "minecraft:basic_flame_particle", { x: l.x + 0.5, y: l.y + 0.6, z: l.z + 0.5 });
    sound(dim, "fire.ignite", l, 0.4);
    placed++;
  }
  // Сохраняем, только если что-то поменялось (иначе поселение перезаписывалось бы каждую секунду).
  if (civ.lights.length !== before) markDirty(civ);
}
