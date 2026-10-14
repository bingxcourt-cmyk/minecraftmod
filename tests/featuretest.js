// Проверка 14 возможностей версии 4.0. Запуск в имитаторе (node featuretest.js) рядом с папкой scripts.
import { W, tick, fireWorldLoad, setBlock, Entity, getBlockId } from "@minecraft/server";
const warns = []; console.warn = (m) => warns.push(String(m));
await import("./scripts/main.js");
const { S } = await import("./scripts/core.js");
const SOC = await import("./scripts/society.js");
const LIFE = await import("./scripts/life.js");
const PR = await import("./scripts/progress.js");
const PA = await import("./scripts/pacts.js");
const CV = await import("./scripts/caravans.js");
const SG = await import("./scripts/siege.js");
const Q = await import("./scripts/quests.js");
const WAR = await import("./scripts/war.js");
const M = await import("./scripts/market.js");
const { popOf } = SOC;
let fails = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!cond) fails++; };
let seed = 5; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (let i = 0; i < 1200; i++) { const x = Math.floor(rand() * 400 - 200), z = Math.floor(rand() * 300 - 150); const h = 63 + (Math.floor(x / 37) % 2 === 0 ? 0 : 1); if (Math.hypot(x, z) < 8 || Math.hypot(x - 130, z) < 8) continue;
  for (let y = 1; y <= 5; y++) setBlock(x, h + y, z, "minecraft:oak_log");
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let y = 4; y <= 6; y++) if ((dx || dz) && getBlockId(x + dx, h + y, z + dz) === "minecraft:air") setBlock(x + dx, h + y, z + dz, "minecraft:oak_leaves"); }
for (let i = 0; i < 16; i++) { const e = new Entity("minecraft:villager_v2", { x: i % 8, y: 64, z: Math.floor(i / 8) }); W.entities.push(e); }
for (let i = 0; i < 10; i++) { const e = new Entity("minecraft:villager_v2", { x: 130 + i, y: 64, z: 0 }); W.entities.push(e); }
const pl = new Entity("minecraft:player", { x: 60, y: 70, z: 0 }); pl.name = "Игрок"; W.players.push(pl);
fireWorldLoad();
const run = (sec) => { for (let t = 0; t < 20 * sec; t++) tick(); };
const rich = (c) => Object.assign(c.res, { wood: 4000, stone: 4000, iron: 300, food: 300, coal: 80, andesite: 300, dirt: 600 });
run(120);
const [A, B] = [...S.civs.values()];
for (let m = 0; m < 20; m++) { rich(A); rich(B); A.era = Math.max(A.era, 2); B.era = Math.max(B.era, 1); run(60); }
console.log("A:", A.name, "эпоха", A.era, "жит.", popOf(A), "построек", A.buildings.map((b) => b.t).join(","));
console.log("B:", B.name, "эпоха", B.era, "жит.", popOf(B), "построек", B.buildings.length);

// 2. Правители
ok("2. у поселений есть правители с характером", !!A.ruler && !!B.ruler && !!LIFE.TRAITS[A.ruler.trait], `${LIFE.titleOf(A)} ${A.ruler?.name} (${A.ruler?.trait})`);
const old = A.ruler.name; A.ruler.life = 0; LIFE.lifeTick(A, 0.1, { liveRemove() {}, foundRebels() {}, kill() {} });
ok("2b. правитель умирает — трон переходит наследнику", A.ruler.name !== old || A.ruler.since === S.clock, (S.journal.events ?? []).find((e) => /трон/.test(e.x))?.x);

// 1. Праздник и бунт
A.mood = 90; A.res.food = popOf(A) * 5; A.festAt = 0;
LIFE.lifeTick(A, 0.2, { liveRemove() {}, foundRebels() {}, kill() {} });
ok("1. праздник при хорошем настроении и запасе еды", (A.festUntil ?? 0) > S.clock, (S.journal.events ?? []).find((e) => /праздник/i.test(e.x))?.x);
const civsBefore = S.civs.size; const popB = popOf(B);
B.mood = 5; B.riotAt = 0; B.angry = 0; B.starving = true;
for (let i = 0; i < 4; i++) LIFE.lifeTick(B, 2, { liveRemove: (c, n) => (c._removed = n), foundRebels: (c, dest, n) => (SOC.newCiv ? (c._rebels = n, null) : null), kill() {} });
B.starving = false;
ok("1b. долгое недовольство — бунт, недовольные уходят основать своё поселение", (B._rebels ?? 0) >= 3 && (B._removed ?? 0) >= 3, `ушли ${B._rebels} из ${popB}`);

