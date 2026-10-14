// experiments/solve_flop.js — run the practice-mode solver from the command line.
//
//   node experiments/solve_flop.js "Kh 9d 4s" "Jc Jd 6h" --oop "Ah Kd Qs Jh Td 9h 9c 5c 2d" [--preset deep]
//   node experiments/solve_flop.js "Kh 9d 4s" "Jc Jd 6h" --ip  "As Ks 8h 8c 7d 6s 5h 3c 2c"
//
// Prints the flop's equilibrium summary and, for any hand given, its best keeps with EV
// (in stakes per hand) and equilibrium frequency. Runs single-threaded, so expect it to
// be a few times slower than the browser.
const S = require('../lib/solver.js');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('usage: node experiments/solve_flop.js "<flop A>" "<flop B>" [--oop "<9 cards>"] [--ip "<9 cards>"] [--preset fast|standard|deep]');
  process.exit(1);
}
const flopA = args[0].split(/\s+/), flopB = args[1].split(/\s+/);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const observers = [];
if (opt('--oop')) observers.push({ id: 'oop', seat: 'oop', cards: opt('--oop').split(/\s+/) });
if (opt('--ip')) observers.push({ id: 'ip', seat: 'ip', cards: opt('--ip').split(/\s+/) });
const preset = opt('--preset') || 'standard';

const res = S.runAll({ flopA, flopB, observers, preset, log: (m) => console.error('  ' + m) });
const pct = (x) => (x * 100).toFixed(0).padStart(3) + '%';
const s = res.summary;
console.log(`\nFlops ${flopA.join(' ')} | ${flopB.join(' ')}   (${preset}: ${s.N} hands/seat, ${s.K} keeps each, ${s.iterations} iters)`);
console.log(`OOP value ${s.valueOop.toFixed(3)} stakes/hand · exploitability ${s.exploitability.toFixed(4)}`);
console.log(`OOP announces:  pat ${pct(s.oopDraw[0])}  d1 ${pct(s.oopDraw[1])}  d2 ${pct(s.oopDraw[2])}  d3 ${pct(s.oopDraw[3])}`);
s.ipDrawGiven.forEach((dist, d) => {
  console.log(`IP after OOP ${d === 0 ? 'pats   ' : 'draws ' + d + ' '}: pat ${pct(dist[0])}  d1 ${pct(dist[1])}  d2 ${pct(dist[2])}  d3 ${pct(dist[3])}   (IP EV ${s.ipValueGiven[d].toFixed(2)})`);
});

for (const o of res.observers) {
  const cards = observers.find((x) => x.id === o.id).cards;
  const blocks = o.seat === 'oop' ? [null] : [0, 1, 2, 3];
  for (const d of blocks) {
    const off = d === null ? 0 : d * S.NKEEPS;
    const order = Array.from({ length: S.NKEEPS }, (_, i) => i).sort((a, b) => o.ev[off + b] - o.ev[off + a]);
    console.log(`\n${o.seat.toUpperCase()} ${cards.join(' ')}${d === null ? '' : `  — if OOP ${d === 0 ? 'pats' : 'draws ' + d}`}`);
    for (const ki of order.slice(0, 8)) {
      console.log(`  ${S.keepCards(cards, ki).join(' ').padEnd(15)} ${['pat   ', 'draw 1', 'draw 2', 'draw 3'][S.KEEP_DRAW[ki]]}  EV ${o.ev[off + ki].toFixed(3).padStart(7)}  mix ${pct(o.freq[off + ki])}`);
    }
  }
}
