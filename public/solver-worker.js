// public/solver-worker.js — runs one phase of lib/solver.js (heads-up) or lib/solver3.js
// (3-handed) off the main thread. The page keeps a small pool of these (see
// solver-pool.js) and splits every expensive phase across them.
importScripts('/lib/fasteval.js', '/lib/solver.js', '/lib/solver3.js');

self.onmessage = (e) => {
  const { id, kind, args } = e.data;
  try {
    const ctx = args.flopA ? Solver.makeContext(args.flopA, args.flopB, args.H || 9) : null;
    let result, transfer = [];
    if (kind === 'scout') {
      result = Solver.scoutRange(ctx, args.pop, args.from, args.to, args.spec, args.P);
      transfer = [result.keeps.buffer, result.evs.buffer, result.best.buffer];
    } else if (kind === 'groupPayoffs') {
      result = Solver.groupPayoffs(ctx, args.popO, args.keepO, args.groupO, args.popI, args.keepI, args.groupI, args.B, args.from, args.to, args.pairs);
      transfer = [result.sum.buffer, result.cnt.buffer];
    } else if (kind === 'solveGroups') {
      result = Solver.solveGroups(args);
    } else if (kind === 'observe') {
      result = Solver.observeRange(ctx, args.cards, args.seat, args.opp, args.s0, args.s1, args.rawCap);
      transfer = [result.sums.buffer, result.sq.buffer, result.cnt.buffer, result.raw.buffer];
    } else if (kind === 'scout3') {
      result = Solver3.scoutRange3(ctx, args.from, args.to, args.spec, args.P);
      transfer = [result.keeps.buffer, result.evs.buffer];
    } else if (kind === 'observe3') {
      result = Solver3.observeRange3(ctx, args.cards, args.seat, args.opp, args.s0, args.s1, args.rawCap);
      transfer = [result.sums.buffer, result.sq.buffer, result.cnt.buffer, result.raw.buffer];
    } else {
      throw new Error('Unknown job ' + kind);
    }
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};
