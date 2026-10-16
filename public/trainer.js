// public/trainer.js — the Train hub: drills, mistake replay, rules of thumb, range viewer,
// heads-up or 3-handed. Built on the same solvers as practice mode (window.SolverPool)
// and the shared UI helpers client.js exposes on window.DDUI.
//
// A drill "spot" is { players: 2|3, pos (place in the action order; button last), anns
// (draw counts announced before you, in order), flopA, flopB, hand } — plus seat/ann
// for heads-up spots, the shape older saved spots have.
(() => {
  const U = window.DDUI, S = window.Solver, P = window.Poker, G = window.Game;
  const { el, show, hide, toggle, esc, money, cardEl, miniCards, DRAW_NAMES, blockOf, annLabel } = U;
  const STAKE = 100; // drills report dollars at $100 per contest, like the practice default
  const SEAT3 = ['first', 'second', 'button'];
  // Who sits at position p, as seen from a drill seat (you vs unnamed bots).
  const drillName = (n, p, myPos) => (p === myPos ? 'You' : n === 2 ? 'the bot' : ['the 1st player', 'the 2nd player', 'the button'][p]);
  const seatTag = (n, p) => (n === 2 ? (p === 0 ? 'OOP' : 'IP') : ['1st', '2nd', 'BTN'][p]);
  // "bot pats", "1st pats · 2nd draws 2"
  function heardText(spot) {
    if (!spot.anns || !spot.anns.length) return '';
    if (spot.players === 2) return `bot ${annLabel(spot.anns[0])}`;
    return spot.anns.map((d, p) => `${seatTag(3, p)} ${annLabel(d)}`).join(' · ');
  }

  let view = null;

  // =====================================================================
  // NAVIGATION
  // =====================================================================
  function openTrain(v) {
    U.enterTrain();
    U.showScreen('train');
    hide('roomBadge');
    setView(v);
  }
  function setView(v) {
    view = v;
    document.querySelectorAll('.ttab').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    ['drill', 'mistakes', 'rules', 'range'].forEach((x) => toggle('tview-' + x, x === v));
    updateMistakeCounts();
    if (v === 'drill') startDrills();
    else stopDrills();
    if (v === 'mistakes') renderMistakes();
    if (v === 'rules') renderRules();
    if (v === 'range') renderRangeView();
  }
  document.querySelectorAll('.train-card').forEach((b) => b.addEventListener('click', () => openTrain(b.dataset.open)));
  document.querySelectorAll('.ttab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  el('btnTrainBack').addEventListener('click', () => {
    stopDrills();
    window.SolverPool.cancel();
    U.leaveTrain();
    U.showScreen('landing');
    updateMistakeCounts();
  });

  // =====================================================================
  // MISTAKE DECK (spaced repetition)
  // =====================================================================
  // Box 0 = due now. Each correct replay moves a spot up a box and pushes it further
  // out; a wrong replay drops it back to box 0. Five correct in a row retires it.
  const BOX_DELAY = [0, 10 * 60e3, 24 * 3600e3, 3 * 24 * 3600e3, 7 * 24 * 3600e3];
  const MASTERED_BOX = 5;
  const loadDeck = () => U.loadJSON(U.MISTAKES_KEY, []);
  const saveDeck = (d) => U.saveJSON(U.MISTAKES_KEY, d);
  const dueCards = (deck = loadDeck()) => deck.filter((m) => m.box < MASTERED_BOX && m.due <= Date.now()).sort((a, b) => a.due - b.due);
  function updateMistakeCounts() {
    const deck = loadDeck();
    const active = deck.filter((m) => m.box < MASTERED_BOX).length, due = dueCards(deck).length;
    el('ttabMistakes').textContent = due ? due : '';
    el('trainMistakeCount').textContent = active
      ? `${due} due now · ${active} in your deck. They come back until you get them right.`
      : 'Your mistakes and blunders come back until you get them right.';
  }
  updateMistakeCounts();

  // =====================================================================
  // DRILL ENGINE
  // =====================================================================
  const drill = {
    running: false, spot: null, result: null, pending: null, prefetch: null,
    marked: new Set(), answered: false, replay: null, gen: 0,
    stats: { n: 0, gto: 0, loss: 0, streak: 0, best: 0 }
  };

  const POS_OPTIONS = {
    2: [['random', 'Random'], ['0', 'Out of position'], ['1', 'In position']],
    3: [['random', 'Random'], ['0', '1st to act'], ['1', '2nd to act'], ['2', 'Button (last)']]
  };
  function fillPositions(keep) {
    const n = Number(el('drPlayers').value);
    const prev = keep ? el('drPos').value : 'random';
    el('drPos').innerHTML = POS_OPTIONS[n].map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    el('drPos').value = POS_OPTIONS[n].some(([v]) => v === prev) ? prev : 'random';
  }
  // Old saved settings used 'oop' / 'ip' for the position.
  fillPositions(false);
  function syncAnnControls() {
    const n = Number(el('drPlayers').value), pos = el('drPos').value;
    // The first announcement matters unless you're always first; the second only to the button.
    toggle('drAnnWrap', pos !== '0');
    el('drAnnLabel').textContent = n === 3 ? '1st announces' : 'Bot announces';
    toggle('drAnn2Wrap', n === 3 && (pos === '2' || pos === 'random'));
  }
  syncAnnControls();

  function settings() {
    return {
      players: Number(el('drPlayers').value), pos: el('drPos').value, ann: el('drAnn').value, ann2: el('drAnn2').value,
      size: Number(el('drSize').value), depth: el('drDepth').value, close: el('drClose').checked
    };
  }
  el('drPlayers').addEventListener('change', () => fillPositions(true));
  ['drPlayers', 'drPos', 'drAnn', 'drAnn2', 'drSize', 'drDepth', 'drClose'].forEach((id) => el(id).addEventListener('change', () => {
    syncAnnControls();
    if (drill.running && !drill.replay && !drill.answered) { killPrefetch(); newDrill(true); }
    else killPrefetch(); // the next spot will follow the new settings
  }));

  function dealSpot(st) {
    const deck = P.shuffle(P.freshDeck());
    const n = st.players;
    const pos = st.pos === 'random' ? Math.floor(Math.random() * n) : Number(st.pos);
    const fixed = [st.ann, st.ann2];
    const anns = [];
    for (let p = 0; p < pos; p++) anns.push(fixed[p] === 'gto' ? null : Number(fixed[p]));
    return withLegacy({ players: n, pos, anns, flopA: deck.slice(0, 3), flopB: deck.slice(3, 6), hand: deck.slice(6, 6 + st.size) });
  }
  const withLegacy = (spot) => (spot.players === 2 ? { ...spot, seat: spot.pos === 1 ? 'ip' : 'oop', ann: spot.pos === 1 ? spot.anns[0] : null } : { ...spot, seat: SEAT3[spot.pos], ann: null });

  // Solve one spot (just your seat as the observer — there's no opponent hand in a drill).
  function solveSpot(spot, depth, onProgress) {
    const args = {
      flopA: spot.flopA, flopB: spot.flopB, handSize: spot.hand.length, preset: depth, onProgress: onProgress || (() => {}),
      observers: [{ id: 'me', seat: spot.players === 3 ? spot.pos : spot.pos === 1 ? 'ip' : 'oop', cards: spot.hand }]
    };
    return spot.players === 3 ? window.SolverPool.solveFlop3(args) : window.SolverPool.solveFlop(args);
  }
  const spotOffset = (spot) => blockOf(spot.anns) * S.layout(spot.hand.length).NKEEPS;

  // Close spot: the best keep and the best keep with a *different* draw count are within
  // 0.15 stakes — the "pat or draw?" decisions that are easy to get wrong.
  function isClose(res, spot) {
    const NK = S.layout(spot.hand.length).NKEEPS, KD = S.layout(spot.hand.length).KEEP_DRAW;
    const me = res.observers[0], off = spotOffset(spot);
    let best = 0;
    for (let k = 1; k < NK; k++) if (me.ev[off + k] > me.ev[off + best]) best = k;
    let alt = -Infinity;
    for (let k = 0; k < NK; k++) if (KD[k] !== KD[best]) alt = Math.max(alt, me.ev[off + k]);
    return me.ev[off + best] - alt <= 0.15;
  }
  const sampleFrom = (f) => { let r = Math.random(), d = 0; for (; d < 3; d++) { r -= f[d]; if (r <= 0) break; } return d; };

  // Deal + solve a spot that satisfies the current settings (retrying for close spots).
  async function produceSpot(st, isAlive, onProgress) {
    for (let tries = 0; tries < 8; tries++) {
      let spot = dealSpot(st);
      const res = await solveSpot(spot, st.depth, onProgress);
      if (!isAlive()) throw new Error('cancelled');
      // "As GTO would": draw each announcement from the equilibrium's own frequencies.
      const sum = res.summary, anns = spot.anns.slice();
      for (let p = 0; p < anns.length; p++) {
        if (anns[p] !== null) continue;
        anns[p] = spot.players === 2 ? sampleFrom(sum.oopDraw) : p === 0 ? sampleFrom(sum.draw0) : sampleFrom(sum.draw1Given[anns[0]]);
      }
      spot = withLegacy({ ...spot, anns });
      if (!st.close || isClose(res, spot) || tries === 7) return { spot, res };
      if (onProgress) onProgress(0, `Looking for a close spot… (${tries + 1})`);
    }
    throw new Error('unreachable');
  }

  function startDrills() {
    if (drill.running) { renderDrill(); return; }
    drill.running = true;
    newDrill(true);
  }
  function stopDrills() {
    if (!drill.running) return;
    drill.running = false;
    drill.gen++;
    drill.replay = null;
    killPrefetch();
    window.SolverPool.cancel();
  }

  // Show the next spot: use the prefetched one if it's ready, else solve now.
  async function newDrill(fresh) {
    const gen = ++drill.gen;
    drill.answered = false;
    drill.marked = new Set();
    drill.result = null;
    drill.grade = null;
    hide('drResult');
    const st = settings();
    let job;
    if (drill.replay) {
      const m = drill.replay.current;
      const spot = withLegacy(U.normSpot({ ...m.spot }));
      drill.spot = spot;
      drill.solving = true;
      renderDrill();
      job = solveSpot(spot, st.depth, (p) => progressLine(p)).then((res) => ({ spot, res }));
    } else if (!fresh && drill.prefetch) {
      job = drill.prefetch.promise;
      drill.spot = drill.prefetch.spot || null;
      drill.prefetch = null;
    } else {
      killPrefetch();
      window.SolverPool.cancel();
      drill.spot = null;
      job = produceSpot(st, () => gen === drill.gen, (p, msg) => progressLine(p, msg));
    }
    drill.solving = true;
    renderDrill();
    try {
      const { spot, res } = await job;
      if (gen !== drill.gen) return;
      drill.spot = spot; drill.result = res; drill.solving = false;
      renderDrill();
      if (drill.answered) gradeDrill();
      if (!drill.replay && !drill.prefetch) prefetchNext();
    } catch (e) {
      if (gen !== drill.gen || String(e.message).includes('cancelled')) return;
      el('drStatus').textContent = 'Solver error: ' + e.message;
    }
  }
  // Solve the following spot in the background while you think about this one.
  function prefetchNext() {
    const st = settings();
    const pf = { spot: null, alive: true };
    pf.promise = produceSpot(st, () => pf.alive && drill.running, null).then((r) => { pf.spot = r.spot; return r; });
    pf.promise.catch(() => {});
    drill.prefetch = pf;
  }
  function killPrefetch() {
    if (drill.prefetch) { drill.prefetch.alive = false; drill.prefetch = null; }
  }
  function progressLine(p, msg) {
    if (!drill.solving) return;
    el('drStatus').textContent = msg || `Solving this spot… ${Math.round(p * 100)}% — you can mark your discards meanwhile.`;
  }

  // ----- rendering -----
  function renderDrill() {
    const spot = drill.spot;
    renderDrillStrip();
    if (drill.replay) {
      show('replayBanner'); hide('drillSettings');
      const q = drill.replay;
      el('replayBanner').innerHTML = `🔁 Replaying mistake ${q.index + 1} of ${q.queue.length} · first played as <strong>${esc(gradeName(q.current.firstGrade))}</strong> (−${q.current.firstLoss.toFixed(2)} stakes) · box ${q.current.box}/${MASTERED_BOX}`;
    } else { hide('replayBanner'); show('drillSettings'); }
    if (!spot) {
      el('drStatus').textContent = 'Dealing and solving a spot…';
      ['drBoardA', 'drBoardB', 'drCards'].forEach((id) => { el(id).innerHTML = ''; });
      el('drPosBanner').className = 'pos-banner hidden';
      el('drSubmit').disabled = true;
      return;
    }
    const n = spot.players, pos = spot.pos;
    const pc = U.posClass(n, pos);
    const b = el('drPosBanner');
    b.className = 'pos-banner ' + pc;
    const names = Array.from({ length: n }, (_, p) => drillName(n, p, pos));
    const known = spot.anns.every((d) => d !== null && d !== undefined);
    b.innerHTML = U.positionBannerHTML(n, pos, names) + (pos > 0 ? `<span class="pb-heard">${known ? `Heard: <strong>${esc(heardText(spot))}</strong>` : 'Announcements coming…'}</span>` : '');
    el('drPosChip').innerHTML = U.posChipHTML(n, pos);
    el('drPosChip').className = 'pos-chip ' + pc;
    ['ip', 'oop', 'mid'].forEach((c) => el('drSeat').classList.toggle('seat-' + c, c === pc));
    const ac = el('drAnnChip');
    if (pos > 0 && known) { ac.textContent = heardText(spot).replace(/^bot/, 'Bot'); show('drAnnChip'); } else hide('drAnnChip');
    if (drill.solving) progressLine(0); else el('drStatus').textContent = drill.answered ? '' : `${n === 3 ? '3-handed · ' : ''}${spot.hand.length} cards dealt · solved at ${settings().depth} depth.`;
    ['drBoardA', 'drBoardB'].forEach((id, i) => {
      const box = el(id); box.innerHTML = '';
      (i ? spot.flopB : spot.flopA).forEach((c) => box.appendChild(cardEl(c, { extra: 'static' })));
      for (let k = 0; k < 2; k++) { const d = document.createElement('div'); d.className = 'card-slot'; d.textContent = k ? 'river' : 'turn'; box.appendChild(d); }
    });
    renderDrillCards();
  }
  function shownOrder() { return U.sortCards(drill.spot.hand, U.getSortMode()); }
  function renderDrillCards() {
    const spot = drill.spot, box = el('drCards');
    box.innerHTML = '';
    const order = shownOrder();
    const b5 = U.getSortMode() === 'best5' ? U.bestFiveOrder(spot.hand) : null;
    order.forEach((c, i) => {
      if (b5 && i === 0) { const t = document.createElement('div'); t.className = 'best5-tag'; t.innerHTML = `<span>Best 5</span><strong>${esc(b5.category)}</strong>`; box.appendChild(t); }
      const isKeep = drill.answered && drill.grade && drill.grade.bestKeep.includes(c);
      const extra = [drill.marked.has(c) ? 'marked-discard' : '', b5 && i < 5 ? 'in-best5' : '', isKeep ? 'gto-keep' : '', drill.answered ? 'static' : ''].filter(Boolean).join(' ');
      const node = cardEl(c, { extra });
      if (!drill.answered) node.addEventListener('click', () => toggleMark(c));
      const key = document.createElement('span'); key.className = 'card-key'; key.textContent = i < 9 ? String(i + 1) : i === 9 ? '0' : '';
      node.appendChild(key);
      box.appendChild(node);
      if (b5 && i === 4 && order.length > 5) { const sep = document.createElement('div'); sep.className = 'best5-sep'; box.appendChild(sep); }
    });
    const H = spot.hand.length, nd = drill.marked.size, k = H - nd;
    const legal = k >= G.MIN_KEEP && k <= G.MAX_KEEP;
    const btn = el('drSubmit');
    if (drill.answered) {
      btn.disabled = false;
      btn.textContent = drill.replay ? (drill.replay.index + 1 < drill.replay.queue.length ? 'Next mistake ▶' : 'Finish replay') : 'Next spot ▶';
      const hint = el('drHint');
      if (drill.grade) {
        hint.innerHTML = '<span class="solver-keep-label">Solver’s keep (green):</span>';
        hint.appendChild(miniCards(drill.grade.bestKeep, { highlight: drill.grade.bestKeep }));
        hint.classList.add('with-cards');
      } else { hint.textContent = 'Grading as soon as the solve finishes…'; hint.classList.remove('with-cards'); }
      hide('drClear'); hide('drSkip');
    } else {
      show('drClear'); toggle('drSkip', !drill.replay);
      btn.disabled = !legal;
      btn.textContent = !legal ? `Mark ${H - G.MAX_KEEP}–${H - G.MIN_KEEP} cards to discard` : k === 5 ? `Pat — discard ${nd}` : `Discard ${nd} · draw ${5 - k}`;
      el('drHint').classList.remove('with-cards');
      el('drHint').textContent = nd === 0 ? `Click the cards you want to discard (${H - G.MAX_KEEP}–${H - G.MIN_KEEP}).` : legal ? `Keeping ${k} → ${k === 5 ? 'pat' : 'draw ' + (5 - k)}.` : k > 5 ? `Discard at least ${H - 5}.` : `Discard at most ${H - 2}.`;
    }
    const g = el('drGrade');
    if (drill.grade) { g.className = `grade-badge g-${drill.grade.key}`; g.textContent = (drill.grade.key === 'gto' ? '✓ ' : '') + drill.grade.label; }
    else if (drill.answered) { g.className = 'grade-badge g-pending'; g.textContent = 'Grading…'; }
    else g.className = 'grade-badge hidden';
  }
  function toggleMark(c) {
    if (drill.answered || !drill.spot) return;
    if (drill.marked.has(c)) drill.marked.delete(c); else drill.marked.add(c);
    renderDrillCards();
  }
  function renderDrillStrip() {
    const s = drill.stats;
    el('drillStrip').innerHTML = `
      <span class="score-pill">Spots <span class="amt">${s.n}</span></span>
      <span class="score-pill">GTO <span class="amt">${s.n ? `${s.gto}/${s.n} (${Math.round(100 * s.gto / s.n)}%)` : '—'}</span></span>
      <span class="score-pill">Avg EV lost <span class="amt ${s.n && s.loss / s.n > 0.005 ? 'neg' : ''}">${s.n ? money(-s.loss / s.n * STAKE) : '—'}</span></span>
      <span class="score-pill">Streak <span class="amt">${s.streak}${s.best ? ` · best ${s.best}` : ''}</span></span>`;
  }

  // ----- answering -----
  el('drClear').addEventListener('click', () => { drill.marked = new Set(); renderDrillCards(); });
  el('drSkip').addEventListener('click', () => { if (!drill.answered) newDrill(false); });
  el('drSubmit').addEventListener('click', onSubmit);
  function onSubmit() {
    if (!drill.spot) return;
    if (drill.answered) {
      if (drill.replay) nextReplay(); else newDrill(false);
      return;
    }
    const H = drill.spot.hand.length, k = H - drill.marked.size;
    if (k < G.MIN_KEEP || k > G.MAX_KEEP) return;
    drill.answered = true;
    drill.myKeep = drill.spot.hand.filter((c) => !drill.marked.has(c));
    renderDrillCards();
    if (drill.result) gradeDrill();
  }
  function gradeDrill() {
    const spot = drill.spot, res = drill.result;
    const L = S.layout(spot.hand.length), NK = L.NKEEPS;
    const me = res.observers[0], off = spotOffset(spot);
    let best = 0;
    for (let k = 1; k < NK; k++) if (me.ev[off + k] > me.ev[off + best]) best = k;
    const mine = U.keepIndexOf(spot.hand, drill.myKeep);
    const loss = me.ev[off + best] - me.ev[off + mine];
    const g = U.gradeFor(loss, me.seDiff[off + mine], mine === best);
    drill.grade = { key: g.key, label: g.label, loss, best, mine, bestKeep: S.keepCards(spot.hand, best) };
    const s = drill.stats;
    s.n++; s.loss += Math.max(0, loss);
    if (g.key === 'gto') { s.gto++; s.streak++; s.best = Math.max(s.best, s.streak); } else s.streak = 0;
    U.showGradeToastFor(drill.grade, STAKE, s.streak);
    U.playGradeSound(g.sound, s.streak);
    U.recordDecision({
      source: drill.replay ? 'replay' : 'drill', flopA: spot.flopA, flopB: spot.flopB, hand: spot.hand,
      players: spot.players, pos: spot.pos, anns: spot.anns, seat: spot.seat, ann: spot.ann, preset: settings().depth,
      myKeep: drill.myKeep, bestKeep: drill.grade.bestKeep, loss, grade: g.key
    });
    if (drill.replay) updateReplayCard(g.key);
    updateMistakeCounts();
    renderDrillStrip();
    renderDrillCards();
    renderDrillResult();
  }
  function renderDrillResult() {
    const spot = drill.spot, res = drill.result, gr = drill.grade;
    const L = S.layout(spot.hand.length), NK = L.NKEEPS, KD = L.KEEP_DRAW;
    const me = res.observers[0], off = spotOffset(spot);
    const ev = (k) => me.ev[off + k], se = (k) => me.se[off + k], sd = (k) => me.seDiff[off + k];
    const order = Array.from({ length: NK }, (_, i) => i).sort((a, b) => ev(b) - ev(a));
    const rows = order.slice(0, 6);
    if (!rows.includes(gr.mine)) rows.push(gr.mine);
    let html = `<div class="verdict">${gr.key === 'gto'
      ? `<strong class="good">✓ ${gr.mine === gr.best ? 'Solver’s best keep.' : 'Statistically tied with the best keep.'}</strong>`
      : `Your keep is #${order.indexOf(gr.mine) + 1} of ${NK}: <strong class="bad">${gr.loss.toFixed(2)} stakes (${money(gr.loss * STAKE, { sign: false })}) behind the best</strong>.`}
      ${spot.pos > 0 ? ` (Given ${esc(heardText(spot))}.)` : ''}${spot.players === 3 ? ' EVs cover both matchups.' : ''}</div>`;
    html += `<div class="table-scroll"><table class="ev-table"><tr><th>#</th><th>Keep</th><th>EV / hand</th><th>Draw</th></tr>` +
      rows.map((k) => `<tr class="${k === gr.mine ? 'chosen' : ''}${k === gr.best ? ' best' : ''}" data-ki="${k}"><td>${order.indexOf(k) + 1}${k === gr.mine ? ' <span class="tag-mini">you</span>' : ''}${k !== gr.best && ev(gr.best) - ev(k) <= sd(k) ? ' <span class="tag-mini">tie</span>' : ''}</td><td class="keepcell"></td><td>${U.evText(ev(k), STAKE, se(k))}</td><td>${DRAW_NAMES[KD[k]]}</td></tr>`).join('') +
      '</table></div>';
    const sim = me.similar;
    if (sim) {
      const mix = Array.isArray(sim.mix[0]) ? sim.mix[blockOf(spot.anns)] : sim.mix;
      html += `<p style="margin-top:12px"><strong>Hands like yours</strong> <span class="hint-inline" style="color:var(--muted)">(the ${sim.n} closest sampled hands)</span> play:</p><div class="mix-row"><span>Equilibrium</span>${U.mixBar(mix)}</div>${U.mixLegend()}`;
    }
    html += `<details class="rv-inline"><summary>Range viewer for this flop</summary><div class="rv-host"></div></details>`;
    const box = el('drResult');
    box.innerHTML = html;
    box.querySelectorAll('tr[data-ki] .keepcell').forEach((td) => td.appendChild(miniCards(S.keepCards(spot.hand, Number(td.parentElement.dataset.ki)))));
    renderRangeViewer(box.querySelector('.rv-host'), res.range, { pos: spot.pos, anns: spot.anns });
    show('drResult');
  }

  // keyboard: digits mark cards, Enter submits / continues
  document.addEventListener('keydown', (e) => {
    if (view !== 'drill' || !drill.running || !drill.spot || e.target.closest('input,select,textarea')) return;
    if (e.key === 'Enter') { e.preventDefault(); if (!el('drSubmit').disabled) onSubmit(); return; }
    const idx = e.key === '0' ? 9 : /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : -1;
    if (idx >= 0) { const c = shownOrder()[idx]; if (c) toggleMark(c); }
  });
  U.onSort = () => { if (view === 'drill' && drill.spot) renderDrillCards(); };

  // =====================================================================
  // MISTAKE REPLAY
  // =====================================================================
  const gradeName = (k) => ({ gto: 'GTO', good: 'Good', inacc: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder' }[k] || k);
  function spotTag(rawSpot) {
    const sp = U.normSpot(rawSpot);
    const where = sp.players === 2 ? (sp.pos === 1 ? 'IP' : 'OOP') : `3-handed · ${seatTag(3, sp.pos)}`;
    const heard = sp.anns && sp.anns.length ? ` · ${heardText(sp)}` : '';
    return where + heard;
  }
  function renderMistakes() {
    const deck = loadDeck();
    const due = dueCards(deck), active = deck.filter((m) => m.box < MASTERED_BOX), mastered = deck.length - active.length;
    const box = el('tview-mistakes');
    if (!deck.length) {
      box.innerHTML = `<p class="hint">No mistakes saved yet. Every <strong>Mistake</strong> or <strong>Blunder</strong> you make in practice games or drills — heads-up or 3-handed — lands here, and comes back on a schedule until you get it right (10 minutes, then 1, 3 and 7 days).</p>`;
      return;
    }
    const when = (t) => { const d = t - Date.now(); if (d <= 0) return 'now'; const h = d / 3600e3; return h < 1 ? `${Math.ceil(d / 60e3)} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`; };
    box.innerHTML = `
      <div class="mistake-head">
        <p><strong>${due.length}</strong> due now · ${active.length} in your deck · ${mastered} mastered</p>
        <button id="btnReplayDue" class="primary sm" ${due.length ? '' : 'disabled'}>Replay ${due.length || ''} due</button>
        <button id="btnReplayAll" class="secondary sm" ${active.length ? '' : 'disabled'}>Replay all ${active.length}</button>
      </div>
      <div class="table-scroll"><table class="ev-table mistake-table"><tr><th>Spot</th><th>Your keep</th><th>Solver's keep</th><th>First</th><th>Box</th><th>Due</th><th></th></tr>
      ${deck.slice().reverse().map((m) => `<tr data-id="${m.id}" class="${m.box >= MASTERED_BOX ? 'mastered' : ''}">
        <td><span class="tag-mini">${esc(spotTag(m.spot))}</span> <span class="hint-inline">${m.spot.flopA.join(' ')} | ${m.spot.flopB.join(' ')}</span></td>
        <td class="mk-mine"></td><td class="mk-best"></td>
        <td><span class="grade-badge g-${m.firstGrade}">${gradeName(m.firstGrade)}</span> <span class="hint-inline">−${m.firstLoss.toFixed(2)}</span></td>
        <td>${m.box >= MASTERED_BOX ? '✓ mastered' : `${m.box}/${MASTERED_BOX}`}</td><td>${m.box >= MASTERED_BOX ? '—' : when(m.due)}</td>
        <td><button class="link-btn" data-del="${m.id}" title="Remove">✕</button></td></tr>`).join('')}
      </table></div>`;
    box.querySelectorAll('tr[data-id]').forEach((tr) => {
      const m = deck.find((x) => x.id === tr.dataset.id);
      tr.querySelector('.mk-mine').appendChild(miniCards(m.myKeep));
      tr.querySelector('.mk-best').appendChild(miniCards(m.bestKeep));
    });
    box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { saveDeck(loadDeck().filter((x) => x.id !== b.dataset.del)); updateMistakeCounts(); renderMistakes(); }));
    const start = (queue) => {
      drill.replay = { queue, index: 0, current: queue[0] };
      drill.running = true;
      view = 'drill';
      document.querySelectorAll('.ttab').forEach((b) => b.classList.toggle('active', b.dataset.view === 'drill'));
      ['drill', 'mistakes', 'rules', 'range'].forEach((x) => toggle('tview-' + x, x === 'drill'));
      newDrill(true);
    };
    const bd = el('btnReplayDue'), ba = el('btnReplayAll');
    if (bd) bd.addEventListener('click', () => start(dueCards()));
    if (ba) ba.addEventListener('click', () => start(loadDeck().filter((m) => m.box < MASTERED_BOX)));
  }
  function updateReplayCard(gradeKey) {
    const deck = loadDeck();
    const m = deck.find((x) => x.id === drill.replay.current.id);
    if (!m) return;
    m.attempts++;
    if (gradeKey === 'gto' || gradeKey === 'good') { m.correct++; m.box = Math.min(MASTERED_BOX, m.box + 1); }
    else m.box = 0;
    m.due = Date.now() + (BOX_DELAY[Math.min(m.box, BOX_DELAY.length - 1)] || 0);
    drill.replay.current = m;
    saveDeck(deck);
  }
  function nextReplay() {
    const q = drill.replay;
    q.index++;
    if (q.index >= q.queue.length) {
      drill.replay = null;
      drill.running = false;
      setView('mistakes');
      return;
    }
    q.current = loadDeck().find((x) => x.id === q.queue[q.index].id) || q.queue[q.index];
    newDrill(true);
  }

  // =====================================================================
  // RULES OF THUMB
  // =====================================================================
  // Mines the decision log for patterns that cost you EV, and states each one plainly.
  function features(d) {
    const best5 = P.bestOfPool(d.hand);
    const cat = Math.min(6, best5.score[0]);
    const tex = (flop) => {
      const suits = {}, ranks = {};
      flop.forEach((c) => { suits[c[1]] = (suits[c[1]] || 0) + 1; ranks[c[0]] = (ranks[c[0]] || 0) + 1; });
      return { paired: Object.values(ranks).some((x) => x >= 2), suited: Math.max(...Object.values(suits)) >= 2, mono: Math.max(...Object.values(suits)) === 3 };
    };
    const a = tex(d.flopA), b = tex(d.flopB);
    return { cat, catName: S.RANGE_CATS[cat], paired: a.paired || b.paired, flushy: a.mono || b.mono || (a.suited && b.suited) };
  }
  // Where a decision was made, as a key and a label.
  const SPOTS = [
    { key: '2-0', label: 'Heads-up, out of position', short: 'out of position (heads-up)', drill: 'Players: Heads-up, Position: Out of position' },
    { key: '2-1', label: 'Heads-up, in position', short: 'in position (heads-up)', drill: 'Players: Heads-up, Position: In position' },
    { key: '3-0', label: '3-handed, 1st to act', short: '1st to act (3-handed)', drill: 'Players: 3-handed, Position: 1st to act' },
    { key: '3-1', label: '3-handed, 2nd to act', short: '2nd to act (3-handed)', drill: 'Players: 3-handed, Position: 2nd to act' },
    { key: '3-2', label: '3-handed, on the button', short: 'on the button (3-handed)', drill: 'Players: 3-handed, Position: Button' }
  ];
  const SPOT_TIPS = {
    '2-0': 'Acting first, your draw count is information — weigh what your announcement tells the bot, not just your own hand.',
    '2-1': 'In position, adjust to the announcement: against a pat, chase the boards; against a big draw, protect what you have.',
    '3-0': 'First of three, your announcement goes to two players at once — you face two ranges that both get to adjust, so made hands gain value and marginal draws lose it.',
    '3-1': 'In the middle you know the 1st player\'s count but the button still gets to react to yours — play closer to your hand\'s raw strength than you would on the button.',
    '3-2': 'On the button you have heard both counts: two pats in front of you mean two made hands to beat on the 5-card contest; two big draws mean protect what you have.'
  };
  function renderRules() {
    const log = U.loadJSON(U.DECISIONS_KEY, []).map(U.normSpot);
    const box = el('tview-rules');
    const N = log.length;
    if (N < 5) {
      box.innerHTML = `<p class="hint">Rules of thumb need a few graded decisions first — you have ${N}. Play some <strong>Drills</strong> or practice hands (every draw you make there is graded and logged), then come back.</p>`;
      return;
    }
    const recent = log.slice(-400);
    const enriched = recent.map((d) => ({ ...d, f: features(d), lossPos: Math.max(0, d.loss), spotKey: `${d.players}-${d.pos}` }));
    const sum = (arr) => arr.reduce((a, d) => a + d.lossPos, 0);
    const avgAll = sum(enriched) / enriched.length;
    const rules = [];
    const add = (subset, text, tip) => {
      if (subset.length < 3) return;
      const tot = sum(subset), avg = tot / subset.length;
      if (avg < 0.05 || tot < 0.3) return;
      rules.push({ text, tip, n: subset.length, tot, avg });
    };
    const mostCommon = (arr, key) => { const c = {}; arr.forEach((d) => { c[key(d)] = (c[key(d)] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0]; };

    const brokePat = enriched.filter((d) => d.bestDraw === 0 && d.myDraw > 0);
    add(brokePat, `When the solver pats, you broke your hand to draw ${brokePat.length} time${brokePat.length > 1 ? 's' : ''}.`,
      `Pat more — most often with <strong>${esc(mostCommon(brokePat, (d) => d.f.catName) || '')}</strong>. A made five wins the 5-card contest outright and blocks the scoop.`);
    const patWrong = enriched.filter((d) => d.bestDraw > 0 && d.myDraw === 0);
    add(patWrong, `You patted ${patWrong.length} time${patWrong.length > 1 ? 's' : ''} when the solver drew.`,
      `Those were mostly <strong>${esc(mostCommon(patWrong, (d) => d.f.catName) || '')}</strong> hands — not strong enough to stand pat; the solver usually drew ${Math.round(patWrong.reduce((a, d) => a + d.bestDraw, 0) / patWrong.length)}.`);
    const tooMany = enriched.filter((d) => d.bestDraw > 0 && d.myDraw > d.bestDraw);
    add(tooMany, `You drew more cards than the solver ${tooMany.length} times.`, 'Keep one more card: a stronger core usually beats a fresh card on both PLO boards.');
    const tooFew = enriched.filter((d) => d.myDraw > 0 && d.myDraw < d.bestDraw);
    add(tooFew, `You drew fewer cards than the solver ${tooFew.length} times.`, 'You held on to a weak kicker or side card — let it go and draw.');
    const wrongCards = enriched.filter((d) => d.myDraw === d.bestDraw && d.grade !== 'gto');
    add(wrongCards, `Right number of cards, wrong ones kept: ${wrongCards.length} spots.`, 'Compare your keep with the solver’s in Mistake replay — the difference is usually which pair or suit carries both boards.');
    for (const sp of SPOTS) {
      const sub = enriched.filter((d) => d.spotKey === sp.key);
      if (sub.length >= 5 && sum(sub) / sub.length > avgAll * 1.3) add(sub, `You lose the most ${sp.short}.`, `${SPOT_TIPS[sp.key]} Drill it with ${sp.drill}.`);
    }
    for (let a = 0; a < 4; a++) {
      const sub = enriched.filter((d) => d.players === 2 && d.pos === 1 && d.anns[0] === a);
      if (sub.length >= 3 && sum(sub) / sub.length > avgAll * 1.3) add(sub, `Your weakest heads-up spot: in position after the bot ${annLabel(a)}.`, `Drill it: Players Heads-up, Position In position, Bot announces “${DRAW_NAMES[a]}”.`);
    }
    // 3-handed: the last announcement you heard (the one just before you).
    for (let a = 0; a < 4; a++) {
      const sub = enriched.filter((d) => d.players === 3 && d.pos > 0 && d.anns[d.pos - 1] === a);
      if (sub.length >= 3 && sum(sub) / sub.length > avgAll * 1.3) add(sub, `3-handed, you struggle right after the player before you ${annLabel(a)}.`, `Drill it: Players 3-handed, Position 2nd to act, 1st announces “${DRAW_NAMES[a]}”.`);
    }
    for (let c = 0; c < 7; c++) {
      const sub = enriched.filter((d) => d.f.cat === c);
      if (sub.length >= 4 && sum(sub) / sub.length > avgAll * 1.4) add(sub, `Hands dealt with a ${S.RANGE_CATS[c].toLowerCase()} cost you the most per decision.`, 'Open the Range viewer on a few flops and look at how the equilibrium plays that row.');
    }
    const paired = enriched.filter((d) => d.f.paired);
    if (paired.length >= 4 && sum(paired) / paired.length > avgAll * 1.4) add(paired, 'Paired flops trip you up.', 'On a paired flop, full houses and trips are live on that board — kept pairs gain value, lone high cards lose it.');
    const flushy = enriched.filter((d) => d.f.flushy);
    if (flushy.length >= 4 && sum(flushy) / flushy.length > avgAll * 1.4) add(flushy, 'Flush-heavy flops trip you up.', 'With two suited flops, suited pairs in your keep pull double duty — and unsuited keeps lose more than they look.');
    rules.sort((a, b) => b.tot - a.tot);
    // Too few decisions for a specific pattern but clearly losing: say what kind of error dominates.
    if (!rules.length && avgAll > 0.1) {
      const countWrong = enriched.filter((d) => d.myDraw !== d.bestDraw), cardsWrong = enriched.filter((d) => d.myDraw === d.bestDraw && d.grade !== 'gto');
      const big = sum(countWrong) >= sum(cardsWrong) ? countWrong : cardsWrong;
      if (big.length) rules.push({
        text: big === countWrong ? `Most of your loss comes from drawing the wrong number of cards (${countWrong.length} of ${enriched.length} spots).` : `Most of your loss comes from keeping the wrong cards with the right draw count (${cardsWrong.length} of ${enriched.length} spots).`,
        tip: 'Too few decisions yet to pin down a more specific pattern — keep drilling and this will sharpen.', n: big.length, tot: sum(big), avg: sum(big) / big.length
      });
    }

    const gto = enriched.filter((d) => d.grade === 'gto').length;
    const by = (pred) => { const s = enriched.filter(pred); return s.length ? { n: s.length, avg: sum(s) / s.length, gto: s.filter((d) => d.grade === 'gto').length } : null; };
    const rowsTbl = [
      ...SPOTS.map((sp) => [sp.label, by((d) => d.spotKey === sp.key)]),
      ...[0, 1, 2, 3].map((a) => [`  … heads-up, after bot ${annLabel(a)}`, by((d) => d.players === 2 && d.pos === 1 && d.anns[0] === a)]),
      ['Solver pats', by((d) => d.bestDraw === 0)], ['Solver draws', by((d) => d.bestDraw > 0)]
    ].filter((r) => r[1]);
    box.innerHTML = `
      <p class="hint">Based on your last ${enriched.length} graded decisions (${gto} GTO, average ${money(-avgAll * STAKE)} per decision at $100 stakes).</p>
      ${rules.length ? rules.slice(0, 6).map((r, i) => `<div class="rule-card"><div class="rule-n">${i + 1}</div><div><div class="rule-text">${r.text}</div><div class="rule-tip">${r.tip}</div><div class="rule-meta">${r.n} decisions · cost ${money(-r.tot * STAKE)} total · ${money(-r.avg * STAKE)} each</div></div></div>`).join('')
        : '<div class="rule-card"><div class="rule-n">✓</div><div><div class="rule-text">No consistent leak stands out yet.</div><div class="rule-tip">Keep drilling — patterns show up after a few dozen decisions.</div></div></div>'}
      <h4 style="margin:18px 0 8px">Breakdown</h4>
      <div class="table-scroll"><table class="ev-table"><tr><th>Spot type</th><th>Decisions</th><th>GTO</th><th>Avg EV lost</th></tr>
      ${rowsTbl.map(([name, r]) => `<tr><td>${name}</td><td>${r.n}</td><td>${Math.round(100 * r.gto / r.n)}%</td><td class="${r.avg > 0.005 ? 'ev-neg' : ''}">${money(-r.avg * STAKE)}</td></tr>`).join('')}
      </table></div>
      <p style="margin-top:12px"><button id="btnClearLog" class="link-btn">Reset decision history</button></p>`;
    el('btnClearLog').addEventListener('click', () => {
      if (!confirm('Delete your decision history? (Your mistake deck is kept.)')) return;
      U.saveJSON(U.DECISIONS_KEY, []);
      renderRules();
    });
  }

  // =====================================================================
  // RANGE VIEWER
  // =====================================================================
  // Rows = hand types (best plain 5-card hand in the dealt cards); bars = share of the
  // range and the equilibrium draw mix.
  //   heads-up tabs: OOP strategy · IP response (per announcement) · OOP's range by announcement
  //   3-handed tabs: 1st · 2nd's response (per d0) · button's response (per d0, d1)
  //                  · 1st's range by announcement · 2nd's range by announcement
  // focus: { pos, anns } (the seat you're studying) — or the older { tab, ann }.
  function renderRangeViewer(host, range, focus = {}) {
    if (!host || !range) return;
    if (range.players === 3) return renderRangeViewer3(host, range, focus);
    const fTab = focus.tab || (focus.pos === 1 ? 'ip' : 'oop');
    const state = { tab: fTab, ann: focus.ann ?? (focus.anns && focus.anns.length ? focus.anns[0] : 0) };
    const draw = () => {
      let rows, title, mode = 'mix';
      if (state.tab === 'oop') { rows = range.oop; title = 'Out of position: how each hand type draws'; }
      else if (state.tab === 'ip') { rows = range.ip[state.ann]; title = `In position, after OOP ${annLabel(state.ann)}: how each hand type responds`; }
      else { rows = range.oopGiven[state.ann]; title = `What OOP holds when it ${annLabel(state.ann)}`; mode = 'share'; }
      host.innerHTML = `
        <div class="study-tabs">
          <button class="study-tab${state.tab === 'oop' ? ' active' : ''}" data-tab="oop">OOP strategy</button>
          <button class="study-tab${state.tab === 'ip' ? ' active' : ''}" data-tab="ip">IP response</button>
          <button class="study-tab${state.tab === 'given' ? ' active' : ''}" data-tab="given">OOP's range by announcement</button>
        </div>
        ${state.tab !== 'oop' ? `<div class="study-tabs">${[0, 1, 2, 3].map((d) => `<button class="study-tab sub${state.ann === d ? ' active' : ''}" data-ann="${d}">OOP ${annLabel(d)}</button>`).join('')}</div>` : ''}
        ${rangeGrid(title, rows, mode)}`;
      host.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; draw(); }));
      host.querySelectorAll('[data-ann]').forEach((b) => b.addEventListener('click', () => { state.ann = Number(b.dataset.ann); draw(); }));
    };
    draw();
  }
  function renderRangeViewer3(host, range, focus) {
    const pos = focus.pos ?? 0, anns = focus.anns || [];
    const state = { tab: ['s0', 's1', 's2'][pos] || 's0', d0: anns[0] ?? 0, d1: anns[1] ?? 0 };
    const draw = () => {
      let rows, title, mode = 'mix', subs = 0;
      const c = state.d0 * 4 + state.d1;
      if (state.tab === 's0') { rows = range.s0; title = '1st to act: how each hand type draws'; }
      else if (state.tab === 's1') { rows = range.s1[state.d0]; title = `2nd to act, after 1st ${annLabel(state.d0)}: how each hand type responds`; subs = 1; }
      else if (state.tab === 's2') { rows = range.s2[c]; title = `Button, after 1st ${annLabel(state.d0)} and 2nd ${annLabel(state.d1)}: how each hand type responds`; subs = 2; }
      else if (state.tab === 'g0') { rows = range.given0[state.d0]; title = `What the 1st player holds when it ${annLabel(state.d0)}`; mode = 'share'; subs = 1; }
      else { rows = range.given1[c]; title = `What the 2nd player holds when it ${annLabel(state.d1)} after 1st ${annLabel(state.d0)}`; mode = 'share'; subs = 2; }
      const tab = (k, t) => `<button class="study-tab${state.tab === k ? ' active' : ''}" data-tab="${k}">${t}</button>`;
      host.innerHTML = `
        <div class="study-tabs">${tab('s0', '1st strategy')}${tab('s1', '2nd response')}${tab('s2', 'Button response')}${tab('g0', '1st\'s range by announcement')}${tab('g1', '2nd\'s range by announcement')}</div>
        ${subs >= 1 ? `<div class="study-tabs">${[0, 1, 2, 3].map((d) => `<button class="study-tab sub${state.d0 === d ? ' active' : ''}" data-d0="${d}">1st ${annLabel(d)}</button>`).join('')}</div>` : ''}
        ${subs >= 2 ? `<div class="study-tabs">${[0, 1, 2, 3].map((d) => `<button class="study-tab sub${state.d1 === d ? ' active' : ''}" data-d1="${d}">2nd ${annLabel(d)}</button>`).join('')}</div>` : ''}
        ${rangeGrid(title, rows, mode)}`;
      host.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; draw(); }));
      host.querySelectorAll('[data-d0]').forEach((b) => b.addEventListener('click', () => { state.d0 = Number(b.dataset.d0); draw(); }));
      host.querySelectorAll('[data-d1]').forEach((b) => b.addEventListener('click', () => { state.d1 = Number(b.dataset.d1); draw(); }));
    };
    draw();
  }
  function rangeGrid(title, rows, mode) {
    const maxShare = Math.max(...rows.map((r) => r.share), 0.01);
    return `<p style="margin:6px 0 10px"><strong>${title}</strong></p>
      <div class="rv-grid">
        <div class="rv-h">Hand type</div><div class="rv-h">Share of range</div><div class="rv-h">${mode === 'mix' ? 'Draw mix' : ''}</div>
        ${rows.map((r) => `<div class="rv-name">${esc(r.name)}</div>
          <div class="rv-share"><span class="rv-bar" style="width:${(r.share / maxShare) * 100}%"></span><span class="rv-pct">${(r.share * 100).toFixed(r.share < 0.1 ? 1 : 0)}%</span></div>
          <div>${mode === 'mix' ? (r.share > 0 ? U.mixBar(r.mix) : '<span class="hint-inline" style="color:var(--muted)">—</span>') : ''}</div>`).join('')}
      </div>
      ${mode === 'mix' ? U.mixLegend() : ''}
      <p class="hint" style="font-size:.78rem;margin-top:8px">Hand type = the best plain 5-card hand in the dealt cards (before any discards). The solver's real decisions also weigh both PLO boards, so two hands of the same type can play differently.</p>`;
  }
  window.DDTrainer = { renderRangeViewer };

  // Standalone range viewer tab
  let rvGen = 0;
  function parseFlop(text) {
    const cards = text.trim().split(/[\s,]+/).filter(Boolean).map((c) => c[0].toUpperCase() + (c[1] || '').toLowerCase());
    const ok = cards.length === 3 && cards.every((c) => /^[2-9TJQKA][shdc]$/.test(c));
    return ok ? cards : null;
  }
  function renderRangeView() {
    if (!el('rvA').value && !el('rvB').value) randomFlops();
  }
  function randomFlops() {
    const d = P.shuffle(P.freshDeck());
    el('rvA').value = d.slice(0, 3).join(' ');
    el('rvB').value = d.slice(3, 6).join(' ');
  }
  el('rvRandom').addEventListener('click', randomFlops);
  el('rvSolve').addEventListener('click', async () => {
    const a = parseFlop(el('rvA').value), b = parseFlop(el('rvB').value);
    hide('rvError');
    if (!a || !b || new Set([...a, ...b]).size !== 6) {
      el('rvError').textContent = 'Enter two flops of three different cards each, like "Kh 9d 4s".';
      show('rvError');
      return;
    }
    const gen = ++rvGen;
    const three = el('rvPlayers').value === '3';
    el('rvBoards').innerHTML = [a, b].map((f, i) => `<div class="board-block"><h4>Board ${'AB'[i]}</h4><div class="board-cards" data-f="${i}"></div></div>`).join('');
    el('rvBoards').querySelectorAll('[data-f]').forEach((bx) => (bx.dataset.f === '0' ? a : b).forEach((c) => bx.appendChild(cardEl(c, { extra: 'static' }))));
    show('rvProgress'); el('rvProgressBar').style.width = '0%';
    el('rvOut').innerHTML = '';
    el('rvSolve').disabled = true;
    try {
      const args = { flopA: a, flopB: b, handSize: Number(el('rvSize').value), preset: el('rvDepth').value, observers: [], onProgress: (p) => { el('rvProgressBar').style.width = `${Math.round(p * 100)}%`; } };
      const res = await (three ? window.SolverPool.solveFlop3(args) : window.SolverPool.solveFlop(args));
      if (gen !== rvGen) return;
      hide('rvProgress');
      const s = res.summary;
      el('rvOut').innerHTML = three
        ? `<div class="stat-grid" style="margin-bottom:12px">
            ${[0, 1, 2].map((p) => `<div class="stat"><div class="k">${G.seatLabel(3, p)} value / hand</div><div class="v">${U.evText(s.values[p], STAKE, s.valuesSe ? s.valuesSe[p] : undefined)}</div></div>`).join('')}
            <div class="stat"><div class="k">1st pats</div><div class="v">${Math.round(s.draw0[0] * 100)}%</div></div>
            <div class="stat"><div class="k">Sampled range</div><div class="v" style="font-size:.85rem">${s.M.toLocaleString()} hands per seat · 3-handed</div></div>
          </div><p class="hint" style="font-size:.78rem;margin:-4px 0 10px">Seat values carry the luck of which hands were sampled for each seat (roughly ±0.1 stakes on Fast, less on deeper settings).</p><div class="rv-host"></div>`
        : `<div class="stat-grid" style="margin-bottom:12px">
            <div class="stat"><div class="k">OOP value / hand</div><div class="v">${U.evText(s.valueOop, STAKE)}</div></div>
            <div class="stat"><div class="k">OOP pats</div><div class="v">${Math.round(s.oopDraw[0] * 100)}%</div></div>
            <div class="stat"><div class="k">Sampled range</div><div class="v" style="font-size:.85rem">${s.M.toLocaleString()} hands per seat</div></div>
          </div><div class="rv-host"></div>`;
      renderRangeViewer(el('rvOut').querySelector('.rv-host'), res.range);
    } catch (e) {
      if (!String(e.message).includes('cancelled')) { el('rvError').textContent = 'Solver error: ' + e.message; show('rvError'); }
    } finally {
      el('rvSolve').disabled = false;
    }
  });
})();