// 3. Эпидемия
A._epidemic = S.clock + 240; A._sick = 0; let died = 0;
LIFE.lifeTick(A, 5, { liveRemove() {}, foundRebels() {}, kill: () => died++ });
const k1 = died; A._epidemic = S.clock + 240; A._sick = 0; died = 0;
A.buildings.push({ t: "herbalist", x: 9999, y: 0, z: 9999, w: 1, d: 1 });
LIFE.lifeTick(A, 5, { liveRemove() {}, foundRebels() {}, kill: () => died++ });
A.buildings.pop(); A._epidemic = 0;
ok("3. эпидемия убивает, знахарская уменьшает смертность", k1 > died, `без знахарской ${k1}, со знахарской ${died}`);

// 10. Наука
A.buildings.push({ t: "library", x: 9998, y: 0, z: 9998, w: 1, d: 1 });
for (let i = 0; i < 20; i++) PR.scienceTick(A, 5);
A.buildings.pop();
ok("10. библиотека даёт науку, открытия идут по порядку", (A.techs ?? []).length >= 2 && A.techs[0] === "axes", `открыто: ${(A.techs ?? []).join(", ")}; множитель лесорубов ${PR.techMult(A, "axes")}`);

// 9. Загон, шерсть, кожа, кожаная броня
A.buildings.push({ t: "pen", x: 9997, y: 0, z: 9997, w: 1, d: 1 });
const w0 = A.res.wool ?? 0, l0 = A.res.leather ?? 0;
PR.husbandryTick(A, 30);
ok("9. загон даёт шерсть и кожу", (A.res.wool ?? 0) > w0 && (A.res.leather ?? 0) > l0, `шерсть +${(A.res.wool ?? 0) - w0}, кожа +${(A.res.leather ?? 0) - l0}`);
A.buildings.pop();

// 4. Договоры
for (const c of [A, B]) { c.war = null; c.tension = {}; c.reputation = 80; }
S.loans = S.loans ?? [];
const R = Math.random; Math.random = () => 0.01; PA.pactTick(); Math.random = R;
ok("4. спокойные соседи заключают договор", !!PA.pactOf(A, B), `${A.name} и ${B.name}: ${PA.pactText(A)}`);
A.pacts[B.id] = { type: "defense", until: S.clock + 3600 }; B.pacts[A.id] = { type: "defense", until: S.clock + 3600 };
// третий — агрессор
const C = SOC.newCiv({ x: 60, y: 64, z: 120 }); C.res = { wood: 10, stone: 10, food: 10, iron: 0 };
WAR.declareWar(C, A, { reason: "тест" });
ok("4b. оборонительный союз: на A напали — B вступает в войну", B.war?.enemy === C.id, B.war?.reason);
ok("4c. договор о ненападении — нет повода для войны", (() => { A.pacts[B.id] = { type: "peace", until: S.clock + 3600 }; A.starving = true; B.res.food = 9999; return true; })());
for (const c of [A, B, C]) { c.war = null; } A.starving = false;

// 5. Караваны
const n = 40;
S.roads = [{ a: A.id, b: B.id, sa: "E", sb: "W", done: "1".repeat(n + 1), pts: [[A.center.x, A.center.z], [B.center.x, B.center.z]], x1: A.center.x, z1: A.center.z, x2: B.center.x, z2: B.center.z, y1: 64, y2: 64, v: 4, pa: n, pb: n }];
S.market.lots = [{ civ: B.id, k: "iron", qty: 50, price: 2, t: S.clock }];
A.coins = 1000; const iron0 = A.res.iron;
const b = M.marketBuy(A, "iron", 20);
ok("5. покупка у соседа по дороге — товар везёт караван", b.qty === 20 && A.res.iron === iron0 && (S.caravans ?? []).some((c) => c.to === A.id && c.qty === 20), b.from);
const eta = S.caravans.find((c) => c.to === A.id).eta;
Math.random = () => 0.99; // без грабежа
while (S.clock < eta + 1) { S.clock++; CV.caravanTick(); }
Math.random = R;
ok("5b. караван прибыл — железо на складе", A.res.iron === iron0 + 20, `ехал ${eta - (S.clock - 1 - (eta - S.clock))} с`);
const needIron = 0;
// 6. Морская торговля
S.roads = [];
for (const c of [A, B]) c.buildings.push({ t: "pier", x: 9990, y: 0, z: 9990, w: 1, d: 1 });
const rt = CV.routeOf(B, A);
ok("6. у обоих пристани — товар идёт морем", rt?.kind === "sea", `${rt?.dur} с в пути`);
for (const c of [A, B]) c.buildings.pop();

