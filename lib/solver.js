// lib/solver.js — approximate equilibrium solver for Drawmaha Duel's draw decision.
//
// THE GAME BEING SOLVED
// Once the two flops are face up, the rest of a hand is a small two-player game with
// hidden information: OOP picks which 2–5 of their 9 cards to keep; the number of cards
// they draw (0–3) is public; IP sees that number and picks their own keep; then the
// turns and rivers fall and three 1-unit contests are settled (scoop = double). There is
// no betting, so all of the strategy lives in those two keep decisions — and in what
// OOP's draw count reveals.
//
// HOW IT IS APPROXIMATED
// The exact game is far too large (each player has C(46,9) ≈ 1.2 billion possible hands
// and 372 ways to keep from each), so we solve a sampled abstraction of it per flop pair:
//
//   1. Population. Sample N random 9-card hands for each seat ("what OOP/IP could hold
//      on these flops"). Neither player's real hand is part of this population, so the
//      solved strategies use only public information.
//   2. Candidate keeps. Score all 372 keeps for every population hand by Monte Carlo
//      against a crude field (round A), then against the field's round-A choices
//      (round B), and keep the best few per draw count (K candidates per hand). Keeping
//      candidates for every draw count matters: it is what lets a hand *choose* how much
//      to reveal.
//   3. Payoff tensor. For every OOP hand × IP hand pairing, run R random scenarios
//      (both players' draw cards + both turns and rivers) and record the payoff of every
//      candidate keep against every candidate keep. Keeps that would need the same card
//      are skipped. (Approximation: the opponent's *discards* are not removed from the
//      deck. Only the cards each side keeps are kept disjoint.)
//   4. CFR+. Run counterfactual regret minimisation on the resulting finite game: OOP's
//      information set is its hand; IP's is (its hand, OOP's announced draw count). The
//      averaged strategies converge to a Nash equilibrium of the sampled game. A small
//      "tremble" keeps every OOP draw count slightly reachable, so IP also learns
//      sensible responses to announcements that equilibrium OOP rarely makes.
//   5. Observers. The two real hands are evaluated against the population with all 372
//      keeps (and more scenarios per pairing) and run their own regret minimisers
//      alongside. Observers never feed back into the population, which is what stops the
//      bot from peeking at your hand (and the study panel from peeking at the bot's).
//
// Units: payoffs are in contest units (win a contest = +1, scoop = ±6). Multiply by the
// stake to get dollars.
//
// The phases are separate pure functions over plain typed arrays so the browser can
// spread the expensive ones across several Web Workers; runAll() chains them for Node.
(function (root, factory) {
  const F = (typeof module !== 'undefined' && module.exports) ? require('./fasteval.js') : root.FastEval;
  const lib = factory(F);
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
  else root.Solver = lib;
})(typeof self !== 'undefined' ? self : this, function (F) {
  F.init();

  // ---------------------------------------------------------------------------
  // Keep enumeration. Local card slots 0..8 are the 9 dealt cards; 9..11 are the first
  // three cards that player would draw in a scenario ("the draw stream").
  // ---------------------------------------------------------------------------
  const NLOCAL = 12;
  const PAIR_ID = new Int8Array(NLOCAL * NLOCAL).fill(-1);
  const PAIR_I = [], PAIR_J = [];
  for (let i = 0; i < NLOCAL; i++) for (let j = i + 1; j < NLOCAL; j++) {
    PAIR_ID[i * NLOCAL + j] = PAIR_I.length; PAIR_I.push(i); PAIR_J.push(j);
  }
  const NPAIRS = PAIR_I.length; // 66

  const KEEPS = []; // { slots: [kept local slots], draw }
  for (let draw = 0; draw <= 3; draw++) {
    const k = 5 - draw;
    const rec = (start, acc) => {
      if (acc.length === k) { KEEPS.push({ slots: acc.slice(), draw }); return; }
      for (let i = start; i < 9; i++) { acc.push(i); rec(i + 1, acc); acc.pop(); }
    };
    rec(0, []);
  }
  const NKEEPS = KEEPS.length; // 372
  const KEEP_DRAW = new Int8Array(NKEEPS);
  const KEEP_MASK9 = new Int32Array(NKEEPS);
  const KEEP_FINAL = new Int8Array(NKEEPS * 5);
  const KEEP_PAIRS = new Int8Array(NKEEPS * 10);
  KEEPS.forEach((kp, ki) => {
    KEEP_DRAW[ki] = kp.draw;
    const fin = kp.slots.slice();
    for (let s = 0; s < kp.draw; s++) fin.push(9 + s);
    fin.forEach((slot, n) => { KEEP_FINAL[ki * 5 + n] = slot; });
    kp.slots.forEach((slot) => { KEEP_MASK9[ki] |= 1 << slot; });
    let p = 0;
    for (let x = 0; x < 5; x++) for (let y = x + 1; y < 5; y++) {
      const a = Math.min(fin[x], fin[y]), b = Math.max(fin[x], fin[y]);
      KEEP_PAIRS[ki * 10 + p++] = PAIR_ID[a * NLOCAL + b];
    }
  });
  const ALL_KEEPS = Int16Array.from({ length: NKEEPS }, (_, i) => i);
  const ALL_PAIRS = Int8Array.from({ length: NPAIRS }, (_, i) => i);

  function pairsNeeded(keepList) {
    const need = new Uint8Array(NPAIRS);
    for (const ki of keepList) for (let p = 0; p < 10; p++) need[KEEP_PAIRS[ki * 10 + p]] = 1;
    const out = [];
    for (let i = 0; i < NPAIRS; i++) if (need[i]) out.push(i);
    return Int8Array.from(out);
  }

  // Bitmask (two 32-bit halves) of the real cards a keep holds, for card-conflict checks.
  function keepMask(cards9, ki) {
    let lo = 0, hi = 0;
    const m = KEEP_MASK9[ki];
    for (let s = 0; s < 9; s++) if (m & (1 << s)) {
      const c = cards9[s];
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
  function makeContext(flopA, flopB) {
    const used = new Uint8Array(52);
    for (const c of flopA) used[c] = 1;
    for (const c of flopB) used[c] = 1;
    const base = [];
    for (let c = 0; c < 52; c++) if (!used[c]) base.push(c);
    return { flopA: Int32Array.from(flopA), flopB: Int32Array.from(flopB), base: Int32Array.from(base) };
  }

  // Scratch space reused by every scenario evaluation (single-threaded per worker).
  function makeScratch() {
    return {
      used: new Uint8Array(52),
      deal: new Int32Array(10),
      boardA: new Int32Array(5), boardB: new Int32Array(5),
      ctxA: new Int32Array(50), ctxB: new Int32Array(50),
      locX: new Int32Array(NLOCAL), locY: new Int32Array(NLOCAL),
      pvA: new Int32Array(NPAIRS), pvB: new Int32Array(NPAIRS),
      x5: new Int32Array(NKEEPS), xA: new Int32Array(NKEEPS), xB: new Int32Array(NKEEPS),
      y5: new Int32Array(NKEEPS), yA: new Int32Array(NKEEPS), yB: new Int32Array(NKEEPS)
    };
  }

  // Deal 10 fresh cards (turn A, river A, turn B, river B, 3 draws for X, 3 for Y) from
  // the deck minus the flops and minus both 9-card hands.
  function dealScenario(ctx, sc, handX, handY) {
    const used = sc.used, base = ctx.base, nb = base.length;
    for (let i = 0; i < 9; i++) { used[handX[i]] = 1; used[handY[i]] = 1; }
    for (let k = 0; k < 10; k++) {
      let c;
      do { c = base[(Math.random() * nb) | 0]; } while (used[c]);
      used[c] = 1;
      sc.deal[k] = c;
    }
    for (let i = 0; i < 9; i++) { used[handX[i]] = 0; used[handY[i]] = 0; }
    for (let k = 0; k < 10; k++) used[sc.deal[k]] = 0;
    const d = sc.deal;
    sc.boardA[0] = ctx.flopA[0]; sc.boardA[1] = ctx.flopA[1]; sc.boardA[2] = ctx.flopA[2]; sc.boardA[3] = d[0]; sc.boardA[4] = d[1];
    sc.boardB[0] = ctx.flopB[0]; sc.boardB[1] = ctx.flopB[1]; sc.boardB[2] = ctx.flopB[2]; sc.boardB[3] = d[2]; sc.boardB[4] = d[3];
    F.prepBoard(sc.boardA, sc.ctxA);
    F.prepBoard(sc.boardB, sc.ctxB);
    for (let i = 0; i < 9; i++) { sc.locX[i] = handX[i]; sc.locY[i] = handY[i]; }
    sc.locX[9] = d[4]; sc.locX[10] = d[5]; sc.locX[11] = d[6];
    sc.locY[9] = d[7]; sc.locY[10] = d[8]; sc.locY[11] = d[9];
  }

  // Value a list of keeps for one player in the current scenario.
  // Writes 5-card / board-A PLO / board-B PLO strengths into o5/oA/oB at the keep index.
  function evalKeeps(sc, loc, keepList, pairList, o5, oA, oB) {
    const pvA = sc.pvA, pvB = sc.pvB;
    for (let n = 0; n < pairList.length; n++) {
      const pid = pairList[n];
      const p = loc[PAIR_I[pid]], q = loc[PAIR_J[pid]];
      pvA[pid] = F.pairValue(sc.ctxA, p, q);
      pvB[pid] = F.pairValue(sc.ctxB, p, q);
    }
    for (let n = 0; n < keepList.length; n++) {
      const ki = keepList[n];
      const f = ki * 5;
      o5[ki] = F.eval5(loc[KEEP_FINAL[f]], loc[KEEP_FINAL[f + 1]], loc[KEEP_FINAL[f + 2]], loc[KEEP_FINAL[f + 3]], loc[KEEP_FINAL[f + 4]]);
      let a = -1, b = -1;
      const pp = ki * 10;
      for (let t = 0; t < 10; t++) {
        const pid = KEEP_PAIRS[pp + t];
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
    const out = new Int32Array(n * 9);
    const base = Array.from(ctx.base);
    for (let h = 0; h < n; h++) {
      for (let i = 0; i < 9; i++) {
        const j = i + ((Math.random() * (base.length - i)) | 0);
        const t = base[i]; base[i] = base[j]; base[j] = t;
        out[h * 9 + i] = base[i];
      }
    }
    return out;
  }
  const handAt = (pop, h) => pop.subarray(h * 9, h * 9 + 9);

  // ---------------------------------------------------------------------------
  // Phase 1: candidate keeps.
  //   Round A — each hand's 372 keeps vs random opposite-seat hands playing a random keep.
  //   Round B — vs random opposite-seat hands playing their round-A favourite.
  // `oppKeep` null means round A. Returns, per hand in [from, to): round-A best keep
  // (round A) or the K candidate keeps (round B).
  // ---------------------------------------------------------------------------
  function scoreAllKeeps(ctx, sc, hand, oppPop, oppKeepOf, trials) {
    const sums = new Float64Array(NKEEPS), cnts = new Float64Array(NKEEPS);
    const nOpp = oppPop.length / 9;
    ensureMaskCache(hand);
    for (let t = 0; t < trials; t++) {
      const j = (Math.random() * nOpp) | 0;
      const opp = handAt(oppPop, j);
      const okp = oppKeepOf(j);
      const [olo, ohi] = keepMask(opp, okp);
      dealScenario(ctx, sc, hand, opp);
      evalKeeps(sc, sc.locY, [okp], KEEP_PAIRS.subarray(okp * 10, okp * 10 + 10), sc.y5, sc.yA, sc.yB);
      evalKeeps(sc, sc.locX, ALL_KEEPS, ALL_PAIRS, sc.x5, sc.xA, sc.xB);
      const y5 = sc.y5[okp], yA = sc.yA[okp], yB = sc.yB[okp];
      for (let ki = 0; ki < NKEEPS; ki++) {
        if ((maskCacheLo[ki] & olo) || (maskCacheHi[ki] & ohi)) continue;
        sums[ki] += payoff(sc.x5[ki], sc.xA[ki], sc.xB[ki], y5, yA, yB);
        cnts[ki] += 1;
      }
    }
    const avg = new Float64Array(NKEEPS);
    for (let ki = 0; ki < NKEEPS; ki++) avg[ki] = cnts[ki] ? sums[ki] / cnts[ki] : -99;
    return avg;
  }

  // Small per-hand cache of keep masks (scoreAllKeeps calls this 372 × trials times).
  let maskCacheHand = null;
  const maskCacheLo = new Int32Array(NKEEPS), maskCacheHi = new Int32Array(NKEEPS);
  function ensureMaskCache(hand) {
    if (maskCacheHand === hand) return;
    maskCacheHand = hand;
    for (let k = 0; k < NKEEPS; k++) { const [lo, hi] = keepMask(hand, k); maskCacheLo[k] = lo; maskCacheHi[k] = hi; }
  }

  function prefilterRoundA(ctx, pop, oppPop, from, to, trials) {
    const sc = makeScratch();
    const best = new Int16Array(to - from);
    for (let h = from; h < to; h++) {
      const avg = scoreAllKeeps(ctx, sc, handAt(pop, h), oppPop, () => (Math.random() * NKEEPS) | 0, trials);
      let b = 0;
      for (let ki = 1; ki < NKEEPS; ki++) if (avg[ki] > avg[b]) b = ki;
      best[h - from] = b;
    }
    return best;
  }

  function prefilterRoundB(ctx, pop, oppPop, oppBestA, from, to, trials, perDraw) {
    const sc = makeScratch();
    const K = perDraw * 4;
    const cand = new Int16Array((to - from) * K);
    for (let h = from; h < to; h++) {
      const avg = scoreAllKeeps(ctx, sc, handAt(pop, h), oppPop, (j) => oppBestA[j], trials);
      for (let d = 0; d < 4; d++) {
        const ids = [];
        for (let ki = 0; ki < NKEEPS; ki++) if (KEEP_DRAW[ki] === d) ids.push(ki);
        ids.sort((x, y) => avg[y] - avg[x]);
        for (let n = 0; n < perDraw; n++) cand[(h - from) * K + d * perDraw + n] = ids[n];
      }
    }
    return cand;
  }

  // ---------------------------------------------------------------------------
  // Phase 2: payoff tensor between the two populations.
  // Layout: index ((h*K + a)*N + j)*K + b, h = OOP hand, j = IP hand. S = summed payoff
  // to OOP over `runs` scenarios; C = number of scenarios (0 = card conflict).
  // ---------------------------------------------------------------------------
  function buildTensor(ctx, popO, candO, popI, candI, K, from, to, runs) {
    const N = popI.length / 9;
    const sc = makeScratch();
    const S = new Int16Array((to - from) * K * N * K);
    const C = new Uint8Array((to - from) * K * N * K);
    const listsI = [], pairsI = [], masksI = [];
    for (let j = 0; j < N; j++) {
      const l = candI.subarray(j * K, j * K + K);
      listsI.push(l); pairsI.push(pairsNeeded(l));
      masksI.push(Array.from(l, (ki) => keepMask(handAt(popI, j), ki)));
    }
    const compat = new Uint8Array(K * K);
    for (let h = from; h < to; h++) {
      const handO = handAt(popO, h);
      const listO = candO.subarray(h * K, h * K + K);
      const pairsO = pairsNeeded(listO);
      const masksO = Array.from(listO, (ki) => keepMask(handO, ki));
      for (let j = 0; j < N; j++) {
        let any = false;
        for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) {
          const ok = !((masksO[a][0] & masksI[j][b][0]) || (masksO[a][1] & masksI[j][b][1]));
          compat[a * K + b] = ok ? 1 : 0;
          if (ok) any = true;
        }
        if (!any) continue;
        const handI = handAt(popI, j), listI = listsI[j];
        for (let r = 0; r < runs; r++) {
          dealScenario(ctx, sc, handO, handI);
          evalKeeps(sc, sc.locX, listO, pairsO, sc.x5, sc.xA, sc.xB);
          evalKeeps(sc, sc.locY, listI, pairsI[j], sc.y5, sc.yA, sc.yB);
          for (let a = 0; a < K; a++) {
            const ka = listO[a];
            const x5 = sc.x5[ka], xA = sc.xA[ka], xB = sc.xB[ka];
            const row = (((h - from) * K + a) * N + j) * K;
            for (let b = 0; b < K; b++) {
              if (!compat[a * K + b]) continue;
              const kb = listI[b];
              S[row + b] += payoff(x5, xA, xB, sc.y5[kb], sc.yA[kb], sc.yB[kb]);
              C[row + b] += 1;
            }
          }
        }
      }
    }
    return { S, C };
  }

  // ---------------------------------------------------------------------------
  // Phase 3: an observer (a real hand) vs the opposite population, all 372 keeps.
  // Layout: index (ki*N + j)*K + b; S is summed payoff to the OBSERVER.
  // Opponent keeps that use any of the observer's 9 cards are impossible → C = 0.
  // ---------------------------------------------------------------------------
  function buildObserver(ctx, cards9, oppPop, oppCand, K, runs) {
    const N = oppPop.length / 9;
    const sc = makeScratch();
    const hand = Int32Array.from(cards9);
    const [mlo, mhi] = cardsMask(hand);
    const S = new Int16Array(NKEEPS * N * K);
    const C = new Uint8Array(NKEEPS * N * K);
    for (let j = 0; j < N; j++) {
      const opp = handAt(oppPop, j);
      const list = oppCand.subarray(j * K, j * K + K);
      const pairs = pairsNeeded(list);
      const ok = Array.from(list, (ki) => { const [lo, hi] = keepMask(opp, ki); return !((lo & mlo) || (hi & mhi)); });
      if (!ok.some(Boolean)) continue;
      for (let r = 0; r < runs; r++) {
        dealScenario(ctx, sc, hand, opp);
        evalKeeps(sc, sc.locX, ALL_KEEPS, ALL_PAIRS, sc.x5, sc.xA, sc.xB);
        evalKeeps(sc, sc.locY, list, pairs, sc.y5, sc.yA, sc.yB);
        for (let b = 0; b < K; b++) {
          if (!ok[b]) continue;
          const kb = list[b];
          const y5 = sc.y5[kb], yA = sc.yA[kb], yB = sc.yB[kb];
          for (let ki = 0; ki < NKEEPS; ki++) {
            const idx = (ki * N + j) * K + b;
            S[idx] += payoff(sc.x5[ki], sc.xA[ki], sc.xB[ki], y5, yA, yB);
            C[idx] += 1;
          }
        }
      }
    }
    return { S, C };
  }

  // ---------------------------------------------------------------------------
  // Phase 4: CFR+ with linear averaging on the sampled game.
  // ---------------------------------------------------------------------------
  function regretMatch(R, off, n, out) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += R[off + i] > 0 ? R[off + i] : 0;
    if (sum > 0) for (let i = 0; i < n; i++) out[off + i] = R[off + i] > 0 ? R[off + i] / sum : 0;
    else for (let i = 0; i < n; i++) out[off + i] = 1 / n;
  }

  function solve(opts) {
    const { N, K, candO, candI, tensor, observers = [], iterations = 200, tremble = 0.03, onProgress } = opts;
    const size = N * K * N * K;
    // Average payoff per entry (to OOP) and validity.
    // (Invalid entries are U = 0, V = 0, so the hot loops below can stay branch-free.)
    const U = new Float64Array(size), V = new Float64Array(size);
    for (let i = 0; i < size; i++) if (tensor.C[i]) { U[i] = tensor.S[i] / tensor.C[i]; V[i] = 1; }
    const drawO = new Int8Array(N * K), drawI = new Int8Array(N * K);
    for (let i = 0; i < N * K; i++) { drawO[i] = KEEP_DRAW[candO[i]]; drawI[i] = KEEP_DRAW[candI[i]]; }

    const Ro = new Float64Array(N * K), So = new Float64Array(N * K), sigO = new Float64Array(N * K);
    const Rp = new Float64Array(N * 4 * K), Sp = new Float64Array(N * 4 * K), sigP = new Float64Array(N * 4 * K);
    const Qo = new Float64Array(N * K);
    const numP = new Float64Array(N * 4 * K), denP = new Float64Array(N * 4 * K);
    const massD = new Float64Array(4);

    // Observer state
    const obs = observers.map((o) => {
      const n = o.seat === 'oop' ? NKEEPS : 4 * NKEEPS;
      const Uo = new Float64Array(o.S.length), Vo = new Float64Array(o.S.length);
      for (let i = 0; i < o.S.length; i++) if (o.C[i]) { Uo[i] = o.S[i] / o.C[i]; Vo[i] = 1; }
      return { ...o, Uo, Vo, R: new Float64Array(n), Sum: new Float64Array(n), sig: new Float64Array(n), Q: new Float64Array(n) };
    });

    // Strategies go sparse quickly under CFR+ (regret matching gives exact zeros), so the
    // value computations below only walk actions with positive probability. OOP's
    // "tremble" (mixing in a little uniform play so every announcement stays reachable)
    // is linear, so its uniform part is precomputed once instead of re-summed each pass.
    const nzB = new Int16Array(N * 4 * K), nzCount = new Int32Array(N * 4);
    function buildNonzero(sigPx) {
      for (let s = 0; s < N * 4; s++) {
        let c = 0;
        for (let b = 0; b < K; b++) if (sigPx[s * K + b] > 0) nzB[s * K + c++] = b;
        nzCount[s] = c;
      }
    }

    // OOP: Q(h,a) = E[payoff | IP plays sigP at (j, draw(a))], over compatible (j,b).
    function oopValues(sigPx, out) {
      buildNonzero(sigPx);
      for (let h = 0; h < N; h++) for (let a = 0; a < K; a++) {
        const d = drawO[h * K + a];
        let num = 0, den = 0;
        const rowBase = (h * K + a) * N;
        for (let j = 0; j < N; j++) {
          const row = (rowBase + j) * K, s = j * 4 + d, sp = s * K, cnt = nzCount[s];
          for (let n = 0; n < cnt; n++) {
            const b = nzB[sp + n], w = sigPx[sp + b];
            num += w * U[row + b]; den += w * V[row + b];
          }
        }
        out[h * K + a] = den > 0 ? num / den : 0;
      }
    }

    // Uniform-play sums for the tremble term (IP side and IP observers).
    const uniNum = new Float64Array(N * 4 * K), uniDen = new Float64Array(N * 4 * K), uniMass = new Float64Array(4);
    for (let h = 0; h < N; h++) for (let a = 0; a < K; a++) {
      const d = drawO[h * K + a];
      uniMass[d] += 1 / (K * N);
      const rowBase = (h * K + a) * N;
      for (let j = 0; j < N; j++) {
        const row = (rowBase + j) * K, sp = (j * 4 + d) * K;
        for (let b = 0; b < K; b++) { uniNum[sp + b] -= U[row + b]; uniDen[sp + b] += V[row + b]; }
      }
    }

    // IP: conditional E[payoff to IP | OOP announced d] for each (j,d,b), plus P(d),
    // when OOP plays (1 - eps) * sig + eps * uniform.
    function ipValues(sig, eps) {
      numP.fill(0); denP.fill(0); massD.fill(0);
      for (let h = 0; h < N; h++) for (let a = 0; a < K; a++) {
        const w = sig[h * K + a];
        if (w <= 0) continue;
        const d = drawO[h * K + a];
        massD[d] += w / N;
        const rowBase = (h * K + a) * N;
        for (let j = 0; j < N; j++) {
          const row = (rowBase + j) * K, sp = (j * 4 + d) * K;
          for (let b = 0; b < K; b++) {
            numP[sp + b] -= w * U[row + b]; denP[sp + b] += w * V[row + b];
          }
        }
      }
      const e1 = 1 - eps, e2 = eps / K;
      for (let d = 0; d < 4; d++) massD[d] = e1 * massD[d] + eps * uniMass[d];
      for (let i = 0; i < numP.length; i++) {
        const num = e1 * numP[i] + e2 * uniNum[i], den = e1 * denP[i] + e2 * uniDen[i];
        numP[i] = den > 0 ? num / den : 0;
      }
      return numP; // now conditional values
    }

    for (const o of obs) {
      if (o.seat !== 'ip') continue;
      o.uniNum = new Float64Array(4 * NKEEPS); o.uniDen = new Float64Array(4 * NKEEPS);
      for (let ki = 0; ki < NKEEPS; ki++) for (let h = 0; h < N; h++) {
        const row = (ki * N + h) * K;
        for (let a = 0; a < K; a++) {
          const d = drawO[h * K + a];
          o.uniNum[d * NKEEPS + ki] += o.Uo[row + a]; o.uniDen[d * NKEEPS + ki] += o.Vo[row + a];
        }
      }
    }

    // Observer values. OOP observer: vs IP strategy sigPx (call after oopValues so the
    // nonzero lists match sigPx). IP observer: vs OOP playing (1-eps)*sigOx + eps*uniform.
    function observerValues(o, sigOx, sigPx, eps) {
      const Uo = o.Uo, Vo = o.Vo;
      if (o.seat === 'oop') {
        for (let ki = 0; ki < NKEEPS; ki++) {
          const d = KEEP_DRAW[ki];
          let num = 0, den = 0;
          for (let j = 0; j < N; j++) {
            const row = (ki * N + j) * K, s = j * 4 + d, sp = s * K, cnt = nzCount[s];
            for (let n = 0; n < cnt; n++) {
              const b = nzB[sp + n], w = sigPx[sp + b];
              num += w * Uo[row + b]; den += w * Vo[row + b];
            }
          }
          o.Q[ki] = den > 0 ? num / den : 0;
        }
      } else {
        const num = new Float64Array(4), den = new Float64Array(4);
        const e1 = 1 - eps, e2 = eps / K;
        for (let ki = 0; ki < NKEEPS; ki++) {
          num.fill(0); den.fill(0);
          for (let h = 0; h < N; h++) {
            const row = (ki * N + h) * K, hk = h * K;
            for (let a = 0; a < K; a++) {
              const w = sigOx[hk + a];
              if (w <= 0) continue;
              const d = drawO[hk + a];
              num[d] += w * Uo[row + a]; den[d] += w * Vo[row + a];
            }
          }
          for (let d = 0; d < 4; d++) {
            const i = d * NKEEPS + ki;
            const nn = e1 * num[d] + e2 * o.uniNum[i], dd = e1 * den[d] + e2 * o.uniDen[i];
            o.Q[i] = dd > 0 ? nn / dd : 0;
          }
        }
      }
    }
    function updateRegrets(R, Sum, sig, Q, off, n, weight, t) {
      let ev = 0;
      for (let i = 0; i < n; i++) ev += sig[off + i] * Q[off + i];
      for (let i = 0; i < n; i++) {
        const r = R[off + i] + weight * (Q[off + i] - ev);
        R[off + i] = r > 0 ? r : 0;
        Sum[off + i] += t * sig[off + i];
      }
    }

    for (let t = 1; t <= iterations; t++) {
      for (let h = 0; h < N; h++) regretMatch(Ro, h * K, K, sigO);
      for (let s = 0; s < N * 4; s++) regretMatch(Rp, s * K, K, sigP);
      oopValues(sigP, Qo);
      const Qp = ipValues(sigO, tremble);
      for (let h = 0; h < N; h++) updateRegrets(Ro, So, sigO, Qo, h * K, K, 1, t);
      for (let j = 0; j < N; j++) for (let d = 0; d < 4; d++) {
        // Regret increments are weighted by how often OOP reaches this announcement
        // (floored so off-path responses still learn — see tremble above).
        updateRegrets(Rp, Sp, sigP, Qp, (j * 4 + d) * K, K, Math.max(massD[d], 1e-3), t);
      }
      // Observers learn alongside the population (every pass, so their averaged mix
      // settles on the keeps that stay best as the population converges) but never
      // feed back into it.
      for (const o of obs) {
        if (o.seat === 'oop') regretMatch(o.R, 0, NKEEPS, o.sig);
        else for (let d = 0; d < 4; d++) regretMatch(o.R, d * NKEEPS, NKEEPS, o.sig);
        observerValues(o, sigO, sigP, tremble);
        if (o.seat === 'oop') updateRegrets(o.R, o.Sum, o.sig, o.Q, 0, NKEEPS, 1, t);
        else for (let d = 0; d < 4; d++) updateRegrets(o.R, o.Sum, o.sig, o.Q, d * NKEEPS, NKEEPS, 1, t);
      }
      if (onProgress && (t % 20 === 0 || t === iterations)) onProgress(t / iterations);
    }

    // ----- final average strategies & reports -----
    const avgO = new Float64Array(N * K), avgP = new Float64Array(N * 4 * K);
    const normalize = (Sum, out, off, n) => {
      let s = 0;
      for (let i = 0; i < n; i++) s += Sum[off + i];
      for (let i = 0; i < n; i++) out[off + i] = s > 0 ? Sum[off + i] / s : 1 / n;
    };
    for (let h = 0; h < N; h++) normalize(So, avgO, h * K, K);
    for (let s = 0; s < N * 4; s++) normalize(Sp, avgP, s * K, K);

    // Values vs the averaged strategies (no tremble) for the exploitability estimate.
    const QoF = new Float64Array(N * K);
    oopValues(avgP, QoF);
    let valueO = 0, brO = 0;
    for (let h = 0; h < N; h++) {
      let ev = 0, mx = -Infinity;
      for (let a = 0; a < K; a++) { ev += avgO[h * K + a] * QoF[h * K + a]; mx = Math.max(mx, QoF[h * K + a]); }
      valueO += ev / N; brO += mx / N;
    }
    const QpF = Float64Array.from(ipValues(avgO, 0));
    const massF = Array.from(massD);
    let valueP = 0, brP = 0;
    for (let j = 0; j < N; j++) for (let d = 0; d < 4; d++) {
      if (massF[d] <= 0) continue;
      let ev = 0, mx = -Infinity;
      const off = (j * 4 + d) * K;
      for (let b = 0; b < K; b++) { ev += avgP[off + b] * QpF[off + b]; mx = Math.max(mx, QpF[off + b]); }
      valueP += massF[d] * ev / N; brP += massF[d] * mx / N;
    }

    // Draw-count summaries.
    const oopDraw = [0, 0, 0, 0];
    for (let i = 0; i < N * K; i++) oopDraw[drawO[i]] += avgO[i] / N;
    const ipDrawGiven = [0, 1, 2, 3].map((d) => {
      const dist = [0, 0, 0, 0];
      for (let j = 0; j < N; j++) for (let b = 0; b < K; b++) dist[drawI[j * K + b]] += avgP[(j * 4 + d) * K + b] / N;
      return dist;
    });
    // IP's equilibrium value conditional on each announcement (how good each draw count
    // is for OOP to show, from IP's side of the table).
    const ipValueGiven = [0, 1, 2, 3].map((d) => {
      let v = 0;
      for (let j = 0; j < N; j++) {
        const off = (j * 4 + d) * K;
        for (let b = 0; b < K; b++) v += avgP[off + b] * QpF[off + b];
      }
      return v / N;
    });

    const observerResults = obs.map((o) => {
      const n = o.seat === 'oop' ? NKEEPS : 4 * NKEEPS;
      const avg = new Float64Array(n);
      if (o.seat === 'oop') normalize(o.Sum, avg, 0, NKEEPS);
      else for (let d = 0; d < 4; d++) normalize(o.Sum, avg, d * NKEEPS, NKEEPS);
      // A little tremble here too, so "what if OOP had announced d" has an answer even
      // for announcements equilibrium OOP never makes.
      observerValues(o, avgO, avgP, tremble);
      return { id: o.id, seat: o.seat, ev: Array.from(o.Q), freq: Array.from(avg) };
    });

    return {
      summary: {
        N, K, iterations,
        valueOop: (valueO - valueP) / 2, // two estimates of the same number; average them
        exploitability: Math.max(0, ((brO - valueO) + (brP - valueP)) / 2),
        oopDraw, ipDrawGiven, ipValueGiven
      },
      observers: observerResults
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers for presenting results
  // ---------------------------------------------------------------------------
  function keepCards(cards9, ki) {
    return KEEPS[ki].slots.map((s) => cards9[s]);
  }

  // Pick an action from a mixed strategy, ignoring "noise" weights below `floor`.
  function sampleMixed(freqs, floor = 0.05) {
    let total = 0;
    const w = freqs.map((f) => (f >= floor ? f : 0));
    for (const x of w) total += x;
    if (total <= 0) { let b = 0; freqs.forEach((f, i) => { if (f > freqs[b]) b = i; }); return b; }
    let r = Math.random() * total;
    for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0 && w[i] > 0) return i; }
    return w.findIndex((x) => x > 0);
  }

  // Size of the sampled game. N = hands per seat, perDraw = candidate keeps per draw
  // count (K = 4 * perDraw), trialsA/B = prefilter scenarios per hand, runs = scenarios
  // per population pairing, obsRuns = scenarios per pairing for the two real hands,
  // iterations = CFR+ passes (exploitability of the sampled game is ~0.001 units by 200).
  const PRESETS = {
    fast: { N: 70, perDraw: 3, trialsA: 10, trialsB: 16, runs: 2, obsRuns: 10, iterations: 150 },
    standard: { N: 110, perDraw: 3, trialsA: 12, trialsB: 20, runs: 3, obsRuns: 14, iterations: 200 },
    deep: { N: 170, perDraw: 4, trialsA: 16, trialsB: 28, runs: 3, obsRuns: 20, iterations: 300 }
  };

  // Single-threaded convenience runner (Node, tests, experiments). `observers` is a list
  // of { id, seat: 'oop'|'ip', cards: [9 card strings] }.
  function runAll({ flopA, flopB, observers = [], preset = 'standard', overrides = {}, log = () => {} }) {
    const P = { ...PRESETS[preset], ...overrides };
    const ctx = makeContext(flopA.map(F.toInt), flopB.map(F.toInt));
    const K = P.perDraw * 4;
    const t0 = Date.now();
    const popO = samplePopulation(ctx, P.N), popI = samplePopulation(ctx, P.N);
    const bestAO = prefilterRoundA(ctx, popO, popI, 0, P.N, P.trialsA);
    const bestAI = prefilterRoundA(ctx, popI, popO, 0, P.N, P.trialsA);
    log(`round A ${Date.now() - t0}ms`);
    const candO = prefilterRoundB(ctx, popO, popI, bestAI, 0, P.N, P.trialsB, P.perDraw);
    const candI = prefilterRoundB(ctx, popI, popO, bestAO, 0, P.N, P.trialsB, P.perDraw);
    log(`round B ${Date.now() - t0}ms`);
    const tensor = buildTensor(ctx, popO, candO, popI, candI, K, 0, P.N, P.runs);
    log(`tensor ${Date.now() - t0}ms`);
    const obs = observers.map((o) => {
      const cards = o.cards.map(F.toInt);
      const t = o.seat === 'oop' ? buildObserver(ctx, cards, popI, candI, K, P.obsRuns) : buildObserver(ctx, cards, popO, candO, K, P.obsRuns);
      return { id: o.id, seat: o.seat, S: t.S, C: t.C };
    });
    log(`observers ${Date.now() - t0}ms`);
    const res = solve({ N: P.N, K, candO, candI, tensor, observers: obs, iterations: P.iterations });
    log(`solve ${Date.now() - t0}ms`);
    return { ...res, popO, popI, candO, candI, K };
  }

  return {
    KEEPS, NKEEPS, KEEP_DRAW, PRESETS,
    makeContext, samplePopulation, prefilterRoundA, prefilterRoundB, buildTensor, buildObserver, solve,
    keepCards, sampleMixed, runAll
  };
});
