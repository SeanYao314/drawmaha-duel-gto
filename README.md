# Drawmaha Duel

A heads-up poker side game in the Drawmaha family, playable in the browser. It has real-time two-player rooms and a practice mode against a bot that solves every flop for an approximate equilibrium. A study panel then shows you what the solver thinks of your draw.

Like its sibling project (Taiwanese Poker), it has **no dependencies**. It runs on Node's built-in `http` module, with nothing to `npm install`.

## Rules

- **Heads-up.** Each player gets **9 cards**. Two 3-card flops, **Board A** and **Board B**, are dealt face up.
- **The player out of position (OOP) acts first.** They keep 2–5 cards and discard the rest (4–7).
  - Discarding exactly 4 keeps 5 cards and draws none. This is called **patting**.
  - Discarding more draws back up to 5 cards.
- **The number of cards OOP draws is announced.** Only then does the player **in position (IP)** choose their own keep.
- **Discards are dead.** After both draws, each board gets a turn and a river.
- **Three contests,** each worth one stake:
  1. Your 5 cards on their own, as a plain **5-card poker hand**.
  2. Your 5 cards as a **PLO5** hand on Board A (exactly 2 of your cards + exactly 3 board cards).
  3. The same on Board B.
- **Scoop.** Winning all three contests outright pays double: 6 stakes instead of 3.
- **Ties push.** An exact tie in a contest moves no money for that contest, and it means nobody can scoop.
- **The button switches every hand.**
- **Discards are shown at showdown.** You see your opponent's discards, and they see yours.

### 7, 8 and 10-card variants

The game also runs with 7, 8 or 10 cards dealt. You pick the hand size when you create a room or start practice, and in practice you can change it between hands. The rest of the game is unchanged: you still keep 2–5 cards and draw back up to 5.

| Cards dealt | Discard range | Pat means discarding | Ways to keep |
|---|---|---|---|
| 7 | 2–5 | 2 | 112 |
| 8 | 3–6 | 3 | 210 |
| 9 (standard) | 4–7 | 4 | 372 |
| 10 | 5–8 | 5 | 627 |

Fewer dealt cards means fewer made hands, so players pat less, draw more, and the swings get bigger. For example, on sample flops the solver's out-of-position player patted about 60% of the time with 9 cards and about 30–40% with 7.

If you play at $100 per contest, each contest is worth $100 and a scoop is worth $600. The stake is picked when a room is created.

Rule constants live in `lib/game.js`: hand size, keep range, the scoop multiplier, and the contest list. `scoreShowdown` is the single place that decides who wins what.

## Running it locally

Requires Node.js 18+.

```bash
node server.js          # http://localhost:3000
node tests/run.js       # test suite
```

Open the page in two browser windows, or send the room link to a friend, to play a live game.

## Live rooms

1. One player creates a room and picks the stake and the number of cards dealt (7–10). They get a 4-character code and a share link.
2. The opponent joins with the code. Rooms are heads-up only.
3. The host starts the game. The first button is random, and it alternates after that.
4. Each player sees their 9 cards and both flops, all fully visible, then clicks the cards to discard (4–7 with 9 cards). A marked card drops down and fades, and clicking it again keeps it.
   - The draw button always says what will happen, for example "Discard 6 · draw 2" or "Pat — discard 4".
   - IP can line up a keep early, but can't submit it until OOP's draw count is announced.
5. After IP draws, the turns and rivers come out one at a time. The opponent's final cards flip over, then the three contests and any scoop are shown. A chime plays when you win, with a bigger one for a scoop. The 🔊 button mutes it.
6. Either player can deal the next hand. Running totals and a hand history stay for the session.

Refreshing or reconnecting puts you back in your seat. Rooms live in server memory only, so restarting the server clears them.

## Practice vs the bot, and the study panel

The **Practice vs Bot** tab runs entirely in your browser. There's no room and no server round-trip. You and the bot alternate positions.

Before the bot draws, it solves the current flop pair (details below). The solve runs in Web Workers spread across your CPU cores, so the page stays responsive. If you're out of position, you act while it solves.

| Depth | Hands sampled per seat | Groups | Refinement rounds | Opponent samples for your hand | Single-core time (9 cards) |
|---|---|---|---|---|---|
| Fast | 300 | 20 | 2 | 2,000 | ~7 s |
| Standard | 700 | 32 | 2 | 4,000 | ~15 s |
| **Deep** (default) | 1,400 | 48 | 2 | 7,000 | ~33 s |
| Max | 2,400 | 64 | 3 | 10,000 | ~75 s |
| Ultra | 3,600 | 80 | 3 | 16,000 | ~2 min |

