// Чертежи построек. Локальные координаты: x — ширина, z — глубина, y = 0 — уровень пола.
// Вход (дверной проём) всегда на стороне z = 0 по центру x.

// Стоимость блоков в ресурсах цивилизации. Неуказанные блоки бесплатны.
const COST = {
  oak_planks: { wood: 1 }, spruce_planks: { wood: 1 }, dark_oak_planks: { wood: 1 }, birch_planks: { wood: 1 },
  oak_log: { wood: 2 }, spruce_log: { wood: 2 }, dark_oak_log: { wood: 2 },
  oak_fence: { wood: 1 }, spruce_fence: { wood: 1 }, ladder: { wood: 1 }, torch: { wood: 1 },
  bed: { wood: 3 }, chest: { wood: 2 }, barrel: { wood: 2 }, crafting_table: { wood: 2 }, composter: { wood: 2 },
  lectern: { wood: 4 }, cartography_table: { wood: 4 }, bookshelf: { wood: 3 },
  cobblestone: { stone: 1 }, stone_bricks: { stone: 1 }, mossy_stone_bricks: { stone: 1 },
  cobblestone_wall: { stone: 1 }, glass_pane: { stone: 1 }, furnace: { stone: 4 },
  smithing_table: { wood: 2, iron: 1 }, blast_furnace: { stone: 5, iron: 1 }, anvil: { iron: 5 },
  bell: { iron: 1 }, lantern: { iron: 1 }, iron_bars: { iron: 1 },
  hay_block: { food: 2 },
};

class BP {
  constructor(w, d) {
    this.w = w;
    this.d = d;
    this.map = new Map();
    this.beds = 0;
  }
  set(x, y, z, id, st, cost) {
    if (x < 0 || z < 0 || x >= this.w || z >= this.d) return;
    this.map.set(`${x},${y},${z}`, { x, y, z, id: "minecraft:" + id, st, cost });
  }
  del(x, y, z) {
    this.map.delete(`${x},${y},${z}`);
  }
  box(x0, y0, z0, x1, y1, z1, id, st) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) this.set(x, y, z, id, st);
  }
  ring(x0, z0, x1, z1, y, id) {
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      if (x === x0 || x === x1 || z === z0 || z === z1) this.set(x, y, z, id);
    }
  }
  walls(x0, z0, x1, z1, y0, y1, id, corner) {
    for (let y = y0; y <= y1; y++) {
      this.ring(x0, z0, x1, z1, y, id);
      if (corner) for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) this.set(x, y, z, corner);
    }
  }
  // Ступенчатая крыша: потолок целиком, выше — кольца, верх — сплошной.
  roof(x0, z0, x1, z1, y, id) {
    this.box(x0, y, z0, x1, y, z1, id);
    for (;;) {
      x0++; z0++; x1--; z1--; y++;
      if (x0 > x1 || z0 > z1) break;
      if (x1 - x0 <= 1 || z1 - z0 <= 1) this.box(x0, y, z0, x1, y, z1, id);
      else this.ring(x0, z0, x1, z1, y, id);
    }
  }
  // Кровать из двух половинок. dir: 0 юг, 1 запад, 2 север, 3 восток (голова в сторону dir).
  bed(x, y, z, dir) {
    const [hx, hz] = [[0, 1], [-1, 0], [0, -1], [1, 0]][dir];
    this.del(x + hx, y, z + hz);
    this.map.set(`${x},${y},${z}`, {
      x, y, z, id: "minecraft:bed",
      st: { direction: dir, head_piece_bit: false, occupied_bit: false },
      pair: { x: x + hx, y, z: z + hz, st: { direction: dir, head_piece_bit: true, occupied_bit: false } },
    });
    this.beds++;
  }
  door(x, z, width = 1, height = 2) {
    const half = Math.floor(width / 2);
    for (let dx = -half; dx <= half; dx++) for (let y = 1; y <= height; y++) this.del(x + dx, y, z);
  }
  build() {
    const ops = [...this.map.values()].sort((a, b) => a.y - b.y);
    let h = 0;
    for (const op of ops) {
      h = Math.max(h, op.y + 1);
      if (!op.cost) op.cost = COST[op.id.slice(10)] ?? {};
    }
    return { w: this.w, d: this.d, h, ops, beds: this.beds };
  }
}

