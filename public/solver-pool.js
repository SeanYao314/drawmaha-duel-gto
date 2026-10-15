// public/solver-pool.js — spreads a flop solve (lib/solver.js) across Web Workers.
//
// Exposes window.SolverPool.solveFlop({ flopA, flopB, observers, handSize, preset, onProgress }),
// which resolves to { summary, observers, preset } exactly like Solver.runAll() does in
// Node, just several times faster on a multi-core machine. Starting a new solve (or
// calling cancel()) abandons whatever was running.
(function () {
  const F = window.FastEval, S = window.Solver;
  const WORKER_COUNT = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

  let workers = [];
  let nextJobId = 1;
  const pending = new Map(); // job id -> { resolve, reject, onProgress, worker }
  let generation = 0;

  function spawn() {
    const w = new Worker('/solver-worker.js');
    w.busy = false;
    w.onmessage = (e) => {
      const { id, result, error, progress } = e.data;
      const job = pending.get(id);
      if (!job) return;
      if (progress !== undefined) { if (job.onProgress) job.onProgress(progress); return; }
      pending.delete(id);
      w.busy = false;
      pump();
      if (error) job.reject(new Error(error)); else job.resolve(result);
    };
    // A worker cancelled while still loading its scripts reports a load error; ignore those.
    w.onerror = (e) => { if (!w.dead) console.error('solver worker error', e.message, e.filename, e.lineno); };
    return w;
  }
  function ensureWorkers() {
    if (workers.length) return;
    for (let i = 0; i < WORKER_COUNT; i++) workers.push(spawn());
  }

  const queue = [];
  function pump() {
    for (const w of workers) {
      if (w.busy || !queue.length) continue;
      const job = queue.shift();
      w.busy = true;
      job.worker = w;
      pending.set(job.id, job);
      w.postMessage({ id: job.id, kind: job.kind, args: job.args }, job.transfer || []);
    }
  }
  function run(kind, args, onProgress, transfer) {
    ensureWorkers();
    return new Promise((resolve, reject) => {
      queue.push({ id: nextJobId++, kind, args, resolve, reject, onProgress, transfer });
      pump();
    });
  }

  function cancel() {
    generation++;
    queue.length = 0;
    for (const job of pending.values()) job.reject(new Error('cancelled'));
    pending.clear();
    workers.forEach((w) => { w.dead = true; w.terminate(); });
    workers = [];
  }

  // Split [0, n) into roughly `parts` contiguous ranges.
  function ranges(n, parts) {
    const out = [];
    const step = Math.max(1, Math.ceil(n / parts));
    for (let from = 0; from < n; from += step) out.push([from, Math.min(n, from + step)]);
    return out;
  }
  function concat(Type, chunks) {
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Type(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  async function solveFlop({ flopA, flopB, observers = [], handSize = 9, preset = 'deep', onProgress = () => {} }) {
    if (pending.size || queue.length) cancel();
    const gen = ++generation;
    const check = () => { if (gen !== generation) throw new Error('cancelled'); };
    const P = S.PRESETS[preset] || S.PRESETS.deep;
    const H = handSize, M = P.M;
    const fa = flopA.map(F.toInt), fb = flopB.map(F.toInt);
    const ctx = S.makeContext(fa, fb, H);
    const L = ctx.L;
    const popO = S.samplePopulation(ctx, M), popI = S.samplePopulation(ctx, M);
    const base = { flopA: fa, flopB: fb, H };
    const ident = S.identityGroups(M);

    // Progress: each phase owns a slice of the bar (weights roughly match run time).
    const W = { scout: 0.1, group: 0.08, round: 0.7 / P.rounds, obs: 0.12 };
    let done = 0;
    const tickFor = (weight, parts) => () => { done += weight / parts; onProgress(Math.min(0.99, done)); };
    const splits = ranges(M, WORKER_COUNT * 3);

    // Scout hands [0, M) of `pop` against `spec` across the pool; concatenate results.
    const scoutAll = async (pop, spec, weight) => {
      const tick = tickFor(weight, splits.length);
      const parts = await Promise.all(splits.map(([from, to]) => run('scout', { ...base, pop, from, to, spec, P }).then((r) => { tick(); return r; })));
      check();
      return { keeps: concat(Int16Array, parts.map((r) => r.keeps)), evs: concat(Float32Array, parts.map((r) => r.evs)), best: concat(Int16Array, parts.map((r) => r.best)) };
    };

    // 1. Scouting: every hand's best keep per draw count vs a made-hand field.
    const [aO, aI] = await Promise.all([
      scoutAll(popO, { mode: 'A', oppPop: popI }, W.scout / 2),
      scoutAll(popI, { mode: 'A', oppPop: popO }, W.scout / 2)
    ]);
    let keepO = aO.keeps, evO = aO.evs;
    let keepI = new Int16Array(M * 16), evI = new Float32Array(M * 16);
    for (let j = 0; j < M; j++) for (let dO = 0; dO < 4; dO++) for (let dI = 0; dI < 4; dI++) {
      keepI[j * 16 + dO * 4 + dI] = aI.keeps[j * 4 + dI]; evI[j * 16 + dO * 4 + dI] = aI.evs[j * 4 + dI];
    }

    // 2. Group similar hands and solve the group game.
    const kmO = S.kmeans(S.featuresOOP(evO, M), 4, P.B), kmI = S.kmeans(S.featuresIP(evI, M), 4, P.B);
    const B = Math.max(kmO.k, kmI.k);
    const pO = new Float64Array(B), pI = new Float64Array(B);
    for (let h = 0; h < M; h++) { pO[kmO.assign[h]] += 1 / M; pI[kmI.assign[h]] += 1 / M; }
    let tick = tickFor(W.group * 0.8, splits.length);
    const payParts = await Promise.all(splits.map(([from, to]) => run('groupPayoffs', { ...base, popO, keepO, groupO: kmO.assign, popI, keepI, groupI: kmI.assign, B, from, to, pairs: P.pairs }).then((r) => { tick(); return r; })));
    check();
    const sum = new Float64Array(B * 16 * B), cnt = new Float64Array(B * 16 * B);
    for (const part of payParts) for (let i = 0; i < sum.length; i++) { sum[i] += part.sum[i]; cnt[i] += part.cnt[i]; }
    const G = await run('solveGroups', { sum, cnt, B, pO, pI, iterations: P.iterations });
    check();
    done += W.group * 0.2; onProgress(done);
    let { sigO, sigI } = S.expandGroupStrategies({ kmO, kmI, sigO: G.sigO, sigI: G.sigI }, M);

    // 3. Per-hand refinement rounds (each hand best-responds; strategies averaged).
    for (let it = 1; it <= P.rounds; it++) {
      const alpha = P.alphas[it - 1];
      const rO = await scoutAll(popO, { mode: 'C-OOP', oppPop: popI, keepI, groupI: ident, sigI }, W.round * 0.3);
      keepO = rO.keeps; evO = rO.evs;
      S.updateOOP(sigO, evO, M, alpha);
      const cw = S.posteriorTables(sigO, ident, M);
      const rI = await scoutAll(popI, { mode: 'C-IP', oppPop: popO, keepO, cw }, W.round * 0.7);
      keepI = rI.keeps; evI = rI.evs;
      S.updateIP(sigI, evI, M, alpha);
    }
    const R = { M, popO, popI, keepO, keepI, evO, evI, sigO, sigI, groupsO: kmO.k, groupsI: kmI.k };

    // 4. The real hands, sampled in parallel chunks.
    const obsSplits = ranges(P.obs, Math.max(1, Math.floor(WORKER_COUNT * 2 / Math.max(1, observers.length))));
    tick = tickFor(W.obs, obsSplits.length * observers.length);
    const obsResults = await Promise.all(observers.map(async (o) => {
      const cards = o.cards.map(F.toInt);
      const opp = S.opponentRange(o.seat, R);
      const chunks = await Promise.all(obsSplits.map(([s0, s1]) => run('observe', { ...base, cards, seat: o.seat, opp, s0, s1, rawCap: S.RAW_CAP }).then((r) => { tick(); return r; })));
      const fin = S.finalizeObserver(L, o.seat, chunks);
      return { id: o.id, seat: o.seat, ...fin, similar: S.similarHandsMix(L, o.seat, fin, R) };
    }));
    check();
    onProgress(1);
    return { summary: S.summaryOf(R, P), observers: obsResults, range: S.rangeSummary(R), preset };
  }

  window.SolverPool = { solveFlop, cancel, workerCount: WORKER_COUNT };
})();
