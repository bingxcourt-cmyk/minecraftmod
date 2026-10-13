import { world, system, MolangVariableMap } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";
import { S, getProp, setProp } from "./core.js";
import { ROLE_NAME } from "./workers.js";

// «ВХ»: подсветка жителей выбранных профессий. Видит только тот игрок, который её включил.
export const WH_ROLES = ["lumberjack", "miner", "farmer", "hunter", "builder", "soldier", "guard", "settler", "child", "golem"];

const COLOR = {
  lumberjack: { red: 0.2, green: 0.9, blue: 0.2 },
  miner: { red: 0.4, green: 0.5, blue: 1 },
  farmer: { red: 1, green: 0.9, blue: 0.1 },
  hunter: { red: 1, green: 0.5, blue: 0.1 },
  builder: { red: 0.1, green: 0.9, blue: 1 },
  soldier: { red: 1, green: 0.1, blue: 0.1 },
  guard: { red: 0.6, green: 0, blue: 0 },
  settler: { red: 1, green: 0.3, blue: 1 },
  child: { red: 1, green: 1, blue: 1 },
  golem: { red: 0.7, green: 0.7, blue: 0.7 },
};
const CODE = { lumberjack: "§a", miner: "§9", farmer: "§e", hunter: "§6", builder: "§b", soldier: "§c", guard: "§4", settler: "§d", child: "§f", golem: "§7" };

const ALIASES = {
  lumberjack: "lumberjack", лесоруб: "lumberjack", лесорубы: "lumberjack",
  miner: "miner", шахтер: "miner", шахтёр: "miner", шахтеры: "miner", шахтёры: "miner",
  farmer: "farmer", фермер: "farmer", фермеры: "farmer",
  hunter: "hunter", охотник: "hunter", охотники: "hunter",
  builder: "builder", строитель: "builder", строители: "builder",
  soldier: "soldier", воин: "soldier", воины: "soldier",
  guard: "guard", стражник: "guard", стражники: "guard", стража: "guard",
  settler: "settler", переселенец: "settler", переселенцы: "settler",
  child: "child", ребенок: "child", ребёнок: "child", дети: "child",
  golem: "golem", страж: "golem", стражи: "golem", голем: "golem", големы: "golem",
};

const KEY = "civ:wh";
const cache = new Map(); // player.id -> Set ролей

export function whOf(pl) {
  let s = cache.get(pl.id);
  if (!s) {
    try {
      s = new Set(JSON.parse(String(getProp(pl, KEY) ?? "[]")));
    } catch {
      s = new Set();
    }
    cache.set(pl.id, s);
  }
  return s;
}

function save(pl, s) {
  cache.set(pl.id, s);
  setProp(pl, KEY, JSON.stringify([...s]));
}

function describe(s) {
  return s.size ? [...s].map((r) => CODE[r] + ROLE_NAME[r]).join("§7, ") : "§7выключено";
}

/** /scriptevent civ:wh <профессия|all|off> — переключает подсветку. Без аргумента — меню. */
export function whCommand(pl, arg) {
  const a = (arg ?? "").trim().toLowerCase();
  if (!a) return showWhForm(pl);
  const s = whOf(pl);
  if (["all", "все", "всё"].includes(a)) WH_ROLES.forEach((r) => s.add(r));
  else if (["off", "выкл", "нет", "none"].includes(a)) s.clear();
  else {
    const role = ALIASES[a];
    if (!role) {
      pl.sendMessage("§cНеизвестная профессия. Можно: лесоруб, шахтёр, фермер, охотник, строитель, воин, переселенец, ребёнок, страж, all, off");
      return;
    }
    if (s.has(role)) s.delete(role);
    else s.add(role);
  }
  save(pl, s);
  pl.sendMessage(`§eВХ: ${describe(s)}`);
}

export function showWhForm(pl, tries = 0) {
  const s = whOf(pl);
  const form = new ModalFormData().title("ВХ на жителей");
  for (const r of WH_ROLES) form.toggle(`${CODE[r]}${ROLE_NAME[r]}`, { defaultValue: s.has(r) });
  form
    .show(pl)
    .then((res) => {
      // Если открыт чат, форма не показывается — пробуем ещё раз чуть позже.
      if (res.canceled && res.cancelationReason === "UserBusy" && tries < 20) {
        system.runTimeout(() => showWhForm(pl, tries + 1), 10);
        return;
      }
      if (res.canceled || !res.formValues) return;
      const next = new Set(WH_ROLES.filter((r, i) => res.formValues[i] === true));
      save(pl, next);
      pl.sendMessage(`§eВХ: ${describe(next)}`);
    })
    .catch(() => {});
}

const ARROWS = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"];

function arrow(pl, pos) {
  const l = pl.location;
  const yaw = pl.getRotation().y; // 0 = юг (+z), 90 = запад (-x)
  const ang = (Math.atan2(-(pos.x - l.x), pos.z - l.z) * 180) / Math.PI; // направление на цель в той же системе
  let rel = ang - yaw;
  rel = ((rel % 360) + 540) % 360 - 180; // -180..180, 0 = прямо
  return ARROWS[(Math.round(rel / 45) + 8) % 8];
}

/** Строка для action bar: ближайшие подсвеченные жители. */
export function whLine(pl) {
  const s = whOf(pl);
  if (!s.size) return "";
  const list = [];
  for (const b of S.brains.values()) {
    if (!s.has(b.role) || !b.ent?.isValid) continue;
    const d = Math.hypot(b.ent.location.x - pl.location.x, b.ent.location.z - pl.location.z);
    list.push({ b, d });
  }
  list.sort((a, b) => a.d - b.d);
  if (!list.length) return "§7ВХ: рядом никого";
  return "§7ВХ: " + list.slice(0, 3).map(({ b, d }) => `${CODE[b.role]}${b.name || ROLE_NAME[b.role]} ${Math.round(d)}м ${arrow(pl, b.ent.location)}`).join("  ");
}

/** Рисует цветной луч над подсвеченными жителями (каждые 10 тиков). */
export function whTick() {
  for (const pl of world.getAllPlayers()) {
    const s = whOf(pl);
    if (!s.size || pl.dimension.id !== "minecraft:overworld") continue;
    const near = [];
    for (const b of S.brains.values()) {
      if (!s.has(b.role) || !b.ent?.isValid) continue;
      const l = b.ent.location;
      const d = Math.hypot(l.x - pl.location.x, l.z - pl.location.z);
      if (d < 96) near.push({ b, l, d });
    }
    near.sort((a, b) => a.d - b.d);
    for (const { b, l } of near.slice(0, 30)) {
      const m = new MolangVariableMap();
      m.setColorRGB("variable.color", COLOR[b.role]);
      for (const dy of [2.3, 3.5, 5, 7, 9.5, 12.5, 16, 20]) {
        try {
          pl.spawnParticle("minecraft:colored_flame_particle", { x: l.x, y: l.y + dy, z: l.z }, m);
        } catch {}
      }
    }
  }
}

world.afterEvents.playerLeave?.subscribe((ev) => cache.delete(ev.playerId));