function center() {
  const b = new BP(5, 5);
  b.box(0, 0, 0, 4, 0, 4, "grass_path");
  b.box(1, 0, 1, 3, 0, 3, "cobblestone");
  b.set(2, 1, 2, "bell", undefined, {});
  for (const [x, z] of [[0, 0], [4, 0], [0, 4], [4, 4]]) {
    b.set(x, 1, z, "oak_fence");
    b.set(x, 2, z, "oak_fence");
    b.set(x, 3, z, "torch");
  }
  return b.build();
}

function hut() {
  const b = new BP(5, 5);
  b.box(0, 0, 0, 4, 0, 4, "oak_planks");
  b.walls(0, 0, 4, 4, 1, 3, "oak_planks", "oak_log");
  b.door(2, 0);
  b.set(0, 2, 2, "oak_fence");
  b.set(4, 2, 2, "oak_fence");
  b.roof(0, 0, 4, 4, 4, "spruce_planks");
  b.bed(1, 1, 2, 0);
  b.bed(3, 1, 2, 0);
  b.set(2, 1, 3, "torch");
  return b.build();
}

function farm(size) {
  const b = new BP(size, size);
  const m = Math.floor(size / 2);
  b.ring(0, 0, size - 1, size - 1, 0, "oak_log");
  for (let x = 1; x < size - 1; x++) for (let z = 1; z < size - 1; z++) {
    if (x === m && z === m) {
      b.set(x, 0, z, "water", undefined, {});
    } else {
      b.set(x, 0, z, "farmland", { moisturized_amount: 7 }, {});
      b.set(x, 1, z, "wheat", { growth: 0 }, {});
    }
  }
  // Брёвна каймы дешевле, чтобы ферму можно было построить пораньше.
  for (const op of b.map.values()) if (op.id === "minecraft:oak_log") op.cost = { wood: 1 };
  b.del(m, 0, 0);
  b.set(m, 0, 0, "grass_path");
  b.set(0, 1, 0, "composter");
  b.set(size - 1, 1, 0, "torch");
  b.set(0, 1, size - 1, "torch");
  b.set(size - 1, 1, size - 1, "torch");
  return b.build();
}

function well() {
  const b = new BP(5, 5);
  b.ring(0, 0, 4, 4, 0, "cobblestone");
  b.box(1, -1, 1, 3, -1, 3, "cobblestone");
  b.box(1, 0, 1, 3, 0, 3, "water", undefined);
  for (const op of b.map.values()) if (op.id === "minecraft:water") op.cost = {};
  b.ring(0, 0, 4, 4, 1, "cobblestone");
  for (const [x, z] of [[0, 0], [4, 0], [0, 4], [4, 4]]) {
    b.set(x, 2, z, "oak_fence");
    b.set(x, 3, z, "oak_fence");
  }
  b.roof(0, 0, 4, 4, 4, "oak_planks");
  return b.build();
}

function house() {
  const b = new BP(7, 7);
  b.ring(0, 0, 6, 6, 0, "cobblestone");
  b.box(1, 0, 1, 5, 0, 5, "oak_planks");
  b.walls(0, 0, 6, 6, 1, 4, "oak_planks", "oak_log");
  b.door(3, 0);
  for (const [x, z] of [[0, 2], [0, 4], [6, 2], [6, 4], [2, 6], [4, 6], [1, 0], [5, 0]]) b.set(x, 2, z, "glass_pane");
  b.roof(0, 0, 6, 6, 5, "spruce_planks");
  b.bed(1, 1, 4, 0);
  b.bed(5, 1, 4, 0);
  b.set(3, 1, 5, "torch");
  b.set(1, 1, 1, "crafting_table");
  b.set(5, 1, 1, "chest");
  return b.build();
}

