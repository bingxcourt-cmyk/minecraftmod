import { S, DIM, markDirty, rnd } from "./core.js";
import { popOf, count } from "./society.js";
import { note } from "./journal.js";

// ---------- Наука ----------
// Библиотеки дают очки науки; открытия идут по порядку и навсегда улучшают поселение.
export const TECHS = [
  { id: "axes", name: "Заточка топоров", cost: 40, hint: "лесорубы на 25% быстрее" },
  { id: "picks", name: "Закалка кирок", cost: 70, hint: "шахтёры и каменотёсы на 25% быстрее" },
  { id: "plough", name: "Плуг", cost: 100, hint: "урожай на 25% больше" },
  { id: "masonry", name: "Каменная кладка", cost: 140, hint: "стену ломают на 30 с дольше, кладут вдвое быстрее" },
  { id: "medicine", name: "Медицина", cost: 180, hint: "эпидемии вдвое слабее" },
  { id: "logistics", name: "Логистика", cost: 220, hint: "караваны вдвое быстрее" },
];
export const hasTech = (civ, id) => !!civ.techs?.includes(id);
/** Множитель скорости работы от открытий. */
export const techMult = (civ, id) => (hasTech(civ, id) ? 1.25 : 1);

export function scienceTick(civ, minutes) {
  const libs = count(civ, (b) => b.t === "library");
  if (!libs) return;
  civ.sci = (civ.sci ?? 0) + (libs + popOf(civ) / 50) * minutes;
  const next = TECHS.find((t) => !hasTech(civ, t.id));
  if (next && civ.sci >= next.cost) {
    civ.sci -= next.cost;
    civ.techs = [...(civ.techs ?? []), next.id];
    note("events", `${civ.name}: учёные открыли «${next.name}» — ${next.hint}`);
  }
  markDirty(civ);
}

export function scienceText(civ) {
  const done = TECHS.filter((t) => hasTech(civ, t.id)).map((t) => t.name);
  const next = TECHS.find((t) => !hasTech(civ, t.id));
  if (!count(civ, (b) => b.t === "library")) return done.length ? `открыто: ${done.join(", ")}` : "нужна библиотека (эпоха «Город»)";
  return `${done.length ? `открыто: ${done.join(", ")}; ` : ""}${next ? `изучают «${next.name}» ${Math.floor(civ.sci ?? 0)}/${next.cost}` : "всё открыто"}`;
}

// ---------- Животноводство ----------
// Загон: коровы и овцы дают еду, шерсть и кожу. Кожа идёт на кожаную броню стражи.
export function husbandryTick(civ, minutes) {
  const pens = count(civ, (b) => b.t === "pen");
  if (!pens) return;
  civ._husb = civ._husb ?? {};
  const add = (k, v) => {
    const t = (civ._husb[k] ?? 0) + v;
    const whole = Math.floor(t);
    civ._husb[k] = t - whole;
    if (whole > 0) civ.res[k] = (civ.res[k] ?? 0) + whole;
  };
  add("food", pens * 1.5 * minutes);
  add("wool", pens * 0.5 * minutes);
  add("leather", pens * 0.3 * minutes);
  markDirty(civ);
}

/** Новый загон заселяют скотом (вживую). */
export function stockPen(b) {
  const dim = DIM();
  for (const t of ["minecraft:cow", "minecraft:cow", "minecraft:sheep", "minecraft:sheep"]) {
    try {
      const e = dim.spawnEntity(t, { x: b.x + rnd(2, Math.max(2, b.w - 3)) + 0.5, y: b.y + 1, z: b.z + rnd(2, Math.max(2, b.d - 3)) + 0.5 });
      e.nameTag = "";
    } catch {}
  }
}
