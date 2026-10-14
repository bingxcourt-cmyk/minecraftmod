// Проверка содержания зданий и точности цен. Запуск: в имитаторе (node upkeeptest.js), рядом с папкой scripts.
import { W, tick, fireWorldLoad, Entity } from "@minecraft/server";
let NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
Date.now = () => NOW;
const warns = []; console.warn = (m) => warns.push(String(m));
await import("./scripts/main.js");
const { S, saveAll, loadAll } = await import("./scripts/core.js");
const U = await import("./scripts/upkeep.js");
const M = await import("./scripts/market.js");
const { money, fmtCoins, transfer } = await import("./scripts/money.js");
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!cond) process.exitCode = 1; };
const spawn = (t, x, z) => { const e = new Entity(t, { x, y: 64, z }); W.entities.push(e); return e; };
for (let i = 0; i < 10; i++) spawn("minecraft:villager_v2", i, 0);
const pl = new Entity("minecraft:player", { x: 0, y: 70, z: 0 }); W.players.push(pl);
fireWorldLoad();
const run = (sec) => { for (let t = 0; t < 20 * sec; t++) tick(); };
run(120);
const civ = [...S.civs.values()].sort((a, b) => (S.members.get(b.id)?.length ?? 0) - (S.members.get(a.id)?.length ?? 0))[0];
// Постройки: даём ресурсы и ждём; часы устройства (NOW) всё это время стоят на месте.
for (let m = 0; m < 25; m++) { Object.assign(civ.res, { wood: 3000, stone: 3000, iron: 100, food: 200 }); run(60); }
const nb = civ.buildings.filter((b) => b.t !== "mine" && b.t !== "quarry").length;
console.log("зданий:", nb, civ.buildings.map((b) => b.t).join(","));

// 2. Игровое время и скорость симуляции не влияют.
const p0 = civ.upkeep?.period;
const j0 = (S.journal.upkeep ?? []).length;
S.speed = 8; W.time = 18000; run(30); S.speed = 1;
ok("2. скорость игры и игровое время не влияют на таймер", civ.upkeep.period === p0 && (S.journal.upkeep ?? []).length === j0, `25 игровых минут прошло, период ${p0} не сменился`);

// 3. Несколько зданий.
const total = U.totalBuildCost(civ);
const exp = {};
for (const [k, v] of Object.entries(total)) exp[k] = v * U.UPKEEP.RATE;
const { need, value } = U.upkeepFor(civ);
ok("3. содержание = 6% суммарной стоимости всех зданий", Object.keys(exp).every((k) => Math.abs(exp[k] - need[k]) < 1e-9),
  `стоимость ${JSON.stringify(total)} → за период ${JSON.stringify(Object.fromEntries(Object.entries(need).map(([k, v]) => [k, +v.toFixed(3)])))}, по рынку ${fmtCoins(value)} мон.`);

// 1. Ровно через 600 секунд реального времени.
const st = civ.upkeep;
const startP = st.period;
NOW = (startP + 1) * 600000 - 1000; U.upkeepTick(NOW);
ok("1a. за 1 с до конца периода — не списано", st.period === startP);
Object.assign(civ.res, { wood: 5000, stone: 5000, iron: 500, food: 500, andesite: 5000, glass: 5000, dirt: 5000 });
civ.coins = 777;
const before = { ...civ.res };
NOW = (startP + 1) * 600000; U.upkeepTick(NOW); console.log("DBG", startP, st.period, civ.upkeep === st, civ.upkeep.period, U.periodOf(NOW));
const spent = Object.fromEntries(Object.keys(before).map((k) => [k, before[k] - civ.res[k]]));
ok("1b. в момент начала нового периода — списано", st.period === startP + 1, `списано ${JSON.stringify(spent)}`);
U.upkeepTick(NOW); U.upkeepTick(NOW + 599000);
ok("1c. повторно в том же периоде не списывается", st.period === startP + 1 && civ.res.stone === before.stone - spent.stone);
ok("4. платят ресурсами, монеты не тронуты", civ.coins === 777);
ok("5a. списано 6% каждого ресурса (дробные доли копятся на следующий период)", Object.keys(exp).every((k) => spent[k] === Math.floor(exp[k] + 1e-9)), `остатки долей ${JSON.stringify(Object.fromEntries(Object.entries(st.frac).map(([k, v]) => [k, +v.toFixed(3)])))}`);

// 5b. Режим долей по рыночным ценам.
U.UPKEEP.MIX = { wood: 0.5, stone: 0.5 };
const u2 = U.upkeepFor(civ);
const pw = M.price("wood");
const ps = M.price("stone");
ok("5b. доли по рыночным ценам: количество = стоимость × доля / цена", Math.abs(u2.need.wood - (u2.value * 0.5) / pw) < 1e-9 && Math.abs(u2.need.stone - (u2.value * 0.5) / ps) < 1e-9,
  `цены: дерево ${fmtCoins(pw)}, камень ${fmtCoins(ps)}; ${fmtCoins(u2.value)} мон. → дерево ${u2.need.wood.toFixed(3)}, камень ${u2.need.stone.toFixed(3)}`);
