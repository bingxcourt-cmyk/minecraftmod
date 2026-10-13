import { world } from "@minecraft/server";
import { S, markDirty, dXZ } from "./core.js";
import { popOf } from "./society.js";
import { price, BASE, raiseCoins } from "./market.js";
import { note } from "./journal.js";

// Кредиты между поселениями. Крепкое даёт в долг слабому; лимит и ставка — от состоятельности
// и репутации заёмщика. Заёмщик либо платит честно (+репутация), либо просит скидку 50%
// (рынок закрыт до полной выплаты), либо отказывается платить — тогда кредитор с союзниками
// идёт на него войной, а добыча делится пополам: 50% кредитору, 50% союзникам.

export function loadLoans() {
  try {
    S.loans = JSON.parse(String(world.getDynamicProperty("civ:loans") ?? "[]"));
  } catch {
    S.loans = [];
  }
}

export function saveLoans() {
  try {
    world.setDynamicProperty("civ:loans", JSON.stringify((S.loans ?? []).slice(-40)));
  } catch {}
}

export const repOf = (civ) => Math.round(civ.rep ?? 50);

/** Состоятельность: монеты + половина рыночной стоимости запасов. */
export function worth(civ) {
  let w = civ.coins ?? 0;
  for (const k of Object.keys(BASE)) w += (civ.res[k] ?? 0) * price(k) * 0.5;
  return Math.floor(w);
}

/** Максимальный кредит: 40% состоятельности при средней репутации (50), больше — при хорошей. */
export function limitOf(civ) {
  return Math.floor(worth(civ) * 0.4 * (0.2 + repOf(civ) / 62.5));
}

/** Ставка: от 5% (репутация 100) до 40% (репутация 0), бедным +5%. */
export function rateOf(civ) {
  const r = 0.35 - repOf(civ) * 0.003 + (worth(civ) < 300 ? 0.05 : 0);
  return Math.max(0.05, Math.min(0.4, r));
}

const live = (l) => l.status === "active" || l.status === "halved";
export const debtOf = (civ) => (S.loans ?? []).find((l) => l.borrower === civ.id && live(l));

function setRep(civ, v) {
  civ.rep = Math.max(0, Math.min(100, v));
  markDirty(civ);
}

/** Раз в минуту: выдача кредитов, выплаты и решения должников. */
export function creditTick(declareWar) {
  S.loans = S.loans ?? [];
  const civs = [...S.civs.values()].filter((c) => popOf(c) > 0);
  // Выдача: тем, кому не хватило монет на нужное.
  for (const b of civs) {
    // Тем, кто уже отказывался платить или с плохой репутацией, в долг не дают.
    if (!(b._short > 0) || debtOf(b) || b.marketBan || b.war || b.defaulted || repOf(b) < 15) continue;
    const want = Math.max(30, Math.ceil(b._short * 2));
    const amount = Math.min(limitOf(b), want);
    if (amount < 20) continue;
    const lender = civs
      .filter((c) => c !== b && (c.coins ?? 0) >= amount + 300 && c.war?.enemy !== b.id && b.war?.enemy !== c.id)
      .sort((x, y) => (y.coins ?? 0) - (x.coins ?? 0))[0];
    if (!lender) continue;
    const rate = rateOf(b);
    const loan = { id: `${S.clock}-${b.id}`, lender: lender.id, borrower: b.id, ln: lender.name, bn: b.name, amount, rate, due: Math.ceil(amount * (1 + rate)), paid: 0, since: S.clock, status: "active", missed: 0 };
    S.loans.push(loan);
    lender.coins -= amount;
    b.coins = (b.coins ?? 0) + amount;
    b._short = 0;
    markDirty(lender);
    markDirty(b);
    note("credit", `${lender.name} дали в долг ${b.name} ${amount} мон. под ${Math.round(rate * 100)}% (вернуть ${loan.due}, репутация ${repOf(b)})`);
  }
  // Выплаты.
  for (const loan of S.loans) {
    if (!live(loan)) continue;
    const b = S.civs.get(loan.borrower);
    const l = S.civs.get(loan.lender);
    if (!b || !l) {
      loan.status = "closed";
      continue;
    }
    if (b.war && b.war.enemy === l.id) continue; // воюют — не до выплат
    const remain = loan.due - loan.paid;
    const inst = Math.min(remain, Math.max(5, Math.ceil(loan.due * 0.15)));
    // Не хватает монет на взнос — продают излишки на рынке.
    if ((b.coins ?? 0) - inst < 10) raiseCoins(b, inst + 10 - (b.coins ?? 0));
    if ((b.coins ?? 0) - inst >= 10) {
      b.coins -= inst;
      l.coins = (l.coins ?? 0) + inst;
      loan.paid += inst;
      loan.missed = 0;
      markDirty(b);
      markDirty(l);
      if (loan.paid >= loan.due) {
        const honest = loan.status === "active";
        loan.status = "repaid";
        if (honest) setRep(b, repOf(b) + 10);
        if (b.marketBan === loan.id) b.marketBan = null;
        note("credit", `${b.name} ${honest ? "честно " : ""}выплатили долг ${l.name} (${loan.due} мон.)${honest ? `, репутация ${repOf(b)}` : ", рынок снова открыт"}`);
      }
      continue;
    }
    loan.missed++;
    if (loan.missed < 8) continue;
    loan.missed = 0;
    // Платить нечем уже 6 минут — решают, как быть.
    if (loan.status === "active" && repOf(b) >= 30 && Math.random() < 0.8) {
      loan.due = loan.paid + Math.ceil(remain / 2);
      loan.status = "halved";
      b.marketBan = loan.id;
      setRep(b, repOf(b) - 15);
      note("credit", `${b.name} попросили у ${l.name} скидку 50% (осталось ${loan.due - loan.paid} мон.); рынок для них закрыт до выплаты, репутация ${repOf(b)}`);
      continue;
    }
    defaultLoan(loan, b, l, declareWar);
  }
  S.loans = S.loans.filter((l) => live(l) || l.status === "defaulted" || S.clock - l.since < 7200);
  saveLoans();
}

