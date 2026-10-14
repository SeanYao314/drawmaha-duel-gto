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

1. One player creates a room and picks the stake. They get a 4-character code and a share link.
2. The opponent joins with the code. Rooms are heads-up only.
3. The host starts the game. The first button is random, and it alternates after that.
4. Each player sees their 9 cards and both flops, then clicks the cards to keep (2–5).
   - The draw button always says what will happen, for example "Discard 6 · draw 2" or "Pat — discard 4".
   - IP can line up a keep early, but can't submit it until OOP's draw count is announced.
5. After IP draws, the turns and rivers come out one at a time. The opponent's final cards flip over, then the three contests and any scoop are shown. A chime plays when you win, with a bigger one for a scoop. The 🔊 button mutes it.
6. Either player can deal the next hand. Running totals and a hand history stay for the session.

Refreshing or reconnecting puts you back in your seat. Rooms live in server memory only, so restarting the server clears them.

## Practice vs the bot, and the study panel

The **Practice vs Bot** tab runs entirely in your browser. There's no room and no server round-trip. You and the bot alternate positions.

Before the bot draws, it solves the current flop pair (details below). The solve runs in Web Workers spread across your CPU cores, so the page stays responsive.

- **Fast:** about a second.
- **Standard:** a couple of seconds on a modern laptop.
- **Deep:** slower, with steadier numbers.

If you're out of position, you act while it solves.

The **Solver study** panel stays hidden until the hand is over, unless you click **Peek at solver**. It shows:

- **Verdict.** Your keep's EV in stakes and dollars per hand, its rank out of all 372 possible keeps, and how much EV you gave up compared with the best keep.
- **Your keep options.** The top keeps for your hand, with EV and how often the solver plays each one, plus the best keep for each draw count.
  - When you're IP, there's a tab for each possible announcement ("bot pats", "bot draws 1", and so on), with the real one marked.
  - A second table shows how your best keep changes with the announcement.
- **This flop's equilibrium.**
  - The value of being OOP or IP on this flop.
  - How often OOP announces each draw count, across every hand it could hold here.
  - How IP responds to each announcement, and how much each announcement is worth to IP.
  - An exploitability estimate.
- **The bot's draw.** Once the cards are shown, which keeps the bot was mixing between and which one it played.

### How the solver works (lib/solver.js)

There's no betting, so all of the strategy is in the two keep decisions and in what OOP's draw count gives away. Once the flops are out, the rest of the hand is a small two-player game with hidden information. The exact game is far too big to solve: about 1.2 billion hands per player, and 372 ways to keep from each. So each flop pair is solved as a **sampled abstraction**:

1. **Population.** Sample N random 9-card hands for each seat (70 / 110 / 170 for Fast / Standard / Deep). Neither player's real hand is in the population, so the solved strategies use only public information.
2. **Candidate keeps.** Score all 372 keeps for every population hand with Monte Carlo runouts, in two rounds:
   - Round A: against a crude field.
   - Round B: against the field's round-A choices.

   Each hand keeps its best few candidates *for each draw count* (12, or 16 on Deep). Keeping candidates for every draw count is what lets a hand choose how much to reveal.
3. **Payoff tensor.** For every OOP hand × IP hand pairing, run random scenarios (both players' draws, plus turns and rivers). Record the payoff of every candidate keep against every candidate keep.
4. **CFR+.** Run counterfactual regret minimisation on that finite game:
   - OOP's information set is its hand.
   - IP's information set is its hand plus the announced draw count.
   - A small "tremble" keeps rarely-used announcements reachable, so IP still learns sensible replies to them.
   - Exploitability inside the sampled game is about 0.001 stakes after 200 iterations.
5. **Observers.** Your real hand and the bot's are evaluated against the population with all 372 keeps and more scenarios. They run their own regret minimisers alongside the population but never feed back into it. That's why the bot never sees your hand, and the study panel never sees the bot's.
   - The bot draws by sampling its own mix, ignoring weights under 5%.
   - When you're IP, the bot's announcement is read from its real draw count.

Speed comes from `lib/fasteval.js`, a table-driven 5-card evaluator (about 25–40 ns per hand, ~57 KB of tables). It also uses a "pair table" trick: a PLO5 hand's value is the best of its 10 two-card pairs on the board, so once every pair is scored, all 372 keeps can be valued from array reads.

**Known limits.** Treat the output as a strong study aid, not an exact solution.
- The solver ignores the blocking effect of the *opponent's discards*. Only the cards each side keeps are forced apart.
- EVs carry Monte Carlo noise of a few hundredths of a stake. When the solver splits its mix between keeps, they're usually within that noise of each other.
- Exploitability is measured inside the sampled game, so it understates the gap to a true full-game equilibrium.

To solve a flop from the command line (single-threaded), run:

```bash
node experiments/solve_flop.js "Kh 9d 4s" "Jc Jd 6h" --oop "Ah Kd Qs Jh Td 9h 9c 5c 2d" --ip "As Ks 8h 8c 7d 6s 5h 3c 2c" --preset standard
```

## Deploying so friends can join

Deployment works the same way as the Taiwanese Poker project. Any host that runs `node server.js` and sets `PORT` will do, for example Render, Railway or Fly.io. Point it at this repo, leave the build command blank, and set the start command to `node server.js`. For a one-night game from your laptop, `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000` gives you a public link.

## Project structure

```
server.js                 HTTP server: static files, /lib/*.js, room API, SSE push
lib/poker.js              Readable 5-card evaluator + PLO construction (live scoring, display)
lib/game.js               Drawmaha Duel rules: deal, keep validation, 3 contests, scoop
lib/fasteval.js           Table-driven evaluator for the solver
lib/solver.js             Sampled-game CFR+ solver (runs in Node and in Web Workers)
public/index.html         App shell (landing / lobby / table)
public/style.css          Styling (same look as Taiwanese Poker; 4-color deck)
public/client.js          Live game client, practice controller, study panel
public/solver-pool.js     Splits a solve across Web Workers
public/solver-worker.js   Worker entry point
experiments/solve_flop.js Command-line solver
tests/run.js              Test suite (node tests/run.js)
```

`lib/*.js` files are UMD modules, so the browser loads exactly the same rule, evaluator and solver code that Node runs.