function smithy() {
  const b = new BP(7, 7);
  b.box(0, 0, 0, 6, 0, 6, "cobblestone");
  for (let y = 1; y <= 3; y++) {
    for (let x = 0; x <= 6; x++) b.set(x, y, 6, "cobblestone");
    for (let z = 0; z <= 6; z++) {
      b.set(0, y, z, "cobblestone");
      b.set(6, y, z, "cobblestone");
    }
    b.set(0, y, 0, "oak_log");
    b.set(6, y, 0, "oak_log");
  }
  b.set(0, 2, 3, "iron_bars");
  b.set(6, 2, 3, "iron_bars");
  b.roof(0, 0, 6, 6, 4, "dark_oak_planks");
  b.set(1, 1, 5, "blast_furnace");
  b.set(2, 1, 5, "furnace");
  b.set(3, 1, 5, "smithing_table");
  b.set(5, 1, 5, "anvil");
  b.set(4, 1, 5, "torch");
  return b.build();
}

function barn() {
  const b = new BP(7, 9);
  b.box(0, 0, 0, 6, 0, 8, "spruce_planks");
  b.walls(0, 0, 6, 8, 1, 4, "oak_planks", "spruce_log");
  b.door(3, 0, 3, 3);
  b.roof(0, 0, 6, 8, 5, "dark_oak_planks");
  b.box(1, 1, 5, 2, 2, 7, "hay_block");
  b.box(4, 1, 6, 5, 1, 7, "hay_block");
  b.set(5, 1, 1, "chest");
  b.set(1, 1, 1, "barrel");
  b.set(3, 1, 7, "torch");
  return b.build();
}

function watchtower() {
  const b = new BP(5, 5);
  b.box(0, 0, 0, 4, 0, 4, "cobblestone");
  b.walls(1, 1, 3, 3, 1, 7, "cobblestone", "oak_log");
  b.door(2, 1);
  for (let y = 1; y <= 8; y++) b.set(2, y, 2, "ladder", { facing_direction: 2 }, undefined);
  b.box(0, 8, 0, 4, 8, 4, "oak_planks");
  b.set(2, 8, 2, "ladder", { facing_direction: 2 });
  b.ring(0, 0, 4, 4, 9, "cobblestone_wall");
  for (const [x, z] of [[0, 0], [4, 0], [0, 4], [4, 4]]) b.set(x, 10, z, "torch");
  return b.build();
}

function stonehouse() {
  const b = new BP(7, 9);
  b.ring(0, 0, 6, 8, 0, "stone_bricks");
  b.box(1, 0, 1, 5, 0, 7, "spruce_planks");
  b.walls(0, 0, 6, 8, 1, 4, "stone_bricks", "cobblestone");
  b.door(3, 0);
  for (const z of [2, 4, 6]) {
    b.set(0, 2, z, "glass_pane");
    b.set(6, 2, z, "glass_pane");
  }
  for (const x of [1, 5]) b.set(x, 2, 0, "glass_pane");
  b.set(3, 2, 8, "glass_pane");
  b.roof(0, 0, 6, 8, 5, "dark_oak_planks");
  b.bed(1, 1, 6, 0);
  b.bed(3, 1, 6, 0);
  b.bed(5, 1, 6, 0);
  b.set(2, 1, 7, "torch");
  b.set(1, 1, 1, "crafting_table");
  b.set(5, 1, 1, "chest");
  b.set(5, 1, 2, "bookshelf");
  return b.build();
}

