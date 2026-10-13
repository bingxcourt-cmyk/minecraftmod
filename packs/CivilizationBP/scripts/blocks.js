import { getB } from "./core.js";

export const strip = (id) => (id.startsWith("minecraft:") ? id.slice(10) : id);

// Блоки, сквозь которые можно пройти.
const PASS = new Set([
  "air", "short_grass", "tall_grass", "grass", "tallgrass", "fern", "large_fern", "deadbush", "dead_bush",
  "dandelion", "poppy", "blue_orchid", "allium", "azure_bluet", "oxeye_daisy", "cornflower",
  "lily_of_the_valley", "wither_rose", "sunflower", "lilac", "rose_bush", "peony", "red_flower",
  "yellow_flower", "double_plant", "snow_layer", "vine", "wheat", "carrots", "potatoes", "beetroot",
  "sweet_berry_bush", "reeds", "sugar_cane", "torchflower", "pink_petals", "redstone_wire", "light_block",
  "structure_void", "red_mushroom", "brown_mushroom", "glow_lichen", "leaf_litter", "wildflowers", "bush",
  "firefly_bush", "short_dry_grass", "tall_dry_grass", "cactus_flower", "hanging_roots", "spore_blossom",
  "sculk_vein", "seagrass", "kelp", "waterlily", "lily_pad", "sapling", "ladder", "melon_stem",
  "pumpkin_stem", "cave_vines", "cave_vines_body_with_berries", "cave_vines_head_with_berries",
  "fire", "soul_fire", "tripwire", "tripwire_hook", "lever", "small_dripleaf_block", "pale_hanging_moss",
]);

export function isPassableId(id) {
  const n = strip(id);
  return (
    PASS.has(n) ||
    n.endsWith("_sapling") || n.endsWith("_propagule") || n.endsWith("torch") || n.endsWith("_carpet") ||
    n.endsWith("_button") || n.endsWith("_pressure_plate") || n.endsWith("_sign") || n.endsWith("_banner") ||
    n.endsWith("rail") || n.endsWith("_tulip") || n.endsWith("_door") || n.endsWith("_coral_fan")
  );
}

export const isLeaves = (id) => strip(id).endsWith("leaves");

export function isLog(id) {
  const n = strip(id);
  return (n.endsWith("_log") || n === "log" || n === "log2") && !n.startsWith("stripped_");
}

const GROUND = new Set([
  "grass_block", "grass", "dirt", "coarse_dirt", "podzol", "mycelium", "rooted_dirt", "dirt_with_roots",
  "sand", "red_sand", "gravel", "stone", "andesite", "diorite", "granite", "deepslate", "tuff", "calcite",
  "clay", "mud", "moss_block", "pale_moss_block", "sandstone", "red_sandstone", "snow", "grass_path",
  "dirt_path", "suspicious_sand", "suspicious_gravel", "smooth_basalt", "bedrock", "terracotta",
  "packed_ice", "ice", "blue_ice", "powder_snow", "dripstone_block",
]);

export function isNaturalGround(id) {
  const n = strip(id);
  return GROUND.has(n) || (n.endsWith("terracotta") && !n.includes("glazed")) || n.endsWith("_ore");
}

// Природные «мягкие» блоки над землёй (их можно разобрать при стройке).
const SOFT = new Set([
  "pumpkin", "melon_block", "cactus", "bamboo", "bamboo_sapling", "bee_nest", "brown_mushroom_block",
  "red_mushroom_block", "mushroom_stem", "azalea", "flowering_azalea", "big_dripleaf", "mangrove_roots",
  "muddy_mangrove_roots", "cocoa", "sea_pickle", "pointed_dripstone", "snow_layer",
]);

export function isNatural(id) {
  return isPassableId(id) || isLeaves(id) || isLog(id) || isNaturalGround(id) || SOFT.has(strip(id)) || id.includes("water");
}

const STONE = new Set([
  "stone", "cobblestone", "andesite", "diorite", "granite", "deepslate", "cobbled_deepslate", "tuff",
  "calcite", "sandstone", "red_sandstone", "smooth_basalt", "dripstone_block", "mossy_cobblestone",
  "blackstone", "basalt",
]);

export function isStoneLike(id) {
  const n = strip(id);
  return STONE.has(n) || (n.endsWith("_ore") && !n.includes("iron"));
}

