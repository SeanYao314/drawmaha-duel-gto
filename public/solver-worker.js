// public/solver-worker.js — runs one phase of lib/solver.js off the main thread.
// The page keeps a small pool of these (see solver-pool.js) and splits the expensive
// phases (prefilter rounds and the payoff tensor) across them.
importScripts('/lib/fasteval.js', '/lib/solver.js');

self.onmessage = (e) => {
  const { id, kind, args } = e.data;
  try {
    const ctx = args.flopA ? Solver.makeContext(args.flopA, args.flopB, args.H || 9) : null;
    let result, transfer = [];
    if (kind === 'roundA') {
      result = Solver.prefilterRoundA(ctx, args.pop, args.oppPop, args.from, args.to, args.trials);
      transfer = [result.buffer];
    } else if (kind === 'roundB') {
      result = Solver.prefilterRoundB(ctx, args.pop, args.oppPop, args.oppBestA, args.from, args.to, args.trials, args.perDraw);
      transfer = [result.buffer];
    } else if (kind === 'tensor') {
      result = Solver.buildTensor(ctx, args.popO, args.candO, args.popI, args.candI, args.K, args.from, args.to, args.runs);
      transfer = [result.S.buffer, result.C.buffer];
    } else if (kind === 'observer') {
      result = Solver.buildObserver(ctx, args.cards, args.oppPop, args.oppCand, args.K, args.runs);
      transfer = [result.S.buffer, result.C.buffer];
    } else if (kind === 'solve') {
      result = Solver.solve({
        ...args,
        onProgress: (p) => self.postMessage({ id, progress: p })
      });
    } else {
      throw new Error('Unknown job ' + kind);
    }
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};