function townhall() {
  const b = new BP(11, 9);
  b.ring(0, 0, 10, 8, 0, "stone_bricks");
  b.box(1, 0, 1, 9, 0, 7, "oak_planks");
  b.walls(0, 0, 10, 8, 1, 5, "stone_bricks", "spruce_log");
  b.door(5, 0, 3, 3);
  for (const x of [2, 8]) for (const y of [2, 3]) {
    b.set(x, y, 0, "glass_pane");
    b.set(x, y, 8, "glass_pane");
  }
  for (const z of [2, 4, 6]) for (const y of [2, 3]) {
    b.set(0, y, z, "glass_pane");
    b.set(10, y, z, "glass_pane");
  }
  b.roof(0, 0, 10, 8, 6, "dark_oak_planks");
  b.set(5, 1, 7, "bell");
  b.set(3, 1, 7, "lectern");
  b.set(7, 1, 7, "cartography_table");
  b.box(1, 1, 7, 1, 2, 7, "bookshelf");
  b.box(9, 1, 7, 9, 2, 7, "bookshelf");
  for (const [x, z] of [[2, 2], [8, 2], [5, 5]]) b.set(x, 1, z, "lantern");
  return b.build();
}

function barracks() {
  const b = new BP(9, 7);
  b.box(0, 0, 0, 8, 0, 6, "cobblestone");
  b.walls(0, 0, 8, 6, 1, 3, "cobblestone", "oak_log");
  b.door(4, 0);
  for (const x of [2, 6]) b.set(x, 2, 0, "iron_bars");
  b.set(0, 2, 3, "iron_bars");
  b.set(8, 2, 3, "iron_bars");
  b.roof(0, 0, 8, 6, 4, "spruce_planks");
  for (const x of [1, 3, 5, 7]) b.bed(x, 1, 4, 0);
  b.set(2, 1, 1, "smithing_table");
  b.set(6, 1, 1, "chest");
  b.set(4, 1, 3, "lantern");
  return b.build();
}

function castle() {
  const n = 15;
  const b = new BP(n, n);
  b.box(0, 0, 0, n - 1, 0, n - 1, "stone_bricks");
  b.walls(0, 0, n - 1, n - 1, 1, 8, "stone_bricks");
  b.door(7, 0, 3, 3);
  for (const p of [3, 11]) for (const y of [3, 6]) {
    b.set(p, y, 0, "glass_pane");
    b.set(p, y, n - 1, "glass_pane");
    b.set(0, y, p, "glass_pane");
    b.set(n - 1, y, p, "glass_pane");
  }
  b.box(1, 5, 1, n - 2, 5, n - 2, "spruce_planks");
  b.box(1, 9, 1, n - 2, 9, n - 2, "stone_bricks");
  for (let y = 1; y <= 9; y++) b.set(1, y, n - 2, "ladder", { facing_direction: 2 });
  b.ring(0, 0, n - 1, n - 1, 9, "stone_bricks");
  for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) {
    if ((x === 0 || z === 0 || x === n - 1 || z === n - 1) && (x + z) % 2 === 0) b.set(x, 10, z, "stone_bricks");
  }
  // Угловые башни.
  for (const [cx, cz] of [[0, 0], [n - 3, 0], [0, n - 3], [n - 3, n - 3]]) {
    for (let y = 9; y <= 11; y++) b.ring(cx, cz, cx + 2, cz + 2, y, "stone_bricks");
    for (const [x, z] of [[cx, cz], [cx + 2, cz], [cx, cz + 2], [cx + 2, cz + 2]]) b.set(x, 12, z, "stone_bricks");
    b.set(cx + 1, 10, cz + 1, "torch");
  }
  for (const x of [4, 6, 8, 10]) b.bed(x, 1, 11, 0);
  b.set(7, 1, 8, "bell");
  b.set(5, 6, 7, "lectern");
  b.set(9, 6, 7, "bookshelf");
  for (const [x, z] of [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]]) {
    b.set(x, 1, z, "lantern");
    b.set(x, 6, z, "lantern");
  }
  b.set(12, 1, 2, "chest");
  return b.build();
}

