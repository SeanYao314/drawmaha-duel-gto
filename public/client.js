(() => {
  const G = window.Game, S = window.Solver;

  // ---------- tiny helpers ----------
  const el = (id) => document.getElementById(id);
  const show = (id) => el(id).classList.remove('hidden');
  const hide = (id) => el(id).classList.add('hidden');
  const toggle = (id, on) => (on ? show : hide)(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const other = (seat) => (seat === 'oop' ? 'ip' : 'oop');

  function money(n, { sign = true } = {}) {
    const abs = Math.abs(Math.round(n)).toLocaleString();
    if (!sign) return '$' + abs;
    return (n > 0 ? '+$' : n < 0 ? '−$' : '$') + abs;
  }
  const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'even');
  function units(u) {
    return (u > 0 ? '+' : u < 0 ? '−' : '') + Math.abs(u).toFixed(2);
  }
  const DRAW_NAMES = ['Pat', 'Draw 1', 'Draw 2', 'Draw 3'];
  const announceText = (a) => `discarded ${a.discards} · ${a.draws === 0 ? 'pat' : 'drawing ' + a.draws}`;

  async function api(pathname, body) {
    const res = await fetch(pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    return res.json();
  }

  // ---------- sounds (Web Audio, no assets) ----------
  const SOUND_PREF_KEY = 'drawmaha-duel-sound-enabled';
  let soundEnabled = true;
  try {
    const saved = localStorage.getItem(SOUND_PREF_KEY);
    if (saved !== null) soundEnabled = saved === 'true';
  } catch (e) { /* default on */ }
  let audioCtx = null;
  function getAudioCtx() {
    try {
      if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        audioCtx = new Ctx();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch (e) { return null; }
  }
  function playTone(ctx, freq, startTime, duration, peakGain, type) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  }
  function playWinSound() {
    if (!soundEnabled) return;
    const ctx = getAudioCtx(); if (!ctx) return;
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => playTone(ctx, f, now + i * 0.09, 0.35, 0.16));
  }
  function playScoopSound() {
    if (!soundEnabled) return;
    const ctx = getAudioCtx(); if (!ctx) return;
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5, 1318.51].forEach((f, i) => playTone(ctx, f, now + i * 0.08, 0.4, 0.19));
    playTone(ctx, 1567.98, now + 0.42, 0.55, 0.13, 'triangle');
  }
  function setSoundEnabled(on) {
    soundEnabled = on;
    try { localStorage.setItem(SOUND_PREF_KEY, String(on)); } catch (e) { /* ignore */ }
    const btn = el('btnSoundToggle');
    btn.textContent = on ? '🔊' : '🔇';
    btn.classList.toggle('muted', !on);
    btn.title = on ? 'Sound on — click to mute' : 'Sound off — click to unmute';
  }
  setSoundEnabled(soundEnabled);
  el('btnSoundToggle').addEventListener('click', () => setSoundEnabled(!soundEnabled));

  // ---------- card sorting (shared, persisted preference) ----------
  const CARD_SORT_KEY = 'drawmaha-duel-card-sort';
  const RANK_ORDER = '23456789TJQKA';
  const SUIT_ORDER = ['s', 'h', 'd', 'c'];
  let cardSortMode = 'dealt';
  try {
    const s = localStorage.getItem(CARD_SORT_KEY);
    if (s === 'rank' || s === 'suit' || s === 'dealt') cardSortMode = s;
  } catch (e) { /* default */ }
  function sortCards(cards, mode) {
    if (mode !== 'rank' && mode !== 'suit') return cards.slice();
    const rankOf = (c) => RANK_ORDER.indexOf(c[0]);
    const suitOf = (c) => SUIT_ORDER.indexOf(c[1]);
    return cards.slice().sort(mode === 'rank'
      ? (a, b) => rankOf(b) - rankOf(a) || suitOf(a) - suitOf(b)
      : (a, b) => suitOf(a) - suitOf(b) || rankOf(b) - rankOf(a));
  }
  function syncSortButtons() {
    document.querySelectorAll('.sort-btn').forEach((b) => b.classList.toggle('active', b.dataset.sort === cardSortMode));
  }
  document.querySelectorAll('.sort-btn').forEach((btn) => btn.addEventListener('click', () => {
    cardSortMode = btn.dataset.sort;
    try { localStorage.setItem(CARD_SORT_KEY, cardSortMode); } catch (e) { /* ignore */ }
    syncSortButtons();
    renderTable();
  }));
  syncSortButtons();

  // ---------- card rendering (4-color deck) ----------
  const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
  function cardEl(card, { small = false, extra = '' } = {}) {
    const div = document.createElement('div');
    div.className = `playing-card suit-${card[1]}${small ? ' small' : ''}${extra ? ' ' + extra : ''}`;
    div.dataset.card = card;
    div.innerHTML = `<span class="rank">${card[0]}</span><span class="suit">${SUIT_SYMBOL[card[1]]}</span>`;
    return div;
  }
  function backEl(small) {
    const d = document.createElement('div');
    d.className = 'card-back' + (small ? ' small' : '');
    return d;
  }
  function slotEl(label) {
    const d = document.createElement('div');
    d.className = 'card-slot';
    d.textContent = label;
    return d;
  }
  // The cards a player threw away, shown small and faded beside their final hand.
  function discardGroup(cards, animate) {
    const g = document.createElement('div');
    g.className = 'discard-group' + (animate ? ' card-reveal' : '');
    g.innerHTML = '<span class="discard-label">Discarded</span>';
    const row = document.createElement('div');
    row.className = 'discard-cards';
    cards.forEach((c) => row.appendChild(cardEl(c, { small: true, extra: 'static' })));
    g.appendChild(row);
    return g;
  }
  function miniCards(cards, { highlight = [], drawn = [] } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'mini';
    cards.forEach((c) => {
      const extra = ['static', highlight.includes(c) ? 'used-in-best' : '', drawn.includes(c) ? 'drawn' : ''].filter(Boolean).join(' ');
      wrap.appendChild(cardEl(c, { small: true, extra }));
    });
    return wrap;
  }

  // ---------- landing ----------
  const STAKES = [1, 5, 10, 25, 50, 100, 200, 500, 1000];
  for (const id of ['createStake', 'practiceStake']) {
    el(id).innerHTML = STAKES.map((s) => `<option value="${s}"${s === 100 ? ' selected' : ''}>$${s.toLocaleString()}</option>`).join('');
  }
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));
      el('tab-' + btn.dataset.tab).classList.remove('hidden');
    });
  });
  function landingError(msg) {
    el('landingError').textContent = msg;
    show('landingError');
  }
  function showScreen(name) {
    ['landing', 'lobby', 'table'].forEach((s) => toggle('screen-' + s, s === name));
  }

  // =====================================================================
  // LIVE (PvP) MODE
  // =====================================================================
  const STORAGE_KEY = 'drawmaha-duel-session';
  const live = { code: null, playerId: null, token: null, room: null, my: null, results: null };
  let es = null;
  let mode = null; // 'live' | 'practice'

  function saveSession() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ code: live.code, playerId: live.playerId, token: live.token }));
  }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
  }
  function clearSession() { localStorage.removeItem(STORAGE_KEY); }

  function connectStream() {
    if (es) es.close();
    es = new EventSource(`/api/stream?code=${encodeURIComponent(live.code)}&playerId=${encodeURIComponent(live.playerId)}&token=${encodeURIComponent(live.token)}`);
    es.addEventListener('room_state', (e) => handleRoomState(JSON.parse(e.data)));
    es.addEventListener('your_hand', (e) => { live.my = JSON.parse(e.data); renderTable(); });
    es.addEventListener('results', (e) => { live.results = JSON.parse(e.data); renderTable(); });
    return es;
  }

  el('btnCreate').addEventListener('click', async () => {
    const name = el('createName').value.trim() || 'Host';
    const res = await api('/api/create_room', { name, stake: Number(el('createStake').value), handSize: Number(el('createHandSize').value) });
    if (!res.ok) return landingError(res.error);
    Object.assign(live, { code: res.code, playerId: res.playerId, token: res.token, room: null, my: null, results: null });
    mode = 'live';
    saveSession();
    connectStream();
  });

  el('btnJoin').addEventListener('click', async () => {
    const name = el('joinName').value.trim() || 'Player';
    const code = el('joinCode').value.trim().toUpperCase();
    if (!code) return landingError('Enter a room code.');
    const res = await api('/api/join_room', { code, name });
    if (!res.ok) return landingError(res.error);
    Object.assign(live, { code: res.code, playerId: res.playerId, token: res.token, room: null, my: null, results: null });
    mode = 'live';
    saveSession();
    connectStream();
  });

  el('btnCopyLink').addEventListener('click', () => {
    el('shareLink').select();
    navigator.clipboard?.writeText(el('shareLink').value).catch(() => {});
  });
  el('btnStart').addEventListener('click', async () => {
    const res = await api('/api/start_game', { code: live.code, playerId: live.playerId, token: live.token });
    if (res && !res.ok) el('lobbyHint').textContent = res.error;
  });

  function handleRoomState(room) {
    live.room = room;
    if (mode !== 'live') return;
    el('roomCodeLabel').textContent = room.code;
    show('roomBadge');
    if (room.phase === 'lobby') {
      showScreen('lobby');
      renderLobby(room);
    } else {
      showScreen('table');
      renderTable();
    }
  }

  function renderLobby(room) {
    el('lobbyCode').textContent = room.code;
    el('shareLink').value = `${location.origin}/?join=${room.code}`;
    el('lobbyCount').textContent = room.players.length;
    el('lobbyStake').textContent = `${room.handSize || 9}-card Drawmaha · ${money(room.stake, { sign: false })} per contest · ${money(room.stake * 6, { sign: false })} for a scoop`;
    const list = el('lobbyPlayers');
    list.innerHTML = '';
    room.players.forEach((p) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = p.name + (p.id === live.playerId ? ' (you)' : '') + (!p.connected ? ' — offline' : '');
      if (!p.connected) label.classList.add('offline');
      li.appendChild(label);
      if (p.id === room.hostId) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'HOST';
        li.appendChild(tag);
      }
      list.appendChild(li);
    });
    const isHost = room.hostId === live.playerId;
    toggle('btnStart', isHost && room.players.length === 2);
    el('lobbyHint').textContent = room.players.length < 2
      ? 'Waiting for your opponent to join…'
      : isHost ? '' : 'Waiting for the host to start the game…';
  }

  function liveVM() {
    const room = live.room;
    if (!room || room.phase === 'lobby') return null;
    const me = room.players.find((p) => p.id === live.playerId);
    const opp = room.players.find((p) => p.id !== live.playerId);
    const meSeat = room.oopId === live.playerId ? 'oop' : 'ip';
    const results = live.results && live.results.handNumber === room.handNumber ? live.results : null;
    const my = live.my || {};
    return {
      key: `live-${room.code}-${room.handNumber}`,
      mode: 'live',
      handNumber: room.handNumber,
      stake: room.stake,
      handSize: room.handSize || 9,
      meId: me.id, oppId: opp ? opp.id : null,
      meName: me.name, oppName: opp ? opp.name : 'Opponent', oppConnected: opp ? opp.connected : false,
      meSeat, oppSeat: other(meSeat),
      hand: my.hand || [], keep: my.keep || null, drawn: my.drawn || null,
      myAnnounce: room.announce[me.id] || null,
      oppAnnounce: opp ? room.announce[opp.id] || null : null,
      acting: room.acting,
      flopA: room.flopA || [], flopB: room.flopB || [],
      results,
      cumulative: { me: room.cumulative[me.id] || 0, opp: opp ? room.cumulative[opp.id] || 0 : 0 },
      history: room.history.map((h) => ({ handNumber: h.handNumber, me: h.dollars[me.id], scoop: h.scoop === me.id ? 'me' : h.scoop ? 'opp' : null }))
    };
  }

  // =====================================================================
  // TABLE RENDERING (shared by live and practice)
  // =====================================================================
  const table = { key: null, selected: new Set(), error: null };
  const reveal = { key: null, stage: 0, timer: null, lastStage: 0 };
  const FINAL_STAGE = 7; // 1 turns · 2 rivers · 3 opp cards · 4-6 contests · 7 totals

  function currentVM() {
    if (mode === 'live') return liveVM();
    if (mode === 'practice') return practiceVM();
    return null;
  }

  function renderTable() {
    const vm = currentVM();
    if (!vm) return;
    if (vm.key !== table.key) {
      table.key = vm.key;
      table.selected = new Set();
      table.error = null;
      hide('gameError');
    }
    el('handNumber').textContent = vm.handNumber;
    toggle('modeTag', vm.mode === 'practice');
    el('sizeTag').textContent = `${vm.handSize}-CARD`;
    toggle('sizeTag', vm.handSize !== 9);
    toggle('practiceSettings', vm.mode === 'practice');
    toggle('btnPracticeBack', vm.mode === 'practice');
    if (vm.mode === 'practice') hide('roomBadge');

    // Results reveal bookkeeping
    if (vm.results && reveal.key !== vm.key) startReveal(vm.key);
    const stage = vm.results ? (reveal.key === vm.key ? reveal.stage : FINAL_STAGE) : 0;

    renderScoreStrip(vm);
    renderOpp(vm, stage);
    renderBoards(vm, stage);
    renderMe(vm);
    renderResults(vm, stage);
    renderHistory(vm);
    if (vm.mode === 'practice') renderStudy(); else hide('studyPanel');
    reveal.lastStage = stage;
  }

  function renderScoreStrip(vm) {
    el('scoreStrip').innerHTML = `
      <span class="score-pill">You <span class="amt ${cls(vm.cumulative.me)}">${money(vm.cumulative.me)}</span></span>
      <span class="score-pill">${esc(vm.oppName)} <span class="amt ${cls(vm.cumulative.opp)}">${money(vm.cumulative.opp)}</span></span>
      <span class="score-pill" style="font-weight:600;color:var(--muted)">${money(vm.stake, { sign: false })} per contest · scoop ${money(vm.stake * 6, { sign: false })}</span>`;
  }

  function posChip(id, seat, acting) {
    const c = el(id);
    c.textContent = seat === 'ip' ? 'Button · in position' : 'Out of position';
    c.className = 'pos-chip ' + seat + (acting ? ' acting' : '');
  }

  function renderOpp(vm, stage) {
    el('oppName').textContent = vm.oppName + (vm.mode === 'live' && !vm.oppConnected ? ' (offline)' : '');
    const acting = !vm.results && vm.acting === vm.oppSeat;
    posChip('oppPos', vm.oppSeat, acting);
    const status = el('oppStatus');
    status.className = 'seat-status';
    if (vm.oppAnnounce) {
      status.textContent = vm.oppAnnounce.draws === 0 ? `Discarded ${vm.oppAnnounce.discards} — pat` : `Discarded ${vm.oppAnnounce.discards} — drawing ${vm.oppAnnounce.draws}`;
      status.classList.add('announce');
    } else if (acting) {
      status.textContent = vm.mode === 'practice' ? (vm.botThinking || 'Thinking…') : 'Choosing a keep…';
    } else {
      status.textContent = 'Waiting for you';
    }
    const box = el('oppCards');
    box.innerHTML = '';
    if (vm.results && stage >= 3) {
      const p = vm.results.players.find((x) => x.id === vm.oppId);
      p.final.forEach((c) => {
        const node = cardEl(c, { extra: 'static' + (p.drawn.includes(c) ? ' drawn' : '') });
        if (reveal.lastStage < 3) node.classList.add('card-reveal');
        box.appendChild(node);
      });
      if (p.discarded && p.discarded.length) box.appendChild(discardGroup(p.discarded, reveal.lastStage < 3));
    } else {
      const n = vm.oppAnnounce ? 5 : vm.handSize;
      for (let i = 0; i < n; i++) box.appendChild(backEl());
    }
  }

  function renderBoards(vm, stage) {
    const boards = vm.results ? [vm.results.boardA, vm.results.boardB] : [vm.flopA, vm.flopB];
    ['boardA', 'boardB'].forEach((id, b) => {
      const box = el(id);
      box.innerHTML = '';
      const cards = boards[b] || [];
      for (let i = 0; i < 5; i++) {
        const visible = i < 3 || (vm.results && ((i === 3 && stage >= 1) || (i === 4 && stage >= 2)));
        if (visible && cards[i]) {
          const node = cardEl(cards[i], { extra: 'static' });
          if ((i === 3 && reveal.lastStage < 1 && stage >= 1) || (i === 4 && reveal.lastStage < 2 && stage >= 2)) node.classList.add('card-reveal');
          box.appendChild(node);
        } else {
          box.appendChild(slotEl(i === 3 ? 'turn' : 'river'));
        }
      }
    });
  }

  function renderMe(vm) {
    el('meName').textContent = vm.mode === 'practice' ? 'You' : `${vm.meName} (you)`;
    const myTurn = !vm.results && vm.acting === vm.meSeat && !vm.keep;
    posChip('mePos', vm.meSeat, myTurn);
    const box = el('meCards');
    box.innerHTML = '';
    const status = el('meStatus');
    status.className = 'seat-status';
    toggle('sortControl', !vm.keep);
    toggle('btnAdvice', vm.mode === 'practice' && !vm.keep && !vm.results);

    if (vm.keep) {
      // Already drawn: show the final five, new cards marked.
      [...vm.keep, ...vm.drawn].forEach((c) => box.appendChild(cardEl(c, { extra: 'static' + (vm.drawn.includes(c) ? ' drawn' : '') })));
      box.appendChild(discardGroup(vm.hand.filter((c) => !vm.keep.includes(c))));
      box.classList.remove('selecting');
      const nd = G.discardCount(vm.keep.length, vm.hand.length);
      status.textContent = vm.drawn.length === 0 ? `You discarded ${nd} — pat` : `You discarded ${nd} — drew ${vm.drawn.length}`;
      status.classList.add('announce');
      el('keepHint').textContent = vm.results ? '' : (vm.acting === vm.oppSeat ? `Waiting for ${vm.oppName} to draw…` : '');
      hide('drawActions');
      return;
    }

    show('drawActions');
    box.classList.add('selecting');
    for (const c of sortCards(vm.hand, cardSortMode)) {
      const node = cardEl(c, { extra: table.selected.has(c) ? 'kept' : '' });
      node.addEventListener('click', () => {
        if (table.selected.has(c)) table.selected.delete(c); else table.selected.add(c);
        renderTable();
      });
      box.appendChild(node);
    }

    const k = table.selected.size;
    const legal = k >= G.MIN_KEEP && k <= G.MAX_KEEP;
    const btn = el('btnDraw');
    if (myTurn) {
      status.textContent = vm.meSeat === 'oop' ? 'Your turn — you act first' : 'Your turn';
    } else {
      status.textContent = '';
    }
    let hint;
    if (k === 0) hint = 'Click the cards you want to keep (2–5). Everything else is discarded.';
    else if (k < G.MIN_KEEP) hint = `Keeping ${k} — keep at least 2.`;
    else if (k > G.MAX_KEEP) hint = `Keeping ${k} — you can keep at most 5.`;
    else hint = `Keeping ${k} → discard ${vm.hand.length - k}, ${k === 5 ? 'pat (draw nothing)' : 'draw ' + (5 - k)}.`;
    if (!myTurn && vm.meSeat === 'ip' && !vm.oppAnnounce) {
      hint += ` ${vm.oppName} is out of position and announces first — you can line up your keep meanwhile.`;
    }
    if (myTurn && vm.meSeat === 'ip' && vm.oppAnnounce) {
      hint = `${vm.oppName} ${announceText(vm.oppAnnounce)}. ` + hint;
    }
    el('keepHint').textContent = hint;
    btn.disabled = !(myTurn && legal);
    btn.textContent = !legal ? 'Select 2–5 cards to keep'
      : k === 5 ? `Pat — discard ${vm.hand.length - 5}` : `Discard ${vm.hand.length - k} · draw ${5 - k}`;
    if (!myTurn && legal) btn.textContent = 'Waiting for your turn…';
    if (table.error) { el('gameError').textContent = table.error; show('gameError'); } else hide('gameError');
  }

  el('btnClearKeep').addEventListener('click', () => { table.selected = new Set(); renderTable(); });

  el('btnDraw').addEventListener('click', async () => {
    const vm = currentVM();
    if (!vm) return;
    const keep = vm.hand.filter((c) => table.selected.has(c));
    const err = G.validateKeep(vm.hand, keep);
    if (err) { table.error = err; renderTable(); return; }
    table.error = null;
    if (vm.mode === 'live') {
      el('btnDraw').disabled = true;
      const res = await api('/api/draw', { code: live.code, playerId: live.playerId, token: live.token, keep });
      if (!res.ok) { table.error = res.error; renderTable(); }
    } else {
      practiceHumanDraw(keep);
    }
  });

  // ---------- results ----------
  function startReveal(key) {
    clearTimeout(reveal.timer);
    reveal.key = key;
    reveal.stage = 0;
    reveal.lastStage = 0;
    show('btnSkipReveal');
    const step = () => {
      reveal.stage += 1;
      renderTable();
      if (reveal.stage < FINAL_STAGE) reveal.timer = setTimeout(step, reveal.stage >= 3 ? 550 : 700);
      else finishReveal();
    };
    reveal.timer = setTimeout(step, 450);
  }
  function finishReveal() {
    hide('btnSkipReveal');
    const vm = currentVM();
    if (!vm || !vm.results) return;
    const r = vm.results;
    const mine = r.dollars[vm.meId];
    if (r.scoop === vm.meId) playScoopSound();
    else if (mine > 0) playWinSound();
  }
  el('btnSkipReveal').addEventListener('click', () => {
    clearTimeout(reveal.timer);
    reveal.stage = FINAL_STAGE;
    renderTable();
    finishReveal();
  });

  function renderResults(vm, stage) {
    toggle('resultsBlock', !!vm.results);
    if (!vm.results) return;
    const r = vm.results;
    const statusText = ['Dealing the turns…', 'Dealing the turns…', 'Dealing the rivers…', 'Showdown…', 'Showdown…', 'Showdown…', 'Showdown…'];
    if (stage < FINAL_STAGE) { el('revealStatus').textContent = statusText[stage]; show('revealStatus'); } else hide('revealStatus');

    const me = r.players.find((p) => p.id === vm.meId), opp = r.players.find((p) => p.id === vm.oppId);
    const tbl = el('contestTable');
    const oppLabel = esc(vm.oppName);
    let html = `<tr><th>Contest</th><th>You</th><th>${oppLabel}</th><th>Result</th></tr>`;
    r.contests.forEach((c, i) => {
      const shown = stage >= 4 + i;
      const myEval = r.evals[vm.meId][c.key], opEval = r.evals[vm.oppId][c.key];
      const res = c.winner === vm.meId ? 1 : c.winner === vm.oppId ? -1 : 0;
      html += `<tr class="${shown ? (reveal.lastStage < 4 + i ? 'shown' : '') : 'pending'}" data-i="${i}">
        <td class="c-label">${esc(c.label)}</td>
        <td class="c-hand ${shown && res > 0 ? 'win' : ''}" data-who="me" data-name="You"><span class="cat">${shown ? esc(myEval.category) : '—'}</span></td>
        <td class="c-hand ${shown && res < 0 ? 'win' : ''}" data-who="opp" data-name="${oppLabel}"><span class="cat">${shown ? esc(opEval.category) : '—'}</span></td>
        <td class="c-result ${shown ? cls(res) : ''}">${shown ? (res > 0 ? 'You win' : res < 0 ? `${oppLabel} wins` : 'Push') : ''}</td></tr>`;
    });
    tbl.innerHTML = html;
    // Attach the actual cards used (hole cards highlighted for the PLO rows).
    r.contests.forEach((c, i) => {
      if (stage < 4 + i) return;
      const row = tbl.querySelector(`tr[data-i="${i}"]`);
      [['me', me], ['opp', opp]].forEach(([who, p]) => {
        const ev = r.evals[p.id][c.key];
        const hole = c.key === 'five' ? [] : ev.cards.filter((x) => p.final.includes(x));
        row.querySelector(`td[data-who="${who}"]`).appendChild(miniCards(ev.cards, { highlight: hole }));
      });
    });

    const mine = r.dollars[vm.meId];
    const banner = el('scoopBanner');
    if (stage >= FINAL_STAGE && r.scoop) {
      const wasHidden = banner.classList.contains('hidden');
      banner.textContent = r.scoop === vm.meId
        ? `🧹 SCOOP! You won all three contests — double money: ${money(mine)}`
        : `🧹 ${vm.oppName} scooped all three contests — double money: ${money(mine)}`;
      show('scoopBanner');
      if (wasHidden) { banner.classList.remove('reveal'); void banner.offsetWidth; banner.classList.add('reveal'); }
    } else hide('scoopBanner');

    el('handTotal').innerHTML = stage >= FINAL_STAGE
      ? (mine === 0 ? '<span class="even">Even hand — no money changes hands.</span>'
        : `This hand: <span class="${cls(mine)}">${money(mine)}</span> <span class="hint-inline" style="color:var(--muted)">(${units(r.units[vm.meId])} stakes)</span>`)
      : '';
    toggle('btnNextHand', stage >= FINAL_STAGE);
    el('btnNextHand').textContent = vm.mode === 'practice' ? 'Deal Next Hand' : 'Deal Next Hand';
  }

  el('btnNextHand').addEventListener('click', async () => {
    if (mode === 'practice') { dealPractice(); return; }
    el('btnNextHand').disabled = true;
    const res = await api('/api/next_hand', { code: live.code, playerId: live.playerId, token: live.token });
    el('btnNextHand').disabled = false;
    if (res && !res.ok) { table.error = res.error; renderTable(); }
  });

  function renderHistory(vm) {
    const items = (vm.history || []).slice().reverse();
    el('historyList').innerHTML = items.length
      ? items.map((h) => `Hand #${h.handNumber}: <span class="${cls(h.me)}">${money(h.me)}</span>${h.scoop ? (h.scoop === 'me' ? ' — 🧹 you scooped' : ` — 🧹 ${esc(vm.oppName)} scooped`) : ''}`).join('<br>')
      : '<span class="hint">No hands finished yet.</span>';
  }

  // =====================================================================
  // PRACTICE MODE (vs the solver bot, entirely client-side)
  // =====================================================================
  const BOT_NAME = 'GTO Bot';
  let practice = null;

  el('btnPracticeStart').addEventListener('click', () => {
    if (es) { es.close(); es = null; }
    mode = 'practice';
    const preset = (document.querySelector('input[name="depth"]:checked') || {}).value || 'deep';
    const handSize = Number(el('practiceHandSize').value) || 9;
    savePracticePrefs({ preset, handSize, stake: Number(el('practiceStake').value) });
    practice = {
      stake: Number(el('practiceStake').value), preset, handSize, handNumber: 0,
      cumulative: { me: 0, bot: 0 }, history: [], firstSeat: Math.random() < 0.5 ? 'oop' : 'ip', hand: null
    };
    el('psHandSize').value = String(handSize);
    el('psDepth').value = preset;
    showScreen('table');
    dealPractice();
  });

  // Practice preferences (hand size, solver depth, stake) persist between visits.
  const PRACTICE_PREFS_KEY = 'drawmaha-duel-practice-prefs';
  function savePracticePrefs(p) {
    try { localStorage.setItem(PRACTICE_PREFS_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
  }
  try {
    const p = JSON.parse(localStorage.getItem(PRACTICE_PREFS_KEY) || 'null');
    if (p) {
      if ([7, 8, 9, 10].includes(p.handSize)) el('practiceHandSize').value = String(p.handSize);
      const r = document.querySelector(`input[name="depth"][value="${p.preset}"]`);
      if (r) r.checked = true;
      if (STAKES.includes(p.stake)) el('practiceStake').value = String(p.stake);
    }
  } catch (e) { /* ignore */ }
  el('psHandSize').addEventListener('change', () => {
    if (!practice) return;
    practice.handSize = Number(el('psHandSize').value);
    savePracticePrefs({ preset: practice.preset, handSize: practice.handSize, stake: practice.stake });
  });
  el('psDepth').addEventListener('change', () => {
    if (!practice) return;
    practice.preset = el('psDepth').value;
    savePracticePrefs({ preset: practice.preset, handSize: practice.handSize, stake: practice.stake });
  });
  el('btnPracticeBack').addEventListener('click', () => {
    window.SolverPool.cancel();
    clearTimeout(reveal.timer);
    practice = null;
    mode = null;
    showScreen('landing');
  });

  function dealPractice() {
    window.SolverPool.cancel();
    practice.handNumber += 1;
    const deck = window.Poker.shuffle(window.Poker.freshDeck());
    const flopA = deck.splice(0, 3), flopB = deck.splice(0, 3);
    const H = practice.handSize;
    const mine = deck.splice(0, H), bots = deck.splice(0, H);
    const mySeat = practice.handNumber % 2 === 1 ? practice.firstSeat : other(practice.firstSeat);
    const h = practice.hand = {
      deck, flopA, flopB, my9: mine, bot9: bots, mySeat, botSeat: other(mySeat),
      myKeep: null, myDrawn: null, botKeep: null, botDrawn: null, acting: 'oop',
      results: null, peek: false, studyTab: null, preset: practice.preset,
      solve: { status: 'running', progress: 0, result: null, error: null, startedAt: performance.now() }
    };
    renderTable();
    window.SolverPool.solveFlop({
      flopA, flopB, preset: practice.preset, handSize: H,
      observers: [{ id: 'me', seat: mySeat, cards: mine }, { id: 'bot', seat: h.botSeat, cards: bots }],
      onProgress: (p) => {
        if (practice && practice.hand === h) { h.solve.progress = p; updateProgress(); }
      }
    }).then((result) => {
      if (!practice || practice.hand !== h) return;
      h.solve.status = 'done';
      h.solve.result = result;
      h.solve.seconds = (performance.now() - h.solve.startedAt) / 1000;
      maybeBotAct();
      renderTable();
    }).catch((err) => {
      if (!practice || practice.hand !== h || String(err.message).includes('cancelled')) return;
      console.error(err);
      h.solve.status = 'error';
      h.solve.error = String(err.message || err);
      maybeBotAct();
      renderTable();
    });
  }

  function practiceVM() {
    if (!practice || !practice.hand) return null;
    const h = practice.hand;
    const botAnnounce = h.botKeep ? { discards: G.discardCount(h.botKeep.length, h.bot9.length), draws: h.botDrawn.length } : null;
    let botThinking = null;
    if (h.acting === h.botSeat && !h.botKeep) {
      botThinking = h.solve.status === 'running' ? `Solving the flop… ${Math.round(h.solve.progress * 100)}%` : 'Choosing…';
    }
    return {
      key: `practice-${practice.handNumber}`,
      mode: 'practice',
      handNumber: practice.handNumber,
      stake: practice.stake,
      handSize: h.my9.length,
      meId: 'me', oppId: 'bot', meName: 'You', oppName: BOT_NAME, oppConnected: true,
      meSeat: h.mySeat, oppSeat: h.botSeat,
      hand: h.my9, keep: h.myKeep, drawn: h.myDrawn,
      oppAnnounce: botAnnounce,
      acting: h.acting,
      flopA: h.flopA, flopB: h.flopB,
      results: h.results,
      botThinking,
      cumulative: { me: practice.cumulative.me, opp: practice.cumulative.bot },
      history: practice.history
    };
  }

  function practiceHumanDraw(keep) {
    const h = practice.hand;
    if (h.myKeep || h.acting !== h.mySeat) return;
    h.myKeep = keep;
    h.myDrawn = h.deck.splice(0, G.drawCount(keep.length));
    if (h.mySeat === 'oop') {
      h.acting = 'ip';
      renderTable();
      maybeBotAct();
    } else {
      finishPractice();
    }
  }

  // The bot draws once it's its turn AND the flop solve has finished.
  function maybeBotAct() {
    const h = practice && practice.hand;
    if (!h || h.botKeep || h.acting !== h.botSeat) return;
    if (h.solve.status === 'running') { renderTable(); return; }
    let ki;
    const NK = S.layout(h.bot9.length).NKEEPS;
    if (h.solve.status === 'done') {
      const o = h.solve.result.observers.find((x) => x.id === 'bot');
      const freqs = h.botSeat === 'oop' ? o.freq : o.freq.slice(h.myDrawn.length * NK, (h.myDrawn.length + 1) * NK);
      ki = S.sampleMixed(freqs);
    } else {
      // Solver failed (shouldn't happen) — fall back to keeping the best 5 dealt cards.
      ki = 0;
    }
    h.botKi = ki;
    const keep = S.keepCards(h.bot9, ki);
    setTimeout(() => {
      if (!practice || practice.hand !== h) return;
      h.botKeep = keep;
      h.botDrawn = h.deck.splice(0, G.drawCount(keep.length));
      if (h.botSeat === 'oop') { h.acting = 'ip'; renderTable(); } else finishPractice();
    }, 500);
  }

  function finishPractice() {
    const h = practice.hand;
    const boardA = [...h.flopA, ...h.deck.splice(0, 2)];
    const boardB = [...h.flopB, ...h.deck.splice(0, 2)];
    const seats = { me: { dealt: h.my9, kept: h.myKeep, drawn: h.myDrawn, name: 'You' }, bot: { dealt: h.bot9, kept: h.botKeep, drawn: h.botDrawn, name: BOT_NAME } };
    const oopId = h.mySeat === 'oop' ? 'me' : 'bot', ipId = oopId === 'me' ? 'bot' : 'me';
    const fin = (id) => [...seats[id].kept, ...seats[id].drawn];
    const res = G.scoreShowdown(oopId, fin(oopId), ipId, fin(ipId), boardA, boardB);
    const dollars = { me: res.units.me * practice.stake, bot: res.units.bot * practice.stake };
    practice.cumulative.me += dollars.me;
    practice.cumulative.bot += dollars.bot;
    practice.history.push({ handNumber: practice.handNumber, me: dollars.me, scoop: res.scoop === 'me' ? 'me' : res.scoop ? 'opp' : null });
    h.acting = null;
    h.results = {
      handNumber: practice.handNumber, stake: practice.stake, boardA, boardB, oopId, ipId,
      players: [oopId, ipId].map((id) => ({
        id, name: seats[id].name, kept: seats[id].kept, drawn: seats[id].drawn, final: fin(id),
        discarded: seats[id].dealt.filter((c) => !seats[id].kept.includes(c)),
        discards: G.discardCount(seats[id].kept.length, seats[id].dealt.length), draws: seats[id].drawn.length
      })),
      evals: res.evals, contests: res.contests, scoop: res.scoop, units: res.units, dollars,
      cumulative: { ...practice.cumulative }
    };
    renderTable();
  }

  el('btnAdvice').addEventListener('click', () => {
    if (!practice || !practice.hand) return;
    practice.hand.peek = !practice.hand.peek;
    renderTable();
  });

  // =====================================================================
  // STUDY PANEL
  // =====================================================================
  function updateProgress() {
    const h = practice && practice.hand;
    if (!h) return;
    el('solveProgressBar').style.width = `${Math.round(h.solve.progress * 100)}%`;
    el('studyStatus').textContent = `Solving this flop… ${Math.round(h.solve.progress * 100)}%`;
    if (h.acting === h.botSeat && !h.botKeep) {
      el('oppStatus').textContent = `Solving the flop… ${Math.round(h.solve.progress * 100)}%`;
    }
  }

  function keepIndexOf(cards9, keep) {
    const NK = S.layout(cards9.length).NKEEPS;
    const set = new Set(keep);
    for (let ki = 0; ki < NK; ki++) {
      const kc = S.keepCards(cards9, ki);
      if (kc.length === keep.length && kc.every((c) => set.has(c))) return ki;
    }
    return -1;
  }

  function evText(u, stake) {
    return `<span class="${u > 0.005 ? 'ev-pos' : u < -0.005 ? 'ev-neg' : ''}">${units(u)}</span> <span class="hint-inline" style="color:var(--muted)">(${money(u * stake)})</span>`;
  }

  function mixBar(dist) {
    const parts = dist.map((p, d) => (p >= 0.005 ? `<span class="d${d}" style="width:${(p * 100).toFixed(1)}%" title="${DRAW_NAMES[d]} ${(p * 100).toFixed(0)}%">${p >= 0.09 ? (p * 100).toFixed(0) + '%' : ''}</span>` : '')).join('');
    return `<div class="mix-bar">${parts}</div>`;
  }
  const mixLegend = () => `<div class="mix-legend">${DRAW_NAMES.map((n, d) => `<span><i class="d${d}"></i>${n}</span>`).join('')}</div>`;

  function renderStudy() {
    const h = practice && practice.hand;
    show('studyPanel');
    if (!h) return;
    const sv = h.solve;
    const body = el('studyBody');
    const decided = !!h.myKeep;
    const visible = !!h.results || h.peek;
    el('btnAdvice').textContent = h.peek ? 'Hide solver' : 'Peek at solver';

    if (sv.status === 'running') {
      show('solveProgress');
      el('solveProgressBar').style.width = `${Math.round(sv.progress * 100)}%`;
      el('studyStatus').textContent = `Solving this flop… ${Math.round(sv.progress * 100)}%`;
      body.innerHTML = `<p class="hint">The bot solves each flop pair for an approximate equilibrium (${S.PRESETS[h.preset].N} sampled hands per seat, ${window.SolverPool.workerCount} worker thread${window.SolverPool.workerCount > 1 ? 's' : ''}) before it draws.${h.mySeat === 'oop' ? ' You act first, so go ahead — it will be ready by the time it needs it.' : ''}</p>`;
      return;
    }
    hide('solveProgress');
    if (sv.status === 'error') {
      el('studyStatus').textContent = 'Solver error';
      body.innerHTML = `<p class="error">The solver failed on this hand: ${esc(sv.error)}</p>`;
      return;
    }
    el('studyStatus').textContent = `Solved in ${sv.seconds.toFixed(1)} s · ${h.preset} depth`;
    if (!visible) {
      body.innerHTML = `<p class="hint">Solved and hidden until the hand is over. ${decided ? '' : 'Click <strong>Peek at solver</strong> if you want the answer before you draw.'}</p>`;
      return;
    }

    const res = sv.result;
    const NK = S.layout(h.my9.length).NKEEPS, KD = S.layout(h.my9.length).KEEP_DRAW;
    const meObs = res.observers.find((o) => o.id === 'me');
    const botObs = res.observers.find((o) => o.id === 'bot');
    const stake = practice.stake;
    const sum = res.summary;
    const iAmIP = h.mySeat === 'ip';
    // Which announcement to view (IP only): the real one if we have it, else a tab choice.
    const actualD = iAmIP && h.botKeep ? h.botDrawn.length : null;
    if (iAmIP && h.studyTab === null) h.studyTab = actualD !== null ? actualD : 0;
    const d = iAmIP ? h.studyTab : null;
    const evOf = (ki) => (iAmIP ? meObs.ev[d * NK + ki] : meObs.ev[ki]);
    const freqOf = (ki) => (iAmIP ? meObs.freq[d * NK + ki] : meObs.freq[ki]);

    const order = Array.from({ length: NK }, (_, i) => i).sort((a, b) => evOf(b) - evOf(a));
    const bestKi = order[0];
    const myKi = decided ? keepIndexOf(h.my9, h.myKeep) : -1;

    let html = '';

    // --- verdict on the keep you made ---
    if (decided && myKi >= 0 && (!iAmIP || d === actualD)) {
      const lost = evOf(bestKi) - evOf(myKi);
      const rank = order.indexOf(myKi) + 1;
      const inMix = freqOf(myKi) >= 0.05;
      html += `<div class="verdict">Your keep (${DRAW_NAMES[KD[myKi]].toLowerCase()}) has EV ${evText(evOf(myKi), stake)} per hand — #${rank} of ${NK}.
        ${lost < 0.02 ? '<strong class="good">That’s the solver’s top choice (or within noise of it).</strong>'
          : `The best keep was worth ${evText(evOf(bestKi), stake)}: <strong class="bad">you gave up ${units(lost)} stakes (${money(lost * stake, { sign: false })})</strong>.`}
        ${inMix ? ` The equilibrium plays your keep ${(freqOf(myKi) * 100).toFixed(0)}% of the time.` : ''}</div>`;
    }

    // --- your keep options ---
    html += `<div class="study-section"><h4>Your keep options${iAmIP ? '' : ''}</h4>`;
    if (iAmIP) {
      html += `<p>You're in position, so your best keep depends on what ${BOT_NAME} announced. Pick an announcement:</p><div class="study-tabs">` +
        [0, 1, 2, 3].map((x) => `<button class="study-tab${x === d ? ' active' : ''}" data-d="${x}">${BOT_NAME} ${x === 0 ? 'pats' : 'draws ' + x}${x === actualD ? ' (actual)' : ''}</button>`).join('') + '</div>';
    } else {
      html += `<p>You're out of position: your draw count is announced before ${BOT_NAME} decides, and these EVs already account for how it reacts.</p>`;
    }
    const rows = order.slice(0, 10);
    if (myKi >= 0 && !rows.includes(myKi)) rows.push(myKi);
    html += `<table class="ev-table"><tr><th>#</th><th>Keep</th><th>EV / hand</th><th>Draw</th><th>Solver mix</th></tr>`;
    rows.forEach((ki) => {
      const f = freqOf(ki);
      html += `<tr class="${ki === myKi ? 'chosen' : ''}${ki === bestKi ? ' best' : ''}" data-ki="${ki}"><td>${order.indexOf(ki) + 1}${ki === myKi ? ' <span class="tag-mini">you</span>' : ''}</td><td class="keepcell"></td><td>${evText(evOf(ki), stake)}</td><td>${DRAW_NAMES[KD[ki]]}</td><td>${f >= 0.005 ? `<span class="freq-bar" style="width:${Math.max(2, f * 70)}px"></span>${(f * 100).toFixed(0)}%` : '—'}</td></tr>`;
    });
    html += '</table>';
    // best per draw count
    html += `<p style="margin-top:10px"><strong>Best by draw count:</strong> ` + [0, 1, 2, 3].map((x) => {
      let b = -1;
      for (let ki = 0; ki < NK; ki++) if (KD[ki] === x && (b < 0 || evOf(ki) > evOf(b))) b = ki;
      return `${DRAW_NAMES[x]} ${evText(evOf(b), stake)}`;
    }).join(' · ') + '</p>';
    html += '</div>';

    // --- IP: how the best keep shifts with the announcement ---
    if (iAmIP) {
      html += `<div class="study-section"><h4>How your best keep reacts to the announcement</h4><table class="ev-table"><tr><th>If ${BOT_NAME}…</th><th>Best keep</th><th>EV / hand</th><th>Draw</th></tr>`;
      [0, 1, 2, 3].forEach((x) => {
        let b = 0;
        for (let ki = 1; ki < NK; ki++) if (meObs.ev[x * NK + ki] > meObs.ev[x * NK + b]) b = ki;
        html += `<tr data-ki="${b}" class="${x === actualD ? 'chosen' : ''}"><td>${x === 0 ? 'pats' : 'draws ' + x}${x === actualD ? ' <span class="tag-mini">actual</span>' : ''}${sum.oopDraw[x] < 0.02 ? ' <span class="tag-mini" title="Equilibrium OOP almost never announces this, so these numbers lean on a small trembling-hand sample">rare</span>' : ''}</td><td class="keepcell"></td><td>${evText(meObs.ev[x * NK + b], stake)}</td><td>${DRAW_NAMES[KD[b]]}</td></tr>`;
      });
      html += '</table></div>';
    }

    // --- the flop's equilibrium ---
    const vO = sum.valueOop;
    html += `<div class="study-section"><h4>This flop's equilibrium</h4>
      <div class="stat-grid">
        <div class="stat"><div class="k">OOP value / hand</div><div class="v">${evText(vO, stake)}</div></div>
        <div class="stat"><div class="k">IP value / hand</div><div class="v">${evText(-vO, stake)}</div></div>
        <div class="stat"><div class="k">Exploitability</div><div class="v">${sum.exploitability.toFixed(3)} <span class="hint-inline" style="color:var(--muted)">stakes</span></div></div>
        <div class="stat"><div class="k">Sampled game</div><div class="v" style="font-size:.85rem">${sum.N}×${sum.N} hands · ${sum.K} keeps each · ${sum.iterations} CFR+ iters</div></div>
      </div>
      <p style="margin-top:12px"><strong>How often OOP announces each draw</strong> (across all hands it could hold here):</p>
      <div class="mix-row"><span>OOP</span>${mixBar(sum.oopDraw)}</div>
      <p style="margin-top:12px"><strong>How IP responds</strong> to each announcement:</p>
      ${[0, 1, 2, 3].map((x) => `<div class="mix-row"><span>OOP ${x === 0 ? 'pats' : 'draws ' + x} <span class="hint-inline" style="color:var(--muted)">IP ${units(sum.ipValueGiven[x])}</span></span>${mixBar(sum.ipDrawGiven[x])}</div>`).join('')}
      ${mixLegend()}
      <p class="hint" style="margin-top:8px">The number next to each announcement is IP's equilibrium EV after hearing it — the bigger it is, the more that announcement costs OOP.</p>
    </div>`;

    // --- the bot's play (only once its cards are visible) ---
    if (h.results && h.botKi !== undefined) {
      const bd = h.botSeat === 'ip' ? h.myDrawn.length : null;
      const bf = (ki) => (bd === null ? botObs.freq[ki] : botObs.freq[bd * NK + ki]);
      const be = (ki) => (bd === null ? botObs.ev[ki] : botObs.ev[bd * NK + ki]);
      const mix = Array.from({ length: NK }, (_, i) => i).filter((ki) => bf(ki) >= 0.05).sort((a, b) => bf(b) - bf(a)).slice(0, 4);
      html += `<div class="study-section"><h4>${BOT_NAME}'s draw</h4><div class="bot-dealt" id="botDealt"><span class="discard-label">Dealt</span></div><p>${h.botSeat === 'ip' ? `After you ${h.myDrawn.length === 0 ? 'patted' : 'drew ' + h.myDrawn.length}, it` : 'Acting first, it'} was choosing between:</p>
        <table class="ev-table"><tr><th>Keep</th><th>EV / hand</th><th>Draw</th><th>Mix</th></tr>
        ${mix.map((ki) => `<tr data-bot-ki="${ki}" class="${ki === h.botKi ? 'chosen' : ''}"><td class="keepcell"></td><td>${evText(be(ki), stake)}</td><td>${DRAW_NAMES[KD[ki]]}</td><td>${(bf(ki) * 100).toFixed(0)}%${ki === h.botKi ? ' <span class="tag-mini">played</span>' : ''}</td></tr>`).join('')}
        </table></div>`;
    }

    html += `<p class="study-foot">How this works: the solver samples ${sum.N} hands for each seat on these two flops, scores every keep with Monte Carlo runouts, keeps the ${sum.K} best candidates per hand (spread across all four draw counts), and runs CFR+ on the resulting game — OOP picks a keep; IP sees only the draw count and picks its own. Your hand and the bot's are evaluated against that equilibrium with all ${NK} keeps, and neither one is visible to the other side. EVs are in stakes per hand (a contest = 1, a scoop = 6) and carry Monte Carlo noise of a few hundredths; treat near-ties as ties. The mix column is how often the solver's own regret minimiser played each keep — when it splits between options, they are usually within that noise of each other. Exploitability is measured inside the sampled game, so it understates the true gap to a full-game equilibrium.</p>`;

    // Tables scroll sideways on narrow phones instead of crushing the card rows.
    html = html.replace(/<table class="ev-table">/g, '<div class="table-scroll"><table class="ev-table">').replace(/<\/table>/g, '</table></div>');
    body.innerHTML = html;
    body.querySelectorAll('tr[data-ki] .keepcell').forEach((td) => {
      const ki = Number(td.parentElement.dataset.ki);
      td.appendChild(miniCards(S.keepCards(h.my9, ki)));
    });
    const dealtBox = body.querySelector('#botDealt');
    if (dealtBox) dealtBox.appendChild(miniCards(h.bot9.filter((c) => h.botKeep.includes(c)).concat(h.bot9.filter((c) => !h.botKeep.includes(c))), { highlight: h.botKeep }));
    body.querySelectorAll('tr[data-bot-ki] .keepcell').forEach((td) => {
      td.appendChild(miniCards(S.keepCards(h.bot9, Number(td.parentElement.dataset.botKi))));
    });
    body.querySelectorAll('.study-tab').forEach((b) => b.addEventListener('click', () => {
      h.studyTab = Number(b.dataset.d);
      renderStudy();
    }));
  }

  // =====================================================================
  // BOOT / REJOIN
  // =====================================================================
  const params = new URLSearchParams(location.search);
  const joinParam = params.get('join');
  if (joinParam) {
    el('joinCode').value = joinParam.toUpperCase();
    document.querySelector('.tab-btn[data-tab="join"]').click();
  }
  const saved = loadSession();
  if (saved && saved.code && saved.playerId && saved.token && !joinParam) {
    Object.assign(live, saved);
    mode = 'live';
    let succeeded = false;
    const stream = connectStream();
    stream.addEventListener('room_state', () => { succeeded = true; }, { once: true });
    stream.onerror = () => {
      if (!succeeded) { clearSession(); stream.close(); mode = null; showScreen('landing'); }
    };
  }
})();