/** Отказ платить: война кредитора и его союзников против должника. */
function defaultLoan(loan, b, l, declareWar) {
  loan.status = "defaulted";
  b.marketBan = null;
  b.defaulted = true;
  setRep(b, 0);
  const allies = [...S.civs.values()]
    .filter((c) => c !== b && c !== l && !c.war && c.era >= 1 && popOf(c) >= 4 && (c.tension?.[l.id] ?? 0) < 30)
    .sort((x, y) => dXZ(x.center, b.center) - dXZ(y.center, b.center))
    .slice(0, 2);
  note("credit", `${b.name} отказались платить ${l.name} (${loan.due - loan.paid} мон.)! ${l.name}${allies.length ? " и союзники " + allies.map((a) => a.name).join(", ") : ""} идут войной`);
  if (l.war || b.war) return; // уже воюют — долг остаётся непогашенным
  loan.allies = allies.map((a) => a.id);
  declareWar(l, b, { reason: "долг", res: "coins", loan: loan.id });
  for (const a of allies) {
    a.war = { enemy: b.id, since: S.clock, startPop: popOf(a), reason: `помощь ${l.name} (долг)`, ally: l.id };
    a._reassign = true;
    markDirty(a);
  }
}

/**
 * Дележ добычи в войне за долг: всё, что забрали у должника, — 50% кредитору, 50% союзникам поровну.
 * Возвращает текст для летописи.
 */
export function splitDebtLoot(loser, winner) {
  const loan = (S.loans ?? []).find((l) => l.status === "defaulted" && l.borrower === loser.id && l.lender === winner.id);
  if (!loan) return null;
  const allies = (loan.allies ?? []).map((id) => S.civs.get(id)).filter(Boolean);
  const take = { coins: Math.floor(loser.coins ?? 0) };
  for (const k in loser.res) take[k] = Math.floor((loser.res[k] ?? 0) * 0.5);
  loser.coins = (loser.coins ?? 0) - take.coins;
  for (const k in loser.res) loser.res[k] -= take[k];
  const give = (c, share) => {
    c.coins = (c.coins ?? 0) + Math.floor(take.coins * share);
    for (const k in loser.res) c.res[k] = (c.res[k] ?? 0) + Math.floor(take[k] * share);
    markDirty(c);
  };
  give(winner, allies.length ? 0.5 : 1);
  for (const a of allies) {
    give(a, 0.5 / allies.length);
    if (a.war?.enemy === loser.id) {
      a.war = null;
      a._reassign = true;
    }
  }
  loan.status = "collected";
  return `забрали ${take.coins} мон. и половину запасов: 50% — ${winner.name}${allies.length ? ", 50% — " + allies.map((a) => a.name).join(", ") : ""}`;
}

/** Кредитор проиграл войну за долг — долг списан. */
export function cancelDebt(debtor, lender) {
  for (const l of S.loans ?? []) {
    if (l.status === "defaulted" && l.borrower === debtor.id && l.lender === lender.id) l.status = "closed";
  }
  for (const c of S.civs.values()) {
    if (c.war?.ally === lender.id && c.war.enemy === debtor.id) {
      c.war = null;
      c._reassign = true;
    }
  }
}

/** Текст для меню кредитов. */
export function creditText() {
  const lines = ["§lРепутация и лимиты:§r"];
  for (const c of S.civs.values()) {
    if (popOf(c) <= 0) continue;
    lines.push(`${c.color}${c.name}§r: репутация ${repOf(c)}, лимит ${limitOf(c)} мон., ставка ${Math.round(rateOf(c) * 100)}%${c.marketBan ? " §c(рынок закрыт)" : ""}`);
  }
  const act = (S.loans ?? []).filter((l) => live(l) || l.status === "defaulted");
  lines.push("", "§lДолги:§r");
  if (!act.length) lines.push("§7нет");
  for (const l of act) {
    const st = l.status === "halved" ? "§eсо скидкой 50%" : l.status === "defaulted" ? "§cотказ платить — война" : "§aвыплачивается";
    lines.push(`${l.bn} должны ${l.ln}: ${l.paid}/${l.due} мон. ${st}§r`);
  }
  return lines.join("\n");
}
