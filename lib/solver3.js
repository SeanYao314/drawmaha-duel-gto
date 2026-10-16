// lib/solver3.js — approximate equilibrium solver for 3-handed Drawmaha.
//
// THE GAME
// Three players, two flops. They act in a fixed order — 1st (left of the button), 2nd,
// then the button — and each one's draw count is public before the next decides. Every
// pair of players settles the same three contests between themselves (5-card hand,
// PLO5 on board A, PLO5 on board B; scoop doubles), so each player's result is the sum
// of their two head-up matchups. So:
//   1st    picks a keep knowing nothing;
//   2nd    picks a keep knowing 1st's draw count d0;
//   button picks a keep knowing d0 and 2nd's draw count d1.
//
// HOW IT IS SOLVED
// Three-player games have no single "the" equilibrium the way heads-up ones do, and CFR
// carries no guarantee there, so this uses fictitious play over sampled ranges — the
// same per-hand refinement the heads-up solver ends with:
//   1. Population. M random hands per seat on these flops (only public information).
//   2. Start. Every hand finds its best keep at each draw count against two opponents
//      who keep their strongest made five.
//   3. Rounds. In turn, 1st, 2nd and the button re-score every keep of every sampled
//      hand against the other two seats' *current* strategies — conditioned on what
//      it has heard: a 2nd-seat hand faces the 1st-seat hands that would have announced
//      d0 (the posterior) and button hands answering (d0, its own draw count); a button
//      hand faces the posteriors for d0 and (d0, d1). Each hand then moves its strategy
//      toward its best response and the moves are averaged over rounds.
//   4. Real hands. Your hand and the bots' are scored with every keep against
//      thousands of opponent pairs drawn from the solved ranges (dealt together, so card
//      removal between all three hands is exact), with paired samples for error bars.
//
// Because the payoff is the sum of two head-up matchups, a hand's EV is the sum of its
// EV against each opponent — which lets scouting score each opponent separately.
//
// Seats are numbered in action order: 0 = 1st, 1 = 2nd, 2 = button.
// Strategy layouts (M hands per seat):
//   sig0[h*4 + d0]                 keep0[h*4 + d0]
//   sig1[(h*4 + d0)*4 + d1]        keep1[(h*4 + d0)*4 + d1]        (= h*16 + c, c = d0*4+d1)
//   sig2[(h*16 + c)*4 + d2]        keep2[(h*16 + c)*4 + d2]
(function (root, factory) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const F = isNode ? require('./fasteval.js') : root.FastEval;
  const S = isNode ? require('./solver.js') : root.Solver;
  const lib = factory(F, S);
  if (isNode) module.exports = lib;
  else root.Solver3 = lib;
})(typeof self !== 'undefined' ? self : this, function (F, S) {
  const X = S._x;
  const { payoff, cardsMask, keepMask, handAt, sampleDist, boardClashes, keepsByDraw, buildBank, dealStream, keepValuesBank, pvBank, evalKeeps } = X;
  const layout = S.layout;

  const SEATS = 3;
  const BLOCKS = [1, 4, 16];      // decision contexts per seat (what it has heard)
  const OBS_SETS = [4, 16, 16];   // sample sets per seat for real-hand evaluation
  const RAW_CAP3 = 1200;          // paired samples kept per (set, keep) for error bars

  // ---------------------------------------------------------------------------
  // Posteriors: who announced what.
  // ---------------------------------------------------------------------------
  // cw0[d0*M + h]: cumulative weight of 1st-seat hand h given it announced d0.
  // cw1[c*M + j]:  cumulative weight of 2nd-seat hand j given (d0, d1), c = d0*4 + d1.
  function posterior0(sig0, M, eps = 0.02) {
    const cw = new Float64Array(4 * M);
    for (let d0 = 0; d0 < 4; d0++) {
      let acc = 0;
      for (let h = 0; h < M; h++) { acc += (1 - eps) * sig0[h * 4 + d0] + eps / 4; cw[d0 * M + h] = acc; }
    }
    return cw;
  }
  function posterior1(sig1, M, eps = 0.02) {
    const cw = new Float64Array(16 * M);
    for (let c = 0; c < 16; c++) {
      let acc = 0;
      for (let j = 0; j < M; j++) { acc += (1 - eps) * sig1[j * 16 + c] + eps / 4; cw[c * M + j] = acc; }
    }
    return cw;
  }
  function sampleCum(cw, M, c) {
    const total = cw[c * M + M - 1];
    const r = Math.random() * total;
    let lo = 0, hi = M - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cw[c * M + mid] < r) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // How likely each (d0, d1) context is at the current strategies: P(d0) * P(d1 | d0).
  function contextWeights(sig0, sig1, M) {
    const w = new Float64Array(16);
    const p0 = [0, 0, 0, 0];
    for (let h = 0; h < M; h++) for (let d = 0; d < 4; d++) p0[d] += sig0[h * 4 + d] / M;
    for (let d0 = 0; d0 < 4; d0++) for (let j = 0; j < M; j++) for (let d1 = 0; d1 < 4; d1++) w[d0 * 4 + d1] += p0[d0] * sig1[j * 16 + d0 * 4 + d1] / M;
    return w;
  }

  // ---------------------------------------------------------------------------
  // Opponent samplers. Each returns [pop index, hand index, keep index].
  //   R1(d0)   a 2nd-seat hand answering d0 (mixing over its own draw counts)
  //   R2m(d0)  a button hand answering d0 and a random 2nd-seat answer to it
  //   R2(c)    a button hand answering (d0, d1)
  //   P0(d0)   a 1st-seat hand that announced d0, playing its keep for d0
  //   P1(c)    a 2nd-seat hand that announced d1 after d0, playing its keep for it
  //   MADE     a random hand keeping its strongest made five (opening field)
  // spec carries whichever of pop0..2 / keep0..2 / sig1 / sig2 / cw0 / cw1 are needed.
  // ---------------------------------------------------------------------------
  function makeSampler(ctx, spec) {
    const H = ctx.H, L = ctx.L, M = spec.M;
    const rnd = () => (Math.random() * M) | 0;
    const madeCache = {};
    const patList = keepsByDraw(L).lists[0];
    const madeKeep = (pi, j) => {
      const key = pi * 1e6 + j;
      if (madeCache[key] !== undefined) return madeCache[key];
      const hand = handAt(ctx, spec['pop' + pi], j);
      let best = patList[0], bv = -1;
      for (const k of patList) {
        const f = k * 5;
        const x = F.eval5(hand[L.KEEP_FINAL[f]], hand[L.KEEP_FINAL[f + 1]], hand[L.KEEP_FINAL[f + 2]], hand[L.KEEP_FINAL[f + 3]], hand[L.KEEP_FINAL[f + 4]]);
        if (x > bv) { bv = x; best = k; }
      }
      return (madeCache[key] = best);
    };
    return function sample(type, c, out) {
      let j, d;
      switch (type) {
        case 'R1':
          j = rnd(); d = sampleDist(spec.sig1, j * 16 + c * 4);
          out[0] = 1; out[1] = j; out[2] = spec.keep1[j * 16 + c * 4 + d]; return;
        case 'R2m': {
          const j1 = rnd(), d1 = sampleDist(spec.sig1, j1 * 16 + c * 4), cc = c * 4 + d1;
          j = rnd(); d = sampleDist(spec.sig2, (j * 16 + cc) * 4);
          out[0] = 2; out[1] = j; out[2] = spec.keep2[(j * 16 + cc) * 4 + d]; return;
        }
        case 'R2':
          j = rnd(); d = sampleDist(spec.sig2, (j * 16 + c) * 4);
          out[0] = 2; out[1] = j; out[2] = spec.keep2[(j * 16 + c) * 4 + d]; return;
        case 'P0':
          j = sampleCum(spec.cw0, M, c);
          out[0] = 0; out[1] = j; out[2] = spec.keep0[j * 4 + c]; return;
        case 'P1':
          j = sampleCum(spec.cw1, M, c);
          out[0] = 1; out[1] = j; out[2] = spec.keep1[j * 16 + c]; return;
        case 'MADE':
          j = rnd();
          out[0] = spec.otherPop; out[1] = j; out[2] = madeKeep(spec.otherPop, j); return;
      }
      throw new Error('bad sampler ' + type);
    };
  }

  // The single-opponent sets a scouting seat is scored against, and which two of them
  // make up each (block, my draw count). mode: 'A' (opening) or seat 0 / 1 / 2.
  function setPlan(mode) {
    if (mode === 'A') return { sets: [['MADE', 0]], nBlocks: 1, pair: () => [0, 0] };
    if (mode === 0) {
      const sets = [];
      for (let d = 0; d < 4; d++) sets.push(['R1', d]);
      for (let d = 0; d < 4; d++) sets.push(['R2m', d]);
      return { sets, nBlocks: 1, pair: (b, d) => [d, 4 + d] };
    }
    if (mode === 1) {
      const sets = [];
      for (let d = 0; d < 4; d++) sets.push(['P0', d]);
      for (let c = 0; c < 16; c++) sets.push(['R2', c]);
      return { sets, nBlocks: 4, pair: (b, d) => [b, 4 + b * 4 + d] };
    }
    const sets = [];
    for (let d = 0; d < 4; d++) sets.push(['P0', d]);
    for (let c = 0; c < 16; c++) sets.push(['P1', c]);
    return { sets, nBlocks: 16, pair: (b) => [b >> 2, 4 + b] };
  }

  // Pre-deal Q opponent outcomes (5-card / PLO A / PLO B strengths) per set and bank board.
  function buildFields3(ctx, bank, spec, plan, Q) {
    const L = ctx.L, H = ctx.H, R = bank.R, nS = plan.sets.length;
    const data = new Int32Array(nS * R * Q * 3);
    const used = new Uint8Array(52), loc = new Int32Array(H + 3), v = new Int32Array(3), o3 = [0, 0, 0];
    const sample = makeSampler(ctx, spec);
    for (let s = 0; s < nS; s++) {
      const [type, c] = plan.sets[s];
      for (let r = 0; r < R; r++) for (let q = 0; q < Q; q++) {
        let hand, tries = 0;
        do {
          sample(type, c, o3);
          hand = handAt(ctx, spec['pop' + o3[0]], o3[1]);
          const [lo, hi] = cardsMask(hand);
          if (!boardClashes(bank, r, lo, hi)) break;
        } while (++tries < 100);
        dealStream(ctx, bank, r, hand, loc, used);
        keepValuesBank(L, bank, r, loc, o3[2], v);
        const o = ((s * R + r) * Q + q) * 3;
        data[o] = v[0]; data[o + 1] = v[1]; data[o + 2] = v[2];
      }
    }
    return { data, Q };
  }

  // Race every keep of one hand (see the heads-up solver's raceHand): pass 1 finds the
  // contenders with a few pre-dealt opponents per board, pass 2 scores them with all Q.
  // The button has 16 contexts, so its pass 1 scores each runout against one context
  // drawn by how often it happens, and pass 2 scores the survivors in every context.
  function raceHand3(ctx, bank, fields, plan, mode, hand, P, scratch, blockCum) {
    const L = ctx.L, NK = L.NKEEPS, R = bank.R, Q = fields.Q, data = fields.data;
    const nB = plan.nBlocks, pooled = mode === 2;
    const { used, loc, pvA, pvB } = scratch;
    const [hlo, hhi] = cardsMask(hand);
    const KF = L.KEEP_FINAL, KP = L.KEEP_PAIRS, KD = L.KEEP_DRAW;
    const pickBoard = () => {
      for (let t = 0; t < 100; t++) { const r = (Math.random() * R) | 0; if (!boardClashes(bank, r, hlo, hhi)) return r; }
      return (Math.random() * R) | 0;
    };
    const setVal = (s, r, Qn, x5, xA, xB) => {
      let o = ((s * R + r) * Q) * 3, acc = 0;
      for (let q = 0; q < Qn; q++, o += 3) {
        const y5 = data[o], yA = data[o + 1], yB = data[o + 2];
        const t = (x5 > y5 ? 1 : x5 < y5 ? -1 : 0) + (xA > yA ? 1 : xA < yA ? -1 : 0) + (xB > yB ? 1 : xB < yB ? -1 : 0);
        acc += t === 3 ? 6 : t === -3 ? -6 : t;
      }
      return acc / Qn;
    };
    const pickBlock = () => {
      const r = Math.random() * blockCum[15];
      let b = 0;
      while (b < 15 && blockCum[b] < r) b++;
      return b;
    };
    const v0 = new Float64Array(4), v1 = new Float64Array(16);
    const runPass = (list, pairList, trials, Qn, pool) => {
      const outB = pool ? 1 : nB;
      const sums = new Float64Array(outB * NK);
      for (let t = 0; t < trials; t++) {
        const r = pickBoard();
        const bT = pool ? pickBlock() : 0;
        dealStream(ctx, bank, r, hand, loc, used);
        for (let n = 0; n < pairList.length; n++) {
          const pid = pairList[n], p = loc[L.PAIR_I[pid]], q = loc[L.PAIR_J[pid]];
          pvA[pid] = pvBank(bank, r, 0, p, q); pvB[pid] = pvBank(bank, r, 1, p, q);
        }
        for (let n = 0; n < list.length; n++) {
          const k = list[n], f = k * 5;
          const x5 = F.eval5(loc[KF[f]], loc[KF[f + 1]], loc[KF[f + 2]], loc[KF[f + 3]], loc[KF[f + 4]]);
          let xA = -1, xB = -1;
          for (let i = k * 10, e = i + 10; i < e; i++) { const pid = KP[i]; if (pvA[pid] > xA) xA = pvA[pid]; if (pvB[pid] > xB) xB = pvB[pid]; }
          const d = KD[k];
          if (pool) {
            const [a, b] = plan.pair(bT, d);
            sums[k] += setVal(a, r, Qn, x5, xA, xB) + setVal(b, r, Qn, x5, xA, xB);
          } else if (mode === 2) {
            for (let d0 = 0; d0 < 4; d0++) v0[d0] = setVal(d0, r, Qn, x5, xA, xB);
            for (let c = 0; c < 16; c++) v1[c] = setVal(4 + c, r, Qn, x5, xA, xB);
            for (let c = 0; c < 16; c++) sums[c * NK + k] += v0[c >> 2] + v1[c];
          } else {
            for (let b = 0; b < nB; b++) {
              const [s1, s2] = plan.pair(b, d);
              sums[b * NK + k] += setVal(s1, r, Qn, x5, xA, xB) + (s2 === s1 && mode === 'A' ? setVal(s1, r, Qn, x5, xA, xB) : setVal(s2, r, Qn, x5, xA, xB));
            }
          }
        }
      }
      for (let i = 0; i < sums.length; i++) sums[i] /= trials;
      return sums;
    };
    const first = runPass(L.ALL_KEEPS, L.ALL_PAIRS, P.t1, Math.min(Q, 4), pooled);
    const keep = new Uint8Array(NK);
    const byDraw = keepsByDraw(L).lists;
    const firstBlocks = pooled ? 1 : nB, k2 = pooled ? P.k2 + 2 : P.k2;
    for (let blk = 0; blk < firstBlocks; blk++) for (let d = 0; d < 4; d++) {
      const ids = Array.from(byDraw[d]).sort((x, y) => first[blk * NK + y] - first[blk * NK + x]);
      for (let n = 0; n < Math.min(k2, ids.length); n++) keep[ids[n]] = 1;
    }
    const survivors = [];
    for (let k = 0; k < NK; k++) if (keep[k]) survivors.push(k);
    const surv = Int16Array.from(survivors);
    const second = runPass(surv, X.pairsNeeded(L, surv), P.t2, Q, false);
    const outAvg = new Float64Array(nB * NK).fill(NaN);
    for (const k of survivors) for (let blk = 0; blk < nB; blk++) outAvg[blk * NK + k] = second[blk * NK + k];
    return outAvg;
  }

  // Scout hands [from, to) of the scouting seat's population. spec.mode: 'A' or 0/1/2.
  // Returns per hand and block: best keep and its EV for each draw count (nBlocks*4).
  function scoutRange3(ctx, from, to, spec, P) {
    const L = ctx.L, NK = L.NKEEPS, mode = spec.mode;
    const plan = setPlan(mode);
    const bank = buildBank(ctx, P.R);
    const fields = buildFields3(ctx, bank, spec, plan, P.Q);
    const nB = plan.nBlocks, per = nB * 4;
    const pop = spec['pop' + spec.seat];
    const keeps = new Int16Array((to - from) * per), evs = new Float32Array((to - from) * per);
    const scratch = { used: new Uint8Array(52), loc: new Int32Array(ctx.H + 3), pvA: new Int32Array(X.MAX_PAIRS), pvB: new Int32Array(X.MAX_PAIRS) };
    const rp = mode === 'A' ? { t1: P.tA1, t2: P.tA2, k2: P.k2 } : { t1: P.tC1, t2: P.tC2, k2: P.k2 };
    let blockCum = null;
    if (mode === 2) {
      blockCum = new Float64Array(16);
      let acc = 0;
      for (let c = 0; c < 16; c++) { acc += spec.blockW[c] + 1e-4; blockCum[c] = acc; }
    }
    const lists = keepsByDraw(L).lists;
    for (let h = from; h < to; h++) {
      const avg = raceHand3(ctx, bank, fields, plan, mode, handAt(ctx, pop, h), rp, scratch, blockCum);
      for (let blk = 0; blk < nB; blk++) for (let d = 0; d < 4; d++) {
        let bk = -1, bv = -Infinity;
        for (const k of lists[d]) { const x = avg[blk * NK + k]; if (x === x && x > bv) { bv = x; bk = k; } }
        const o = (h - from) * per + blk * 4 + d;
        keeps[o] = bk; evs[o] = bv;
      }
    }
    return { keeps, evs };
  }

  // ---------------------------------------------------------------------------
  // Fictitious-play bookkeeping
  // ---------------------------------------------------------------------------
  function stepAll(sig, ev, nCtx, alpha) {
    for (let i = 0; i < nCtx; i++) {
      const off = i * 4;
      let best = 0;
      for (let d = 1; d < 4; d++) if (ev[off + d] > ev[off + best]) best = d;
      for (let d = 0; d < 4; d++) sig[off + d] = (1 - alpha) * sig[off + d] + (d === best ? alpha : 0);
    }
  }
  // Opening strategies from the made-hand scouting: every context gets the same keep per
  // draw count, and each hand starts on its best draw count.
  function openingState(M, a0, a1, a2) {
    const keep0 = Int16Array.from(a0.keeps), ev0 = Float32Array.from(a0.evs);
    const keep1 = new Int16Array(M * 16), ev1 = new Float32Array(M * 16);
    const keep2 = new Int16Array(M * 64), ev2 = new Float32Array(M * 64);
    for (let j = 0; j < M; j++) for (let x = 0; x < 4; x++) for (let d = 0; d < 4; d++) {
      keep1[j * 16 + x * 4 + d] = a1.keeps[j * 4 + d]; ev1[j * 16 + x * 4 + d] = a1.evs[j * 4 + d];
    }
    for (let j = 0; j < M; j++) for (let c = 0; c < 16; c++) for (let d = 0; d < 4; d++) {
      keep2[(j * 16 + c) * 4 + d] = a2.keeps[j * 4 + d]; ev2[(j * 16 + c) * 4 + d] = a2.evs[j * 4 + d];
    }
    const sig0 = new Float64Array(M * 4), sig1 = new Float64Array(M * 16), sig2 = new Float64Array(M * 64);
    stepAll(sig0, ev0, M, 1); stepAll(sig1, ev1, M * 4, 1); stepAll(sig2, ev2, M * 16, 1);
    return { keep0, keep1, keep2, ev0, ev1, ev2, sig0, sig1, sig2 };
  }

  // What scouting seat `mode` needs to know about the other two (structured-clone friendly).
  function scoutSpec(mode, st, extra = {}) {
    const base = { mode, seat: extra.seat !== undefined ? extra.seat : mode, M: st.M, ...extra };
    if (mode === 'A') return { ...base, ['pop' + base.seat]: st.pops[base.seat], ['pop' + extra.otherPop]: st.pops[extra.otherPop] };
    if (mode === 0) return { ...base, pop0: st.pops[0], pop1: st.pops[1], pop2: st.pops[2], keep1: st.keep1, sig1: st.sig1, keep2: st.keep2, sig2: st.sig2 };
    if (mode === 1) return { ...base, pop0: st.pops[0], pop1: st.pops[1], pop2: st.pops[2], keep0: st.keep0, cw0: posterior0(st.sig0, st.M), keep2: st.keep2, sig2: st.sig2 };
    return { ...base, pop0: st.pops[0], pop1: st.pops[1], pop2: st.pops[2], keep0: st.keep0, cw0: posterior0(st.sig0, st.M), keep1: st.keep1, cw1: posterior1(st.sig1, st.M), blockW: contextWeights(st.sig0, st.sig1, st.M) };
  }
  // The two opponents a seat's real hand is evaluated against.
  function opponentSpec(seat, st) {
    const M = st.M;
    if (seat === 0) return { M, pop1: st.pops[1], pop2: st.pops[2], keep1: st.keep1, sig1: st.sig1, keep2: st.keep2, sig2: st.sig2 };
    if (seat === 1) return { M, pop0: st.pops[0], pop2: st.pops[2], keep0: st.keep0, cw0: posterior0(st.sig0, M), keep2: st.keep2, sig2: st.sig2 };
    return { M, pop0: st.pops[0], pop1: st.pops[1], keep0: st.keep0, cw0: posterior0(st.sig0, M), keep1: st.keep1, cw1: posterior1(st.sig1, M) };
  }

  // ---------------------------------------------------------------------------
  // Real hands
  // ---------------------------------------------------------------------------
  // Sample sets: 1st → my draw count d0 (4); 2nd → (d0 heard, my d1) (16);
  // button → (d0, d1) heard (16). Each sample deals both opponents and all draws.
  function dealScenario3(ctx, sc, hX, hY, hZ) {
    const used = sc.used, base = ctx.base, nb = base.length, H = ctx.H;
    for (let i = 0; i < H; i++) { used[hX[i]] = 1; used[hY[i]] = 1; used[hZ[i]] = 1; }
    for (let k = 0; k < 13; k++) {
      let c;
      do { c = base[(Math.random() * nb) | 0]; } while (used[c]);
      used[c] = 1;
      sc.deal[k] = c;
    }
    for (let i = 0; i < H; i++) { used[hX[i]] = 0; used[hY[i]] = 0; used[hZ[i]] = 0; }
    for (let k = 0; k < 13; k++) used[sc.deal[k]] = 0;
    const d = sc.deal;
    sc.boardA[0] = ctx.flopA[0]; sc.boardA[1] = ctx.flopA[1]; sc.boardA[2] = ctx.flopA[2]; sc.boardA[3] = d[0]; sc.boardA[4] = d[1];
    sc.boardB[0] = ctx.flopB[0]; sc.boardB[1] = ctx.flopB[1]; sc.boardB[2] = ctx.flopB[2]; sc.boardB[3] = d[2]; sc.boardB[4] = d[3];
    F.prepBoard(sc.boardA, sc.ctxA);
    F.prepBoard(sc.boardB, sc.ctxB);
    for (let i = 0; i < H; i++) { sc.locX[i] = hX[i]; sc.locY[i] = hY[i]; sc.locZ[i] = hZ[i]; }
    for (let k = 0; k < 3; k++) { sc.locX[H + k] = d[4 + k]; sc.locY[H + k] = d[7 + k]; sc.locZ[H + k] = d[10 + k]; }
  }

  function observeRange3(ctx, cards, seat, opp, s0, s1, rawCap) {
    const L = ctx.L, H = ctx.H, NK = L.NKEEPS;
    const sc = X.makeScratch();
    sc.deal = new Int32Array(13);
    sc.locZ = new Int32Array(X.MAX_LOCAL);
    sc.z5 = new Int32Array(X.MAX_KEEPS); sc.zA = new Int32Array(X.MAX_KEEPS); sc.zB = new Int32Array(X.MAX_KEEPS);
    const hand = Int32Array.from(cards);
    const [mlo, mhi] = cardsMask(hand);
    const byDraw = keepsByDraw(L);
    const nSets = OBS_SETS[seat];
    const sums = new Float64Array(nSets * NK), sq = new Float64Array(nSets * NK), cnt = new Float64Array(nSets * NK);
    const rawFrom = s0, rawTo = Math.min(s1, rawCap), rawLen = Math.max(0, rawTo - rawFrom);
    const raw = new Int8Array(nSets * NK * rawLen);
    const sample = makeSampler(ctx, opp);
    const oA = [0, 0, 0], oB = [0, 0, 0];
    const one = new Int16Array(1);
    const clash = (pi, j, k, lo0, hi0) => {
      const [lo, hi] = keepMask(L, handAt(ctx, opp['pop' + pi], j), k);
      return (lo & lo0) || (hi & hi0);
    };
    for (let set = 0; set < nSets; set++) {
      // My keeps scored in this set, and the two opponent draws that define it.
      let myList, myPairs;
      if (seat === 0) { myList = byDraw.lists[set]; myPairs = byDraw.pairs[set]; }
      else if (seat === 1) { myList = byDraw.lists[set & 3]; myPairs = byDraw.pairs[set & 3]; }
      else { myList = L.ALL_KEEPS; myPairs = L.ALL_PAIRS; }
      for (let s = s0; s < s1; s++) {
        let tries = 0;
        do {
          if (seat === 0) {
            // 2nd answers my d0; the button answers (d0, that d1).
            const j1 = (Math.random() * opp.M) | 0, d1 = sampleDist(opp.sig1, j1 * 16 + set * 4);
            oA[0] = 1; oA[1] = j1; oA[2] = opp.keep1[j1 * 16 + set * 4 + d1];
            sample('R2', set * 4 + d1, oB);
          } else if (seat === 1) {
            sample('P0', set >> 2, oA);
            sample('R2', set, oB);
          } else {
            sample('P0', set >> 2, oA);
            sample('P1', set, oB);
          }
          if (clash(oA[0], oA[1], oA[2], mlo, mhi) || clash(oB[0], oB[1], oB[2], mlo, mhi)) continue;
          const [alo, ahi] = keepMask(L, handAt(ctx, opp['pop' + oA[0]], oA[1]), oA[2]);
          if (clash(oB[0], oB[1], oB[2], alo, ahi)) continue;
          break;
        } while (++tries < 200);
        const hA = handAt(ctx, opp['pop' + oA[0]], oA[1]), hB = handAt(ctx, opp['pop' + oB[0]], oB[1]);
        dealScenario3(ctx, sc, hand, hA, hB);
        one[0] = oA[2];
        evalKeeps(L, sc, sc.locY, one, L.KEEP_PAIRS.subarray(oA[2] * 10, oA[2] * 10 + 10), sc.y5, sc.yA, sc.yB);
        one[0] = oB[2];
        evalKeeps(L, sc, sc.locZ, one, L.KEEP_PAIRS.subarray(oB[2] * 10, oB[2] * 10 + 10), sc.z5, sc.zA, sc.zB);
        evalKeeps(L, sc, sc.locX, myList, myPairs, sc.x5, sc.xA, sc.xB);
        const a5 = sc.y5[oA[2]], aA = sc.yA[oA[2]], aB = sc.yB[oA[2]];
        const b5 = sc.z5[oB[2]], bA = sc.zA[oB[2]], bB = sc.zB[oB[2]];
        for (let n = 0; n < myList.length; n++) {
          const ki = myList[n];
          const x5 = sc.x5[ki], xA = sc.xA[ki], xB = sc.xB[ki];
          const v = payoff(x5, xA, xB, a5, aA, aB) + payoff(x5, xA, xB, b5, bA, bB);
          const idx = set * NK + ki;
          sums[idx] += v; sq[idx] += v * v; cnt[idx] += 1;
          if (s < rawTo) raw[idx * rawLen + (s - rawFrom)] = v;
        }
      }
    }
    return { sums, sq, cnt, raw, rawLen };
  }

  // Merge observeRange3 chunks into EVs, standard errors and the "solver plays" mix for
  // every decision block (1st: 1, 2nd: one per d0, button: one per (d0, d1)).
  function finalizeObserver3(L, seat, chunks) {
    const NK = L.NKEEPS, KD = L.KEEP_DRAW, nSets = OBS_SETS[seat], nB = BLOCKS[seat];
    const sums = new Float64Array(nSets * NK), sq = new Float64Array(nSets * NK), cnt = new Float64Array(nSets * NK);
    let rawLen = 0;
    for (const c of chunks) {
      for (let i = 0; i < nSets * NK; i++) { sums[i] += c.sums[i]; sq[i] += c.sq[i]; cnt[i] += c.cnt[i]; }
      rawLen += c.rawLen;
    }
    const raw = new Int8Array(nSets * NK * rawLen);
    let off = 0;
    for (const c of chunks) {
      for (let i = 0; i < nSets * NK; i++) raw.set(c.raw.subarray(i * c.rawLen, (i + 1) * c.rawLen), i * rawLen + off);
      off += c.rawLen;
    }
    const setOf = (b, k) => (seat === 0 ? KD[k] : seat === 1 ? b * 4 + KD[k] : b);
    const ev = new Float64Array(nB * NK), se = new Float64Array(nB * NK), freq = new Float64Array(nB * NK), seDiff = new Float64Array(nB * NK);
    for (let b = 0; b < nB; b++) {
      for (let k = 0; k < NK; k++) {
        const idx = setOf(b, k) * NK + k, n = cnt[idx];
        const m = n ? sums[idx] / n : -99;
        const v = n > 1 ? Math.max(0, (sq[idx] - n * m * m) / (n - 1)) : 0;
        ev[b * NK + k] = m;
        se[b * NK + k] = n ? Math.sqrt(v / n) : 0;
      }
      let best = 0;
      for (let k = 1; k < NK; k++) if (ev[b * NK + k] > ev[b * NK + best]) best = k;
      const bSet = setOf(b, best), bIdx = bSet * NK + best;
      const w = new Float64Array(NK);
      for (let k = 0; k < NK; k++) {
        const kSet = setOf(b, k), kIdx = kSet * NK + k;
        let s;
        if (kSet === bSet && rawLen > 1) {
          let m = 0, m2 = 0;
          for (let x = 0; x < rawLen; x++) { const dd = raw[kIdx * rawLen + x] - raw[bIdx * rawLen + x]; m += dd; m2 += dd * dd; }
          m /= rawLen;
          const vd = Math.max(0, (m2 - rawLen * m * m) / (rawLen - 1));
          s = Math.sqrt(vd / Math.max(1, cnt[kIdx]));
        } else {
          s = Math.sqrt(se[b * NK + k] ** 2 + se[b * NK + best] ** 2);
        }
        seDiff[b * NK + k] = s;
        const gap = ev[b * NK + best] - ev[b * NK + k];
        if (k === best) w[k] = 1;
        else if (s > 0 && gap <= s) w[k] = Math.exp(-0.5 * (gap / s) ** 2);
      }
      let tot = 0;
      for (let k = 0; k < NK; k++) tot += w[k];
      for (let k = 0; k < NK; k++) freq[b * NK + k] = w[k] / tot;
    }
    return { ev: Array.from(ev), se: Array.from(se), seDiff: Array.from(seDiff), freq: Array.from(freq), samples: Math.max(...cnt), blocks: nB };
  }

  // "Hands like yours", per decision block: the equilibrium mix of the 40 sampled hands
  // (same seat) whose EV-by-draw-count profile in that block is closest to yours.
  function similarHandsMix3(L, seat, fin, st, k = 40) {
    const NK = L.NKEEPS, M = st.M, nB = BLOCKS[seat];
    const evArr = [st.ev0, st.ev1, st.ev2][seat], sigArr = [st.sig0, st.sig1, st.sig2][seat];
    const offOf = (h, b) => (seat === 0 ? h * 4 : seat === 1 ? h * 16 + b * 4 : (h * 16 + b) * 4);
    const mix = [];
    for (let b = 0; b < nB; b++) {
      const vec = [0, 1, 2, 3].map((d) => {
        let m = -Infinity;
        for (let x = 0; x < NK; x++) if (L.KEEP_DRAW[x] === d) m = Math.max(m, fin.ev[b * NK + x]);
        return m;
      });
      const dist = [];
      for (let h = 0; h < M; h++) {
        const o = offOf(h, b);
        let s = 0;
        for (let d = 0; d < 4; d++) { const v = evArr[o + d] - vec[d]; s += v * v; }
        dist.push([s, h]);
      }
      dist.sort((x, y) => x[0] - y[0]);
      const near = dist.slice(0, k).map((x) => x[1]);
      const m = [0, 0, 0, 0];
      for (const h of near) for (let d = 0; d < 4; d++) m[d] += sigArr[offOf(h, b) + d] / near.length;
      mix.push(m);
    }
    return { n: Math.min(k, M), mix };
  }

  // ---------------------------------------------------------------------------
  // Summary and range viewer data
  // ---------------------------------------------------------------------------
  // Unbiased seat values: deal n fresh three-way hands from the populations, let each seat
  // play its solved (mixed) strategy given what it heard, and score every matchup. Unlike
  // the scouting EVs (each the best of many noisy estimates), these sum to exactly zero.
  function selfPlay3(ctx, st, n = 20000) {
    const L = ctx.L, M = st.M;
    const sc = X.makeScratch();
    sc.deal = new Int32Array(13); sc.locZ = new Int32Array(X.MAX_LOCAL);
    sc.z5 = new Int32Array(X.MAX_KEEPS); sc.zA = new Int32Array(X.MAX_KEEPS); sc.zB = new Int32Array(X.MAX_KEEPS);
    const one = new Int16Array(1);
    const tot = [0, 0, 0], sq = [0, 0, 0];
    const val = (loc, k, o5, oA, oB) => { one[0] = k; evalKeeps(L, sc, loc, one, L.KEEP_PAIRS.subarray(k * 10, k * 10 + 10), o5, oA, oB); return [o5[k], oA[k], oB[k]]; };
    let done = 0;
    for (let t = 0; t < n * 3 && done < n; t++) {
      const h0 = (Math.random() * M) | 0, h1 = (Math.random() * M) | 0, h2 = (Math.random() * M) | 0;
      const d0 = sampleDist(st.sig0, h0 * 4), k0 = st.keep0[h0 * 4 + d0];
      const d1 = sampleDist(st.sig1, h1 * 16 + d0 * 4), k1 = st.keep1[h1 * 16 + d0 * 4 + d1];
      const c = d0 * 4 + d1, d2 = sampleDist(st.sig2, (h2 * 16 + c) * 4), k2 = st.keep2[(h2 * 16 + c) * 4 + d2];
      const hA = handAt(ctx, st.pops[0], h0), hB = handAt(ctx, st.pops[1], h1), hC = handAt(ctx, st.pops[2], h2);
      const m0 = keepMask(L, hA, k0), m1 = keepMask(L, hB, k1), m2 = keepMask(L, hC, k2);
      if ((m0[0] & m1[0]) || (m0[1] & m1[1]) || (m0[0] & m2[0]) || (m0[1] & m2[1]) || (m1[0] & m2[0]) || (m1[1] & m2[1])) continue;
      dealScenario3(ctx, sc, hA, hB, hC);
      const a = val(sc.locX, k0, sc.x5, sc.xA, sc.xB), b = val(sc.locY, k1, sc.y5, sc.yA, sc.yB), z = val(sc.locZ, k2, sc.z5, sc.zA, sc.zB);
      const ab = payoff(a[0], a[1], a[2], b[0], b[1], b[2]), az = payoff(a[0], a[1], a[2], z[0], z[1], z[2]), bz = payoff(b[0], b[1], b[2], z[0], z[1], z[2]);
      const v = [ab + az, -ab + bz, -az - bz];
      for (let s = 0; s < 3; s++) { tot[s] += v[s]; sq[s] += v[s] * v[s]; }
      done++;
    }
    const mean = tot.map((x) => x / Math.max(1, done));
    const se = sq.map((x, s) => Math.sqrt(Math.max(0, x / Math.max(1, done) - mean[s] * mean[s]) / Math.max(1, done)));
    return { values: mean, se, n: done };
  }

  function summary3(st, P, ctx) {
    const M = st.M;
    const draw0 = [0, 0, 0, 0];
    let v0 = 0, g0 = 0;
    for (let h = 0; h < M; h++) {
      let ev = 0, mx = -Infinity;
      for (let d = 0; d < 4; d++) { draw0[d] += st.sig0[h * 4 + d] / M; ev += st.sig0[h * 4 + d] * st.ev0[h * 4 + d]; mx = Math.max(mx, st.ev0[h * 4 + d]); }
      v0 += ev / M; g0 += (mx - ev) / M;
    }
    const draw1Given = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    const v1Given = [0, 0, 0, 0], g1Given = [0, 0, 0, 0];
    for (let j = 0; j < M; j++) for (let d0 = 0; d0 < 4; d0++) {
      let ev = 0, mx = -Infinity;
      for (let d1 = 0; d1 < 4; d1++) { const i = j * 16 + d0 * 4 + d1; draw1Given[d0][d1] += st.sig1[i] / M; ev += st.sig1[i] * st.ev1[i]; mx = Math.max(mx, st.ev1[i]); }
      v1Given[d0] += ev / M; g1Given[d0] += (mx - ev) / M;
    }
    const draw2Given = Array.from({ length: 16 }, () => [0, 0, 0, 0]);
    const v2Given = new Array(16).fill(0), g2Given = new Array(16).fill(0);
    for (let j = 0; j < M; j++) for (let c = 0; c < 16; c++) {
      let ev = 0, mx = -Infinity;
      for (let d2 = 0; d2 < 4; d2++) { const i = (j * 16 + c) * 4 + d2; draw2Given[c][d2] += st.sig2[i] / M; ev += st.sig2[i] * st.ev2[i]; mx = Math.max(mx, st.ev2[i]); }
      v2Given[c] += ev / M; g2Given[c] += (mx - ev) / M;
    }
    let v1 = 0, g1 = 0, v2 = 0, g2 = 0;
    const ctxP = new Array(16).fill(0);
    for (let d0 = 0; d0 < 4; d0++) {
      v1 += draw0[d0] * v1Given[d0]; g1 += draw0[d0] * g1Given[d0];
      for (let d1 = 0; d1 < 4; d1++) {
        const p = draw0[d0] * draw1Given[d0][d1], c = d0 * 4 + d1;
        ctxP[c] = p; v2 += p * v2Given[c]; g2 += p * g2Given[c];
      }
    }
    // Seat values from self-play when a context is available (unbiased, sum to 0); the
    // scouted averages above are each the best of several noisy estimates, so they run high.
    const sp = ctx ? selfPlay3(ctx, st, P.selfPlay || 40000) : null;
    return {
      players: 3, M, rounds: P.rounds3, obs: P.obs,
      values: sp ? sp.values : [v0, v1, v2], valuesSe: sp ? sp.se : null, // stakes per hand per seat
      scoutedValues: [v0, v1, v2],
      exploitability: (g0 + g1 + g2) / 3,
      draw0, draw1Given, draw2Given, v1Given, v2Given, ctxP
    };
  }

  function rangeSummary3(st) {
    const M = st.M, H = st.pops[0].length / M;
    const cats = st.pops.map((pop) => {
      const out = new Int8Array(M);
      for (let h = 0; h < M; h++) out[h] = X.madeCategory(pop.subarray(h * H, h * H + H));
      return out;
    });
    const agg = (cat, weightOf, mixOf) => {
      const rows = S.RANGE_CATS.map((name) => ({ name, share: 0, mix: [0, 0, 0, 0] }));
      let total = 0;
      for (let h = 0; h < M; h++) {
        const w = weightOf(h);
        if (w <= 0) continue;
        total += w;
        const row = rows[cat[h]];
        row.share += w;
        if (mixOf) { const m = mixOf(h); for (let d = 0; d < 4; d++) row.mix[d] += w * m[d]; }
      }
      for (const r of rows) { if (r.share > 0) r.mix = r.mix.map((x) => x / r.share); r.share = total > 0 ? r.share / total : 0; }
      return rows;
    };
    const mix4 = (arr, off) => [arr[off], arr[off + 1], arr[off + 2], arr[off + 3]];
    const s0 = agg(cats[0], () => 1, (h) => mix4(st.sig0, h * 4));
    const s1 = [0, 1, 2, 3].map((d0) => agg(cats[1], () => 1, (j) => mix4(st.sig1, j * 16 + d0 * 4)));
    const s2 = Array.from({ length: 16 }, (_, c) => agg(cats[2], () => 1, (j) => mix4(st.sig2, (j * 16 + c) * 4)));
    const given0 = [0, 1, 2, 3].map((d0) => agg(cats[0], (h) => st.sig0[h * 4 + d0], null).map((r) => ({ name: r.name, share: r.share })));
    const given1 = Array.from({ length: 16 }, (_, c) => agg(cats[1], (j) => st.sig1[j * 16 + c], null).map((r) => ({ name: r.name, share: r.share })));
    return { players: 3, cats: S.RANGE_CATS, s0, s1, s2, given0, given1 };
  }

  // ---------------------------------------------------------------------------
  // Post-discard EV against several opponents: my kept cards vs each opponent's kept
  // cards, averaged over everyone's draws and the turns/rivers (Monte Carlo, seedable for
  // common random numbers). Returns my total (the sum of my matchups).
  //   opps: [{ keep, draw }]; dead: cards that can't come off the deck.
  // ---------------------------------------------------------------------------
  function keepEquityMulti({ meKeep, meDraw, opps, flopA, flopB, dead, samples = 6000, seed = null }) {
    const rand = seed === null ? Math.random : X.mulberry32(seed);
    const toI = (c) => (typeof c === 'string' ? F.toInt(c) : c);
    const mk = meKeep.map(toI), fa = flopA.map(toI), fb = flopB.map(toI);
    const ok = opps.map((o) => ({ keep: o.keep.map(toI), draw: o.draw }));
    const deadSet = new Set(dead.map(toI));
    const deck = [];
    for (let c = 0; c < 52; c++) if (!deadSet.has(c)) deck.push(c);
    const need = 4 + meDraw + ok.reduce((a, o) => a + o.draw, 0);
    const n = deck.length, d = deck.slice();
    let total = 0;
    for (let t = 0; t < samples; t++) {
      for (let i = 0; i < need; i++) { const j = i + ((rand() * (n - i)) | 0); const x = d[i]; d[i] = d[j]; d[j] = x; }
      // Boards first, then each opponent's draws, then mine — so two keeps of mine compared
      // on the same seed share boards and opponents' draws even with different draw counts.
      const bA = [...fa, d[0], d[1]], bB = [...fb, d[2], d[3]];
      let p = 4;
      const finals = ok.map((o) => { const f = o.keep.concat(d.slice(p, p + o.draw)); p += o.draw; return f; });
      const me = mk.concat(d.slice(p, p + meDraw));
      const m5 = F.eval5(me[0], me[1], me[2], me[3], me[4]), mA = F.ploBest(me, bA), mB = F.ploBest(me, bB);
      for (const op of finals) {
        const s = Math.sign(m5 - F.eval5(op[0], op[1], op[2], op[3], op[4])) + Math.sign(mA - F.ploBest(op, bA)) + Math.sign(mB - F.ploBest(op, bB));
        total += s === 3 ? 6 : s === -3 ? -6 : s;
      }
    }
    return total / samples;
  }

  // Rounds of fictitious play per preset (the heads-up presets' other numbers are reused).
  const ROUNDS3 = { fast: 3, standard: 3, deep: 4, max: 4, ultra: 5 };
  const ALPHAS3 = [0.8, 0.5, 0.4, 0.33, 0.28];
  function presetFor(preset, overrides = {}) {
    const base = S.PRESETS[preset] || S.PRESETS.deep;
    return { ...base, rounds3: ROUNDS3[preset] || 4, ...overrides };
  }

  // Single-threaded runner (Node, tests, experiments). observers: [{ id, seat: 0|1|2, cards }].
  function runAll3({ flopA, flopB, observers = [], handSize, preset = 'standard', overrides = {}, log = () => {} }) {
    const H = handSize || (observers[0] ? observers[0].cards.length : 9);
    const P = presetFor(preset, overrides);
    const ctx = S.makeContext(flopA.map(F.toInt), flopB.map(F.toInt), H);
    const M = P.M, t0 = Date.now();
    const pops = [0, 1, 2].map(() => S.samplePopulation(ctx, M));
    const st0 = { M, pops };
    const open = [0, 1, 2].map((seat) => scoutRange3(ctx, 0, M, scoutSpec('A', st0, { seat, otherPop: (seat + 1) % 3 }), P));
    const st = { M, pops, ...openingState(M, open[0], open[1], open[2]) };
    log(`opening ${Date.now() - t0}ms`);
    for (let it = 1; it <= P.rounds3; it++) {
      const alpha = ALPHAS3[it - 1] || 1 / (it + 1);
      for (const seat of [0, 1, 2]) {
        const r = scoutRange3(ctx, 0, M, scoutSpec(seat, st), P);
        st['keep' + seat] = r.keeps; st['ev' + seat] = r.evs;
        stepAll(st['sig' + seat], r.evs, M * BLOCKS[seat], alpha);
      }
      const s = summary3(st, P);
      log(`round ${it} ${Date.now() - t0}ms 1st draws ${s.draw0.map((x) => x.toFixed(2))}`);
    }
    const obs = observers.map((o) => {
      const chunk = observeRange3(ctx, o.cards.map(F.toInt), o.seat, opponentSpec(o.seat, st), 0, P.obs, RAW_CAP3);
      const fin = finalizeObserver3(ctx.L, o.seat, [chunk]);
      return { id: o.id, seat: o.seat, ...fin, similar: similarHandsMix3(ctx.L, o.seat, fin, st) };
    });
    log(`observers ${Date.now() - t0}ms`);
    return { summary: summary3(st, P, ctx), observers: obs, range: rangeSummary3(st) };
  }

  return {
    SEATS, BLOCKS, OBS_SETS, RAW_CAP3, ROUNDS3, ALPHAS3, presetFor, selfPlay3,
    posterior0, posterior1, contextWeights, scoutRange3, scoutSpec, opponentSpec, openingState, stepAll,
    observeRange3, finalizeObserver3, similarHandsMix3, summary3, rangeSummary3, keepEquityMulti, runAll3
  };
});
