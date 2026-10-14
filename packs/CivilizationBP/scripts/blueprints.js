// Чертежи построек. Локальные координаты: x — ширина, z — глубина, y = 0 — уровень пола.
// Вход (дверной проём) всегда на стороне z = 0 по центру x.

// Стоимость блоков в ресурсах цивилизации. Неуказанные блоки бесплатны.
const COST = {
  oak_planks: { wood: 1 }, spruce_planks: { wood: 1 }, dark_oak_planks: { wood: 1 }, birch_planks: { wood: 1 },
  oak_log: { wood: 2 }, spruce_log: { wood: 2 }, dark_oak_log: { wood: 2 },
  oak_fence: { wood: 1 }, spruce_fence: { wood: 1 }, ladder: { wood: 1 }, torch: {},
  bed: { wood: 3 }, chest: { wood: 2 }, barrel: { wood: 2 }, crafting_table: { wood: 2 }, composter: { wood: 2 },
  lectern: { wood: 4 }, cartography_table: { wood: 4 }, bookshelf: { wood: 3 },
  cobblestone: { stone: 1 }, stone_bricks: { stone: 1 }, mossy_stone_bricks: { stone: 1 },
  cobblestone_wall: { stone: 1 }, glass_pane: { stone: 1 }, furnace: { stone: 4 },
  smithing_table: { wood: 2, iron: 1 }, blast_furnace: { stone: 5, iron: 1 }, anvil: { iron: 5 },
  bell: { iron: 1 }, lantern: {}, iron_bars: { iron: 1 },
  hay_block: { food: 2 },
  glass: { glass: 1 }, smooth_stone: { stone: 1 },
  // Отделка: ступеньки, плиты, двери, люки, наличники.
  oak_stairs: { wood: 1 }, spruce_stairs: { wood: 1 }, dark_oak_stairs: { wood: 1 },
  stone_brick_stairs: { stone: 1 }, stone_stairs: { stone: 1 },
  oak_slab: { wood: 1 }, spruce_slab: { wood: 1 }, stone_brick_slab: { stone: 1 },
  spruce_door: { wood: 2 }, spruce_trapdoor: { wood: 1 }, oak_pressure_plate: { wood: 1 },
  stripped_oak_log: { wood: 2 }, stripped_spruce_log: { wood: 2 }, chiseled_stone_bricks: { stone: 1 },
  cracked_stone_bricks: { stone: 1 }, polished_andesite: { andesite: 1 }, flower_pot: {},
  oak_leaves: {}, grindstone: { stone: 2, wood: 1 }, cauldron: { iron: 3 }, carved_pumpkin: { food: 1 }, gravel: {},
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
  // Двускатная крыша из ступенек: конёк вдоль z, скаты в стороны x, фронтоны заполняются fill.
  gable(x0, z0, x1, z1, y, stair, fill, ridge) {
    for (let i = 0; ; i++) {
      const xa = x0 + i;
      const xb = x1 - i;
      const yy = y + i;
      if (xa > xb) break;
      for (let z = z0; z <= z1; z++) {
        if (xa === xb) this.set(xa, yy, z, ridge, { "minecraft:vertical_half": "bottom" });
        else {
          this.set(xa, yy, z, stair, { weirdo_direction: 0, upside_down_bit: false });
          this.set(xb, yy, z, stair, { weirdo_direction: 1, upside_down_bit: false });
        }
      }
      for (let x = xa + 1; x < xb; x++) {
        this.set(x, yy, z0, fill);
        this.set(x, yy, z1, fill);
      }
    }
  }
  // Настоящая дверь (две половинки) в проёме на стороне z = 0.
  realDoor(x, z, id = "spruce_door") {
    this.del(x, 2, z);
    this.map.set(`${x},1,${z}`, {
      x, y: 1, z, id: "minecraft:" + id,
      st: { direction: 3, upper_block_bit: false, door_hinge_bit: false, open_bit: false },
      pair: { x, y: 2, z, st: { direction: 3, upper_block_bit: true, door_hinge_bit: false, open_bit: false } },
    });
  }
  // Деревянный каркас: брёвна по углам и поясом сверху.
  frame(x0, z0, x1, z1, y0, y1, log) {
    for (let y = y0; y <= y1; y++) for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) this.set(x, y, z, log);
    this.ring(x0, z0, x1, z1, y1, log);
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

// Окна: стекло в проёмах стены на высотах ys.
function windows(b, pts, ys) {
  for (const [x, z] of pts) for (const y of ys) b.set(x, y, z, "glass_pane");
}

function center() {
  // Площадь 7×7. Центр должен быть по карману новому племени (30 дерева и 12 камня на старте).
  const b = new BP(7, 7);
  b.box(0, 0, 0, 6, 0, 6, "grass_path");
  b.box(2, 0, 2, 4, 0, 4, "stone_bricks");
  b.set(3, 0, 3, "chiseled_stone_bricks");
  b.set(3, 1, 3, "bell", undefined, {});
  b.set(3, 1, 4, "crafting_table");
  b.set(2, 1, 4, "barrel");
  for (const [x, z] of [[0, 0], [6, 0], [0, 6], [6, 6]]) {
    b.set(x, 1, z, "oak_fence");
    b.set(x, 2, z, "oak_fence");
    b.set(x, 3, z, "torch");
  }
  for (const [x, z] of [[1, 0], [5, 0], [0, 3], [6, 3]]) b.set(x, 1, z, "flower_pot");
  return b.build();
}

function hut() {
  // Хижина 7×7 с крытым крыльцом.
  const b = new BP(7, 7);
  b.box(0, 0, 0, 6, 0, 6, "cobblestone");
  b.box(1, 0, 2, 5, 0, 5, "oak_planks");
  b.box(2, 0, 0, 4, 0, 0, "spruce_planks");
  b.walls(0, 1, 6, 6, 1, 3, "oak_planks");
  b.ring(0, 1, 6, 6, 1, "cobblestone");
  b.frame(0, 1, 6, 6, 1, 3, "oak_log");
  b.realDoor(3, 1);
  for (const x of [0, 6]) for (let y = 1; y <= 3; y++) b.set(x, y, 0, "oak_fence");
  windows(b, [[0, 3], [0, 4], [6, 3], [6, 4], [2, 6], [4, 6], [1, 1], [5, 1]], [2]);
  b.gable(0, 0, 6, 6, 4, "spruce_stairs", "spruce_planks", "spruce_slab");
  b.bed(1, 1, 5, 0);
  b.bed(3, 1, 5, 0);
  b.bed(5, 1, 5, 0);
  b.set(1, 1, 2, "torch");
  b.set(5, 1, 2, "crafting_table");
  b.set(4, 1, 2, "flower_pot");
  b.set(1, 1, 0, "flower_pot");
  b.set(5, 1, 0, "barrel");
  return b.build();
}

function farm(size) {
  const b = new BP(size, size);
  const m = Math.floor(size / 2);
  b.ring(0, 0, size - 1, size - 1, 0, "oak_log");
  for (let x = 1; x < size - 1; x++) for (let z = 1; z < size - 1; z++) {
    if ((x === m && z === m) || (size > 9 && (x === 2 || x === size - 3) && z === m)) {
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
  for (const [x, z] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
    b.set(x, 1, z, "oak_fence");
    b.set(x, 2, z, "torch");
  }
  b.set(m - 1, 1, 0, "composter");
  b.set(m + 1, 1, 0, "hay_block");
  return b.build();
}

function well() {
  const b = new BP(5, 5);
  b.ring(0, 0, 4, 4, 0, "stone_bricks");
  b.box(1, -1, 1, 3, -1, 3, "cobblestone");
  b.box(1, 0, 1, 3, 0, 3, "water", undefined);
  for (const op of b.map.values()) if (op.id === "minecraft:water") op.cost = {};
  b.ring(0, 0, 4, 4, 1, "stone_brick_slab");
  for (const [x, z] of [[0, 0], [4, 0], [0, 4], [4, 4]]) {
    b.set(x, 1, z, "stone_bricks");
    b.set(x, 2, z, "oak_fence");
    b.set(x, 3, z, "oak_fence");
  }
  b.set(2, 3, 2, "oak_fence"); // цепь для ведра
  b.gable(0, 0, 4, 4, 4, "spruce_stairs", "spruce_planks", "spruce_slab");
  return b.build();
}

function house() {
  // Двухэтажный дом 9×9: каменный первый этаж, фахверковый второй, балкон над входом, труба.
  const b = new BP(9, 9);
  b.box(0, 0, 0, 8, 0, 8, "cobblestone");
  b.box(1, 0, 2, 7, 0, 7, "oak_planks");
  b.box(2, 0, 0, 6, 0, 1, "stone_bricks"); // крыльцо
  b.walls(0, 2, 8, 8, 1, 3, "cobblestone");
  b.frame(0, 2, 8, 8, 1, 3, "oak_log");
  b.box(0, 4, 0, 8, 4, 8, "spruce_planks"); // перекрытие и пол балкона
  b.walls(0, 2, 8, 8, 5, 7, "oak_planks");
  b.frame(0, 2, 8, 8, 5, 7, "stripped_oak_log");
  b.ring(0, 2, 8, 8, 5, "stripped_oak_log");
  // Балкон с перилами и столбы крыльца.
  for (let x = 0; x <= 8; x++) b.set(x, 5, 0, "oak_fence");
  for (const x of [0, 8]) for (let y = 1; y <= 3; y++) b.set(x, y, 0, "oak_log");
  b.del(4, 5, 0);
  b.set(4, 5, 0, "oak_fence");
  b.realDoor(4, 2);
  b.del(4, 6, 2);
  b.del(4, 5, 2);
  windows(b, [[0, 4], [0, 6], [8, 4], [8, 6], [2, 8], [6, 8], [2, 2], [6, 2]], [2, 6]);
  b.gable(0, 0, 8, 8, 8, "dark_oak_stairs", "spruce_planks", "dark_oak_slab");
  // Лестница на второй этаж.
  for (let y = 1; y <= 4; y++) b.set(1, y, 7, "ladder", { facing_direction: 2 });
  for (let y = 1; y <= 11; y++) b.set(7, y, 7, "cobblestone");
  b.set(7, 12, 7, "cobblestone_wall");
  b.set(6, 1, 7, "furnace");
  // Первый этаж — кухня и гостиная, второй — спальни.
  b.set(1, 1, 3, "crafting_table");
  b.set(7, 1, 3, "chest");
  b.set(7, 1, 4, "barrel");
  for (const x of [3, 4]) {
    b.set(x, 1, 5, "oak_fence");
    b.set(x, 2, 5, "oak_pressure_plate");
  }
  b.set(1, 1, 5, "bookshelf");
  b.set(1, 1, 6, "bookshelf");
  b.set(5, 1, 3, "torch");
  b.bed(2, 5, 7, 0);
  b.bed(4, 5, 7, 0);
  b.bed(6, 5, 7, 0);
  b.bed(7, 5, 4, 0);
  b.set(3, 5, 3, "torch");
  b.set(2, 1, 0, "flower_pot");
  b.set(6, 1, 0, "flower_pot");
  return b.build();
}

function stonehouse() {
  // Каменный особняк 9×11 в два этажа: эркер-окна, мшистая кладка, две трубы.
  const b = new BP(9, 11);
  b.box(0, 0, 0, 8, 0, 10, "stone_bricks");
  b.box(1, 0, 1, 7, 0, 9, "spruce_planks");
  b.walls(0, 0, 8, 10, 1, 7, "stone_bricks");
  b.ring(0, 0, 8, 10, 1, "mossy_stone_bricks");
  b.ring(0, 0, 8, 10, 4, "polished_andesite");
  b.frame(0, 0, 8, 10, 1, 7, "stripped_spruce_log");
  for (const [x, z] of [[2, 0], [6, 10], [8, 3], [0, 7]]) b.set(x, 3, z, "cracked_stone_bricks");
  b.box(1, 4, 1, 7, 4, 9, "spruce_planks");
  b.realDoor(4, 0);
  b.set(4, 3, 0, "chiseled_stone_bricks");
  windows(b, [[0, 2], [0, 5], [0, 8], [8, 2], [8, 5], [8, 8], [2, 0], [6, 0], [2, 10], [6, 10]], [2, 3, 5, 6]);
  b.gable(0, 0, 8, 10, 8, "stone_brick_stairs", "stone_bricks", "stone_brick_slab");
  for (let y = 1; y <= 4; y++) b.set(7, y, 9, "ladder", { facing_direction: 2 });
  for (const x of [1, 7]) {
    for (let y = 1; y <= 13; y++) b.set(x, y, 5, y <= 7 ? "stone_bricks" : "cobblestone");
    b.set(x, 14, 5, "cobblestone_wall");
  }
  b.set(1, 1, 4, "furnace");
  b.set(1, 1, 1, "crafting_table");
  b.set(7, 1, 1, "chest");
  b.set(7, 1, 2, "chest");
  for (const z of [6, 7, 8]) b.set(1, 1, z, "bookshelf");
  for (const x of [3, 4, 5]) {
    b.set(x, 1, 5, "oak_fence");
    b.set(x, 2, 5, "oak_pressure_plate");
  }
  b.set(4, 1, 8, "lantern");
  for (const x of [2, 4, 6]) b.bed(x, 5, 9, 0);
  b.bed(2, 5, 3, 2);
  b.bed(5, 5, 3, 2);
  b.set(4, 5, 6, "lantern");
  b.set(1, 5, 9, "bookshelf");
  return b.build();
}

function smithy() {
  // Кузница 9×9: открытый навес с наковальней и горном, мастерская с трубой.
  const b = new BP(9, 9);
  b.box(0, 0, 0, 8, 0, 8, "stone_bricks");
  b.box(1, 0, 4, 7, 0, 7, "cobblestone");
  b.walls(0, 4, 8, 8, 1, 4, "cobblestone");
  b.frame(0, 4, 8, 8, 1, 4, "spruce_log");
  b.realDoor(4, 4);
  windows(b, [[0, 6], [8, 6], [2, 8], [6, 8]], [2]);
  // Навес на столбах.
  for (const [x, z] of [[0, 0], [8, 0]]) for (let y = 1; y <= 4; y++) b.set(x, y, z, "spruce_log");
  b.box(0, 5, 0, 8, 5, 3, "spruce_slab");
  b.gable(0, 4, 8, 8, 5, "stone_brick_stairs", "stone_bricks", "stone_brick_slab");
  b.set(2, 1, 1, "anvil");
  b.set(6, 1, 1, "grindstone");
  b.set(6, 1, 2, "cauldron");
  b.set(1, 1, 3, "barrel");
  b.set(7, 1, 3, "barrel");
  // Горн с трубой в мастерской.
  for (let y = 1; y <= 11; y++) b.set(1, y, 7, y <= 1 ? "blast_furnace" : "stone_bricks");
  b.set(2, 1, 7, "furnace");
  b.set(3, 1, 7, "smithing_table");
  b.set(5, 1, 7, "furnace");
  b.set(7, 1, 5, "chest");
  b.set(4, 1, 6, "lantern");
  b.set(4, 3, 1, "lantern");
  return b.build();
}

function barn() {
  // Большой амбар 9×11 с ломаной крышей и сеновалом.
  const b = new BP(9, 11);
  b.ring(0, 0, 8, 10, 0, "cobblestone");
  b.box(1, 0, 1, 7, 0, 9, "spruce_planks");
  b.walls(0, 0, 8, 10, 1, 5, "spruce_planks");
  b.frame(0, 0, 8, 10, 1, 5, "dark_oak_log");
  for (const x of [0, 8]) for (const z of [3, 7]) for (let y = 1; y <= 5; y++) b.set(x, y, z, "dark_oak_log");
  b.door(4, 0, 3, 3);
  for (const x of [3, 4, 5]) b.set(x, 4, 0, "dark_oak_planks");
  windows(b, [[0, 5], [8, 5]], [3]);
  // Ломаная (голландская) крыша: крутые нижние скаты и пологий верх.
  for (let z = 0; z <= 10; z++) {
    b.set(0, 6, z, "dark_oak_stairs", { weirdo_direction: 0, upside_down_bit: false });
    b.set(8, 6, z, "dark_oak_stairs", { weirdo_direction: 1, upside_down_bit: false });
    b.set(1, 7, z, "dark_oak_stairs", { weirdo_direction: 0, upside_down_bit: false });
    b.set(7, 7, z, "dark_oak_stairs", { weirdo_direction: 1, upside_down_bit: false });
  }
  for (const z of [0, 10]) {
    for (let x = 1; x <= 7; x++) b.set(x, 6, z, "spruce_planks");
    for (let x = 2; x <= 6; x++) b.set(x, 7, z, "spruce_planks");
  }
  b.gable(2, 0, 6, 10, 8, "spruce_stairs", "spruce_planks", "spruce_slab");
  b.set(4, 7, 0, "spruce_trapdoor", { direction: 3, open_bit: true, upside_down_bit: false });
  // Сеновал.
  b.box(1, 5, 6, 7, 5, 9, "spruce_planks");
  b.box(1, 6, 7, 7, 6, 9, "hay_block");
  for (let y = 1; y <= 5; y++) b.set(7, y, 5, "ladder", { facing_direction: 4 }); // на восточной стене
  b.box(1, 1, 7, 2, 2, 9, "hay_block");
  b.box(6, 1, 8, 6, 1, 9, "hay_block");
  b.set(7, 1, 1, "chest");
  b.set(1, 1, 1, "barrel");
  b.set(1, 1, 2, "barrel");
  b.set(1, 1, 3, "composter");
  b.set(4, 1, 9, "torch");
  return b.build();
}

function watchtower() {
  // Сторожевая башня 7×7, 16 блоков: каменное основание, бревенчатые углы, смотровая с крышей.
  const b = new BP(7, 7);
  b.box(0, 0, 0, 6, 0, 6, "stone_bricks");
  b.walls(1, 1, 5, 5, 1, 10, "cobblestone");
  b.ring(1, 1, 5, 5, 1, "mossy_stone_bricks");
  for (const [x, z] of [[1, 1], [5, 1], [1, 5], [5, 5]]) for (let y = 1; y <= 10; y++) b.set(x, y, z, "spruce_log");
  b.realDoor(3, 1);
  windows(b, [[3, 5], [1, 3], [5, 3]], [4, 7]);
  b.set(3, 7, 1, "glass_pane");
  for (let y = 1; y <= 11; y++) b.set(3, y, 4, "ladder", { facing_direction: 2 });
  b.box(0, 11, 0, 6, 11, 6, "spruce_planks");
  b.set(3, 11, 4, "ladder", { facing_direction: 2 });
  b.ring(0, 0, 6, 6, 12, "oak_fence");
  for (const [x, z] of [[0, 0], [6, 0], [0, 6], [6, 6]]) for (let y = 12; y <= 14; y++) b.set(x, y, z, "spruce_log");
  b.ring(0, 0, 6, 6, 15, "spruce_slab");
  b.ring(1, 1, 5, 5, 15, "spruce_planks");
  b.ring(1, 1, 5, 5, 16, "spruce_slab");
  b.ring(2, 2, 4, 4, 16, "spruce_planks");
  b.set(3, 17, 3, "spruce_slab");
  b.set(3, 16, 3, "spruce_planks");
  b.set(3, 13, 0, "torch");
  b.set(3, 13, 6, "torch");
  b.set(5, 12, 3, "barrel");
  return b.build();
}

function townhall() {
  // Ратуша 15×11: колонный портик, двусветный зал, часовая башня с колоколом.
  const b = new BP(15, 11);
  b.box(0, 0, 0, 14, 0, 10, "stone_bricks");
  b.box(1, 0, 3, 13, 0, 9, "oak_planks");
  b.walls(0, 2, 14, 10, 1, 8, "stone_bricks");
  b.ring(0, 2, 14, 10, 1, "chiseled_stone_bricks");
  b.ring(0, 2, 14, 10, 8, "polished_andesite");
  for (const x of [0, 4, 10, 14]) for (let y = 1; y <= 8; y++) b.set(x, y, 2, "stripped_oak_log");
  // Портик: колонны и навес.
  for (const x of [2, 5, 9, 12]) for (let y = 1; y <= 5; y++) b.set(x, y, 0, "stone_bricks");
  b.box(1, 6, 0, 13, 6, 1, "stone_brick_slab");
  for (let x = 1; x <= 13; x++) b.set(x, 5, 1, "stone_brick_stairs", { weirdo_direction: 3, upside_down_bit: true });
  b.door(7, 2, 3, 4);
  windows(b, [[2, 2], [12, 2], [2, 10], [5, 10], [9, 10], [12, 10], [0, 4], [0, 6], [0, 8], [14, 4], [14, 6], [14, 8]], [2, 3, 4, 5, 6]);
  b.gable(0, 2, 14, 10, 9, "dark_oak_stairs", "dark_oak_planks", "dark_oak_slab");
  // Часовая башня над входом.
  for (let y = 9; y <= 20; y++) b.ring(6, 3, 8, 5, y, y >= 18 ? "oak_fence" : "stone_bricks");
  for (const [x, z] of [[6, 3], [8, 3], [6, 5], [8, 5]]) for (let y = 18; y <= 20; y++) b.set(x, y, z, "stone_bricks");
  b.set(7, 16, 3, "glass_pane");
  b.set(7, 17, 3, "glass_pane");
  b.box(6, 21, 3, 8, 21, 5, "dark_oak_slab");
  b.set(7, 20, 4, "bell");
  b.box(7, 18, 4, 7, 19, 4, "oak_fence");
  // Зал.
  b.set(7, 1, 9, "lectern");
  b.set(5, 1, 9, "cartography_table");
  b.box(1, 1, 9, 1, 4, 9, "bookshelf");
  b.box(13, 1, 9, 13, 4, 9, "bookshelf");
  b.box(1, 1, 3, 1, 3, 3, "bookshelf");
  b.box(13, 1, 3, 13, 3, 3, "bookshelf");
  for (let x = 4; x <= 10; x++) {
    b.set(x, 1, 6, "oak_fence");
    b.set(x, 2, 6, "oak_pressure_plate");
  }
  for (const [x, z] of [[3, 4], [11, 4], [3, 8], [11, 8], [7, 8]]) b.set(x, 1, z, "lantern");
  for (const x of [2, 12]) b.set(x, 1, 1, "flower_pot");
  return b.build();
}

function barracks() {
  // Казармы 11×9: тренировочный двор у входа, спальня на 6 коек, оружейная.
  const b = new BP(11, 9);
  b.box(0, 0, 0, 10, 0, 8, "cobblestone");
  b.box(1, 0, 0, 9, 0, 2, "gravel");
  b.walls(0, 3, 10, 8, 1, 4, "cobblestone");
  b.frame(0, 3, 10, 8, 1, 4, "oak_log");
  for (const x of [5]) for (let y = 1; y <= 4; y++) b.set(x, y, 8, "oak_log");
  b.realDoor(5, 3);
  for (const x of [2, 8]) b.set(x, 2, 3, "iron_bars");
  b.set(0, 2, 6, "iron_bars");
  b.set(10, 2, 6, "iron_bars");
  b.gable(0, 3, 10, 8, 5, "spruce_stairs", "spruce_planks", "spruce_slab");
  // Двор: ограда, соломенные чучела.
  for (let x = 0; x <= 10; x++) if (x !== 5) b.set(x, 1, 0, "oak_fence");
  for (const z of [1, 2]) {
    b.set(0, 1, z, "oak_fence");
    b.set(10, 1, z, "oak_fence");
  }
  for (const x of [2, 8]) {
    b.set(x, 1, 1, "hay_block");
    b.set(x, 2, 1, "carved_pumpkin");
  }
  for (const x of [1, 3, 7, 9]) b.bed(x, 1, 7, 0);
  b.bed(1, 1, 5, 2);
  b.bed(9, 1, 5, 2);
  b.set(3, 1, 4, "smithing_table");
  b.set(7, 1, 4, "grindstone");
  b.set(4, 1, 4, "chest");
  b.set(6, 1, 4, "chest");
  b.set(5, 1, 6, "lantern");
  return b.build();
}

function castle() {
  // Замок 19×19: стены с зубцами, четыре угловые башни, донжон в центре, ворота с решёткой.
  const n = 19;
  const b = new BP(n, n);
  b.box(0, 0, 0, n - 1, 0, n - 1, "stone_bricks");
  b.box(1, 0, 1, n - 2, 0, n - 2, "grass_path");
  b.walls(0, 0, n - 1, n - 1, 1, 7, "stone_bricks");
  b.ring(0, 0, n - 1, n - 1, 1, "mossy_stone_bricks");
  b.box(1, 7, 1, n - 2, 7, 2, "stone_brick_slab");
  for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) {
    if ((x === 0 || z === 0 || x === n - 1 || z === n - 1) && (x + z) % 2 === 0) b.set(x, 8, z, "stone_bricks");
  }
  // Ворота с решёткой.
  b.door(9, 0, 3, 4);
  for (const x of [8, 9, 10]) b.set(x, 4, 0, "iron_bars");
  b.set(9, 5, 0, "chiseled_stone_bricks");
  // Угловые башни 5×5.
  for (const [cx, cz] of [[0, 0], [n - 5, 0], [0, n - 5], [n - 5, n - 5]]) {
    for (let y = 1; y <= 11; y++) b.ring(cx, cz, cx + 4, cz + 4, y, "stone_bricks");
    b.box(cx + 1, 11, cz + 1, cx + 3, 11, cz + 3, "spruce_planks");
    for (const [x, z] of [[cx, cz], [cx + 2, cz], [cx + 4, cz], [cx, cz + 2], [cx + 4, cz + 2], [cx, cz + 4], [cx + 2, cz + 4], [cx + 4, cz + 4]]) b.set(x, 12, z, "stone_bricks");
    b.set(cx + 2, 6, cz, "glass_pane");
    b.set(cx + 2, 6, cz + 4, "glass_pane");
    b.set(cx, 6, cz + 2, "glass_pane");
    b.set(cx + 4, 6, cz + 2, "glass_pane");
    b.set(cx + 2, 12, cz + 2, "torch");
  }
  // Донжон 7×7 в центре.
  const k0 = 6;
  const k1 = 12;
  for (let y = 1; y <= 14; y++) b.ring(k0, k0, k1, k1, y, "stone_bricks");
  b.ring(k0, k0, k1, k1, 1, "chiseled_stone_bricks");
  b.box(k0 + 1, 5, k0 + 1, k1 - 1, 5, k1 - 1, "spruce_planks");
  b.box(k0 + 1, 10, k0 + 1, k1 - 1, 10, k1 - 1, "spruce_planks");
  b.box(k0 + 1, 14, k0 + 1, k1 - 1, 14, k1 - 1, "stone_bricks");
  for (let x = k0; x <= k1; x++) for (let z = k0; z <= k1; z++) {
    if ((x === k0 || z === k0 || x === k1 || z === k1) && (x + z) % 2 === 0) b.set(x, 15, z, "stone_bricks");
  }
  b.realDoor(9, k0);
  for (const y of [3, 7, 12]) {
    b.set(9, y, k1, "glass_pane");
    b.set(k0, y, 9, "glass_pane");
    b.set(k1, y, 9, "glass_pane");
  }
  for (let y = 1; y <= 14; y++) b.set(k0 + 1, y, k1 - 1, "ladder", { facing_direction: 2 });
  b.set(9, 1, k1 - 1, "bell");
  b.set(10, 6, k1 - 1, "lectern");
  b.box(k1 - 1, 6, k0 + 1, k1 - 1, 7, k0 + 2, "bookshelf");
  for (const x of [k0 + 2, k0 + 4]) b.bed(x, 11, k1 - 1, 0);
  for (const x of [8, 10]) b.bed(x, 6, k0 + 2, 2);
  for (const [x, z] of [[k0 + 2, k0 + 2], [k1 - 2, k0 + 2]]) {
    b.set(x, 1, z, "lantern");
    b.set(x, 6, z, "lantern");
  }
  b.set(k1 - 1, 1, k0 + 1, "chest");
  // Двор: колодец-фонтан и огород для гарнизона.
  for (const [x, z] of [[3, 9], [15, 9], [9, 3], [9, 15]]) b.set(x, 1, z, "lantern");
  b.set(3, 1, 7, "hay_block");
  b.set(15, 1, 11, "barrel");
  return b.build();
}

// Стекольный завод: печи плавят песок в стекло (8 стекла на 1 уголь).
function glassworks() {
  const b = new BP(9, 7);
  b.box(0, 0, 0, 8, 0, 6, "stone_bricks");
  b.walls(0, 0, 8, 6, 1, 4, "stone_bricks", "smooth_stone");
  b.door(4, 0, 3, 3);
  for (const x of [1, 7]) b.set(x, 2, 0, "glass");
  for (const z of [2, 4]) {
    b.set(0, 2, z, "glass");
    b.set(8, 2, z, "glass");
  }
  b.roof(0, 0, 8, 6, 5, "stone_bricks");
  for (const x of [1, 2, 3, 5, 6, 7]) b.set(x, 1, 5, x % 2 ? "furnace" : "blast_furnace");
  b.set(4, 1, 5, "barrel");
  for (let y = 6; y <= 10; y++) b.set(7, y, 5, "stone_bricks");
  b.set(1, 1, 1, "torch");
  b.set(7, 1, 1, "torch");
  return b.build();
}

// Небоскрёб 10×10, высота 35 блоков: 7 этажей, фасад наполовину стеклянный.
function skyscraper() {
  const n = 10;
  const H = 35;
  const b = new BP(n, n);
  for (let y = 0; y < H; y++) {
    const f = y % 5;
    if (f === 0 || y === H - 1) {
      b.box(0, y, 0, n - 1, y, n - 1, y === 0 ? "stone_bricks" : "smooth_stone");
      continue;
    }
    for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) {
      if (x !== 0 && z !== 0 && x !== n - 1 && z !== n - 1) continue;
      const corner = (x === 0 || x === n - 1) && (z === 0 || z === n - 1);
      b.set(x, y, z, corner || f === 1 ? "stone_bricks" : "glass");
    }
  }
  b.door(5, 0, 1, 2);
  for (let y = 1; y < H; y++) b.set(1, y, n - 2, "ladder", { facing_direction: 2 });
  for (let y = 0; y < H - 1; y += 5) {
    b.set(5, y + 1, 5, "torch");
    if (y > 0) {
      b.bed(7, y + 1, 7, 2);
      b.bed(8, y + 1, 7, 2);
    }
  }
  b.set(2, 1, 2, "chest");
  b.set(3, 1, 2, "crafting_table");
  return b.build();
}

export const TYPES = {
  center: { name: "Центр поселения", gen: center },
  hut: { name: "Хижина", gen: hut },
  farm_small: { name: "Огород", gen: () => farm(7) },
  farm: { name: "Ферма", gen: () => farm(11) },
  well: { name: "Колодец", gen: well },
  house: { name: "Дом", gen: house },
  smithy: { name: "Кузница", gen: smithy },
  barn: { name: "Амбар", gen: barn },
  watchtower: { name: "Сторожевая башня", gen: watchtower },
  stonehouse: { name: "Каменный дом", gen: stonehouse },
  townhall: { name: "Ратуша", gen: townhall },
  barracks: { name: "Казармы", gen: barracks },
  castle: { name: "Замок", gen: castle },
  glassworks: { name: "Стекольный завод", gen: glassworks },
  skyscraper: { name: "Небоскрёб", gen: skyscraper },
  quarry: { name: "Карьер", gen: () => new BP(5, 5).build() },
  mine: { name: "Шахта", gen: () => new BP(3, 3).build() },
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
    if (out.weirdo_direction !== undefined) out.weirdo_direction = { 0: 2, 2: 1, 1: 3, 3: 0 }[out.weirdo_direction];
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
  // Подсыпка площадки до уровня поселения (снизу вверх) — землёй, а если её долго нет — камнем.
  for (let y = o.y - 7; y < o.y; y++) for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
    ops.push({ k: "f", x: o.x + x, y, z: o.z + z });
  }
  // Пандус перед входом: спуск или подъём на 1 блок за шаг, чтобы жители могли зайти с земли.
  const cx = Math.floor(bp.w / 2);
  for (let k = 1; k <= 6; k++) for (let dx = -1; dx <= 1; dx++) {
    const [wx, wz] = toWorld(o, r, bp.w, bp.d, cx + dx, -k);
    for (let y = o.y - 7; y <= o.y - k; y++) ops.push({ k: "f", x: wx, y, z: wz, ramp: true });
    for (let y = o.y + 6; y >= o.y + k; y--) ops.push({ k: "c", x: wx, y, z: wz, ramp: true });
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
