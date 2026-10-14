// lib/solver.js — approximate equilibrium solver for Drawmaha Duel's draw decision.
//
// THE GAME BEING SOLVED
// Once the two flops are face up, the rest of a hand is a small two-player game with
// hidden information: OOP picks which 2–5 of their dealt cards (normally 9; the game
// also supports 7, 8 and 10) to keep; the number of cards they draw (0–3) is public;
// IP sees that number and picks their own keep; then the turns and rivers fall and
// three 1-unit contests are settled (scoop = double). There is no betting, so all of
// the strategy lives in those two keep decisions — and in what OOP's draw count reveals.
//
// HOW IT IS APPROXIMATED — hand grouping (abstraction)
// Each player could hold any of ~a billion hands (9-card game), so the solver works on
// a large random sample of each seat's range (thousands of hands) and groups hands that
// play alike, the way serious poker solvers handle huge ranges:
//
//   1. Population. Sample M hands per seat from the cards not on the flops. Neither real
//      hand is in it, so everything solved here uses only public information.
//   2. Keep scouting (rounds A, B). For every population hand, score every keep by Monte
//      Carlo against a crude field, then against the field's round-A choices, and record
//      the hand's best keep *for each draw count* and what that draw count is worth.
//   3. Grouping. Cluster hands by that "EV at pat / draw 1 / draw 2 / draw 3" profile
//      (k-means into B groups per seat). Hands in a group want the same things, so they
//      share one strategy — and each group's numbers are averaged over many hands, which
//      is what makes the result stable from one solve to the next.
//   4. Group game. Estimate group-vs-group payoffs for every (OOP draw count, IP draw
//      count) by sampling hand pairs and runouts, then solve it with CFR+: OOP's group
//      chooses a draw count; IP's group sees it and chooses its own. The game is tiny,
//      so it is solved essentially exactly (thousands of iterations).
//   5. Refinement (round C). With the group strategies known, every hand re-picks its
//      keeps: OOP against IP's actual responses, IP separately for each announcement
//      against the OOP hands that would make it. Then regroup and re-solve.
//   6. Your hand and the bot's. Each real hand is scored with every keep against
//      thousands of opponent hands drawn from the solved range (posterior given the
//      announcement, for IP), with paired samples so differences between keeps carry
//      error bars. Neither real hand ever feeds into the population, so the bot never
//      sees your cards (and the study panel never sees the bot's).
//
// Approximations: opponents' discards aren't removed from the deck (only cards that
// would be *kept* by both sides are kept disjoint); groups are chosen by EV profile, not
// exact holdings; Monte Carlo noise is reported as ± error bars.
//
// Units: payoffs are in contest units (win a contest = +1, scoop = ±6). Multiply by the
// stake to get dollars.
//
// Every phase is a pure function over plain typed arrays so the browser can spread the
// expensive ones across Web Workers (public/solver-pool.js); runAll() chains them in Node.
(function (root, factory) {
  const F = (typeof module !== 'undefined' && module.exports) ? require('./fasteval.js') : root.FastEval;
  const lib = factory(F);
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
  else root.Solver = lib;
})(typeof self !== 'undefined' ? self : this, function (F) {
  F.init();


  // ---------------------------------------------------------------------------
  // Keep enumeration, per hand size H (7–10). Local card slots 0..H-1 are the dealt
  // cards; H..H+2 are the first three cards that player would draw in a scenario ("the
  // draw stream"). A keep is 2–5 dealt cards (draw 3..0), whatever H is.
  // ---------------------------------------------------------------------------
  const MAX_LOCAL = 13, MAX_PAIRS = 78, MAX_KEEPS = 627; // H = 10
  const layouts = {};
  function layout(H) {
    if (layouts[H]) return layouts[H];
    const NLOCAL = H + 3;
    const PAIR_ID = new Int8Array(NLOCAL * NLOCAL).fill(-1);
    const PAIR_I = [], PAIR_J = [];
    for (let i = 0; i < NLOCAL; i++) for (let j = i + 1; j < NLOCAL; j++) {
      PAIR_ID[i * NLOCAL + j] = PAIR_I.length; PAIR_I.push(i); PAIR_J.push(j);
    }
    const NPAIRS = PAIR_I.length;
    const KEEPS = []; // { slots: [kept local slots], draw }
    for (let draw = 0; draw <= 3; draw++) {
      const k = 5 - draw;
      const rec = (start, acc) => {
        if (acc.length === k) { KEEPS.push({ slots: acc.slice(), draw }); return; }
        for (let i = start; i < H; i++) { acc.push(i); rec(i + 1, acc); acc.pop(); }
      };
      rec(0, []);
    }
    const NKEEPS = KEEPS.length; // 112 / 210 / 372 / 627 for H = 7 / 8 / 9 / 10
    const KEEP_DRAW = new Int8Array(NKEEPS);
    const KEEP_MASK = new Int32Array(NKEEPS);
    const KEEP_FINAL = new Int8Array(NKEEPS * 5);
    const KEEP_PAIRS = new Int8Array(NKEEPS * 10);
    KEEPS.forEach((kp, ki) => {
      KEEP_DRAW[ki] = kp.draw;
      const fin = kp.slots.slice();
      for (let s = 0; s < kp.draw; s++) fin.push(H + s);
      fin.forEach((slot, n) => { KEEP_FINAL[ki * 5 + n] = slot; });
      kp.slots.forEach((slot) => { KEEP_MASK[ki] |= 1 << slot; });
      let p = 0;
      for (let x = 0; x < 5; x++) for (let y = x + 1; y < 5; y++) {
        const a = Math.min(fin[x], fin[y]), b = Math.max(fin[x], fin[y]);
        KEEP_PAIRS[ki * 10 + p++] = PAIR_ID[a * NLOCAL + b];
      }
    });
    return (layouts[H] = {
      H, NLOCAL, PAIR_I, PAIR_J, NPAIRS, KEEPS, NKEEPS, KEEP_DRAW, KEEP_MASK, KEEP_FINAL, KEEP_PAIRS,
      ALL_KEEPS: Int16Array.from({ length: NKEEPS }, (_, i) => i),
      ALL_PAIRS: Int8Array.from({ length: NPAIRS }, (_, i) => i)
    });
  }

  function pairsNeeded(L, keepList) {
    const need = new Uint8Array(L.NPAIRS);
    for (const ki of keepList) for (let p = 0; p < 10; p++) need[L.KEEP_PAIRS[ki * 10 + p]] = 1;
    const out = [];
    for (let i = 0; i < L.NPAIRS; i++) if (need[i]) out.push(i);
    return Int8Array.from(out);
  }

  // Bitmask (two 32-bit halves) of the real cards a keep holds, for card-conflict checks.
  function keepMask(L, cards, ki) {
    let lo = 0, hi = 0;
    const m = L.KEEP_MASK[ki];
    for (let s = 0; s < L.H; s++) if (m & (1 << s)) {
      const c = cards[s];
      if (c < 32) lo |= 1 << c; else hi |= 1 << (c - 32);
    }
    return [lo, hi];
  }
  function cardsMask(cards) {
    let lo = 0, hi = 0;
    for (const c of cards) { if (c < 32) lo |= 1 << c; else hi |= 1 << (c - 32); }
    return [lo, hi];
  }

  // ---------------------------------------------------------------------------
  // Scenario machinery
  // ---------------------------------------------------------------------------
  function makeContext(flopA, flopB, H = 9) {
    const used = new Uint8Array(52);
    for (const c of flopA) used[c] = 1;
    for (const c of flopB) used[c] = 1;
    const base = [];
    for (let c = 0; c < 52; c++) if (!used[c]) base.push(c);
    return { H, L: layout(H), flopA: Int32Array.from(flopA), flopB: Int32Array.from(flopB), base: Int32Array.from(base) };
  }

  // Scratch space reused by every scenario evaluation (single-threaded per worker).
  function makeScratch() {
    return {
      used: new Uint8Array(52),
      deal: new Int32Array(10),
      boardA: new Int32Array(5), boardB: new Int32Array(5),
      ctxA: new Int32Array(50), ctxB: new Int32Array(50),
      locX: new Int32Array(MAX_LOCAL), locY: new Int32Array(MAX_LOCAL),
      pvA: new Int32Array(MAX_PAIRS), pvB: new Int32Array(MAX_PAIRS),
      x5: new Int32Array(MAX_KEEPS), xA: new Int32Array(MAX_KEEPS), xB: new Int32Array(MAX_KEEPS),
      y5: new Int32Array(MAX_KEEPS), yA: new Int32Array(MAX_KEEPS), yB: new Int32Array(MAX_KEEPS)
    };
  }

  // Deal 10 fresh cards (turn A, river A, turn B, river B, 3 draws for X, 3 for Y) from
  // the deck minus the flops and minus both dealt hands.
  function dealScenario(ctx, sc, handX, handY) {
    const used = sc.used, base = ctx.base, nb = base.length, H = ctx.H;
    for (let i = 0; i < H; i++) { used[handX[i]] = 1; used[handY[i]] = 1; }
    for (let k = 0; k < 10; k++) {
      let c;
      do { c = base[(Math.random() * nb) | 0]; } while (used[c]);
      used[c] = 1;
      sc.deal[k] = c;
    }
    for (let i = 0; i < H; i++) { used[handX[i]] = 0; used[handY[i]] = 0; }
    for (let k = 0; k < 10; k++) used[sc.deal[k]] = 0;
    const d = sc.deal;
    sc.boardA[0] = ctx.flopA[0]; sc.boardA[1] = ctx.flopA[1]; sc.boardA[2] = ctx.flopA[2]; sc.boardA[3] = d[0]; sc.boardA[4] = d[1];
    sc.boardB[0] = ctx.flopB[0]; sc.boardB[1] = ctx.flopB[1]; sc.boardB[2] = ctx.flopB[2]; sc.boardB[3] = d[2]; sc.boardB[4] = d[3];
    F.prepBoard(sc.boardA, sc.ctxA);
    F.prepBoard(sc.boardB, sc.ctxB);
    for (let i = 0; i < H; i++) { sc.locX[i] = handX[i]; sc.locY[i] = handY[i]; }
    sc.locX[H] = d[4]; sc.locX[H + 1] = d[5]; sc.locX[H + 2] = d[6];
    sc.locY[H] = d[7]; sc.locY[H + 1] = d[8]; sc.locY[H + 2] = d[9];
  }

  // Value a list of keeps for one player in the current scenario.
  // Writes 5-card / board-A PLO / board-B PLO strengths into o5/oA/oB at the keep index.
  function evalKeeps(L, sc, loc, keepList, pairList, o5, oA, oB) {
    const pvA = sc.pvA, pvB = sc.pvB, PI = L.PAIR_I, PJ = L.PAIR_J, KF = L.KEEP_FINAL, KP = L.KEEP_PAIRS;
    for (let n = 0; n < pairList.length; n++) {
      const pid = pairList[n];
      const p = loc[PI[pid]], q = loc[PJ[pid]];
      pvA[pid] = F.pairValue(sc.ctxA, p, q);
      pvB[pid] = F.pairValue(sc.ctxB, p, q);
    }
    for (let n = 0; n < keepList.length; n++) {
      const ki = keepList[n];
      const f = ki * 5;
      o5[ki] = F.eval5(loc[KF[f]], loc[KF[f + 1]], loc[KF[f + 2]], loc[KF[f + 3]], loc[KF[f + 4]]);
      let a = -1, b = -1;
      const pp = ki * 10;
      for (let t = 0; t < 10; t++) {
        const pid = KP[pp + t];
        if (pvA[pid] > a) a = pvA[pid];
        if (pvB[pid] > b) b = pvB[pid];
      }
      oA[ki] = a; oB[ki] = b;
    }
  }

  // Payoff to X for one scenario: 3 contests of ±1, scoop doubles to ±6.
  function payoff(x5, xA, xB, y5, yA, yB) {
    const s = (x5 > y5 ? 1 : x5 < y5 ? -1 : 0) + (xA > yA ? 1 : xA < yA ? -1 : 0) + (xB > yB ? 1 : xB < yB ? -1 : 0);
    return s === 3 ? 6 : s === -3 ? -6 : s;
  }

  // ---------------------------------------------------------------------------
  // Phase 0: population
  // ---------------------------------------------------------------------------
  function samplePopulation(ctx, n) {
    const H = ctx.H;
    const out = new Int32Array(n * H);
    const base = Array.from(ctx.base);
    for (let h = 0; h < n; h++) {
      for (let i = 0; i < H; i++) {
        const j = i + ((Math.random() * (base.length - i)) | 0);
        const t = base[i]; base[i] = base[j]; base[j] = t;
        out[h * H + i] = base[i];
      }
    }
    return out;
  }
  const handAt = (ctx, pop, h) => pop.subarray(h * ctx.H, h * ctx.H + ctx.H);


  // Draw counts 0..3 → list of keep indices with that draw, per layout (cached).
  const keepsByDrawCache = {};
  function keepsByDraw(L) {
    if (keepsByDrawCache[L.H]) return keepsByDrawCache[L.H];
    const out = [[], [], [], []];
    for (let k = 0; k < L.NKEEPS; k++) out[L.KEEP_DRAW[k]].push(k);
    const lists = out.map((a) => Int16Array.from(a));
    const pairs = lists.map((l) => pairsNeeded(L, l));
    return (keepsByDrawCache[L.H] = { lists, pairs });
  }

  // ---------------------------------------------------------------------------
  // Fast keep scouting with a board bank.
  //
  // Picking each population hand's best keep per draw count needs ~100+ runouts per
  // hand to be reliable (with ~10, a hand gives up 0.4–0.8 stakes per decision — enough
  // to bias the whole solve). To afford that for thousands of hands:
  //   - a bank of R turn/river pairs is dealt once, with whole-board pair tables, so a
  //     hole pair's PLO value on a bank board is one or two array reads;
  //   - for each bank board, Q opponent outcomes (final 5-card / PLO A / PLO B
  //     strengths) are pre-dealt from the opposing field, so one runout of my hand is
  //     compared against Q opponents at once;
  //   - every keep is raced: T1 runouts for all keeps, then T2 fresh runouts for the
  //     best K2 per draw count, whose pass-2 averages are what get reported.
  // Scouting ignores card clashes between my hand and the pre-dealt opponents (it only
  // ranks my own keeps); the group payoffs and the real-hand evaluations deal exactly.
  // ---------------------------------------------------------------------------
  function buildBank(ctx, R) {
    const base = ctx.base, nb = base.length;
    const cards = new Int32Array(R * 4), mlo = new Int32Array(R), mhi = new Int32Array(R);
    const nf = new Int32Array(R * 2 * 169), fl = new Int32Array(R * 2 * 676);
    const bA = new Int32Array(5), bB = new Int32Array(5);
    for (let r = 0; r < R; r++) {
      const pick = [];
      while (pick.length < 4) { const c = base[(Math.random() * nb) | 0]; if (!pick.includes(c)) pick.push(c); }
      for (let i = 0; i < 4; i++) cards[r * 4 + i] = pick[i];
      const [lo, hi] = cardsMask(pick); mlo[r] = lo; mhi[r] = hi;
      bA.set(ctx.flopA, 0); bA[3] = pick[0]; bA[4] = pick[1];
      bB.set(ctx.flopB, 0); bB[3] = pick[2]; bB[4] = pick[3];
      F.boardPairTables(bA, nf, (r * 2) * 169, fl, (r * 2) * 676);
      F.boardPairTables(bB, nf, (r * 2 + 1) * 169, fl, (r * 2 + 1) * 676);
    }
    return { R, cards, mlo, mhi, nf, fl };
  }
  const pvBank = (bank, r, which, p, q) => F.pairValueTable(bank.nf, (r * 2 + which) * 169, bank.fl, (r * 2 + which) * 676, p, q);

  // Values (5-card, PLO A, PLO B) of `keep` for `loc` (H dealt + 3 draw-stream cards).
  function keepValuesBank(L, bank, r, loc, k, out) {
    const f = k * 5;
    out[0] = F.eval5(loc[L.KEEP_FINAL[f]], loc[L.KEEP_FINAL[f + 1]], loc[L.KEEP_FINAL[f + 2]], loc[L.KEEP_FINAL[f + 3]], loc[L.KEEP_FINAL[f + 4]]);
    let a = -1, b = -1;
    for (let t = 0; t < 10; t++) {
      const pid = L.KEEP_PAIRS[k * 10 + t], p = loc[L.PAIR_I[pid]], q = loc[L.PAIR_J[pid]];
      const va = pvBank(bank, r, 0, p, q), vb = pvBank(bank, r, 1, p, q);
      if (va > a) a = va;
      if (vb > b) b = vb;
    }
    out[1] = a; out[2] = b;
  }

  // Deal `hand`'s 3-card draw stream for bank board r into loc[H..H+2].
  function dealStream(ctx, bank, r, hand, loc, used) {
    const H = ctx.H, base = ctx.base, nb = base.length;
    for (let i = 0; i < H; i++) { used[hand[i]] = 1; loc[i] = hand[i]; }
    for (let i = 0; i < 4; i++) used[bank.cards[r * 4 + i]] = 1;
    for (let k = 0; k < 3; k++) {
      let c;
      do { c = base[(Math.random() * nb) | 0]; } while (used[c]);
      used[c] = 1; loc[H + k] = c;
    }
    for (let i = 0; i < H; i++) used[hand[i]] = 0;
    for (let i = 0; i < 4; i++) used[bank.cards[r * 4 + i]] = 0;
    for (let k = 0; k < 3; k++) used[loc[H + k]] = 0;
  }
  function boardClashes(bank, r, lo, hi) { return (bank.mlo[r] & lo) || (bank.mhi[r] & hi); }

  // Opponent fields. spec.mode:
  //   'A'      one field: random opponent hands keeping their strongest made 5 cards
  //   'B'      one field: opponents playing spec.oppBest[j]
  //   'C-OOP'  4 fields (one per OOP draw count d): IP hands answering d with their
  //            group's mix (spec.keepI / groupI / sigI)
  //   'C-IP'   4 fields (one per announcement dO): OOP hands from the posterior given dO
  //            playing their keep for dO (spec.keepO / cw)
  function buildFields(ctx, bank, spec, Q) {
    const L = ctx.L, H = ctx.H, R = bank.R, nOpp = spec.oppPop.length / H;
    const nF = spec.mode === 'A' || spec.mode === 'B' ? 1 : 4;
    const out = new Int32Array(nF * R * Q * 3);
    const used = new Uint8Array(52), loc = new Int32Array(H + 3), v = new Int32Array(3);
    const madeCache = new Int16Array(nOpp).fill(-1);
    const patList = keepsByDraw(L).lists[0];
    const madeKeep = (j, hand) => {
      if (madeCache[j] >= 0) return madeCache[j];
      let best = patList[0], bv = -1;
      for (const k of patList) {
        const f = k * 5;
        const x = F.eval5(hand[L.KEEP_FINAL[f]], hand[L.KEEP_FINAL[f + 1]], hand[L.KEEP_FINAL[f + 2]], hand[L.KEEP_FINAL[f + 3]], hand[L.KEEP_FINAL[f + 4]]);
        if (x > bv) { bv = x; best = k; }
      }
      return (madeCache[j] = best);
    };
    for (let f = 0; f < nF; f++) for (let r = 0; r < R; r++) for (let q = 0; q < Q; q++) {
      let j, k, hand, tries = 0;
      do {
        if (spec.mode === 'C-IP') j = samplePosterior(spec.cw, nOpp, f);
        else j = (Math.random() * nOpp) | 0;
        hand = handAt(ctx, spec.oppPop, j);
        const [lo, hi] = cardsMask(hand);
        if (!boardClashes(bank, r, lo, hi)) break;
      } while (++tries < 100);
      if (spec.mode === 'A') k = madeKeep(j, hand);
      else if (spec.mode === 'B') k = spec.oppBest[j];
      else if (spec.mode === 'C-OOP') k = spec.keepI[j * 16 + f * 4 + sampleDist(spec.sigI, (spec.groupI[j] * 4 + f) * 4)];
      else k = spec.keepO[j * 4 + f];
      dealStream(ctx, bank, r, hand, loc, used);
      keepValuesBank(L, bank, r, loc, k, v);
      const o = ((f * R + r) * Q + q) * 3;
      out[o] = v[0]; out[o + 1] = v[1]; out[o + 2] = v[2];
    }
    return { data: out, nF, Q };
  }

  // Race every keep of one hand. Returns avg payoff per (block, keep) from pass 2
  // (NaN for keeps that didn't survive pass 1). Blocks: 'A'/'B' → 1 block vs the one
  // field; 'C-OOP' → 1 block, each keep vs the field for its own draw count;
  // 'C-IP' → 4 blocks, every keep vs each announcement's field.
  function raceHand(ctx, bank, fields, mode, hand, P, scratch) {
    const L = ctx.L, NK = L.NKEEPS, R = bank.R, Q = fields.Q, data = fields.data;
    const nBlocks = mode === 'C-IP' ? 4 : 1;
    const { used, loc } = scratch;
    const [hlo, hhi] = cardsMask(hand);
    const pickBoard = () => {
      for (let t = 0; t < 100; t++) { const r = (Math.random() * R) | 0; if (!boardClashes(bank, r, hlo, hhi)) return r; }
      return (Math.random() * R) | 0;
    };
    const pvA = scratch.pvA, pvB = scratch.pvB, KF = L.KEEP_FINAL, KP = L.KEEP_PAIRS;
    // Pass 1 only has to find the contenders, so it compares against fewer of the
    // pre-dealt opponents per board; pass 2 (the reported numbers) uses all Q.
    const runPass = (list, pairList, trials, Qn) => {
      const sums = new Float64Array(nBlocks * NK);
      for (let t = 0; t < trials; t++) {
        const r = pickBoard();
        dealStream(ctx, bank, r, hand, loc, used);
        // Every hole pair this pass needs, valued once per runout.
        for (let n = 0; n < pairList.length; n++) {
          const pid = pairList[n], p = loc[L.PAIR_I[pid]], q = loc[L.PAIR_J[pid]];
          pvA[pid] = pvBank(bank, r, 0, p, q); pvB[pid] = pvBank(bank, r, 1, p, q);
        }
        for (let n = 0; n < list.length; n++) {
          const k = list[n], f = k * 5;
          const x5 = F.eval5(loc[KF[f]], loc[KF[f + 1]], loc[KF[f + 2]], loc[KF[f + 3]], loc[KF[f + 4]]);
          let xA = -1, xB = -1;
          for (let i = k * 10, e = i + 10; i < e; i++) { const pid = KP[i]; if (pvA[pid] > xA) xA = pvA[pid]; if (pvB[pid] > xB) xB = pvB[pid]; }
          for (let blk = 0; blk < nBlocks; blk++) {
            const f = mode === 'C-OOP' ? L.KEEP_DRAW[k] : mode === 'C-IP' ? blk : 0;
            let o = ((f * R + r) * Q) * 3, acc = 0;
            for (let q = 0; q < Qn; q++, o += 3) acc += payoff(x5, xA, xB, data[o], data[o + 1], data[o + 2]);
            sums[blk * NK + k] += acc / Qn;
          }
        }
      }
      for (let i = 0; i < sums.length; i++) sums[i] /= trials;
      return sums;
    };
    const first = runPass(L.ALL_KEEPS, L.ALL_PAIRS, P.t1, Math.min(Q, 4));
    // Survivors: best K2 per draw count in every block.
    const keep = new Uint8Array(NK);
    const byDraw = keepsByDraw(L).lists;
    for (let blk = 0; blk < nBlocks; blk++) for (let d = 0; d < 4; d++) {
      const ids = Array.from(byDraw[d]).sort((x, y) => first[blk * NK + y] - first[blk * NK + x]);
      for (let n = 0; n < Math.min(P.k2, ids.length); n++) keep[ids[n]] = 1;
    }
    const survivors = [];
    for (let k = 0; k < NK; k++) if (keep[k]) survivors.push(k);
    const surv = Int16Array.from(survivors);
    const second = runPass(surv, pairsNeeded(L, surv), P.t2, Q);
    const outAvg = new Float64Array(nBlocks * NK).fill(NaN);
    for (const k of survivors) for (let blk = 0; blk < nBlocks; blk++) outAvg[blk * NK + k] = second[blk * NK + k];
    return outAvg;
  }

  // Scout hands [from, to) of `pop` against `spec`'s field (see buildFields).
  // Returns per hand: best keep and its EV for each draw count (×4), or for 'C-IP' for
  // each (announcement, draw count) (×16); plus the overall best keep (modes A/B).
  function scoutRange(ctx, pop, from, to, spec, P) {
    const L = ctx.L, NK = L.NKEEPS;
    const bank = buildBank(ctx, P.R);
    const fields = buildFields(ctx, bank, spec, P.Q);
    const per = spec.mode === 'C-IP' ? 16 : 4;
    const keeps = new Int16Array((to - from) * per), evs = new Float32Array((to - from) * per), best = new Int16Array(to - from);
    const scratch = { used: new Uint8Array(52), loc: new Int32Array(ctx.H + 3), pvA: new Int32Array(MAX_PAIRS), pvB: new Int32Array(MAX_PAIRS) };
    const rp = spec.mode === 'A' ? { t1: P.tA1, t2: P.tA2, k2: P.k2 } : spec.mode === 'B' ? { t1: P.tB1, t2: P.tB2, k2: P.k2 } : { t1: P.tC1, t2: P.tC2, k2: P.k2 };
    for (let h = from; h < to; h++) {
      const avg = raceHand(ctx, bank, fields, spec.mode, handAt(ctx, pop, h), rp, scratch);
      const nBlocks = per / 4;
      let overall = -1, overallV = -Infinity;
      for (let blk = 0; blk < nBlocks; blk++) for (let d = 0; d < 4; d++) {
        let bk = -1, bv = -Infinity;
        for (const k of keepsByDraw(L).lists[d]) { const x = avg[blk * NK + k]; if (x === x && x > bv) { bv = x; bk = k; } }
        const o = (h - from) * per + blk * 4 + d;
        keeps[o] = bk; evs[o] = bv;
        if (bv > overallV) { overallV = bv; overall = bk; }
      }
      best[h - from] = overall;
    }
    return { keeps, evs, best };
  }

  // ---------------------------------------------------------------------------
  // Grouping: k-means (k-means++ seeding) on per-hand feature vectors.
  // ---------------------------------------------------------------------------
  function kmeans(features, dim, k, iters = 20) {
    const n = features.length / dim;
    k = Math.min(k, n);
    const cent = new Float64Array(k * dim);
    const dist2 = (i, c) => { let s = 0; for (let x = 0; x < dim; x++) { const v = features[i * dim + x] - cent[c * dim + x]; s += v * v; } return s; };
    // k-means++ seeding
    let first = (Math.random() * n) | 0;
    for (let x = 0; x < dim; x++) cent[x] = features[first * dim + x];
    const dmin = new Float64Array(n).fill(Infinity);
    for (let c = 1; c < k; c++) {
      let total = 0;
      for (let i = 0; i < n; i++) { const d = dist2(i, c - 1); if (d < dmin[i]) dmin[i] = d; total += dmin[i]; }
      let r = Math.random() * total, pick = n - 1;
      for (let i = 0; i < n; i++) { r -= dmin[i]; if (r <= 0) { pick = i; break; } }
      for (let x = 0; x < dim; x++) cent[c * dim + x] = features[pick * dim + x];
    }
    const assign = new Uint16Array(n);
    for (let it = 0; it < iters; it++) {
      let moved = 0;
      for (let i = 0; i < n; i++) {
        let bc = 0, bd = Infinity;
        for (let c = 0; c < k; c++) { const d = dist2(i, c); if (d < bd) { bd = d; bc = c; } }
        if (assign[i] !== bc || it === 0) { moved++; assign[i] = bc; }
      }
      const sum = new Float64Array(k * dim), cnt = new Float64Array(k);
      for (let i = 0; i < n; i++) { cnt[assign[i]]++; for (let x = 0; x < dim; x++) sum[assign[i] * dim + x] += features[i * dim + x]; }
      for (let c = 0; c < k; c++) if (cnt[c]) for (let x = 0; x < dim; x++) cent[c * dim + x] = sum[c * dim + x] / cnt[c];
      if (!moved && it > 0) break;
    }
    return { assign, centroids: cent, k, dim };
  }
  function nearestCentroid(km, vec) {
    let bc = 0, bd = Infinity;
    for (let c = 0; c < km.k; c++) {
      let s = 0;
      for (let x = 0; x < km.dim; x++) { const v = vec[x] - km.centroids[c * km.dim + x]; s += v * v; }
      if (s < bd) { bd = s; bc = c; }
    }
    return bc;
  }

  // Features: OOP hands → EV of their best keep at each draw count (4 numbers).
  // IP hands → for each announcement, the EV of their best response (4 numbers).
  function featuresOOP(evO, n) { return Float64Array.from(evO.subarray(0, n * 4)); }
  function featuresIP(evI, n) {
    const f = new Float64Array(n * 4);
    for (let j = 0; j < n; j++) for (let dO = 0; dO < 4; dO++) {
      let m = -Infinity;
      for (let dI = 0; dI < 4; dI++) m = Math.max(m, evI[(j * 4 + dO) * 4 + dI]);
      f[j * 4 + dO] = m;
    }
    return f;
  }

  // ---------------------------------------------------------------------------
  // Group game payoffs. For OOP hands in [from,to), `pairs` random IP partners each,
  // one runout per pairing; accumulates the payoff of OOP's keep for dO vs IP's keep
  // for (dO, dI) into cell [bO][dO][bI][dI]. Returns partial sums and counts.
  //   keepO: Int16 [M*4] (per dO)   keepI: Int16 [M*16] (per dO, dI)
  // ---------------------------------------------------------------------------
  function groupPayoffs(ctx, popO, keepO, groupO, popI, keepI, groupI, B, from, to, pairs) {
    const L = ctx.L, H = ctx.H, nI = popI.length / H, sc = makeScratch();
    const sum = new Float64Array(B * 4 * B * 4), cnt = new Float64Array(B * 4 * B * 4);
    const listO = new Int16Array(4), listI = new Int16Array(16);
    for (let h = from; h < to; h++) {
      const handO = handAt(ctx, popO, h), bO = groupO[h];
      for (let d = 0; d < 4; d++) listO[d] = keepO[h * 4 + d];
      const pairsO = pairsNeeded(L, listO);
      const mO = Array.from(listO, (k) => keepMask(L, handO, k));
      for (let p = 0; p < pairs; p++) {
        const j = (Math.random() * nI) | 0, handI = handAt(ctx, popI, j), bI = groupI[j];
        for (let x = 0; x < 16; x++) listI[x] = keepI[j * 16 + x];
        dealScenario(ctx, sc, handO, handI);
        evalKeeps(L, sc, sc.locX, listO, pairsO, sc.x5, sc.xA, sc.xB);
        evalKeeps(L, sc, sc.locY, listI, pairsNeeded(L, listI), sc.y5, sc.yA, sc.yB);
        for (let dO = 0; dO < 4; dO++) {
          const ko = listO[dO];
          for (let dI = 0; dI < 4; dI++) {
            const ki = listI[dO * 4 + dI];
            const [lo, hi] = keepMask(L, handI, ki);
            if ((mO[dO][0] & lo) || (mO[dO][1] & hi)) continue;
            const cell = ((bO * 4 + dO) * B + bI) * 4 + dI;
            sum[cell] += payoff(sc.x5[ko], sc.xA[ko], sc.xB[ko], sc.y5[ki], sc.yA[ki], sc.yB[ki]);
            cnt[cell] += 1;
          }
        }
      }
    }
    return { sum, cnt };
  }

  // ---------------------------------------------------------------------------
  // CFR+ on the group game. OOP info set: its group bO → draw count dO. IP info set:
  // (its group bI, announced dO) → draw count dI. Group frequencies pO, pI act as
  // chance. A small tremble keeps every announcement reachable so IP learns sensible
  // replies even to announcements equilibrium OOP rarely makes.
  // ---------------------------------------------------------------------------
  function regretMatch(R, off, n, out) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += R[off + i] > 0 ? R[off + i] : 0;
    if (sum > 0) for (let i = 0; i < n; i++) out[off + i] = R[off + i] > 0 ? R[off + i] / sum : 0;
    else for (let i = 0; i < n; i++) out[off + i] = 1 / n;
  }

  function solveGroups({ sum, cnt, B, pO, pI, iterations = 2000, tremble = 0.02 }) {
    const C = B * 4 * B * 4;
    // Average payoff per cell; empty cells fall back to the (dO, dI) average across groups.
    const U = new Float64Array(C);
    const fbS = new Float64Array(16), fbC = new Float64Array(16);
    for (let bO = 0; bO < B; bO++) for (let dO = 0; dO < 4; dO++) for (let bI = 0; bI < B; bI++) for (let dI = 0; dI < 4; dI++) {
      const i = ((bO * 4 + dO) * B + bI) * 4 + dI;
      fbS[dO * 4 + dI] += sum[i]; fbC[dO * 4 + dI] += cnt[i];
    }
    for (let bO = 0; bO < B; bO++) for (let dO = 0; dO < 4; dO++) for (let bI = 0; bI < B; bI++) for (let dI = 0; dI < 4; dI++) {
      const i = ((bO * 4 + dO) * B + bI) * 4 + dI;
      // Light shrinkage toward the global (dO,dI) mean steadies thinly-sampled cells.
      const prior = fbC[dO * 4 + dI] ? fbS[dO * 4 + dI] / fbC[dO * 4 + dI] : 0, k0 = 2;
      U[i] = (sum[i] + k0 * prior) / (cnt[i] + k0);
    }

    const RO = new Float64Array(B * 4), SO = new Float64Array(B * 4), sO = new Float64Array(B * 4);
    const RI = new Float64Array(B * 16), SI = new Float64Array(B * 16), sI = new Float64Array(B * 16);
    const QO = new Float64Array(B * 4), QI = new Float64Array(B * 16), mass = new Float64Array(4);

    function oopQ(sigI, out) {
      for (let bO = 0; bO < B; bO++) for (let dO = 0; dO < 4; dO++) {
        let v = 0;
        for (let bI = 0; bI < B; bI++) {
          const base = ((bO * 4 + dO) * B + bI) * 4, s = (bI * 4 + dO) * 4;
          let w = 0;
          for (let dI = 0; dI < 4; dI++) w += sigI[s + dI] * U[base + dI];
          v += pI[bI] * w;
        }
        out[bO * 4 + dO] = v;
      }
    }
    // Conditional IP values given each announcement (OOP plays (1-eps)*sigO + eps*uniform).
    function ipQ(sigO, eps, out) {
      out.fill(0); mass.fill(0);
      const reach = new Float64Array(B * 4);
      for (let bO = 0; bO < B; bO++) for (let dO = 0; dO < 4; dO++) {
        const r = pO[bO] * ((1 - eps) * sigO[bO * 4 + dO] + eps / 4);
        reach[bO * 4 + dO] = r; mass[dO] += r;
      }
      for (let bI = 0; bI < B; bI++) for (let dO = 0; dO < 4; dO++) for (let dI = 0; dI < 4; dI++) {
        let v = 0;
        for (let bO = 0; bO < B; bO++) v -= reach[bO * 4 + dO] * U[((bO * 4 + dO) * B + bI) * 4 + dI];
        out[(bI * 4 + dO) * 4 + dI] = mass[dO] > 0 ? v / mass[dO] : 0;
      }
    }
    function update(R, S, sig, Q, off, n, weight, t) {
      let ev = 0;
      for (let i = 0; i < n; i++) ev += sig[off + i] * Q[off + i];
      for (let i = 0; i < n; i++) {
        const r = R[off + i] + weight * (Q[off + i] - ev);
        R[off + i] = r > 0 ? r : 0;
        S[off + i] += t * sig[off + i];
      }
    }
    for (let t = 1; t <= iterations; t++) {
      for (let b = 0; b < B; b++) regretMatch(RO, b * 4, 4, sO);
      for (let s = 0; s < B * 4; s++) regretMatch(RI, s * 4, 4, sI);
      oopQ(sI, QO);
      ipQ(sO, tremble, QI);
      for (let b = 0; b < B; b++) update(RO, SO, sO, QO, b * 4, 4, pO[b], t);
      for (let bI = 0; bI < B; bI++) for (let dO = 0; dO < 4; dO++) update(RI, SI, sI, QI, (bI * 4 + dO) * 4, 4, pI[bI] * Math.max(mass[dO], 1e-3), t);
    }
    const avgO = new Float64Array(B * 4), avgI = new Float64Array(B * 16);
    const norm = (S, out, off) => { let s = 0; for (let i = 0; i < 4; i++) s += S[off + i]; for (let i = 0; i < 4; i++) out[off + i] = s > 0 ? S[off + i] / s : 0.25; };
    for (let b = 0; b < B; b++) norm(SO, avgO, b * 4);
    for (let s = 0; s < B * 4; s++) norm(SI, avgI, s * 4);

    // Values and exploitability of the averaged strategies (no tremble).
    oopQ(avgI, QO);
    let valueO = 0, brO = 0;
    for (let b = 0; b < B; b++) {
      let ev = 0, mx = -Infinity;
      for (let d = 0; d < 4; d++) { ev += avgO[b * 4 + d] * QO[b * 4 + d]; mx = Math.max(mx, QO[b * 4 + d]); }
      valueO += pO[b] * ev; brO += pO[b] * mx;
    }
    ipQ(avgO, 0, QI);
    const massF = Array.from(mass);
    let valueI = 0, brI = 0;
    const ipValueGiven = [0, 0, 0, 0];
    for (let bI = 0; bI < B; bI++) for (let dO = 0; dO < 4; dO++) {
      let ev = 0, mx = -Infinity;
      for (let dI = 0; dI < 4; dI++) { const q = QI[(bI * 4 + dO) * 4 + dI]; ev += avgI[(bI * 4 + dO) * 4 + dI] * q; mx = Math.max(mx, q); }
      ipValueGiven[dO] += pI[bI] * ev;
      if (massF[dO] <= 0) continue;
      valueI += massF[dO] * pI[bI] * ev; brI += massF[dO] * pI[bI] * mx;
    }
    const oopDraw = [0, 0, 0, 0];
    for (let b = 0; b < B; b++) for (let d = 0; d < 4; d++) oopDraw[d] += pO[b] * avgO[b * 4 + d];
    const ipDrawGiven = [0, 1, 2, 3].map((dO) => {
      const dist = [0, 0, 0, 0];
      for (let bI = 0; bI < B; bI++) for (let dI = 0; dI < 4; dI++) dist[dI] += pI[bI] * avgI[(bI * 4 + dO) * 4 + dI];
      return dist;
    });
    return {
      sigO: avgO, sigI: avgI,
      summary: {
        valueOop: (valueO - valueI) / 2,
        exploitability: Math.max(0, ((brO - valueO) + (brI - valueI)) / 2),
        oopDraw, ipDrawGiven, ipValueGiven, iterations
      }
    };
  }

  // Cumulative sampling weights over OOP hands for each announcement dO:
  // P(hand h | OOP announced dO) ∝ sigO[group(h)][dO]. Layout: cw[dO * M + h].
  function posteriorTables(sigO, groupO, M, eps = 0.02) {
    const cw = new Float64Array(4 * M);
    for (let dO = 0; dO < 4; dO++) {
      let acc = 0;
      for (let h = 0; h < M; h++) { acc += (1 - eps) * sigO[groupO[h] * 4 + dO] + eps / 4; cw[dO * M + h] = acc; }
    }
    return cw;
  }
  function samplePosterior(cw, M, dO) {
    const total = cw[dO * M + M - 1];
    const r = Math.random() * total;
    let lo = 0, hi = M - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cw[dO * M + mid] < r) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function sampleDist(sig, off) {
    let r = Math.random();
    for (let i = 0; i < 4; i++) { r -= sig[off + i]; if (r <= 0) return i; }
    return 3;
  }

  // ---------------------------------------------------------------------------
  // Real hands. Every keep of `cards` is scored over `n` paired samples per block:
  //   seat 'oop': block = my draw count d (opponents respond to d);
  //   seat 'ip' : block = OOP's announcement dO (opponents drawn from the posterior).
  // Opponent hands whose relevant keep would use one of my cards are redrawn.
  // Returns per-block sums/sumsq/counts for every keep, plus raw payoffs for the first
  // `rawCap` samples (paired, for error bars on differences between keeps).
  // ---------------------------------------------------------------------------
  function observeRange(ctx, cards, seat, opp, s0, s1, rawCap) {
    const L = ctx.L, H = ctx.H, NK = L.NKEEPS, sc = makeScratch();
    const hand = Int32Array.from(cards);
    const [mlo, mhi] = cardsMask(hand);
    const byDraw = keepsByDraw(L);
    const nOpp = opp.pop.length / H;
    const sums = new Float64Array(4 * NK), sq = new Float64Array(4 * NK), cnt = new Float64Array(4 * NK);
    const rawFrom = s0, rawTo = Math.min(s1, rawCap), rawLen = Math.max(0, rawTo - rawFrom);
    const raw = new Int8Array(4 * NK * rawLen);
    const oppList = new Int16Array(1);
    for (let block = 0; block < 4; block++) {
      const myList = seat === 'oop' ? byDraw.lists[block] : L.ALL_KEEPS;
      const myPairs = seat === 'oop' ? byDraw.pairs[block] : L.ALL_PAIRS;
      for (let s = s0; s < s1; s++) {
        let j, k, tries = 0;
        do {
          if (seat === 'oop') {
            j = (Math.random() * nOpp) | 0;
            k = opp.keeps[j * 16 + block * 4 + sampleDist(opp.sig, (opp.group[j] * 4 + block) * 4)];
          } else {
            j = samplePosterior(opp.cw, nOpp, block);
            k = opp.keeps[j * 4 + block];
          }
          const [lo, hi] = keepMask(L, handAt(ctx, opp.pop, j), k);
          if (!((lo & mlo) || (hi & mhi))) break;
        } while (++tries < 200);
        const oppHand = handAt(ctx, opp.pop, j);
        dealScenario(ctx, sc, hand, oppHand);
        oppList[0] = k;
        evalKeeps(L, sc, sc.locY, oppList, L.KEEP_PAIRS.subarray(k * 10, k * 10 + 10), sc.y5, sc.yA, sc.yB);
        evalKeeps(L, sc, sc.locX, myList, myPairs, sc.x5, sc.xA, sc.xB);
        const y5 = sc.y5[k], yA = sc.yA[k], yB = sc.yB[k];
        for (let n = 0; n < myList.length; n++) {
          const ki = myList[n];
          const v = payoff(sc.x5[ki], sc.xA[ki], sc.xB[ki], y5, yA, yB);
          const idx = block * NK + ki;
          sums[idx] += v; sq[idx] += v * v; cnt[idx] += 1;
          if (s < rawTo) raw[idx * rawLen + (s - rawFrom)] = v;
        }
      }
    }
    return { sums, sq, cnt, raw, rawLen };
  }

  // Merge observeRange chunks (in sample order) and turn them into EVs, standard
  // errors, and a "solver plays" mix: the best keep plus any keep statistically tied
  // with it (within one standard error of the paired difference), weighted by closeness.
  function finalizeObserver(L, seat, chunks) {
    const NK = L.NKEEPS;
    const sums = new Float64Array(4 * NK), sq = new Float64Array(4 * NK), cnt = new Float64Array(4 * NK);
    let rawLen = 0;
    for (const c of chunks) {
      for (let i = 0; i < 4 * NK; i++) { sums[i] += c.sums[i]; sq[i] += c.sq[i]; cnt[i] += c.cnt[i]; }
      rawLen += c.rawLen;
    }
    const raw = new Int8Array(4 * NK * rawLen);
    let off = 0;
    for (const c of chunks) {
      for (let i = 0; i < 4 * NK; i++) raw.set(c.raw.subarray(i * c.rawLen, (i + 1) * c.rawLen), i * rawLen + off);
      off += c.rawLen;
    }
    const nBlocks = seat === 'oop' ? 1 : 4; // OOP: one decision; IP: one per announcement
    const ev = new Float64Array(nBlocks * NK), se = new Float64Array(nBlocks * NK), freq = new Float64Array(nBlocks * NK), seDiff = new Float64Array(nBlocks * NK);
    for (let blk = 0; blk < nBlocks; blk++) {
      for (let k = 0; k < NK; k++) {
        const idx = (seat === 'oop' ? L.KEEP_DRAW[k] : blk) * NK + k;
        const n = cnt[idx];
        const m = n ? sums[idx] / n : -99;
        const v = n > 1 ? Math.max(0, (sq[idx] - n * m * m) / (n - 1)) : 0;
        ev[blk * NK + k] = m;
        se[blk * NK + k] = n ? Math.sqrt(v / n) : 0;
      }
      let best = 0;
      for (let k = 1; k < NK; k++) if (ev[blk * NK + k] > ev[blk * NK + best]) best = k;
      const bIdx = (seat === 'oop' ? L.KEEP_DRAW[best] : blk) * NK + best;
      const w = new Float64Array(NK);
      for (let k = 0; k < NK; k++) {
        const kIdx = (seat === 'oop' ? L.KEEP_DRAW[k] : blk) * NK + k;
        let s;
        const samePairs = seat === 'ip' || L.KEEP_DRAW[k] === L.KEEP_DRAW[best];
        if (samePairs && rawLen > 1) {
          // paired: same scenarios for both keeps
          let m = 0, m2 = 0;
          for (let x = 0; x < rawLen; x++) { const d = raw[kIdx * rawLen + x] - raw[bIdx * rawLen + x]; m += d; m2 += d * d; }
          m /= rawLen;
          const vd = Math.max(0, (m2 - rawLen * m * m) / (rawLen - 1));
          s = Math.sqrt(vd / Math.max(1, cnt[kIdx]));
        } else {
          s = Math.sqrt(se[blk * NK + k] ** 2 + se[blk * NK + best] ** 2);
        }
        seDiff[blk * NK + k] = s;
        const gap = ev[blk * NK + best] - ev[blk * NK + k];
        if (k === best) w[k] = 1;
        else if (s > 0 && gap <= s) w[k] = Math.exp(-0.5 * (gap / s) ** 2);
      }
      let tot = 0;
      for (let k = 0; k < NK; k++) tot += w[k];
      for (let k = 0; k < NK; k++) freq[blk * NK + k] = w[k] / tot;
    }
    return { ev: Array.from(ev), se: Array.from(se), seDiff: Array.from(seDiff), freq: Array.from(freq), samples: Math.max(...cnt) };
  }

  // ---------------------------------------------------------------------------
  // Presentation helpers
  // ---------------------------------------------------------------------------
  function keepCards(cards, ki) {
    return layout(cards.length).KEEPS[ki].slots.map((s) => cards[s]);
  }
  function sampleMixed(freqs, floor = 0.05) {
    let total = 0;
    const w = freqs.map((f) => (f >= floor ? f : 0));
    for (const x of w) total += x;
    if (total <= 0) { let b = 0; freqs.forEach((f, i) => { if (f > freqs[b]) b = i; }); return b; }
    let r = Math.random() * total;
    for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0 && w[i] > 0) return i; }
    return w.findIndex((x) => x > 0);
  }

  // M = hands sampled per seat; B = groups per seat; R/Q = bank boards and pre-dealt
  // opponents per board for scouting; t{A,B,C}1/2 = racing runouts per hand in each
  // scouting round (pass 1 all keeps, pass 2 the best k2 per draw count); pairs =
  // group-payoff partners per OOP hand; obs = paired samples per block for each real
  // hand; iterations = CFR+ passes on the (tiny) group game.
  const PRESETS = {
    fast: { M: 300, B: 20, R: 128, Q: 6, tA1: 10, tA2: 30, tB1: 16, tB2: 60, tC1: 16, tC2: 60, k2: 5, pairs: 30, obs: 2000, iterations: 1500, rounds: 2, alphas: [0.6, 0.5] },
    standard: { M: 700, B: 32, R: 192, Q: 8, tA1: 12, tA2: 40, tB1: 20, tB2: 90, tC1: 16, tC2: 90, k2: 6, pairs: 36, obs: 4000, iterations: 2000, rounds: 2, alphas: [0.6, 0.5] },
    deep: { M: 1400, B: 48, R: 256, Q: 8, tA1: 12, tA2: 40, tB1: 24, tB2: 120, tC1: 20, tC2: 110, k2: 6, pairs: 40, obs: 7000, iterations: 2500, rounds: 2, alphas: [0.6, 0.5] },
    max: { M: 2400, B: 64, R: 256, Q: 8, tA1: 12, tA2: 40, tB1: 24, tB2: 140, tC1: 20, tC2: 130, k2: 6, pairs: 44, obs: 10000, iterations: 3000, rounds: 3, alphas: [0.6, 0.5, 0.4] },
    ultra: { M: 3600, B: 80, R: 320, Q: 8, tA1: 12, tA2: 40, tB1: 28, tB2: 160, tC1: 20, tC2: 140, k2: 6, pairs: 48, obs: 16000, iterations: 3000, rounds: 3, alphas: [0.6, 0.5, 0.4] }
  };
  const RAW_CAP = 4000;

  // Group the population, solve the group game, return everything later phases need.
  function groupAndSolve(evO, evI16, M, B, payoffFn, iterations) {
    const kmO = kmeans(featuresOOP(evO, M), 4, B);
    const kmI = kmeans(featuresIP(evI16, M), 4, B);
    const pO = new Float64Array(kmO.k), pI = new Float64Array(kmI.k);
    for (let h = 0; h < M; h++) { pO[kmO.assign[h]] += 1 / M; pI[kmI.assign[h]] += 1 / M; }
    const Bm = Math.max(kmO.k, kmI.k);
    const pay = payoffFn(kmO.assign, kmI.assign, Bm);
    const pO2 = new Float64Array(Bm), pI2 = new Float64Array(Bm);
    pO2.set(pO); pI2.set(pI);
    const sol = solveGroups({ sum: pay.sum, cnt: pay.cnt, B: Bm, pO: pO2, pI: pI2, iterations });
    return { kmO, kmI, pO: pO2, pI: pI2, B: Bm, ...sol };
  }

  // ---------------------------------------------------------------------------
  // Per-hand refinement. The group solve is a fast first answer, but hands in one
  // group don't all want the same draw count, so every sampled hand then re-optimizes
  // on its own: OOP hands best-respond to IP's current play, IP hands best-respond to
  // each announcement given who makes it, alternating for a few rounds and averaging
  // strategies (fictitious play), with groups only as the starting point.
  // Per-hand strategies use the same layouts as group ones with "group = the hand
  // itself": sigO[h*4 + dO], sigI[(j*4 + dO)*4 + dI].
  // ---------------------------------------------------------------------------
  const identityGroups = (M) => Uint16Array.from({ length: M }, (_, i) => i);
  function expandGroupStrategies(G, M) {
    const sigO = new Float64Array(M * 4), sigI = new Float64Array(M * 16);
    for (let h = 0; h < M; h++) {
      const g = G.kmO.assign[h];
      for (let d = 0; d < 4; d++) sigO[h * 4 + d] = G.sigO[g * 4 + d];
    }
    for (let j = 0; j < M; j++) {
      const g = G.kmI.assign[j];
      for (let x = 0; x < 16; x++) sigI[j * 16 + x] = G.sigI[g * 16 + x];
    }
    return { sigO, sigI };
  }
  // Move each hand's strategy a step `alpha` toward its best response(s).
  function stepToward(sig, off, evs, evOff, alpha) {
    let best = 0;
    for (let d = 1; d < 4; d++) if (evs[evOff + d] > evs[evOff + best]) best = d;
    for (let d = 0; d < 4; d++) sig[off + d] = (1 - alpha) * sig[off + d] + (d === best ? alpha : 0);
  }
  function updateOOP(sigO, evO, M, alpha) { for (let h = 0; h < M; h++) stepToward(sigO, h * 4, evO, h * 4, alpha); }
  function updateIP(sigI, evI, M, alpha) {
    for (let j = 0; j < M; j++) for (let dO = 0; dO < 4; dO++) stepToward(sigI, (j * 4 + dO) * 4, evI, (j * 4 + dO) * 4, alpha);
  }

  // Equilibrium summary from the per-hand strategies and their latest scouted EVs.
  function summarize(sigO, evO, sigI, evI, M) {
    const oopDraw = [0, 0, 0, 0];
    let valueO = 0, gainO = 0;
    for (let h = 0; h < M; h++) {
      let ev = 0, mx = -Infinity;
      for (let d = 0; d < 4; d++) { oopDraw[d] += sigO[h * 4 + d] / M; ev += sigO[h * 4 + d] * evO[h * 4 + d]; mx = Math.max(mx, evO[h * 4 + d]); }
      valueO += ev / M; gainO += (mx - ev) / M;
    }
    const ipDrawGiven = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    const ipValueGiven = [0, 0, 0, 0], gainIGiven = [0, 0, 0, 0];
    for (let j = 0; j < M; j++) for (let dO = 0; dO < 4; dO++) {
      let ev = 0, mx = -Infinity;
      for (let dI = 0; dI < 4; dI++) {
        const i = (j * 4 + dO) * 4 + dI;
        ipDrawGiven[dO][dI] += sigI[i] / M; ev += sigI[i] * evI[i]; mx = Math.max(mx, evI[i]);
      }
      ipValueGiven[dO] += ev / M; gainIGiven[dO] += (mx - ev) / M;
    }
    let valueI = 0, gainI = 0;
    for (let d = 0; d < 4; d++) { valueI += oopDraw[d] * ipValueGiven[d]; gainI += oopDraw[d] * gainIGiven[d]; }
    return {
      valueOop: (valueO - valueI) / 2,
      // Average EV a hand could still gain by deviating from its mixed strategy (both
      // seats averaged). Includes scouting noise, so it slightly overstates the gap.
      exploitability: (gainO + gainI) / 2,
      oopDraw, ipDrawGiven, ipValueGiven
    };
  }

  // "Hands like yours": the equilibrium mix averaged over the population hands whose
  // EV-by-draw-count profile is nearest to the real hand's.
  function similarHandsMix(L, seat, obs, R, k = 40) {
    const NK = L.NKEEPS, M = R.M;
    const vec = [0, 0, 0, 0];
    for (let d = 0; d < 4; d++) {
      let m = -Infinity;
      for (let x = 0; x < NK; x++) {
        if (seat === 'oop' && L.KEEP_DRAW[x] === d) m = Math.max(m, obs.ev[x]);
        if (seat === 'ip') m = Math.max(m, obs.ev[d * NK + x]);
      }
      vec[d] = m;
    }
    const feats = seat === 'oop' ? featuresOOP(R.evO, M) : featuresIP(R.evI, M);
    const dist = [];
    for (let h = 0; h < M; h++) {
      let s = 0;
      for (let d = 0; d < 4; d++) { const v = feats[h * 4 + d] - vec[d]; s += v * v; }
      dist.push([s, h]);
    }
    dist.sort((x, y) => x[0] - y[0]);
    const near = dist.slice(0, k).map((x) => x[1]);
    if (seat === 'oop') {
      const mix = [0, 0, 0, 0];
      for (const h of near) for (let d = 0; d < 4; d++) mix[d] += R.sigO[h * 4 + d] / near.length;
      return { n: near.length, mix };
    }
    const mix = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    for (const j of near) for (let dO = 0; dO < 4; dO++) for (let dI = 0; dI < 4; dI++) mix[dO][dI] += R.sigI[(j * 4 + dO) * 4 + dI] / near.length;
    return { n: near.length, mix };
  }

  // Single-threaded runner (Node, tests, experiments). observers: [{ id, seat, cards }].
  function runAll({ flopA, flopB, observers = [], handSize, preset = 'standard', overrides = {}, log = () => {} }) {
    const H = handSize || (observers[0] ? observers[0].cards.length : 9);
    const P = { ...PRESETS[preset], ...overrides };
    const ctx = makeContext(flopA.map(F.toInt), flopB.map(F.toInt), H);
    const M = P.M, ident = identityGroups(M);
    const t0 = Date.now();
    const popO = samplePopulation(ctx, M), popI = samplePopulation(ctx, M);
    const aO = scoutRange(ctx, popO, 0, M, { mode: 'A', oppPop: popI }, P), aI = scoutRange(ctx, popI, 0, M, { mode: 'A', oppPop: popO }, P);
    let keepO = aO.keeps, evO = aO.evs;
    let keepI = new Int16Array(M * 16), evI = new Float32Array(M * 16);
    for (let j = 0; j < M; j++) for (let dO = 0; dO < 4; dO++) for (let dI = 0; dI < 4; dI++) {
      keepI[j * 16 + dO * 4 + dI] = aI.keeps[j * 4 + dI]; evI[j * 16 + dO * 4 + dI] = aI.evs[j * 4 + dI];
    }
    log(`scouting ${Date.now() - t0}ms`);
    const payFn = (gO, gI, B) => groupPayoffs(ctx, popO, keepO, gO, popI, keepI, gI, B, 0, M, P.pairs);
    const G = groupAndSolve(evO, evI, M, P.B, payFn, P.iterations);
    let { sigO, sigI } = expandGroupStrategies(G, M);
    log(`group solve ${Date.now() - t0}ms oopDraw ${G.summary.oopDraw.map((x) => x.toFixed(2))}`);
    for (let it = 1; it <= P.rounds; it++) {
      const alpha = P.alphas[it - 1];
      const rO = scoutRange(ctx, popO, 0, M, { mode: 'C-OOP', oppPop: popI, keepI, groupI: ident, sigI }, P);
      keepO = rO.keeps; evO = rO.evs;
      updateOOP(sigO, evO, M, alpha);
      const cw = posteriorTables(sigO, ident, M);
      const rI = scoutRange(ctx, popI, 0, M, { mode: 'C-IP', oppPop: popO, keepO, cw }, P);
      keepI = rI.keeps; evI = rI.evs;
      updateIP(sigI, evI, M, alpha);
      log(`round ${it} ${Date.now() - t0}ms oopDraw ${summarize(sigO, evO, sigI, evI, M).oopDraw.map((x) => x.toFixed(2))}`);
    }
    const R = { M, popO, popI, keepO, keepI, evO, evI, sigO, sigI, groupsO: G.kmO.k, groupsI: G.kmI.k };
    const res = finishObservers(ctx, observers.map((o) => ({ ...o, cards: o.cards.map(F.toInt) })), R, P);
    log(`observers ${Date.now() - t0}ms`);
    return res;
  }

  // What an observer needs about the opposing range (per-hand strategies).
  function opponentRange(seat, R) {
    if (seat === 'oop') return { pop: R.popI, keeps: R.keepI, group: identityGroups(R.M), sig: R.sigI };
    return { pop: R.popO, keeps: R.keepO, cw: posteriorTables(R.sigO, identityGroups(R.M), R.M) };
  }
  function finishObservers(ctx, observers, R, P) {
    const L = ctx.L;
    const obs = observers.map((o) => {
      const chunk = observeRange(ctx, o.cards, o.seat, opponentRange(o.seat, R), 0, P.obs, RAW_CAP);
      const fin = finalizeObserver(L, o.seat, [chunk]);
      return { id: o.id, seat: o.seat, ...fin, similar: similarHandsMix(L, o.seat, fin, R) };
    });
    return { summary: summaryOf(R, P), observers: obs };
  }
  function summaryOf(R, P) {
    return { ...summarize(R.sigO, R.evO, R.sigI, R.evI, R.M), M: R.M, groupsO: R.groupsO, groupsI: R.groupsI, rounds: P.rounds, obs: P.obs };
  }

  const L9 = layout(9);
  return {
    layout, KEEPS: L9.KEEPS, NKEEPS: L9.NKEEPS, KEEP_DRAW: L9.KEEP_DRAW, PRESETS, RAW_CAP,
    makeContext, samplePopulation, scoutRange, groupPayoffs, solveGroups, kmeans, featuresOOP, featuresIP,
    posteriorTables, observeRange, finalizeObserver, similarHandsMix, opponentRange, summaryOf, groupAndSolve,
    expandGroupStrategies, identityGroups, updateOOP, updateIP, summarize,
    keepCards, sampleMixed, runAll
  };
});
