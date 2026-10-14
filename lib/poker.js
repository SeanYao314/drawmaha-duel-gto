// lib/poker.js
// Card representation: 2-char strings, e.g. "As" (Ace of spades), "Td" (Ten of diamonds).
// Ranks: 2 3 4 5 6 7 8 9 T J Q K A   Suits: s h d c
//
// This is the readable evaluator (it also reports *which* five cards made a hand), used
// for live scoring and for display. The solver uses the faster lib/fasteval.js.
// UMD-style so the same code runs server-side (require()) and in the browser
// (served at /lib/poker.js) — no risk of client/server logic drift.

const RANKS = '23456789TJQKA';
const SUITS = 's h d c'.split(' ');

const CATEGORY_NAMES = [
  'High Card',
  'Pair',
  'Two Pair',
  'Trips',
  'Straight',
  'Flush',
  'Full House',
  'Quads',
  'Straight Flush'
];

function freshDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  return deck;
}

function shuffle(deck) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function rankValue(card) {
  return RANKS.indexOf(card[0]) + 2;
}
function suitOf(card) {
  return card[1];
}

// Generate all k-combinations of arr (arr of any items). Fine for small n.
function combinations(arr, k) {
  const results = [];
  const n = arr.length;
  if (k > n) return results;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    results.push(idx.map((i) => arr[i]));
    let i = k - 1;
    while (i >= 0 && idx[i] === i + n - k) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return results;
}

// Evaluate exactly 5 cards. Returns a score array; compare lexicographically.
// score[0] = category (0-8, higher is better), rest are tiebreakers (higher better).
function evaluate5(cards) {
  const ranks = cards.map(rankValue).sort((a, b) => b - a);
  const suits = cards.map(suitOf);
  const isFlush = suits.every((s) => s === suits[0]);

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([r, c]) => ({ r: Number(r), c }))
    .sort((a, b) => b.c - a.c || b.r - a.r);

  const uniqueDesc = [...new Set(ranks)];
  let isStraight = false;
  let straightHigh = 0;
  if (uniqueDesc.length === 5) {
    if (uniqueDesc[0] - uniqueDesc[4] === 4) {
      isStraight = true;
      straightHigh = uniqueDesc[0];
    } else if (uniqueDesc.join(',') === '14,5,4,3,2') {
      // wheel: A-2-3-4-5, straight high is the 5
      isStraight = true;
      straightHigh = 5;
    }
  }

  if (isStraight && isFlush) return [8, straightHigh];
  if (groups[0].c === 4) return [7, groups[0].r, groups[1].r];
  if (groups[0].c === 3 && groups[1] && groups[1].c === 2) return [6, groups[0].r, groups[1].r];
  if (isFlush) return [5, ...ranks];
  if (isStraight) return [4, straightHigh];
  if (groups[0].c === 3) return [3, groups[0].r, ...groups.slice(1).map((g) => g.r)];
  if (groups[0].c === 2 && groups[1] && groups[1].c === 2) {
    const pairs = [groups[0].r, groups[1].r].sort((a, b) => b - a);
    return [2, ...pairs, groups[2].r];
  }
  if (groups[0].c === 2) return [1, groups[0].r, ...groups.slice(1).map((g) => g.r)];
  return [0, ...ranks];
}

// Lexicographic compare of two score arrays. Returns >0 if a>b, <0 if a<b, 0 if equal.
function compareScores(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] === undefined ? -1 : a[i];
    const bv = b[i] === undefined ? -1 : b[i];
    if (av !== bv) return av - bv;
  }
  return 0;
}

// Best 5-card hand out of an arbitrary pool of cards (no usage restriction).
function bestOfPool(pool) {
  const combos = combinations(pool, 5);
  let best = null;
  for (const combo of combos) {
    const score = evaluate5(combo);
    if (!best || compareScores(score, best.score) > 0) best = { score, cards: combo };
  }
  return best;
}

// Hold'em-style construction: best 5 of hand + board with no usage restriction.
function bestGeneric(handCards, board) {
  return bestOfPool([...handCards, ...board]);
}

// PLO construction: EXACTLY 2 of your hole cards + EXACTLY 3 board cards (works for
// any hole-card count — Drawmaha Duel uses it with 5, i.e. PLO5).
function bestPLO(handCards4, board) {
  const handPairs = combinations(handCards4, 2);
  const boardTriples = combinations(board, 3);
  let best = null;
  for (const hp of handPairs) {
    for (const bt of boardTriples) {
      const combo = [...hp, ...bt];
      const score = evaluate5(combo);
      if (!best || compareScores(score, best.score) > 0) best = { score, cards: combo };
    }
  }
  return best;
}

function categoryName(score) {
  return CATEGORY_NAMES[score[0]];
}

const PokerLib = {
  RANKS,
  SUITS,
  CATEGORY_NAMES,
  freshDeck,
  shuffle,
  rankValue,
  suitOf,
  combinations,
  evaluate5,
  compareScores,
  bestOfPool,
  bestGeneric,
  bestPLO,
  categoryName
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PokerLib;
} else {
  window.Poker = PokerLib;
}
