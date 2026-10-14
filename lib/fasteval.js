// lib/fasteval.js — table-driven 5-card evaluator for the solver.
//
// lib/poker.js is the readable evaluator used for live scoring and for showing *which*
// cards made a hand. This file trades readability for raw speed, because the solver
// evaluates tens of millions of hands per flop.
//
// Cards are integers 0..51: card = rank * 4 + suit, rank 0..12 = 2..A, suit 0..3 = s h d c.
// Every 5-card combination of the deck (2,598,960 of them) gets a precomputed strength
// in a typed array, indexed by its colexicographic rank — so evaluating a hand is "sort
// five ints, add five table entries, read one array slot". Building the table takes
// roughly half a second and ~10 MB of memory, done once per process / Web Worker.
//
// UMD: require() in Node, or a plain <script> / importScripts() in the browser/worker
// (exposes `FastEval` on the global object).
(function (root, factory) {
  const lib = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
  else root.FastEval = lib;
})(typeof self !== 'undefined' ? self : this, function () {
  const RANK_CHARS = '23456789TJQKA';
  const SUIT_CHARS = 'shdc';

  function toInt(card) {
    return RANK_CHARS.indexOf(card[0]) * 4 + SUIT_CHARS.indexOf(card[1]);
  }
  function toStr(c) {
    return RANK_CHARS[c >> 2] + SUIT_CHARS[c & 3];
  }

  // Binomial coefficients C(n, k) for n < 52, k = 1..5, as flat arrays.
  const C1 = new Int32Array(52), C2 = new Int32Array(52), C3 = new Int32Array(52), C4 = new Int32Array(52), C5 = new Int32Array(52);
  for (let n = 0; n < 52; n++) {
    C1[n] = n;
    C2[n] = (n * (n - 1)) / 2;
    C3[n] = (n * (n - 1) * (n - 2)) / 6;
    C4[n] = (n * (n - 1) * (n - 2) * (n - 3)) / 24;
    C5[n] = (n * (n - 1) * (n - 2) * (n - 3) * (n - 4)) / 120;
  }

  // Direct (slow-ish) evaluation of 5 int cards → a single integer, higher is better.
  // Layout: category << 20 | five 4-bit tiebreak ranks. Only used to build the table.
  const cnt = new Int32Array(13);
  const grp = new Int32Array(5);
  function scoreDirect(a, b, c, d, e) {
    cnt.fill(0);
    cnt[a >> 2]++; cnt[b >> 2]++; cnt[c >> 2]++; cnt[d >> 2]++; cnt[e >> 2]++;
    const s0 = a & 3;
    const flush = (b & 3) === s0 && (c & 3) === s0 && (d & 3) === s0 && (e & 3) === s0;
    // group ranks as count*16 + rank, sorted descending (count first, then rank)
    let ng = 0, mask = 0;
    for (let r = 12; r >= 0; r--) {
      if (!cnt[r]) continue;
      mask |= 1 << r;
      let v = cnt[r] * 16 + r, i = ng++;
      while (i > 0 && grp[i - 1] < v) { grp[i] = grp[i - 1]; i--; }
      grp[i] = v;
    }
    let straightHigh = -1;
    if (ng === 5) {
      for (let hi = 12; hi >= 4; hi--) {
        const m = 0x1f << (hi - 4);
        if ((mask & m) === m) { straightHigh = hi; break; }
      }
      if (straightHigh < 0 && mask === 0x100f) straightHigh = 3; // wheel A-2-3-4-5
    }
    const c0 = grp[0] >> 4, c1 = ng > 1 ? grp[1] >> 4 : 0;
    let cat;
    if (straightHigh >= 0 && flush) cat = 8;
    else if (c0 === 4) cat = 7;
    else if (c0 === 3 && c1 === 2) cat = 6;
    else if (flush) cat = 5;
    else if (straightHigh >= 0) cat = 4;
    else if (c0 === 3) cat = 3;
    else if (c0 === 2 && c1 === 2) cat = 2;
    else if (c0 === 2) cat = 1;
    else cat = 0;
    let tb = 0;
    if (cat === 8 || cat === 4) tb = straightHigh << 16;
    else for (let i = 0, shift = 16; i < ng; i++, shift -= 4) tb |= (grp[i] & 15) << shift;
    return (cat << 20) | tb;
  }

  // Two small tables instead of one per-combination table (which would be 10 MB and
  // cache-miss on almost every lookup):
  //  - FLUSH[rankMask]: the 5 cards share a suit → value depends only on which 5 ranks.
  //  - RANKS_T[multisetIndex]: otherwise → value depends only on the rank multiset.
  //    Sorted ranks r0<=..<=r4 map to strictly increasing r_i + i in 0..16, whose colex
  //    rank (over 17 items) indexes 6,188 slots. Both tables together are ~57 KB.
  const M1 = new Int32Array(17), M2 = new Int32Array(17), M3 = new Int32Array(17), M4 = new Int32Array(17), M5 = new Int32Array(17);
  for (let n = 0; n < 17; n++) {
    M1[n] = C1[n]; M2[n] = C2[n]; M3[n] = C3[n]; M4[n] = C4[n]; M5[n] = C5[n];
  }
  let FLUSH = null, RANKS_T = null;

  function init() {
    if (FLUSH) return;
    FLUSH = new Int32Array(1 << 13);
    RANKS_T = new Int32Array(6188);
    // Suits chosen so that a "non-flush" build never accidentally makes a flush, and a
    // "flush" build always does: flush → all spades; non-flush → first card a heart.
    for (let a = 0; a < 13; a++)
      for (let b = a; b < 13; b++)
        for (let c = b; c < 13; c++)
          for (let d = c; d < 13; d++)
            for (let e = d; e < 13; e++) {
              if (e === a) continue; // 5 of one rank is impossible
              const idx = M1[a] + M2[b + 1] + M3[c + 2] + M4[d + 3] + M5[e + 4];
              // non-flush: give each card a distinct-enough suit (a heart breaks any flush)
              RANKS_T[idx] = scoreDirect(a * 4 + 1, b * 4 + (b === a ? 2 : 0), c * 4 + (c === b ? 3 : 0), d * 4 + (d === c ? (d === b ? 2 : 1) : 0), e * 4 + (e === d ? (e === c ? 3 : 2) : 0));
              if (a < b && b < c && c < d && d < e) {
                FLUSH[(1 << a) | (1 << b) | (1 << c) | (1 << d) | (1 << e)] = scoreDirect(a * 4, b * 4, c * 4, d * 4, e * 4);
              }
            }
  }

  // Evaluate 5 int cards in any order. Higher is better; equal means a tie.
  function eval5(a, b, c, d, e) {
    const s = a & 3;
    let p = a >> 2, q = b >> 2, r = c >> 2, u = d >> 2, v = e >> 2, t;
    if ((b & 3) === s && (c & 3) === s && (d & 3) === s && (e & 3) === s) {
      return FLUSH[(1 << p) | (1 << q) | (1 << r) | (1 << u) | (1 << v)];
    }
    // 5-element sorting network (9 compare-exchanges), ascending
    if (p > q) { t = p; p = q; q = t; }
    if (u > v) { t = u; u = v; v = t; }
    if (r > v) { t = r; r = v; v = t; }
    if (r > u) { t = r; r = u; u = t; }
    if (q > v) { t = q; q = v; v = t; }
    if (p > u) { t = p; p = u; u = t; }
    if (p > r) { t = p; p = r; r = t; }
    if (q > u) { t = q; q = u; u = t; }
    if (q > r) { t = q; q = r; r = t; }
    return RANKS_T[M1[p] + M2[q + 1] + M3[r + 2] + M4[u + 3] + M5[v + 4]];
  }

  // The 10 three-card subsets of a 5-card board, as index triples.
  const TRIPLES = [];
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) for (let k = j + 1; k < 5; k++) TRIPLES.push([i, j, k]);

  // Best PLO value using exactly 2 of `hand` (any length) + exactly 3 of `board` (5 cards).
  function ploBest(hand, board) {
    let best = -1;
    for (let i = 0; i < hand.length; i++)
      for (let j = i + 1; j < hand.length; j++)
        for (let t = 0; t < 10; t++) {
          const tr = TRIPLES[t];
          const v = eval5(hand[i], hand[j], board[tr[0]], board[tr[1]], board[tr[2]]);
          if (v > best) best = v;
        }
    return best;
  }

  // Best value of a hole PAIR on a 5-card board (pair + best 3 board cards).
  // The solver builds "pair tables" from this: a 5-card PLO hand's value is just the
  // max over its 10 pairs, so once every pair that could appear is scored, every keep
  // option for a hand can be valued with a few array reads.
  function pairOnBoard(p, q, board) {
    let best = -1;
    for (let t = 0; t < 10; t++) {
      const tr = TRIPLES[t];
      const v = eval5(p, q, board[tr[0]], board[tr[1]], board[tr[2]]);
      if (v > best) best = v;
    }
    return best;
  }

  // Faster pair-on-board for hot loops: prepBoard() precomputes, for each of the 10
  // board triples, its sorted ranks, its rank mask, and its suit if all three share one
  // (else -1). pairValue() then only has to merge two ranks into three already-sorted
  // ones instead of sorting five cards from scratch.
  function prepBoard(board, out) {
    const ctx = out || new Int32Array(50);
    for (let t = 0; t < 10; t++) {
      const tr = TRIPLES[t];
      const x = board[tr[0]], y = board[tr[1]], z = board[tr[2]];
      let a = x >> 2, b = y >> 2, c = z >> 2, tmp;
      if (a > b) { tmp = a; a = b; b = tmp; }
      if (b > c) { tmp = b; b = c; c = tmp; }
      if (a > b) { tmp = a; a = b; b = tmp; }
      const o = t * 5;
      ctx[o] = a; ctx[o + 1] = b; ctx[o + 2] = c;
      ctx[o + 3] = ((x & 3) === (y & 3) && (y & 3) === (z & 3)) ? (x & 3) : -1;
      ctx[o + 4] = (1 << a) | (1 << b) | (1 << c);
    }
    return ctx;
  }

  function pairValue(ctx, p, q) {
    let rp = p >> 2, rq = q >> 2;
    if (rp > rq) { const t = rp; rp = rq; rq = t; }
    const sp = p & 3;
    const suited = sp === (q & 3);
    const pm = (1 << rp) | (1 << rq);
    let best = -1;
    for (let o = 0; o < 50; o += 5) {
      let v;
      if (suited && ctx[o + 3] === sp) {
        v = FLUSH[pm | ctx[o + 4]];
      } else {
        // insert rp then rq (rq >= rp) into the sorted triple a <= b <= c
        const a = ctx[o], b = ctx[o + 1], c = ctx[o + 2];
        let s0, s1, s2, s3;
        if (rp <= a) { s0 = rp; s1 = a; s2 = b; s3 = c; }
        else if (rp <= b) { s0 = a; s1 = rp; s2 = b; s3 = c; }
        else if (rp <= c) { s0 = a; s1 = b; s2 = rp; s3 = c; }
        else { s0 = a; s1 = b; s2 = c; s3 = rp; }
        let r0, r1, r2, r3, r4;
        if (rq <= s1) { r0 = s0; r1 = rq; r2 = s1; r3 = s2; r4 = s3; }
        else if (rq <= s2) { r0 = s0; r1 = s1; r2 = rq; r3 = s2; r4 = s3; }
        else if (rq <= s3) { r0 = s0; r1 = s1; r2 = s2; r3 = rq; r4 = s3; }
        else { r0 = s0; r1 = s1; r2 = s2; r3 = s3; r4 = rq; }
        v = RANKS_T[M1[r0] + M2[r1 + 1] + M3[r2 + 2] + M4[r3 + 3] + M5[r4 + 4]];
      }
      if (v > best) best = v;
    }
    return best;
  }

  // Whole-board pair tables. For one 5-card board, precompute the best PLO value of
  // EVERY hole-pair by rank: nf[a*13+b] (ignoring flushes) and, for each suit with 3+
  // cards on the board, fl[s*169 + a*13+b] (both hole cards of suit s; -1 otherwise).
  // Building costs ~2k lookups once per board; after that any hole pair on this board
  // is valued with one or two array reads (pairValueTable). The solver's scouting phase
  // reuses a bank of boards across thousands of hands, so this is a large speed-up.
  function insertRank5(rp, rq, a, b, c) {
    // rp <= rq, a <= b <= c → colex index of the merged sorted 5 ranks
    let s0, s1, s2, s3;
    if (rp <= a) { s0 = rp; s1 = a; s2 = b; s3 = c; }
    else if (rp <= b) { s0 = a; s1 = rp; s2 = b; s3 = c; }
    else if (rp <= c) { s0 = a; s1 = b; s2 = rp; s3 = c; }
    else { s0 = a; s1 = b; s2 = c; s3 = rp; }
    let r0, r1, r2, r3, r4;
    if (rq <= s1) { r0 = s0; r1 = rq; r2 = s1; r3 = s2; r4 = s3; }
    else if (rq <= s2) { r0 = s0; r1 = s1; r2 = rq; r3 = s2; r4 = s3; }
    else if (rq <= s3) { r0 = s0; r1 = s1; r2 = s2; r3 = rq; r4 = s3; }
    else { r0 = s0; r1 = s1; r2 = s2; r3 = s3; r4 = rq; }
    return M1[r0] + M2[r1 + 1] + M3[r2 + 2] + M4[r3 + 3] + M5[r4 + 4];
  }
  function boardPairTables(board, nf, nfOff, fl, flOff) {
    const ctx = prepBoard(board);
    for (let a = 0; a < 13; a++) for (let b = a; b < 13; b++) {
      let best = -1;
      for (let o = 0; o < 50; o += 5) {
        const v = RANKS_T[insertRank5(a, b, ctx[o], ctx[o + 1], ctx[o + 2])];
        if (v > best) best = v;
      }
      nf[nfOff + a * 13 + b] = best; nf[nfOff + b * 13 + a] = best;
    }
    const suitCount = [0, 0, 0, 0];
    for (const c of board) suitCount[c & 3]++;
    for (let s = 0; s < 4; s++) {
      const base = flOff + s * 169;
      if (suitCount[s] < 3) { for (let i = 0; i < 169; i++) fl[base + i] = -1; continue; }
      for (let a = 0; a < 13; a++) for (let b = a; b < 13; b++) {
        let best = -1;
        if (a !== b) for (let o = 0; o < 50; o += 5) {
          if (ctx[o + 3] !== s) continue;
          const m = ctx[o + 4];
          if (m & ((1 << a) | (1 << b))) continue;
          const v = FLUSH[m | (1 << a) | (1 << b)];
          if (v > best) best = v;
        }
        fl[base + a * 13 + b] = best; fl[base + b * 13 + a] = best;
      }
    }
  }
  function pairValueTable(nf, nfOff, fl, flOff, p, q) {
    const a = p >> 2, b = q >> 2;
    let v = nf[nfOff + a * 13 + b];
    const s = p & 3;
    if (s === (q & 3)) { const f = fl[flOff + s * 169 + a * 13 + b]; if (f > v) v = f; }
    return v;
  }

  const CATEGORY_NAMES = ['High Card', 'Pair', 'Two Pair', 'Trips', 'Straight', 'Flush', 'Full House', 'Quads', 'Straight Flush'];
  function categoryOf(v) { return CATEGORY_NAMES[v >> 20]; }

  return { init, eval5, ploBest, pairOnBoard, prepBoard, pairValue, boardPairTables, pairValueTable, toInt, toStr, categoryOf, scoreDirect, TRIPLES, RANK_CHARS, SUIT_CHARS };
});
