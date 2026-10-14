// tests/run.js — dependency-free test suite. Run with: node tests/run.js
const assert = require('assert');
const P = require('../lib/poker.js');
const G = require('../lib/game.js');
const F = require('../lib/fasteval.js');
const S = require('../lib/solver.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n    ')); }
}
const cards = (s) => s.split(' ');

console.log('Hand evaluation');
test('fast evaluator agrees with the readable one on 200k random pairs of hands', () => {
  F.init();
  const deck = P.freshDeck();
  for (let i = 0; i < 200000; i++) {
    const d = P.shuffle(deck);
    const a = d.slice(0, 5), b = d.slice(5, 10);
    const s1 = Math.sign(P.compareScores(P.evaluate5(a), P.evaluate5(b)));
    const s2 = Math.sign(F.eval5(...a.map(F.toInt)) - F.eval5(...b.map(F.toInt)));
    assert.strictEqual(s1, s2, `${a} vs ${b}`);
  }
});
test('fast PLO agrees with readable PLO on 20k random boards', () => {
  const deck = P.freshDeck();
  for (let i = 0; i < 20000; i++) {
    const d = P.shuffle(deck);
    const h1 = d.slice(0, 5), h2 = d.slice(5, 10), bd = d.slice(10, 15);
    const s1 = Math.sign(P.compareScores(P.bestPLO(h1, bd).score, P.bestPLO(h2, bd).score));
    const s2 = Math.sign(F.ploBest(h1.map(F.toInt), bd.map(F.toInt)) - F.ploBest(h2.map(F.toInt), bd.map(F.toInt)));
    assert.strictEqual(s1, s2);
  }
});
test('pairValue (prepared board) matches pairOnBoard', () => {
  const deck = P.freshDeck();
  const ctx = new Int32Array(50);
  for (let i = 0; i < 20000; i++) {
    const d = P.shuffle(deck).map(F.toInt);
    F.prepBoard(d.slice(2, 7), ctx);
    assert.strictEqual(F.pairValue(ctx, d[0], d[1]), F.pairOnBoard(d[0], d[1], d.slice(2, 7)));
  }
});
test('wheel straight is a straight, and loses to a 6-high straight', () => {
  const wheel = F.eval5(...cards('As 2d 3c 4h 5s').map(F.toInt));
  const six = F.eval5(...cards('2d 3c 4h 5s 6d').map(F.toInt));
  assert.strictEqual(F.categoryOf(wheel), 'Straight');
  assert.ok(six > wheel);
});
test('PLO must use exactly two hole cards (four-flush in hand + one on board is not a flush)', () => {
  const r = P.bestPLO(cards('Ah Kh Qh Jh 2c'), cards('Th 7s 7d 3c 4s'));
  assert.notStrictEqual(P.categoryName(r.score), 'Flush');
});

console.log('Rules');
test('keep validation: 2–5 cards from your own hand', () => {
  const hand = cards('As Ks Qs Js Ts 9s 8s 7s 6s');
  assert.ok(G.validateKeep(hand, cards('As')));
  assert.ok(G.validateKeep(hand, cards('As Ks Qs Js Ts 9s')));
  assert.ok(G.validateKeep(hand, cards('As 2c')));
  assert.ok(G.validateKeep(hand, cards('As As')));
  assert.strictEqual(G.validateKeep(hand, cards('As Ks')), null);
  assert.strictEqual(G.validateKeep(hand, cards('As Ks Qs Js Ts')), null);
});
test('draw and discard counts', () => {
  assert.deepStrictEqual([5, 4, 3, 2].map((k) => G.drawCount(k)), [0, 1, 2, 3]);
  assert.deepStrictEqual([5, 4, 3, 2].map((k) => G.discardCount(k)), [4, 5, 6, 7]);
});
test('dealing: 9 + 9 + two 3-card flops, all distinct, 28 left for draws and turns/rivers', () => {
  const { deck, flopA, flopB, hands } = G.dealHand(['a', 'b']);
  const all = [...deck, ...flopA, ...flopB, ...hands.a, ...hands.b];
  assert.strictEqual(new Set(all).size, 52);
  assert.strictEqual(hands.a.length, 9);
  assert.strictEqual(deck.length, 28);
});
test('scoring: net units = contests won − contests lost, ×2 on a scoop (10k random hands)', () => {
  for (let i = 0; i < 10000; i++) {
    const { deck, flopA, flopB, hands } = G.dealHand(['x', 'y']);
    const bA = [...flopA, ...deck.splice(0, 2)], bB = [...flopB, ...deck.splice(0, 2)];
    const r = G.scoreShowdown('x', hands.x.slice(0, 5), 'y', hands.y.slice(0, 5), bA, bB);
    const raw = r.contests.reduce((s, c) => s + (c.winner === 'x' ? 1 : c.winner === 'y' ? -1 : 0), 0);
    if (r.scoop) assert.strictEqual(r.units.x, raw * 2); else { assert.strictEqual(r.units.x, raw); assert.ok(Math.abs(raw) < 3); }
    assert.strictEqual(r.units.x, -r.units.y);
  }
});
test('scoring: sweeping all three contests scoops for double (6 units)', () => {
  const bA = cards('2c 7d 9h Jd 4s'), bB = cards('3s 8d 8c Kh 4c');
  const r = G.scoreShowdown('x', cards('As Ac Ah Kd Ks'), 'y', cards('2d 3d 5h 6c Tc'), bA, bB);
  assert.strictEqual(r.scoop, 'x');
  assert.strictEqual(r.units.x, 6);
  assert.strictEqual(r.units.y, -6);
});
test('scoring: a pushed contest blocks the scoop', () => {
  // Both players play the same 5-card straight-flush-free hands? Use identical ranks.
  const bA = cards('2c 7d 9h Jd 4s'), bB = cards('3s 8d 8c Kh 4c');
  const r = G.scoreShowdown('x', cards('As Kc Qh Jc 9c'), 'y', cards('Ad Kd Qd Js 9s'), bA, bB);
  assert.strictEqual(r.contests[0].winner, null); // identical 5-card hands push
  assert.strictEqual(r.scoop, null);
  assert.ok(Math.abs(r.units.x) <= 2);
});