U.UPKEEP.MIX = "build";

// 6. Нехватка.
civ.res.stone = 3; civ.res.wood = 0; W.msgs.length = 0;
NOW += 600000; U.upkeepTick(NOW);
ok("6a. нехватка: долг записан, запасы не ушли в минус", (st.debt.stone ?? 0) > 0 && civ.res.stone >= 0 && civ.res.wood >= 0, `долг ${JSON.stringify(st.debt)}, камня на складе ${civ.res.stone}`);
const msg = W.msgs.find((m) => m.includes("содержание"));
ok("6b. игроки рядом уведомлены, каких ресурсов и сколько не хватает", !!msg, msg?.replace(/§./g, ""));
ok("6c. здания не удалены", civ.buildings.filter((b) => b.t !== "mine" && b.t !== "quarry").length === nb);

// 7. Перезапуск сервера.
saveAll(true);
const id = civ.id;
S.civs.clear(); loadAll();
const civ2 = S.civs.get(id);
const pBefore = civ2.upkeep.period;
const stoneBefore = civ2.res.stone;
U.upkeepTick(NOW);
ok("7a. после перезапуска оплаченный период не списывается повторно", civ2.upkeep.period === pBefore && civ2.res.stone === stoneBefore);
const pb = civ2.upkeep.period;
NOW += 3 * 600000 + 5000;
Object.assign(civ2.res, { wood: 9000, stone: 9000, iron: 900, food: 900 });
U.upkeepTick(NOW); U.upkeepTick(NOW);
ok("7b. сервер стоял 3 периода — начислено ровно 3 периода", civ2.upkeep.period === pb + 3);

// 8. Погашение долга.
civ2.upkeep.debt = { stone: 50 }; civ2.res.stone = 20; U.repayDebt(civ2);
const mid = civ2.upkeep.debt.stone;
civ2.res.stone += 100; U.repayDebt(civ2);
ok("8. долг гасится последующими поставками", mid === 30 && !civ2.upkeep.debt.stone && civ2.res.stone === 70, `после первой поставки долг ${mid}, после второй — 0, на складе ${civ2.res.stone}`);

// 9. Точность цен.
S.market.lots.push({ civ: id, k: "dirt", qty: 1000, price: 0.000012, t: S.clock });
S.market.last.dirt = 125.123456;
M.saveMarket(); S.market = null; M.loadMarket();
const lot = S.market.lots.find((l) => l.price === 0.000012);
ok("9a. цены 0.000012 и 125.123456 сохраняются без потерь", !!lot && S.market.last.dirt === 125.123456);
ok("9b. отображение без округления до 0.00", fmtCoins(0.000012) === "0.000012" && fmtCoins(0.0015) === "0.0015" && fmtCoins(0.00012) === "0.00012" && fmtCoins(0.02) === "0.02" && fmtCoins(125.123456) === "125.123456");
const a = { coins: 10 };
const b = { coins: 5 };
const sum0 = money(a.coins + b.coins);
for (let i = 0; i < 1000; i++) transfer(a, b, 0.000012);
ok("9c. 1000 переводов по 0.000012 — деньги не появились и не исчезли", money(a.coins + b.coins) === sum0 && money(b.coins - 5) === 0.012, `получатель +${fmtCoins(b.coins - 5)}`);
// Покупка по цене 0.000012 через рынок: монеты покупателя и продавца в сумме не меняются.
const seller = civ2;
seller.res.dirt = 0;
const buyerCiv = { id: "test-buyer", name: "Покупатель", coins: 1, res: { dirt: 0, food: 0 }, buildings: [] };
S.civs.set(buyerCiv.id, buyerCiv);
const sumBefore = money(seller.coins + buyerCiv.coins);
const lotBefore = lot.qty;
M.marketBuy(buyerCiv, "dirt", 500);
const bought = lotBefore - (S.market.lots.find((l) => l === lot || (l.price === 0.000012 && l.k === "dirt"))?.qty ?? 0);
ok("9d. покупка по 0.000012: сумма денег сохраняется, оплата точная", money(seller.coins + buyerCiv.coins) === sumBefore && bought === 500 && money(1 - buyerCiv.coins) === 0.006, `куплено ${bought} земли за ${fmtCoins(money(1 - buyerCiv.coins))} мон.`);
S.civs.delete(buyerCiv.id);

console.log("ERRORS", W.errors.length, W.errors.slice(0, 3));