The work splits across your cores, so divide those times by roughly the number of cores you have, minus one. The 10-card game takes longest, because each hand has 627 ways to keep. The study panel shows the actual time for each solve. Your last practice settings are remembered.

The **Solver study** panel stays hidden until the hand is over, unless you click **Peek at solver**. It shows:

- **Verdict.** Your keep's EV per hand (± one standard error), its rank among all possible keeps, and how much EV you gave up compared with the best keep. If the gap is within the error bar, it says the two are statistically tied.
- **Your keep options.** The top keeps with EV ± error, a **tie** tag on any keep the solver can't separate from the best, and how the solver plays your hand. It also shows the best keep for each draw count, and **hands like yours**: the equilibrium draw mix of the 40 sampled hands whose EV profile is closest to yours.
  - When you're IP, there's a tab for each possible announcement ("bot pats", "bot draws 1", and so on), with the real one marked.
  - A second table shows how your best keep changes with the announcement.
- **This flop's equilibrium.**
  - The value of being OOP or IP on this flop.
  - How often OOP announces each draw count, and how IP responds to each announcement.
  - "Avg gain from deviating": how much a sampled hand could still gain by switching strategy. Near zero means the solve has settled.
- **The bot's draw.** Once the cards are shown: its full dealt hand (kept cards highlighted, discards faded), which keeps it was choosing between, and which one it played. Its discards also appear next to its final hand on the table.

### Position and draw feedback

- **Position banner.** A color-coded banner above the table says where you sit this hand. Gold with a **D** button means you're in position: the opponent draws first and you decide after hearing the count. Blue means you're out of position and act first. Your seat is outlined in the same color, the button holder's chip shows the D, and the banner pulses whenever a new hand is dealt. This works in live games too.
- **GTO grade (practice).** As soon as your draw and the bot's solve are both in, your keep is graded against the solver's best keep (given the bot's real announcement when you're in position). The grade appears as a pop-up, a badge on your seat and a sound:
  - **✓ GTO!** if you found the best draw or one statistically tied with it. It plays a bright chime that climbs in pitch as your streak grows, and the pop-up shows "🔥 N in a row".
  - **Good** if it's within 0.10 stakes, **Inaccuracy** within 0.30, **Mistake** within 0.75, and **Blunder** beyond that. Mistakes and blunders play a low "thud".

  The Session panel tallies your GTO draws, your best and current streak, and each hand's grade. The 🔊 button mutes the sounds.

### Session graph

Below the table, practice mode keeps a running **Session** panel. It has four totals, a line chart by hand (hover for the values after any hand), and a hand-by-hand table:

- **PnL:** the money that actually changed hands.
- **After-draw EV:** what your final five were worth against the bot's actual final five, averaged exactly over every possible turn and river on both boards (discards and both draws removed from the deck). This is PnL with the board luck taken out: if you were behind after the draw but hit both boards, PnL goes up while after-draw EV goes down.
- **GTO EV:** the EV of the solver's best draw for your dealt cards against the equilibrium range (given the bot's real announcement when you're in position). It measures how good your starting hands were.
- **EV lost:** the best draw's EV minus the EV of the draw you actually chose. It's always ≤ 0. For example, picking a keep worth +1.30 when the best was +1.43 adds −0.13 stakes (−$13 at $100).

A new hand's numbers join the graph only once its reveal has finished, so the graph never spoils a result.

### How the solver works (lib/solver.js)

There's no betting, so all of the strategy is in the two keep decisions and in what OOP's draw count gives away. Once the flops are out, the rest of the hand is a small two-player game with hidden information. The exact game is far too big to solve: with 9 cards, about 1.2 billion hands per player and 372 ways to keep from each. So each flop pair is solved on a large sample of each player's range:

1. **Population.** Deal thousands of random hands to each seat. Neither player's real hand is in the sample, so the solved strategies use only public information.
2. **Keep scouting.** For every sampled hand, race every keep to find its best keep for each draw count:
   - first all keeps over about 12–20 runouts;
   - then the best 6 per draw count over 100+ fresh runouts.

   To make that affordable, the solver uses:
   - a **bank** of pre-dealt turn/river pairs with precomputed tables of every hole pair's PLO value, so valuing a hand on a bank board is a few array reads;
   - for each bank board, opponent outcomes dealt in advance, so one runout of your hand is scored against several opponents at once.

   Precision matters here. With about 10 runouts per hand, a hand picks a keep that's typically 0.4–0.8 stakes worse than its best. With racing, it's 0.02–0.04.
