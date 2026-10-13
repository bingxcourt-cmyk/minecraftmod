import { getProp, setProp, markDirty, sound, particle, DIM, playersNear } from "./core.js";

// Какой инструмент нужен профессии.
export const TOOL_FOR = { lumberjack: "axe", miner: "pickaxe", farmer: "hoe", hunter: "sword", soldier: "sword" };
export const TOOL_NAME = { axe: "топор", pickaxe: "кирка", hoe: "мотыга", sword: "меч" };

// Уровни как у Стива: рука, дерево, камень, железо, алмаз.
// mult — во сколько раз дольше действие, dur — прочность, dmg — урон мечом.
export const TIERS = [
  { name: "рука", mult: 3, dur: 0, dmg: 1 },
  { name: "деревянный", short: "дер.", mult: 1.6, dur: 59, dmg: 4, cost: { wood: 4 } },
  { name: "каменный", short: "кам.", mult: 1, dur: 131, dmg: 5, cost: { wood: 1, stone: 3 } },
  { name: "железный", short: "жел.", mult: 0.7, dur: 250, dmg: 6, cost: { wood: 1, iron: 3 }, needs: "smithy" },
  { name: "алмазный", short: "алм.", mult: 0.5, dur: 1561, dmg: 7, cost: { wood: 1, diamond: 3 }, needs: "smithy" },
];

const KEY = "civ:tools";

export function toolsOf(ent) {
  try {
    return JSON.parse(String(getProp(ent, KEY) ?? "{}"));
  } catch {
    return {};
  }
}

export const toolTier = (ent, kind) => toolsOf(ent)[kind]?.t ?? 0;

export function toolLabel(ent, role) {
  const kind = TOOL_FOR[role];
  if (!kind) return "";
  const t = toolTier(ent, kind);
  return t ? `§8${TIERS[t].short} ${TOOL_NAME[kind]}` : "§cбез инструмента";
}

/**
 * Лучший уровень инструмента, который цивилизация может сделать прямо сейчас.
 * reserve — сколько ресурсов не трогать (они нужны текущей стройке).
 */
export function bestCraftable(civ, reserve = {}) {
  for (let t = TIERS.length - 1; t >= 1; t--) {
    const T = TIERS[t];
    if (T.needs && !civ.buildings.some((b) => b.t === T.needs)) continue;
    if (Object.entries(T.cost).every(([k, v]) => (civ.res[k] ?? 0) - v >= Math.min(reserve[k] ?? 0, 30))) return t;
  }
  return 0;
}

/** Нужно ли жителю сделать (или улучшить) инструмент для своей профессии. */
export function craftNeed(civ, ent, role, reserve) {
  const kind = TOOL_FOR[role];
  if (!kind) return null;
  return bestCraftable(civ, reserve) > toolTier(ent, kind) ? kind : null;
}

/** Делает инструмент из запасов цивилизации. Возвращает уровень или 0. */
export function craft(civ, ent, kind, reserve) {
  const t = bestCraftable(civ, reserve);
  if (t <= toolTier(ent, kind)) return 0;
  for (const [k, v] of Object.entries(TIERS[t].cost)) civ.res[k] -= v;
  const tools = toolsOf(ent);
  tools[kind] = { t, d: TIERS[t].dur };
  setProp(ent, KEY, JSON.stringify(tools));
  markDirty(civ);
  const dim = DIM();
  sound(dim, t >= 3 ? "random.anvil_use" : "dig.wood", ent.location);
  particle(dim, "minecraft:villager_happy", { x: ent.location.x, y: ent.location.y + 2, z: ent.location.z });
  if (t === 4) for (const pl of playersNear(civ.center, 64)) pl.sendMessage(`§b[${civ.name}] Сделан алмазный ${TOOL_NAME[kind]}!`);
  return t;
}

/**
 * Работа инструментом: тратит прочность. Возвращает { mult, tier, broke }.
 */
export function useTool(ent, kind) {
  const tools = toolsOf(ent);
  const tool = tools[kind];
  if (!tool) return { mult: TIERS[0].mult, tier: 0, broke: false };
  const tier = tool.t;
  tool.d--;
  let broke = false;
  if (tool.d <= 0) {
    delete tools[kind];
    broke = true;
    sound(DIM(), "random.break", ent.location);
  }
  setProp(ent, KEY, JSON.stringify(tools));
  return { mult: TIERS[tier].mult, tier, broke };
}
