// lib/game.js — Drawmaha Duel rules: dealing, draw validation, and scoring.
//
// Heads-up. Each player gets 9 cards (or 7, 8 or 10 in the variants); two 3-card flops
// are dealt face up. The player out of position (OOP) keeps 2–5 cards (with 9 cards:
// discarding 4–7) and the number of cards they draw is announced; then the player in
// position (IP) does the same. Discards are dead. Whatever the hand size, you keep 2–5
// and draw back up to 5 — fewer dealt cards means fewer made hands, so fewer pats.
// After both draws, each board gets a turn and a river.
//
// Every player's final 5 cards are scored three ways, each worth 1 unit:
//   - the 5 cards on their own, as a plain 5-card poker hand
//   - as a PLO5 hand on Board A (exactly 2 hole cards + exactly 3 board cards)
//   - as a PLO5 hand on Board B
// Winning all three outright is a scoop and pays double (6 units instead of 3).
// An exact tie in a contest is a push; a push anywhere means no scoop.
//
// 3-handed: players act left of the button first, button last, each hearing the earlier
// draw counts; every pair settles the three contests head-up (see scoreTable below).
//
// UMD so the client can reuse the same constants and scoring for display.
(function (root, factory) {
  const P = (typeof module !== 'undefined' && module.exports) ? require('./poker.js') : root.Poker;
  const lib = factory(P);
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
  else root.Game = lib;
})(typeof self !== 'undefined' ? self : this, function (P) {
  const HAND_SIZE = 9; // the standard game
  const HAND_SIZES = [7, 8, 9, 10];
  const FINAL_SIZE = 5;
  const MIN_KEEP = 2; // discard 7, draw 3
  const MAX_KEEP = 5; // discard 4, draw 0 ("pat")
  const SCOOP_MULTIPLIER = 2;

  const CONTESTS = [
    { key: 'five', label: '5-Card Hand' },
    { key: 'boardA', label: 'Board A (PLO5)' },
    { key: 'boardB', label: 'Board B (PLO5)' }
  ];

  function dealHand(seatIds, handSize = HAND_SIZE) {
    const deck = P.shuffle(P.freshDeck());
    const flopA = deck.splice(0, 3);
    const flopB = deck.splice(0, 3);
    const hands = {};
    for (const id of seatIds) hands[id] = deck.splice(0, handSize);
    return { deck, flopA, flopB, hands };
  }

  // Returns an error string, or null if `keep` is a legal keep from `hand`.
  function validateKeep(hand, keep) {
    if (!Array.isArray(keep)) return 'Pick the cards you want to keep.';
    if (keep.length < MIN_KEEP || keep.length > MAX_KEEP) {
      return `Keep between ${MIN_KEEP} and ${MAX_KEEP} cards (discard ${hand.length - MAX_KEEP} to ${hand.length - MIN_KEEP}).`;
    }
    const seen = new Set();
    for (const c of keep) {
      if (typeof c !== 'string' || !hand.includes(c)) return 'You can only keep cards from your own hand.';
      if (seen.has(c)) return 'Duplicate card in keep.';
      seen.add(c);
    }
    return null;
  }

  function drawCount(keepLength) {
    return FINAL_SIZE - keepLength;
  }
  function discardCount(keepLength, handSize = HAND_SIZE) {
    return handSize - keepLength;
  }
  function drawLabel(n) {
    return n === 0 ? 'pat' : `draw ${n}`;
  }

  function evaluateFinal(hand5, boardA, boardB) {
    const five = { score: P.evaluate5(hand5), cards: hand5.slice() };
    const a = P.bestPLO(hand5, boardA);
    const b = P.bestPLO(hand5, boardB);
    return {
      five: { ...five, category: P.categoryName(five.score) },
      boardA: { ...a, category: P.categoryName(a.score) },
      boardB: { ...b, category: P.categoryName(b.score) }
    };
  }

  // Score one hand between two players. Returns per-contest winners, scoop info, and
  // the net units won by `idA` (idB's result is the negative).
  function scoreShowdown(idA, handA, idB, handB, boardA, boardB) {
    const evals = { [idA]: evaluateFinal(handA, boardA, boardB), [idB]: evaluateFinal(handB, boardA, boardB) };
    const contests = CONTESTS.map(({ key, label }) => {
      const cmp = P.compareScores(evals[idA][key].score, evals[idB][key].score);
      return { key, label, winner: cmp > 0 ? idA : cmp < 0 ? idB : null };
    });
    let net = 0;
    for (const c of contests) net += c.winner === idA ? 1 : c.winner === idB ? -1 : 0;
    let scoop = null;
    if (contests.every((c) => c.winner === idA)) scoop = idA;
    else if (contests.every((c) => c.winner === idB)) scoop = idB;
    if (scoop) net *= SCOOP_MULTIPLIER;
    return { evals, contests, scoop, units: { [idA]: net, [idB]: -net } };
  }

  // ---------------------------------------------------------------------------
  // 3-handed (and the general N-player case): every pair of players plays the same three
  // contests head-up — the hands are compared pairwise, a pair's scoop doubles that
  // matchup only — and each player's result is the sum of their matchups.
  // ---------------------------------------------------------------------------
  const PLAYER_COUNTS = [2, 3];

  // Action order for a hand: the player after the button acts first; the button acts last.
  function actionOrder(ids, buttonIndex) {
    const n = ids.length, out = [];
    for (let i = 1; i <= n; i++) out.push(ids[(buttonIndex + i) % n]);
    return out;
  }
  // Seat labels by number of players and position in the action order.
  function seatLabel(n, pos) {
    if (n === 2) return pos === 0 ? 'Out of position' : 'In position';
    return ['1st to act', '2nd to act', 'Button'][pos];
  }
  function seatShort(n, pos) {
    if (n === 2) return pos === 0 ? 'OOP' : 'IP';
    return ['1st', '2nd', 'BTN'][pos];
  }

  // finals: { [id]: 5 cards }. Returns evals, per-contest places (1 = best, ties share),
  // every pairwise matchup, and each player's total units.
  function scoreTable(ids, finals, boardA, boardB) {
    const evals = {};
    for (const id of ids) evals[id] = evaluateFinal(finals[id], boardA, boardB);
    const contests = CONTESTS.map(({ key, label }) => {
      const places = {};
      for (const id of ids) {
        let better = 0;
        for (const o of ids) if (o !== id && P.compareScores(evals[o][key].score, evals[id][key].score) > 0) better++;
        places[id] = better + 1;
      }
      return { key, label, places };
    });
    const matchups = [];
    const units = {};
    for (const id of ids) units[id] = 0;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      const winners = CONTESTS.map(({ key }) => {
        const cmp = P.compareScores(evals[a][key].score, evals[b][key].score);
        return cmp > 0 ? a : cmp < 0 ? b : null;
      });
      let net = 0;
      for (const w of winners) net += w === a ? 1 : w === b ? -1 : 0;
      const scoop = winners.every((w) => w === a) ? a : winners.every((w) => w === b) ? b : null;
      if (scoop) net *= SCOOP_MULTIPLIER;
      matchups.push({ a, b, winners, scoop, units: { [a]: net, [b]: -net } });
      units[a] += net; units[b] -= net;
    }
    return { evals, contests, matchups, units };
  }

  return {
    HAND_SIZE, HAND_SIZES, FINAL_SIZE, MIN_KEEP, MAX_KEEP, SCOOP_MULTIPLIER, CONTESTS, PLAYER_COUNTS,
    dealHand, validateKeep, drawCount, discardCount, drawLabel, evaluateFinal, scoreShowdown,
    actionOrder, seatLabel, seatShort, scoreTable
  };
});
