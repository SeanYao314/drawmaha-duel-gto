// public/solver-pool.js — spreads a flop solve (lib/solver.js) across Web Workers.
//
// Exposes window.SolverPool.solveFlop({ flopA, flopB, observers, preset, onProgress }),
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
    w.onerror = (e) => console.error('solver worker error', e);
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
      w.postMessage({ id: job.id, kind: job.kind, args: job.args });
    }
  }
  function run(kind, args, onProgress) {
    ensureWorkers();
    return new Promise((resolve, reject) => {
      queue.push({ id: nextJobId++, kind, args, resolve, reject, onProgress });
      pump();
    });
  }

  function cancel() {
    generation++;
    queue.length = 0;
    for (const job of pending.values()) job.reject(new Error('cancelled'));
    pending.clear();
    workers.forEach((w) => w.terminate());
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

  async function solveFlop({ flopA, flopB, observers = [], preset = 'standard', onProgress = () => {} }) {
    if (pending.size || queue.length) cancel();
    const gen = ++generation;
    const check = () => { if (gen !== generation) throw new Error('cancelled'); };
    const P = S.PRESETS[preset] || S.PRESETS.standard;
    const N = P.N, K = P.perDraw * 4;
    const fa = flopA.map(F.toInt), fb = flopB.map(F.toInt);
    const ctx = S.makeContext(fa, fb);
    const popO = S.samplePopulation(ctx, N), popI = S.samplePopulation(ctx, N);
    const base = { flopA: fa, flopB: fb };

    // Progress bookkeeping: each phase owns a slice of the bar.
    let done = 0;
    const phase = (weight, parts) => () => { done += weight / parts; onProgress(Math.min(0.99, done)); };
    const splits = ranges(N, WORKER_COUNT * 2);

    // Round A (both seats)
    let tick = phase(0.1, splits.length * 2);
    const [aO, aI] = await Promise.all([popO, popI].map((pop, s) => {
      const opp = s === 0 ? popI : popO;
      return Promise.all(splits.map(([from, to]) => run('roundA', { ...base, pop, oppPop: opp, from, to, trials: P.trialsA }).then((r) => { tick(); return r; })))
        .then((chunks) => concat(Int16Array, chunks));
    }));
    check();

    // Round B (both seats) → candidate keeps
    tick = phase(0.15, splits.length * 2);
    const [candO, candI] = await Promise.all([0, 1].map((s) => {
      const pop = s === 0 ? popO : popI, opp = s === 0 ? popI : popO, oppBest = s === 0 ? aI : aO;
      return Promise.all(splits.map(([from, to]) => run('roundB', { ...base, pop, oppPop: opp, oppBestA: oppBest, from, to, trials: P.trialsB, perDraw: P.perDraw }).then((r) => { tick(); return r; })))
        .then((chunks) => concat(Int16Array, chunks));
    }));
    check();

    // Payoff tensor (split by OOP hand) + observers, all queued together.
    const tSplits = ranges(N, WORKER_COUNT * 3);
    tick = phase(0.55, tSplits.length + observers.length);
    const tensorP = Promise.all(tSplits.map(([from, to]) => run('tensor', { ...base, popO, candO, popI, candI, K, from, to, runs: P.runs }).then((r) => { tick(); return r; })))
      .then((chunks) => ({ S: concat(Int16Array, chunks.map((c) => c.S)), C: concat(Uint8Array, chunks.map((c) => c.C)) }));
    const obsP = Promise.all(observers.map((o) => {
      const cards9 = o.cards.map(F.toInt);
      const oppPop = o.seat === 'oop' ? popI : popO, oppCand = o.seat === 'oop' ? candI : candO;
      return run('observer', { ...base, cards9, oppPop, oppCand, K, runs: P.obsRuns }).then((r) => { tick(); return { id: o.id, seat: o.seat, S: r.S, C: r.C }; });
    }));
    const [tensor, obs] = await Promise.all([tensorP, obsP]);
    check();

    // CFR+ on one worker.
    const before = done;
    const result = await run('solve', { N, K, candO, candI, tensor, observers: obs, iterations: P.iterations }, (p) => onProgress(Math.min(0.99, before + 0.2 * p)));
    check();
    onProgress(1);
    return { ...result, preset };
  }

  window.SolverPool = { solveFlop, cancel, workerCount: WORKER_COUNT };
})();