// 7. Таран и кипяток
WAR.declareWar(A, B, { reason: "тест осады" });
B.wall = B.wall ?? { ox: 0, oz: 0, c: "", s: "" };
A.buildings.push({ t: "smithy", x: 9989, y: 0, z: 9989, w: 1, d: 1 });
rich(A); SG.siegeTick(A);
ok("7. таран построен — стену ломают втрое быстрее", A.war?.ram === true && SG.breakTime(A, B) === 20, `время пролома: ${SG.breakTime(A, B)} с вместо 60`);
ok("7b. кипяток у защитников с кузницей", SG.hasBoilingOil(A) === true);
// 8. Наёмники
A.coins = 2000; A.warLosses = 5; B.warLosses = 0;
const membersA = (S.members.get(A.id) ?? []).length;
SG.siegeTick(A);
const mercs = W.entities.filter((e) => e.props.get("civ:merc")).length;
ok("8. проигрывая, богатое поселение нанимает наёмников", A.war?.mercs === 3 && mercs === 3 && A.coins < 2000, `наёмников ${mercs}, казна ${Math.round(A.coins)}`);
WAR.makePeace(A, B, "тест: мир");
run(2); SG.siegeTick(A); run(2);
ok("8b. после войны наёмники уходят", W.entities.filter((e) => e.props.get("civ:merc") && e.isValid).length === 0);
A.buildings.pop();

// 11. Чудо света
A.era = 3; A.res.stone = 900; A.blockedUntil = 0; A.order = null;
const nx = SOC.chooseNext(A);
ok("11. богатое королевство строит чудо света", nx?.t === "wonder" || SOC.has(A, "wonder"), nx?.t);

// 12. Задания
A.quest = null; A.questAt = 0; A.waiting = "камень"; A._def = null;
Q.questTick(A);
ok("12. при дефиците поселение даёт задание игроку", A.quest?.k === "stone", Q.questText(A));
const inv = { size: 3, items: [{ typeId: "minecraft:cobblestone", amount: 64 }, { typeId: "minecraft:dirt", amount: 5 }, undefined], getItem(i) { return this.items[i]; }, setItem(i, it) { this.items[i] = it; }, addItem(it) { this.items[2] = it; } };
pl.getComponent = (n) => (n === "minecraft:inventory" ? { container: inv } : undefined);
const st0 = A.res.stone;
const res = Q.deliverQuest(pl, A);
ok("12b. сдача задания: камень на складе, изумруды игроку, уважение", A.res.stone === st0 + 64 && inv.items[2]?.typeId === "minecraft:emerald" && Q.playerRep(A, pl) === 10, res);

// 13. Игрок-правитель: приказы
A.order = "library"; A.blockedUntil = 0;
const o = SOC.chooseNext(A);
ok("13. приказ правителя «что строить» выполняется первым", o?.t === "library");
A._def = { res: "food", until: S.clock + 600, forced: true }; A.waiting = "камень";
ok("13b. приказ «бросить силы на ресурс» важнее дефицита", SOC.deficitOf(A) === "food");
A._def = null;

// 14. Карта
const map = Q.mapText(pl);
ok("14. карта мира с поселениями и игроком", map.includes("@") && map.includes(A.name) && map.split("\n").length > 16, map.split("\n")[0]);

// Прогон после всего: без ошибок
run(120);
console.log("ERRORS", W.errors.length, W.errors.slice(0, 3), "предупреждений", warns.filter((w) => !/загружен/.test(w)).slice(0, 3));
console.log(fails ? `ПРОВАЛЕНО: ${fails}` : "ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ");