export const TYPES = {
  center: { name: "Центр поселения", gen: center },
  hut: { name: "Хижина", gen: hut },
  farm_small: { name: "Огород", gen: () => farm(7) },
  farm: { name: "Ферма", gen: () => farm(9) },
  well: { name: "Колодец", gen: well },
  house: { name: "Дом", gen: house },
  smithy: { name: "Кузница", gen: smithy },
  barn: { name: "Амбар", gen: barn },
  watchtower: { name: "Сторожевая башня", gen: watchtower },
  stonehouse: { name: "Каменный дом", gen: stonehouse },
  townhall: { name: "Ратуша", gen: townhall },
  barracks: { name: "Казармы", gen: barracks },
  castle: { name: "Замок", gen: castle },
  quarry: { name: "Карьер", gen: () => new BP(5, 5).build() },
};

const bpCache = new Map();
export function getBP(type) {
  let bp = bpCache.get(type);
  if (!bp) {
    bp = TYPES[type].gen();
    bpCache.set(type, bp);
  }
  return bp;
}

/** Размер постройки в мире с учётом поворота. */
export function dims(type, r) {
  const bp = getBP(type);
  return r % 2 ? { W: bp.d, D: bp.w, H: bp.h } : { W: bp.w, D: bp.d, H: bp.h };
}

/** Перевод локальных координат в мировые (поворот r — четверти по часовой стрелке). */
export function toWorld(o, r, w, d, x, z) {
  switch (r & 3) {
    case 0: return [o.x + x, o.z + z];
    case 1: return [o.x + d - 1 - z, o.z + x];
    case 2: return [o.x + w - 1 - x, o.z + d - 1 - z];
    default: return [o.x + z, o.z + w - 1 - x];
  }
}

const FACE_CW = { 2: 5, 5: 3, 3: 4, 4: 2 };
const CARD_CW = { north: "east", east: "south", south: "west", west: "north" };

function rotState(st, r) {
  if (!st) return st;
  const out = { ...st };
  for (let i = 0; i < (r & 3); i++) {
    if (out.direction !== undefined) out.direction = (out.direction + 1) % 4;
    if (out.facing_direction !== undefined && FACE_CW[out.facing_direction]) out.facing_direction = FACE_CW[out.facing_direction];
    if (out["minecraft:cardinal_direction"]) out["minecraft:cardinal_direction"] = CARD_CW[out["minecraft:cardinal_direction"]];
  }
  return out;
}

/**
 * Полный список действий стройки в мировых координатах:
 * k = "c" — расчистка, "f" — подсыпка земли, "p" — установка блока.
 */
export function makeOps(type, o, r) {
  const bp = getBP(type);
  const { W, D } = dims(type, r);
  const ops = [];
  const top = o.y + bp.h + 2;
  for (let y = top; y > o.y; y--) for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
    ops.push({ k: "c", x: o.x + x, y, z: o.z + z });
  }
  for (let y = o.y - 3; y < o.y; y++) for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
    ops.push({ k: "f", x: o.x + x, y, z: o.z + z });
  }
  for (const op of bp.ops) {
    const [wx, wz] = toWorld(o, r, bp.w, bp.d, op.x, op.z);
    const p = { k: "p", x: wx, y: o.y + op.y, z: wz, id: op.id, st: rotState(op.st, r), cost: op.cost };
    if (op.pair) {
      const [px, pz] = toWorld(o, r, bp.w, bp.d, op.pair.x, op.pair.z);
      p.pair = { x: px, y: o.y + op.pair.y, z: pz, st: rotState(op.pair.st, r) };
    }
    ops.push(p);
  }
  return ops;
}

/** Мировые координаты точки перед входом. */
export function doorFront(b) {
  const bp = getBP(b.t);
  const [x, z] = toWorld(b, b.r, bp.w, bp.d, Math.floor(bp.w / 2), -1);
  return { x, y: b.y, z };
}

/** Клетки с пшеницей фермы (мировые координаты блока пшеницы). */
export function cropCells(b) {
  const bp = getBP(b.t);
  const out = [];
  for (const op of bp.ops) {
    if (op.id !== "minecraft:wheat") continue;
    const [x, z] = toWorld(b, b.r, bp.w, bp.d, op.x, op.z);
    out.push({ x, y: b.y + op.y, z });
  }
  return out;
}