3. **Group similar hands.** Cluster hands by their "EV at pat / draw 1 / draw 2 / draw 3" profile (k-means), estimate group-vs-group payoffs for every pair of draw counts, and solve that small game with CFR+. OOP's group picks a draw count; IP's group sees it and picks its own. A small "tremble" keeps rare announcements reachable, so IP still learns sensible replies to them.
4. **Refine every hand.** Grouping on its own blurs decisions, because hands in one group don't all want the same draw count. So, starting from the group solution, every sampled hand re-optimizes on its own, alternating between the seats for a few rounds and averaging strategies (fictitious play):
   - OOP hands respond to IP's actual replies.
   - IP hands respond to each announcement, given which OOP hands make it.
5. **Your hand and the bot's.** Each real hand is scored with every keep against thousands of opponent hands drawn from the solved range. When you're IP, the opponents come from the hands that would have made that announcement. Every keep is scored on the same samples, so differences between keeps get proper error bars.
   - The bot plays the best keep for its hand, picking at random among keeps that are statistically tied with it.
   - Neither real hand ever feeds into the population, so the bot never sees your cards and the study panel never sees the bot's.

**How steady it is.** I re-ran the five-solves-per-hand test that showed the old solver's noise, on the same three hands, using Deep:

| Measurement (1 s.d. across solves) | Old solver (Deep) | New solver (Deep) | New solver (Ultra)* |
|---|---|---|---|
| EV of a given keep | 0.12–0.30 | 0.03–0.08 | 0.01–0.07 (mostly 0.02–0.05) |
| Gap between two different plans (pat vs draw) | 0.17–0.38 | 0.06–0.09 | 0.03–0.08 |
| Value of position on the flop | 0.05–0.15 | 0.02–0.04 | 0.02–0.03 |
| Best keep agreed across solves | 13 of 15 | 12 of 15 | 8 of 9 |

\* Ultra was run 3 times per hand instead of 5 (each single-threaded Ultra solve takes about 2 minutes), so its spreads are rougher estimates.

The agreement count barely moved, and that's expected. On the close hand, the top three keeps really are within 0.03 of each other. The new panel marks them as ties instead of pretending one is clearly best. The ± on each EV is the sampling error of your hand's own evaluation, about 0.03 on Deep. Re-solving the flop with a new sample of hands adds roughly that much again, which is what Max and Ultra reduce.

**Known limits.** Treat the output as a strong study aid, not an exact solution.
- Scouting ignores card clashes between a hand and the pre-dealt opponents (it only ranks that hand's own keeps). The group payoffs and real-hand evaluations deal exactly.
- The solver ignores the blocking effect of the *opponent's discards*. Only the cards each side keeps are forced apart.
- "Avg gain from deviating" uses scouting EVs, which carry a little noise, so it slightly overstates the remaining gap.

To solve a flop from the command line (single-threaded), run:

```bash
node experiments/solve_flop.js "Kh 9d 4s" "Jc Jd 6h" --oop "Ah Kd Qs Jh Td 9h 9c 5c 2d" --ip "As Ks 8h 8c 7d 6s 5h 3c 2c" --preset deep
```

## Deploying so friends can join

Deployment works the same way as the Taiwanese Poker project. Any host that runs `node server.js` and sets `PORT` will do, for example Render, Railway or Fly.io. Point it at this repo, leave the build command blank, and set the start command to `node server.js`. For a one-night game from your laptop, `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000` gives you a public link.

## Project structure

```
server.js                 HTTP server: static files, /lib/*.js, room API, SSE push
lib/poker.js              Readable 5-card evaluator + PLO construction (live scoring, display)
lib/game.js               Drawmaha Duel rules: deal, keep validation, 3 contests, scoop
lib/fasteval.js           Table-driven evaluator + whole-board pair tables for the solver
lib/solver.js             Range-sampling solver: keep racing, hand grouping + CFR+, per-hand refinement
public/index.html         App shell (landing / lobby / table)
public/style.css          Styling (same look as Taiwanese Poker; 4-color deck)
public/client.js          Live game client, practice controller, study panel
public/solver-pool.js     Splits a solve across Web Workers
public/solver-worker.js   Worker entry point
experiments/solve_flop.js Command-line solver
tests/run.js              Test suite (node tests/run.js)
```

`lib/*.js` files are UMD modules, so the browser loads exactly the same rule, evaluator and solver code that Node runs.