test('7, 8 and 10-card deals: keep 2–5, discard counts follow the hand size', () => {
  for (const H of [7, 8, 10]) {
    const { deck, hands } = G.dealHand(['a', 'b'], H);
    assert.strictEqual(hands.a.length, H);
    assert.strictEqual(deck.length, 52 - 6 - 2 * H);
    assert.strictEqual(G.validateKeep(hands.a, hands.a.slice(0, 5)), null);
    assert.ok(G.validateKeep(hands.a, hands.a.slice(0, 6)));
    assert.strictEqual(G.discardCount(5, H), H - 5);
    assert.strictEqual(G.discardCount(2, H), H - 2);
  }
});

console.log('Solver');
test('keep counts per hand size: 112 / 210 / 372 / 627', () => {
  assert.deepStrictEqual([7, 8, 9, 10].map((h) => S.layout(h).NKEEPS), [112, 210, 372, 627]);
});
test('a 7-card and a 10-card solve both run and return valid strategies', () => {
  for (const H of [7, 10]) {
    const d = P.shuffle(P.freshDeck());
    const res = S.runAll({
      flopA: d.slice(0, 3), flopB: d.slice(3, 6),
      observers: [{ id: 'me', seat: 'ip', cards: d.slice(6, 6 + H) }],
      overrides: { M: 60, B: 8, R: 48, Q: 4, tA1: 4, tA2: 10, tC1: 4, tC2: 10, k2: 3, pairs: 8, obs: 300, iterations: 200, rounds: 1, alphas: [0.6] }
    });
    const o = res.observers[0];
    assert.strictEqual(o.ev.length, 4 * S.layout(H).NKEEPS);
    for (let dd = 0; dd < 4; dd++) {
      const f = o.freq.slice(dd * S.layout(H).NKEEPS, (dd + 1) * S.layout(H).NKEEPS).reduce((x, y) => x + y, 0);
      assert.ok(Math.abs(f - 1) < 1e-6);
    }
    assert.strictEqual(S.keepCards(d.slice(6, 6 + H), 0).length, 5);
  }
});
test('372 keep options: 126 pat, 126 draw-1, 84 draw-2, 36 draw-3', () => {
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < S.NKEEPS; i++) counts[S.KEEP_DRAW[i]]++;
  assert.deepStrictEqual(counts, [126, 126, 84, 36]);
});
test('a tiny solve runs, returns valid mixed strategies, and finds the obvious keep', () => {
  // OOP holds a royal flush on two low flops. Patting it is clearly best (a full solve
  // has it ~0.45 stakes ahead of anything else); a small, noisy solve should still rank
  // it near the top.
  const res = S.runAll({
    flopA: cards('2c 7d 3h'), flopB: cards('4c 8d 2h'),
    observers: [{ id: 'me', seat: 'oop', cards: cards('As Ks Qs Js Ts 5d 6h 9c 9d') }],
    overrides: { M: 150, B: 12, R: 96, Q: 6, tA1: 8, tA2: 30, tC1: 8, tC2: 30, k2: 4, pairs: 16, obs: 1500, iterations: 400, rounds: 1, alphas: [0.6] }
  });
  const o = res.observers[0];
  const sumF = o.freq.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sumF - 1) < 1e-6, 'observer freq sums to 1');
  const d = res.summary.oopDraw.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(d - 1) < 1e-6, 'OOP draw mix sums to 1');
  const order = [...o.ev.keys()].sort((a, b) => o.ev[b] - o.ev[a]);
  const hand = cards('As Ks Qs Js Ts 5d 6h 9c 9d');
  const royal = order.findIndex((ki) => S.KEEP_DRAW[ki] === 0 && ['As', 'Ks', 'Qs', 'Js', 'Ts'].every((c) => S.keepCards(hand, ki).includes(c)));
  assert.ok(royal < 3, 'royal pat ranked #' + (royal + 1));
});

test('fast pair tables agree with the direct pair evaluator', () => {
  const nf = new Int32Array(169), fl = new Int32Array(676);
  for (let i = 0; i < 2000; i++) {
    const d = P.shuffle(P.freshDeck()).map(F.toInt);
    F.boardPairTables(d.slice(0, 5), nf, 0, fl, 0);
    for (let t = 0; t < 10; t++) assert.strictEqual(F.pairValueTable(nf, 0, fl, 0, d[5 + 2 * t], d[6 + 2 * t]), F.pairOnBoard(d[5 + 2 * t], d[6 + 2 * t], d.slice(0, 5)));
  }
});
test('group game: solved strategies are valid distributions', () => {
  const B = 3, sum = new Float64Array(B * 16 * B), cnt = new Float64Array(B * 16 * B).fill(1);
  for (let i = 0; i < sum.length; i++) sum[i] = Math.sin(i) * 2;
  const r = S.solveGroups({ sum, cnt, B, pO: Float64Array.from([0.5, 0.3, 0.2]), pI: Float64Array.from([0.2, 0.3, 0.5]), iterations: 500 });
  for (let b = 0; b < B; b++) assert.ok(Math.abs(r.sigO.slice(b * 4, b * 4 + 4).reduce((x, y) => x + y, 0) - 1) < 1e-9);
  assert.ok(r.summary.exploitability < 0.05, 'exploitability ' + r.summary.exploitability);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
