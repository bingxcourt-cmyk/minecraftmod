import { system, world } from "@minecraft/server";
import { S, DIM, dXZ } from "./core.js";
import { TOOL_FOR, toolTier } from "./tools.js";

// Инструмент в руке: житель в Bedrock не рисует предметы в руках, поэтому рядом с его рукой
// ходит маленькая сущность «civ:tool» — плоская картинка инструмента (текстура из игры).
const ID = "civ:tool";
const KIND = { axe: 0, pickaxe: 1, hoe: 2, sword: 3 };
const SHOW_R = 64; // дальше игрок всё равно не разглядит

export const swinging = new Map(); // entity.id -> тик, до которого идёт взмах

/** Индекс картинки: вид инструмента × 4 + материал, или -1, если инструмента нет. */
export function heldIndex(ent, role) {
  const kind = TOOL_FOR[role];
  if (!kind) return -1;
  const t = toolTier(ent, kind);
  return t ? KIND[kind] * 4 + Math.min(t, 4) - 1 : -1;
}

function drop(brain) {
  const h = brain.held;
  brain.held = null;
  try {
    if (h?.isValid) h.remove();
  } catch {}
}

export function dropHeld(brain) {
  drop(brain);
}

/** Каждые 2 тика: инструмент следует за рукой жителя. */
export function heldTick() {
  const players = world.getAllPlayers().filter((p) => p.dimension.id === "minecraft:overworld");
  const tick = system.currentTick;
  const dim = DIM();
  for (const b of S.brains.values()) {
    const e = b.ent;
    const civ = S.civs.get(b.civId);
    const idx = b.heldIdx ?? -1;
    const visible = idx >= 0 && e?.isValid && civ && civ._active !== false && players.some((p) => dXZ(p.location, e.location) < SHOW_R);
    if (!visible) {
      if (b.held) drop(b);
      continue;
    }
    const l = e.location;
    const yaw = e.getRotation().y;
    const r = (yaw * Math.PI) / 180;
    // Вперёд и вправо относительно взгляда жителя; руки у него на уровне ~0.8 блока.
    const fx = -Math.sin(r);
    const fz = Math.cos(r);
    const pos = { x: l.x + fx * 0.32 - fz * 0.28, y: l.y + 0.62, z: l.z + fz * 0.32 + fx * 0.28 };
    if (!b.held || !b.held.isValid) {
      try {
        b.held = dim.spawnEntity(ID, pos);
        b.held.setDynamicProperty("owner", e.id);
        b.heldShown = -1;
        b.heldSwing = false;
      } catch {
        b.held = null;
        continue;
      }
    }
    const h = b.held;
    try {
      if (b.heldShown !== idx) {
        h.setProperty("civ:tool", idx);
        b.heldShown = idx;
      }
      const sw = (swinging.get(e.id) ?? 0) > tick;
      if (sw !== b.heldSwing) {
        h.setProperty("civ:swing", sw);
        b.heldSwing = sw;
      }
      h.teleport(pos, { rotation: { x: 0, y: yaw } });
    } catch {}
  }
}

/** Убирает «потерявшиеся» держатели (после перезахода в мир, смерти жителя и т.п.). */
export function heldCleanup() {
  const owned = new Set();
  for (const b of S.brains.values()) if (b.held?.isValid) owned.add(b.held.id);
  let list = [];
  try {
    list = DIM().getEntities({ type: ID });
  } catch {}
  for (const h of list) {
    if (owned.has(h.id)) continue;
    try {
      h.remove();
    } catch {}
  }
}
