// experiments/solve_flop.js — run the practice-mode solver from the command line.
//
//   node experiments/solve_flop.js "Kh 9d 4s" "Jc Jd 6h" --oop "Ah Kd Qs Jh Td 9h 9c 5c 2d" [--preset deep]
//   node experiments/solve_flop.js "Kh 9d 4s" "Jc Jd 6h" --ip  "As Ks 8h 8c 7d 6s 5h 3c 2c"
//
// Prints the flop's equilibrium summary and, for any hand given, its best keeps with EV
// (in stakes per hand) and equilibrium frequency. Runs single-threaded, so expect it to
// be a few times slower than the browser.
//   node experiments/solve_flop.js "Kh 9d 4s" "Jc Jd 6h" --players 3 --button "As Ks 8h 8c 7d 6s 5h 3c 2c"
//     (3-handed: give any of --first / --second / --button; the button's keeps are shown
//      after the 1st and 2nd players both pat)
const S = require('../lib/solver.js');
const S3 = require('../lib/solver3.js');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('usage: node experiments/solve_flop.js "<flop A>" "<flop B>" [--oop "<9 cards>"] [--ip "<9 cards>"] [--preset fast|standard|deep|max|ultra]  (3-handed: --players 3 [--first|--second|--button "<cards>"])');
  process.exit(1);
}
const flopA = args[0].split(/\s+/), flopB = args[1].split(/\s+/);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

if (opt('--players') === '3') {
  const preset3 = opt('--preset') || 'deep';
  const obs3 = ['--first', '--second', '--button'].map((f, seat) => (opt(f) ? { id: f.slice(2), seat, cards: opt(f).split(/\s+/) } : null)).filter(Boolean);
  const r = S3.runAll3({ flopA, flopB, observers: obs3, preset: preset3, log: (m) => console.error('  ' + m) });
  const pc = (x) => (x * 100).toFixed(0).padStart(3) + '%';
  const sm = r.summary;
  console.log(`\nFlops ${flopA.join(' ')} | ${flopB.join(' ')}   (3-handed, ${preset3}: ${sm.M} hands/seat, ${sm.rounds} rounds)`);
  console.log(`Seat values (stakes/hand): 1st ${sm.values[0].toFixed(3)}  2nd ${sm.values[1].toFixed(3)}  button ${sm.values[2].toFixed(3)}`);
  console.log(`1st announces:  pat ${pc(sm.draw0[0])}  d1 ${pc(sm.draw0[1])}  d2 ${pc(sm.draw0[2])}  d3 ${pc(sm.draw0[3])}`);
  sm.draw1Given.forEach((dist, d) => console.log(`2nd after 1st ${d === 0 ? 'pats   ' : 'draws ' + d + ' '}: pat ${pc(dist[0])}  d1 ${pc(dist[1])}  d2 ${pc(dist[2])}  d3 ${pc(dist[3])}`));
  for (const o of r.observers) {
    const cards = obs3.find((x) => x.id === o.id).cards, L = S.layout(cards.length), NK = L.NKEEPS;
    const order = Array.from({ length: NK }, (_, i) => i).sort((a2, b2) => o.ev[b2] - o.ev[a2]);
    console.log(`\n${o.id.toUpperCase()} ${cards.join(' ')}${o.seat > 0 ? '  — after everyone before pats' : ''}`);
    for (const ki of order.slice(0, 8)) console.log(`  ${S.keepCards(cards, ki).join(' ').padEnd(15)} ${['pat   ', 'draw 1', 'draw 2', 'draw 3'][L.KEEP_DRAW[ki]]}  EV ${o.ev[ki].toFixed(3).padStart(7)} ±${o.se[ki].toFixed(3)}  plays ${pc(o.freq[ki])}`);
  }
  process.exit(0);
}
const observers = [];
if (opt('--oop')) observers.push({ id: 'oop', seat: 'oop', cards: opt('--oop').split(/\s+/) });
if (opt('--ip')) observers.push({ id: 'ip', seat: 'ip', cards: opt('--ip').split(/\s+/) });
const preset = opt('--preset') || 'deep';

const res = S.runAll({ flopA, flopB, observers, preset, log: (m) => console.error('  ' + m) });
const pct = (x) => (x * 100).toFixed(0).padStart(3) + '%';
const s = res.summary;
console.log(`\nFlops ${flopA.join(' ')} | ${flopB.join(' ')}   (${preset}: ${s.M} hands/seat, ${s.groupsO} groups, ${s.rounds} refinement rounds)`);
console.log(`OOP value ${s.valueOop.toFixed(3)} stakes/hand · avg gain from deviating ${s.exploitability.toFixed(3)}`);
console.log(`OOP announces:  pat ${pct(s.oopDraw[0])}  d1 ${pct(s.oopDraw[1])}  d2 ${pct(s.oopDraw[2])}  d3 ${pct(s.oopDraw[3])}`);
s.ipDrawGiven.forEach((dist, d) => {
  console.log(`IP after OOP ${d === 0 ? 'pats   ' : 'draws ' + d + ' '}: pat ${pct(dist[0])}  d1 ${pct(dist[1])}  d2 ${pct(dist[2])}  d3 ${pct(dist[3])}   (IP EV ${s.ipValueGiven[d].toFixed(2)})`);
});

for (const o of res.observers) {
  const cards = observers.find((x) => x.id === o.id).cards;
  const blocks = o.seat === 'oop' ? [null] : [0, 1, 2, 3];
  for (const d of blocks) {
    const NK = S.layout(cards.length).NKEEPS, off = d === null ? 0 : d * NK;
    const order = Array.from({ length: NK }, (_, i) => i).sort((a, b) => o.ev[off + b] - o.ev[off + a]);
    console.log(`\n${o.seat.toUpperCase()} ${cards.join(' ')}${d === null ? '' : `  — if OOP ${d === 0 ? 'pats' : 'draws ' + d}`}`);
    for (const ki of order.slice(0, 8)) {
      console.log(`  ${S.keepCards(cards, ki).join(' ').padEnd(15)} ${['pat   ', 'draw 1', 'draw 2', 'draw 3'][S.layout(cards.length).KEEP_DRAW[ki]]}  EV ${o.ev[off + ki].toFixed(3).padStart(7)} ±${o.se[off + ki].toFixed(3)}  plays ${pct(o.freq[off + ki])}`);
    }
  }
}
