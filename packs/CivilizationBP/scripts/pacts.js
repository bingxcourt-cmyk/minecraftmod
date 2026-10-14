import { S, dXZ, markDirty } from "./core.js";
import { popOf } from "./society.js";
import { note } from "./journal.js";
import { repOf } from "./credit.js";

// ---------- Союзы и договоры ----------
// Соседи, которые долго живут без вражды и честно платят по долгам, заключают договоры на час:
//  peace   — о ненападении: не воюют друг с другом;
//  trade   — торговый союз: друг у друга покупают на 10% дешевле;
//  defense — оборонительный: если на одного нападут, второй вступает в войну.
export const PACT_NAME = { peace: "о ненападении", trade: "торговый союз", defense: "оборонительный союз" };
const PACT_SEC = 3600;

export const pactOf = (a, b) => {
  const p = a.pacts?.[b.id];
  return p && p.until > S.clock ? p : null;
};
export const hasPact = (a, b, type) => {
  const p = pactOf(a, b);
  return !!p && (!type || p.type === type || (type === "peace" && p.type !== "peace"));
};

function sign(a, b, type) {
  for (const [x, y] of [[a, b], [b, a]]) {
    x.pacts = x.pacts ?? {};
    x.pacts[y.id] = { type, until: S.clock + PACT_SEC };
    markDirty(x);
  }
  note("events", `${a.name} и ${b.name} заключили договор: ${PACT_NAME[type]} (на час)`);
}

/** Раз в минуту: новые договоры между спокойными соседями, старые истекают. */
export function pactTick() {
  const civs = [...S.civs.values()].filter((c) => popOf(c) >= 4);
  for (const c of civs) {
    for (const id of Object.keys(c.pacts ?? {})) {
      if (!S.civs.has(id) || c.pacts[id].until <= S.clock) delete c.pacts[id];
    }
  }
  for (let i = 0; i < civs.length; i++) for (let j = i + 1; j < civs.length; j++) {
    const a = civs[i];
    const b = civs[j];
    if (pactOf(a, b) || a.war || b.war || dXZ(a.center, b.center) > 260) continue;
    if ((a.tension[b.id] ?? 0) > 15 || repOf(a) < 40 || repOf(b) < 40) continue;
    if (Math.random() > 0.08) continue;
    const traders = a.ruler?.trait === "trader" || b.ruler?.trait === "trader";
    const scared = (a._threats?.length ?? 0) + (b._threats?.length ?? 0) > 0 || a.raid || b.raid;
    sign(a, b, traders ? "trade" : scared || Math.random() < 0.4 ? "defense" : "peace");
  }
}

/** На b напал a — союзники b по обороне вступают в войну против a. */
export function callDefenders(attacker, victim) {
  const joined = [];
  for (const c of S.civs.values()) {
    if (c === attacker || c === victim || c.war) continue;
    if (!hasPact(victim, c, "defense") || pactOf(victim, c)?.type !== "defense") continue;
    c.war = { enemy: attacker.id, since: S.clock, startPop: popOf(c), reason: `защита союзника ${victim.name}`, ally: victim.id };
    c._reassign = true;
    markDirty(c);
    joined.push(c.name);
  }
  if (joined.length) note("events", `${joined.join(", ")} вступили в войну на стороне ${victim.name} (оборонительный союз)`);
  return joined;
}

export function pactText(civ) {
  const list = Object.entries(civ.pacts ?? {})
    .filter(([id, p]) => p.until > S.clock && S.civs.has(id))
    .map(([id, p]) => `${S.civs.get(id).name} — ${PACT_NAME[p.type]} (${Math.ceil((p.until - S.clock) / 60)} мин)`);
  return list.length ? list.join(", ") : "нет";
}
