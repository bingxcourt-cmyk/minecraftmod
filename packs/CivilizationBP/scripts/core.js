import { world } from "@minecraft/server";

// Общее состояние мода. Всё, что начинается с "_" в объекте цивилизации, не сохраняется.
export const S = {
  civs: new Map(), // id -> цивилизация
  members: new Map(), // civId -> жители (Entity[])
  golems: new Map(), // civId -> големы (Entity[])
  unclaimed: [], // жители без цивилизации
  brains: new Map(), // entity.id -> состояние «мозга» жителя
  clock: 0, // секунды симуляции (сохраняются)
  speed: 1, // множитель скорости работы
  nightWork: true, // работают ли мирные жители ночью
  activeChunks: 7, // радиус «живой» симуляции вокруг игрока, в чанках
  dirty: new Set(),
  search: new Map(), // civId -> поиск места под постройку
  qsearch: new Map(), // civId -> поиск места под карьер
  emptyTicks: new Map(),
  claimedTrees: new Set(),
  claimedPrey: new Set(),
  opsCache: new Map(),
  cellsCache: new Map(),
};

export const P = { CIV: "civ:id", ROLE: "civ:role", HUNGER: "civ:hunger", NAME: "civ:name" };

export const DIM = () => world.getDimension("overworld");

export const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
export const dXZ = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export function getB(dim, x, y, z) {
  try {
    return dim.getBlock({ x, y, z });
  } catch {
    return undefined;
  }
}

export function loaded(dim, p) {
  try {
    return dim.isChunkLoaded({ x: Math.floor(p.x), y: 64, z: Math.floor(p.z) });
  } catch {
    return false;
  }
}

export function getProp(e, k) {
  try {
    return e.getDynamicProperty(k);
  } catch {
    return undefined;
  }
}

export function setProp(e, k, v) {
  try {
    e.setDynamicProperty(k, v);
  } catch {}
}

export const markDirty = (civ) => S.dirty.add(civ.id);

export function playersNear(p, r) {
  return world
    .getAllPlayers()
    .filter((pl) => pl.dimension.id === "minecraft:overworld" && dXZ(pl.location, p) < r);
}

export function announce(civ, msg, r = 160) {
  for (const pl of playersNear(civ.center, r)) pl.sendMessage(msg);
}

export function sound(dim, id, p, volume = 0.7) {
  try {
    dim.playSound(id, p, { volume });
  } catch {}
}

export function particle(dim, id, p) {
  try {
    dim.spawnParticle(id, p);
  } catch {}
}

// Перезарядка действия в тиках с учётом голода и скорости.
export const cdTicks = (base, brain) => Math.max(2, Math.round((base * (brain.hungry ? 2 : 1)) / S.speed));

export const isNight = () => {
  const t = world.getTimeOfDay();
  return t > 13000 && t < 23000;
};

// ---------- Названия ----------
const SYL1 = ["Ал", "Бор", "Вел", "Гор", "Дар", "Ел", "Зар", "Ир", "Кар", "Лад", "Мир", "Нор", "Ор", "Рус", "Свет", "Тар", "Ул", "Яр", "Брег", "Вол", "Сев", "Дуб", "Лес", "Кам"];
const SYL2 = ["град", "ополь", "ск", "ия", "ово", "ин", "мир", "еж", "ань", "ов", "слав", "бург", "ица", "ар", "ея"];
const NAMES = ["Иван", "Пётр", "Анна", "Марья", "Фёдор", "Олег", "Ольга", "Дарья", "Егор", "Илья", "Вера", "Нина", "Глеб", "Борис", "Лука", "Ефим", "Агата", "Злата", "Тимофей", "Савва", "Ульяна", "Яков", "Ксения", "Матвей", "Фрол", "Прохор", "Любава", "Мирон", "Варвара", "Добрыня", "Ратибор", "Всеслав", "Милана", "Ярина", "Остап", "Елисей", "Алёна", "Демид", "Василиса", "Тихон"];
const COLORS = ["§c", "§9", "§a", "§e", "§d", "§b", "§6", "§5", "§2", "§3"];

export function civName() {
  const used = new Set([...S.civs.values()].map((c) => c.name));
  for (let i = 0; i < 50; i++) {
    const n = pick(SYL1) + pick(SYL2);
    if (!used.has(n)) return n;
  }
  return pick(SYL1) + pick(SYL2) + " " + rnd(2, 99);
}

export const personName = () => pick(NAMES);

export function civColor() {
  const used = new Set([...S.civs.values()].map((c) => c.color));
  return COLORS.find((c) => !used.has(c)) ?? pick(COLORS);
}

// ---------- Сохранение ----------
const replacer = (k, v) => (k.startsWith("_") ? undefined : v);

export function saveAll(force = false) {
  const ids = force ? [...S.civs.keys()] : [...S.dirty];
  for (const id of ids) {
    const civ = S.civs.get(id);
    try {
      world.setDynamicProperty("civ:" + id, civ ? JSON.stringify(civ, replacer) : undefined);
    } catch {}
  }
  S.dirty.clear();
  try {
    world.setDynamicProperty("civ:index", JSON.stringify([...S.civs.keys()]));
    world.setDynamicProperty("civ:clock", S.clock);
    world.setDynamicProperty("civ:speed", S.speed);
    world.setDynamicProperty("civ:night", S.nightWork ? "work" : "rest");
    world.setDynamicProperty("civ:radius", S.activeChunks);
  } catch {}
}

export function loadAll() {
  let idx = [];
  try {
    idx = JSON.parse(String(world.getDynamicProperty("civ:index") ?? "[]"));
  } catch {}
  for (const id of idx) {
    const raw = world.getDynamicProperty("civ:" + id);
    if (typeof raw !== "string") continue;
    try {
      S.civs.set(id, JSON.parse(raw));
    } catch {}
  }
  S.clock = Number(world.getDynamicProperty("civ:clock") ?? 0);
  S.speed = Number(world.getDynamicProperty("civ:speed") ?? 1) || 1;
  S.nightWork = world.getDynamicProperty("civ:night") !== "rest";
  S.activeChunks = Number(world.getDynamicProperty("civ:radius") ?? 7) || 7;
}

export function deleteCiv(civ) {
  S.civs.delete(civ.id);
  S.dirty.add(civ.id);
  S.search.delete(civ.id);
  S.qsearch.delete(civ.id);
  for (const other of S.civs.values()) {
    if (other.tension) delete other.tension[civ.id];
    if (other.war && other.war.enemy === civ.id) other.war = null;
    S.dirty.add(other.id);
  }
}