export const isIronOre = (id) => { const n = strip(id); return n === "iron_ore" || n === "deepslate_iron_ore"; };

const UNBREAKABLE = new Set([
  "bedrock", "barrier", "end_portal_frame", "reinforced_deepslate", "command_block", "structure_block",
  "mob_spawner", "trial_spawner", "vault", "obsidian", "crying_obsidian",
]);

export function isProtected(id) {
  const n = strip(id);
  return UNBREAKABLE.has(n) || n.includes("chest") || n.includes("shulker") || n === "barrel";
}

/**
 * Находит уровень земли в столбце: самый верхний твёрдый природный блок.
 * Возвращает { y, liquid, unnatural } или undefined, если чанк не загружен.
 */
export function groundAt(dim, x, z) {
  let top;
  try {
    top = dim.getTopmostBlock({ x, z });
  } catch {
    return undefined;
  }
  if (!top) return undefined;
  let y = top.location.y;
  let unnatural = false;
  for (let i = 0; i < 32; i++, y--) {
    const b = getB(dim, x, y, z);
    if (!b) return undefined;
    const id = b.typeId;
    if (b.isLiquid || id.includes("water") || id.includes("lava")) return { y, liquid: true, unnatural };
    if (b.isAir || isPassableId(id) || isLeaves(id) || isLog(id) || SOFT.has(strip(id))) {
      if (!isNatural(id)) unnatural = true;
      continue;
    }
    if (!isNatural(id)) unnatural = true;
    return { y, liquid: false, unnatural };
  }
  return undefined;
}

// Калитки в стене: свои жители проходят, бандиты и вражеские армии — нет (им приходится ломать стену).
export const GATE = { hostile: false };

// Можно ли стоять «ногами» в этом блоке.
export function canPass(b) {
  if (!b) return false;
  if (b.typeId.endsWith("fence_gate")) return !GATE.hostile;
  return b.isAir || b.isLiquid || isPassableId(b.typeId);
}

// Можно ли стоять на этом блоке.
export function canStandOn(b) {
  return !!b && !b.isAir && (b.isLiquid || !isPassableId(b.typeId));
}

/** Ищет высоту, на которую житель может шагнуть из текущей точки. */
export function walkY(dim, x, z, yCur, allowDrop) {
  const fx = Math.floor(x);
  const fz = Math.floor(z);
  const fy = Math.floor(yCur + 0.01);
  const order = allowDrop ? [0, 1, -1, -2, -3, -4, -5, -6, -7, -8] : [0, 1, -1];
  for (const dy of order) {
    const y = fy + dy;
    const feet = getB(dim, fx, y, fz);
    if (!canPass(feet)) continue;
    const head = getB(dim, fx, y + 1, fz);
    if (!canPass(head)) continue;
    const below = getB(dim, fx, y - 1, fz);
    if (!canStandOn(below)) continue;
    return y;
  }
  return undefined;
}

export function standY(dim, x, z) {
  const g = groundAt(dim, Math.floor(x), Math.floor(z));
  return g ? g.y + 1 : undefined;
}

/** Есть ли вода (или лава) в радиусе r блоков от точки — проверяем периметр квадрата через 2 блока. */
export function waterNear(dim, x, z, r) {
  for (let d = 1; d <= r; d += Math.max(1, Math.floor(r / 3))) {
    for (let i = -d; i <= d; i += 2) {
      for (const [px, pz] of [[x + i, z - d], [x + i, z + d], [x - d, z + i], [x + d, z + i]]) {
        const g = groundAt(dim, px, pz);
        if (g?.liquid) return true;
      }
    }
  }
  return false;
}

/** Ближайшее сухое место (без воды в радиусе 6) в пределах maxR блоков. */
export function findDrySpot(dim, cx, cz, maxR = 64) {
  for (let r = 0; r <= maxR; r += 4) {
    const n = Math.max(1, Math.floor(r * 1.5));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const x = Math.floor(cx + Math.cos(a) * r);
      const z = Math.floor(cz + Math.sin(a) * r);
      const g = groundAt(dim, x, z);
      if (!g || g.liquid || g.unnatural || waterNear(dim, x, z, 6)) continue;
      return { x, y: g.y + 1, z };
    }
  }
  return undefined;
}
