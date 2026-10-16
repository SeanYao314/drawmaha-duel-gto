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
    if (s === 'rank' || s === 'suit' || s === 'dealt' || s === 'best5') cardSortMode = s;
  } catch (e) { /* default */ }
  // 'best5': the strongest 5-card poker hand you can make from your cards comes first,
  // in the order you'd read it (trips before the pair, quads before the kicker, a
  // straight from the top), then the leftover cards high to low.
  function bestFiveOrder(cards) {
    if (cards.length < 5) return { order: cards.slice(), category: null };
    const best = window.Poker.bestOfPool(cards);
    const rankOf = (c) => RANK_ORDER.indexOf(c[0]);
    const suitOf = (c) => SUIT_ORDER.indexOf(c[1]);
    const cnt = {};
    for (const c of best.cards) cnt[c[0]] = (cnt[c[0]] || 0) + 1;
    const cat = best.score[0];
    let five;
    if (cat === 4 || cat === 8) {
      // straight / straight flush: from the top card down (wheel: 5-4-3-2-A)
      const hi = best.score[1];
      const val = (c) => { const r = rankOf(c) + 2; return hi === 5 && r === 14 ? 1 : r; };
      five = best.cards.slice().sort((a, b) => val(b) - val(a));
    } else {
      five = best.cards.slice().sort((a, b) => cnt[b[0]] - cnt[a[0]] || rankOf(b) - rankOf(a) || suitOf(a) - suitOf(b));
    }
    const rest = cards.filter((c) => !five.includes(c)).sort((a, b) => rankOf(b) - rankOf(a) || suitOf(a) - suitOf(b));
    return { order: [...five, ...rest], category: window.Poker.categoryName(best.score) };
  }
  function sortCards(cards, mode) {
    if (mode === 'best5') return bestFiveOrder(cards).order;
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
    if (window.DDUI && window.DDUI.onSort) window.DDUI.onSort();
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
    ['landing', 'lobby', 'table', 'train'].forEach((s) => toggle('screen-' + s, s === name));
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
    const res = await api('/api/create_room', { name, stake: Number(el('createStake').value), handSize: Number(el('createHandSize').value), players: Number(el('createPlayers').value) });
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
    const max = room.maxPlayers || 2;
    el('lobbyCount').textContent = room.players.length;
    el('lobbyMax').textContent = max;
    el('lobbySub').textContent = max === 3 ? 'Send this link to your two opponents.' : 'Send this link to your opponent.';
    el('lobbyStake').textContent = `${max === 3 ? '3-handed · ' : ''}${room.handSize || 9}-card Drawmaha · ${money(room.stake, { sign: false })} per contest · ${money(room.stake * 6, { sign: false })} for a scoop${max === 3 ? ' (each matchup settles separately)' : ''}`;
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
    toggle('btnStart', isHost && room.players.length === max);
    el('lobbyHint').textContent = room.players.length < max
      ? (max === 3 ? `Waiting for ${max - room.players.length} more player${max - room.players.length > 1 ? 's' : ''} to join…` : 'Waiting for your opponent to join…')
      : isHost ? '' : 'Waiting for the host to start the game…';
  }

  function liveVM() {
    const room = live.room;
    if (!room || room.phase === 'lobby') return null;
    const me = room.players.find((p) => p.id === live.playerId);
    const order = room.order || room.players.map((p) => p.id);
    const results = live.results && live.results.handNumber === room.handNumber ? live.results : null;
    const my = live.my || {};
    const seats = order.map((id, pos) => {
      const p = room.players.find((x) => x.id === id) || { name: '?', connected: false };
      return { id, name: id === me.id ? 'You' : p.name, pos, isMe: id === me.id, connected: p.connected, announce: room.announce[id] || null };
    });
    return {
      key: `live-${room.code}-${room.handNumber}`,
      mode: 'live',
      handNumber: room.handNumber,
      stake: room.stake,
      handSize: room.handSize || 9,
      n: order.length,
      meId: me.id, meName: me.name, mePos: order.indexOf(me.id),
      seats, ring: room.players.map((p) => p.id),
      hand: my.hand || [], keep: my.keep || null, drawn: my.drawn || null,
      actingId: results ? null : room.actingId,
      flopA: room.flopA || [], flopB: room.flopB || [],
      results,
      cumulative: room.cumulative,
      history: room.history.map((h) => ({
        handNumber: h.handNumber, me: h.dollars[me.id],
        scoops: h.scoops || (h.scoop ? [{ winner: h.scoop, loser: order.find((x) => x !== h.scoop) }] : [])
      }))
    };
  }

  // =====================================================================
  // TABLE RENDERING (shared by live and practice, heads-up or 3-handed)
  // =====================================================================
  // A view model (vm) describes one hand from my side:
  //   n (2 or 3), seats: [{ id, name, pos, isMe, connected, announce }] in action order
  //   (button last), meId, mePos, hand/keep/drawn (mine), actingId (null once it's over),
  //   flopA/flopB, results, cumulative { id: dollars }, history.
  const table = { key: null, selected: new Set(), error: null };
  const reveal = { key: null, stage: 0, timer: null, lastStage: 0 };
  const FINAL_STAGE = 7; // 1 turns · 2 rivers · 3 opponents' cards · 4-6 contests · 7 totals

  const seatOf = (vm, id) => vm.seats.find((s) => s.id === id);
  const nameOf = (vm, id) => (id === vm.meId ? 'You' : (seatOf(vm, id) || { name: '?' }).name);
  const oppSeats = (vm) => vm.seats.filter((s) => !s.isMe);
  const annLabel = (d) => (d === 0 ? 'pats' : `draws ${d}`);
  const annPast = (d) => (d === 0 ? 'patted' : `drew ${d}`);
  // Which solver decision block a seat is in, given the draw counts it heard (in action
  // order): 0 for the first player, d0 for the 2nd, d0*4 + d1 for the 3-handed button.
  const blockOf = (anns) => anns.reduce((b, d) => b * 4 + d, 0);

  function currentVM() {
    if (mode === 'train') return null;
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
    el('modeTag').textContent = vm.n === 3 ? 'PRACTICE vs 2 BOTS' : 'PRACTICE vs BOT';
    const tags = [vm.n === 3 ? '3-HANDED' : null, vm.handSize !== 9 ? `${vm.handSize}-CARD` : null].filter(Boolean);
    el('sizeTag').textContent = tags.join(' · ');
    toggle('sizeTag', tags.length > 0);
    toggle('practiceSettings', vm.mode === 'practice');
    toggle('btnPracticeBack', vm.mode === 'practice');
    if (vm.mode === 'practice') hide('roomBadge');

    // Results reveal bookkeeping
    if (vm.results && reveal.key !== vm.key) startReveal(vm.key);
    const stage = vm.results ? (reveal.key === vm.key ? reveal.stage : FINAL_STAGE) : 0;

    renderScoreStrip(vm);
    renderPositionBanner(vm);
    renderOpps(vm, stage);
    renderBoards(vm, stage);
    renderMe(vm);
    renderResults(vm, stage);
    renderHistory(vm);
    if (vm.mode === 'practice') { renderStudy(); renderSession(stage); } else { hide('studyPanel'); hide('sessionPanel'); }
    reveal.lastStage = stage;
  }

  function renderScoreStrip(vm) {
    // Fixed seat order (you first, then clockwise), so the pills don't shuffle as the button moves.
    const ring = vm.ring || vm.seats.map((s) => s.id);
    const at = ring.indexOf(vm.meId);
    const order = ring.map((_, i) => seatOf(vm, ring[(at + i) % ring.length])).filter(Boolean);
    el('scoreStrip').innerHTML = order.map((s) => `<span class="score-pill">${s.isMe ? 'You' : esc(s.name)} <span class="amt ${cls(vm.cumulative[s.id] || 0)}">${money(vm.cumulative[s.id] || 0)}</span></span>`).join('') +
      `<span class="score-pill" style="font-weight:600;color:var(--muted)">${money(vm.stake, { sign: false })} per contest · scoop ${money(vm.stake * 6, { sign: false })}${vm.n === 3 ? ' · each matchup' : ''}</span>`;
  }

  // Seat colours: blue = acts first, teal = 2nd of three, gold = button (acts last).
  const posClass = (n, pos) => (pos === n - 1 ? 'ip' : pos === 0 ? 'oop' : 'mid');
  function posChipHTML(n, pos) {
    if (n === 2) return pos === 1 ? '<span class="dealer-btn" title="Dealer button">D</span> In position' : 'Out of position · acts first';
    return pos === 2 ? '<span class="dealer-btn" title="Dealer button">D</span> Button · acts last' : pos === 0 ? '1st to act' : '2nd to act';
  }
  function setPosChip(node, n, pos, acting) {
    node.innerHTML = posChipHTML(n, pos);
    node.className = 'pos-chip ' + posClass(n, pos) + (acting ? ' acting' : '');
  }
  // Big reminder of where you sit. nm[p] = name of whoever sits at position p.
  function positionBannerHTML(n, pos, nm) {
    if (n === 2) {
      return pos === 1
        ? `<span class="pb-icon"><span class="dealer-btn big">D</span></span><span><strong>You're IN POSITION</strong> — you have the button. ${esc(nm[0])} draws first and announces how many; then you decide.</span>`
        : `<span class="pb-icon">⬆</span><span><strong>You're OUT OF POSITION</strong> — you act first. Your draw count is announced before ${esc(nm[1])} decides.</span>`;
    }
    if (pos === 0) return `<span class="pb-icon">⬆</span><span><strong>You're 1ST TO ACT</strong> — left of the button. Your draw count is announced before ${esc(nm[1])} and ${esc(nm[2])} decide.</span>`;
    if (pos === 1) return `<span class="pb-icon pb-num">2</span><span><strong>You're 2ND TO ACT</strong> — you hear ${esc(nm[0])}'s draw count first; yours is announced before ${esc(nm[2])} (the button) decides.</span>`;
    return `<span class="pb-icon"><span class="dealer-btn big">D</span></span><span><strong>You're on the BUTTON</strong> — you act last, after hearing both ${esc(nm[0])}'s and ${esc(nm[1])}'s draw counts.</span>`;
  }

  // It pulses once whenever a new hand is dealt.
  let lastBannerKey = null;
  function renderPositionBanner(vm) {
    const b = el('posBanner');
    const pc = posClass(vm.n, vm.mePos);
    b.className = 'pos-banner ' + pc;
    b.innerHTML = positionBannerHTML(vm.n, vm.mePos, vm.seats.map((s) => s.name));
    if (vm.key !== lastBannerKey) {
      lastBannerKey = vm.key;
      b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
    }
    ['ip', 'oop', 'mid'].forEach((c) => el('meSeat').classList.toggle('seat-' + c, c === pc));
  }

  function renderOpps(vm, stage) {
    const host = el('oppSeats');
    const opps = oppSeats(vm);
    const compact = opps.length > 1;
    host.className = 'opp-seats' + (compact ? ' two' : '');
    host.innerHTML = '';
    for (const s of opps) {
      const seat = document.createElement('div');
      seat.className = 'seat seat-opp';
      seat.dataset.seatId = s.id;
      seat.innerHTML = '<div class="seat-head"><span class="seat-name"></span><span class="pos-chip"></span><span class="seat-status"></span></div><div class="seat-cards"></div>';
      seat.querySelector('.seat-name').textContent = s.name + (vm.mode === 'live' && !s.connected ? ' (offline)' : '');
      const acting = !vm.results && vm.actingId === s.id;
      setPosChip(seat.querySelector('.pos-chip'), vm.n, s.pos, acting);
      const status = seat.querySelector('.seat-status');
      if (s.announce) {
        status.textContent = s.announce.draws === 0 ? `Discarded ${s.announce.discards} — pat` : `Discarded ${s.announce.discards} — drawing ${s.announce.draws}`;
        status.classList.add('announce');
      } else if (acting) {
        status.textContent = vm.mode === 'practice' ? ((vm.botThinking && vm.botThinking[s.id]) || 'Thinking…') : 'Choosing a keep…';
      } else {
        status.textContent = vm.actingId === vm.meId ? 'Waiting for you' : 'Waiting to act';
      }
      const box = seat.querySelector('.seat-cards');
      if (vm.results && stage >= 3) {
        const p = vm.results.players.find((x) => x.id === s.id);
        p.final.forEach((c) => {
          const node = cardEl(c, { small: compact, extra: 'static' + (p.drawn.includes(c) ? ' drawn' : '') });
          if (reveal.lastStage < 3) node.classList.add('card-reveal');
          box.appendChild(node);
        });
        if (p.discarded && p.discarded.length) box.appendChild(discardGroup(p.discarded, reveal.lastStage < 3));
      } else {
        const nCards = s.announce ? 5 : vm.handSize;
        for (let i = 0; i < nCards; i++) box.appendChild(backEl(compact));
      }
      host.appendChild(seat);
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
    const myTurn = !vm.results && vm.actingId === vm.meId && !vm.keep;
    setPosChip(el('mePos'), vm.n, vm.mePos, myTurn);
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
      const nd = G.discardCount(vm.keep.length, vm.hand.length);
      status.textContent = vm.drawn.length === 0 ? `You discarded ${nd} — pat` : `You discarded ${nd} — drew ${vm.drawn.length}`;
      status.classList.add('announce');
      const gb = el('gradeBadge');
      if (vm.grade) { gb.className = `grade-badge g-${vm.grade.key}`; gb.textContent = (vm.grade.key === 'gto' ? '✓ ' : '') + vm.grade.label; }
      else if (vm.mode === 'practice') { gb.className = 'grade-badge g-pending'; gb.textContent = 'Grading…'; }
      else gb.className = 'grade-badge hidden';
      el('keepHint').textContent = !vm.results && vm.actingId ? `Waiting for ${nameOf(vm, vm.actingId)} to draw…` : '';
      hide('drawActions');
      return;
    }

    el('gradeBadge').className = 'grade-badge hidden';
    show('drawActions');
    // All cards start fully visible; clicking a card marks it for discard (click again
    // to keep it). Whatever isn't marked is your keep.
    const ordered = sortCards(vm.hand, cardSortMode);
    const b5 = cardSortMode === 'best5' ? bestFiveOrder(vm.hand) : null;
    ordered.forEach((c, i) => {
      if (b5 && i === 0) {
        const tag = document.createElement('div');
        tag.className = 'best5-tag';
        tag.innerHTML = `<span>Best 5</span><strong>${esc(b5.category)}</strong>`;
        box.appendChild(tag);
      }
      const node = cardEl(c, { extra: (table.selected.has(c) ? 'marked-discard' : '') + (b5 && i < 5 ? ' in-best5' : '') });
      node.addEventListener('click', () => {
        if (table.selected.has(c)) table.selected.delete(c); else table.selected.add(c);
        renderTable();
      });
      box.appendChild(node);
      if (b5 && i === 4 && ordered.length > 5) {
        const sep = document.createElement('div');
        sep.className = 'best5-sep';
        box.appendChild(sep);
      }
    });

    const nDisc = table.selected.size, k = vm.hand.length - nDisc;
    const minDisc = vm.hand.length - G.MAX_KEEP, maxDisc = vm.hand.length - G.MIN_KEEP;
    const legal = k >= G.MIN_KEEP && k <= G.MAX_KEEP;
    const btn = el('btnDraw');
    status.textContent = myTurn ? (vm.mePos === 0 ? 'Your turn — you act first' : 'Your turn') : '';
    let hint;
    if (nDisc === 0) hint = `Click the cards you want to discard (${minDisc}–${maxDisc}). Whatever you don't mark is your hand.`;
    else if (k > G.MAX_KEEP) hint = `Discarding ${nDisc} — discard at least ${minDisc} (you can keep at most 5).`;
    else if (k < G.MIN_KEEP) hint = `Discarding ${nDisc} — discard at most ${maxDisc} (you must keep at least 2).`;
    else hint = `Discarding ${nDisc}, keeping ${k} → ${k === 5 ? 'pat (draw nothing)' : 'draw ' + (5 - k)}.`;
    const before = vm.seats.slice(0, vm.mePos);
    const notYet = before.filter((s) => !s.announce);
    if (!myTurn && !vm.results && notYet.length) {
      hint += ` ${notYet.map((s) => s.name).join(' and ')} ${notYet.length > 1 ? 'announce' : 'announces'} first — you can line up your discards meanwhile.`;
    }
    const heard = before.filter((s) => s.announce);
    if (myTurn && heard.length) hint = heard.map((s) => `${s.name} ${announceText(s.announce)}`).join('; ') + '. ' + hint;
    el('keepHint').textContent = hint;
    btn.disabled = !(myTurn && legal);
    btn.textContent = !legal ? `Mark ${minDisc}–${maxDisc} cards to discard`
      : k === 5 ? `Pat — discard ${nDisc}` : `Discard ${nDisc} · draw ${5 - k}`;
    if (!myTurn && legal) btn.textContent = 'Waiting for your turn…';
    if (table.error) { el('gameError').textContent = table.error; show('gameError'); } else hide('gameError');
  }

  el('btnClearKeep').addEventListener('click', () => { table.selected = new Set(); renderTable(); });

  el('btnDraw').addEventListener('click', async () => {
    const vm = currentVM();
    if (!vm) return;
    const keep = vm.hand.filter((c) => !table.selected.has(c));
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
    const iScooped = r.matchups ? r.matchups.some((m) => m.scoop === vm.meId) : r.scoop === vm.meId;
    if (iScooped) playScoopSound();
    else if (mine > 0) playWinSound();
  }
  el('btnSkipReveal').addEventListener('click', () => {
    clearTimeout(reveal.timer);
    reveal.stage = FINAL_STAGE;
    renderTable();
    finishReveal();
  });

  // Scoops as plain sentences, from my side. scoops: [{ winner, loser }].
  function scoopSentences(vm, scoops) {
    return (scoops || []).map(({ winner, loser }) => winner === vm.meId ? `you scooped ${nameOf(vm, loser)}`
      : loser === vm.meId ? `${nameOf(vm, winner)} scooped you` : `${nameOf(vm, winner)} scooped ${nameOf(vm, loser)}`);
  }

  function renderResults(vm, stage) {
    toggle('resultsBlock', !!vm.results);
    if (!vm.results) return;
    const statusText = ['Dealing the turns…', 'Dealing the turns…', 'Dealing the rivers…', 'Showdown…', 'Showdown…', 'Showdown…', 'Showdown…'];
    if (stage < FINAL_STAGE) { el('revealStatus').textContent = statusText[stage]; show('revealStatus'); } else hide('revealStatus');
    if (vm.n === 3) renderResults3(vm, stage); else renderResults2(vm, stage);
    toggle('btnNextHand', stage >= FINAL_STAGE);
  }

  function renderResults2(vm, stage) {
    const r = vm.results;
    const oppSeat = oppSeats(vm)[0];
    const oppId = oppSeat.id, oppName = oppSeat.name;
    hide('matchupList');
    const me = r.players.find((p) => p.id === vm.meId), opp = r.players.find((p) => p.id === oppId);
    const tbl = el('contestTable');
    const oppLabel = esc(oppName);
    let html = `<tr><th>Contest</th><th>You</th><th>${oppLabel}</th><th>Result</th></tr>`;
    r.contests.forEach((c, i) => {
      const shown = stage >= 4 + i;
      const myEval = r.evals[vm.meId][c.key], opEval = r.evals[oppId][c.key];
      const res = c.winner === vm.meId ? 1 : c.winner === oppId ? -1 : 0;
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
        : `🧹 ${oppName} scooped all three contests — double money: ${money(mine)}`;
      show('scoopBanner');
      if (wasHidden) { banner.classList.remove('reveal'); void banner.offsetWidth; banner.classList.add('reveal'); }
    } else hide('scoopBanner');

    el('handTotal').innerHTML = stage >= FINAL_STAGE
      ? (mine === 0 ? '<span class="even">Even hand — no money changes hands.</span>'
        : `This hand: <span class="${cls(mine)}">${money(mine)}</span> <span class="hint-inline" style="color:var(--muted)">(${units(r.units[vm.meId])} stakes)</span>`)
      : '';
  }

  // 3-handed: one table with everyone's hand per contest (places 1st–3rd), then the three
  // head-up matchups those places decide.
  function renderResults3(vm, stage) {
    const r = vm.results;
    const cols = [seatOf(vm, vm.meId), ...oppSeats(vm)];
    const PLACE = ['', '1st', '2nd', '3rd'];
    const tbl = el('contestTable');
    let html = `<tr><th>Contest</th>${cols.map((s) => `<th>${s.isMe ? 'You' : esc(s.name)}</th>`).join('')}</tr>`;
    r.contests.forEach((c, i) => {
      const shown = stage >= 4 + i;
      html += `<tr class="three ${shown ? (reveal.lastStage < 4 + i ? 'shown' : '') : 'pending'}" data-i="${i}"><td class="c-label">${esc(c.label)}</td>` +
        cols.map((s, ci) => {
          const pl = c.places[s.id];
          return `<td class="c-hand ${shown && pl === 1 ? 'win' : ''}" data-who="p${ci}" data-name="${s.isMe ? 'You' : esc(s.name)}"><span class="cat">${shown ? `<span class="place p${pl}">${PLACE[pl]}</span> ${esc(r.evals[s.id][c.key].category)}` : '—'}</span></td>`;
        }).join('') + '</tr>';
    });
    tbl.innerHTML = html;
    r.contests.forEach((c, i) => {
      if (stage < 4 + i) return;
      const row = tbl.querySelector(`tr[data-i="${i}"]`);
      cols.forEach((s, ci) => {
        const p = r.players.find((x) => x.id === s.id);
        const ev = r.evals[s.id][c.key];
        const hole = c.key === 'five' ? [] : ev.cards.filter((x) => p.final.includes(x));
        row.querySelector(`td[data-who="p${ci}"]`).appendChild(miniCards(ev.cards, { highlight: hole }));
      });
    });

    // The three matchups (mine first), each settled on its own.
    const list = el('matchupList');
    if (stage >= FINAL_STAGE) {
      const mine = r.matchups.filter((m) => m.a === vm.meId || m.b === vm.meId).concat(r.matchups.filter((m) => m.a !== vm.meId && m.b !== vm.meId));
      list.innerHTML = '<div class="mu-title">Matchups</div>' + mine.map((m) => {
        const left = m.b === vm.meId ? m.b : m.a, right = left === m.a ? m.b : m.a;
        const net = m.units[left] * vm.stake;
        const marks = m.winners.map((w, i) => `<span class="mu-c ${w === left ? 'w' : w === right ? 'l' : 'p'}" title="${esc(G.CONTESTS[i].label)}">${['5', 'A', 'B'][i]}${w === left ? '✓' : w === right ? '✗' : '='}</span>`).join('');
        const scoop = m.scoop ? `<span class="mu-scoop">🧹 ${m.scoop === vm.meId ? 'you scooped' : esc(nameOf(vm, m.scoop)) + ' scooped'}</span>` : '';
        const mineRow = left === vm.meId;
        return `<div class="mu-row${mineRow ? ' mine' : ''}"><span class="mu-names">${esc(nameOf(vm, left))} vs ${esc(nameOf(vm, right))}</span><span class="mu-marks">${marks}</span>${scoop}<span class="mu-net ${mineRow ? cls(net) : ''}">${mineRow ? (net === 0 ? 'Even' : money(net)) : net === 0 ? 'Even' : `${esc(nameOf(vm, net > 0 ? left : right))} wins ${money(Math.abs(net), { sign: false })}`}</span></div>`;
      }).join('');
      show('matchupList');
    } else hide('matchupList');

    const mine = r.dollars[vm.meId];
    const banner = el('scoopBanner');
    const scoops = r.matchups.filter((m) => m.scoop).map((m) => ({ winner: m.scoop, loser: m.scoop === m.a ? m.b : m.a }));
    if (stage >= FINAL_STAGE && scoops.length) {
      const wasHidden = banner.classList.contains('hidden');
      const lines = scoopSentences(vm, scoops);
      banner.textContent = `🧹 SCOOP${scoops.length > 1 ? 'S' : ''}! ${lines.map((x) => x[0].toUpperCase() + x.slice(1)).join(' · ')} — double money in that matchup.`;
      show('scoopBanner');
      if (wasHidden) { banner.classList.remove('reveal'); void banner.offsetWidth; banner.classList.add('reveal'); }
    } else hide('scoopBanner');

    el('handTotal').innerHTML = stage >= FINAL_STAGE
      ? (mine === 0 ? '<span class="even">Even hand overall — your two matchups cancel out.</span>'
        : `This hand: <span class="${cls(mine)}">${money(mine)}</span> <span class="hint-inline" style="color:var(--muted)">(${units(r.units[vm.meId])} stakes, both matchups)</span>`)
      : '';
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
      ? items.map((h) => `Hand #${h.handNumber}: <span class="${cls(h.me)}">${money(h.me)}</span>${h.scoops && h.scoops.length ? ' — 🧹 ' + esc(scoopSentences(vm, h.scoops).join(', ')) : ''}`).join('<br>')
      : '<span class="hint">No hands finished yet.</span>';
  }

  // =====================================================================
  // PRACTICE MODE (vs one solver bot heads-up, or two bots 3-handed; all client-side)
  // =====================================================================
  const BOT_NAME = 'GTO Bot';
  const BOT_NAMES = { bot: 'GTO Bot', bot1: 'Bot 1', bot2: 'Bot 2' };
  const playerName = (id) => (id === 'me' ? 'You' : BOT_NAMES[id]);
  let practice = null;

  el('btnPracticeStart').addEventListener('click', () => {
    if (es) { es.close(); es = null; }
    mode = 'practice';
    const preset = (document.querySelector('input[name="depth"]:checked') || {}).value || 'deep';
    const handSize = Number(el('practiceHandSize').value) || 9;
    const players = Number(el('practicePlayers').value) === 3 ? 3 : 2;
    savePracticePrefs({ preset, handSize, stake: Number(el('practiceStake').value), players });
    // Seats around the table; the button moves one seat per hand (first button random).
    const ring = players === 3 ? ['me', 'bot1', 'bot2'] : ['me', 'bot'];
    practice = {
      stake: Number(el('practiceStake').value), preset, handSize, players, ring, handNumber: 0,
      buttonIndex: Math.floor(Math.random() * players),
      cumulative: Object.fromEntries(ring.map((id) => [id, 0])), history: [], stats: [], hand: null
    };
    el('psHandSize').value = String(handSize);
    el('psDepth').value = preset;
    showScreen('table');
    dealPractice();
  });

  // Practice preferences (players, hand size, solver depth, stake) persist between visits.
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
      if (p.players === 3) el('practicePlayers').value = '3';
    }
  } catch (e) { /* ignore */ }
  const prefsNow = () => ({ preset: practice.preset, handSize: practice.handSize, stake: practice.stake, players: practice.players });
  el('psHandSize').addEventListener('change', () => {
    if (!practice) return;
    practice.handSize = Number(el('psHandSize').value);
    savePracticePrefs(prefsNow());
  });
  el('psDepth').addEventListener('change', () => {
    if (!practice) return;
    practice.preset = el('psDepth').value;
    savePracticePrefs(prefsNow());
  });
  el('btnPracticeBack').addEventListener('click', () => {
    window.SolverPool.cancel();
    clearTimeout(reveal.timer);
    practice = null;
    mode = null;
    showScreen('landing');
  });

  // The draw counts the player at `pos` heard (everyone before them in the action order).
  const handAnns = (h, pos) => h.order.slice(0, pos).map((id) => h.drawn[id].length);
  // Solver seat for an observer: 'oop' / 'ip' heads-up, 0 / 1 / 2 three-handed.
  const solverSeat = (n, pos) => (n === 2 ? (pos === 0 ? 'oop' : 'ip') : pos);
  // Seat names stored in the decision log (heads-up keeps the original 'oop' / 'ip').
  const legacySeat = (n, pos) => (n === 2 ? (pos === 0 ? 'oop' : 'ip') : ['first', 'second', 'button'][pos]);

  function dealPractice() {
    window.SolverPool.cancel();
    practice.handNumber += 1;
    if (practice.handNumber > 1) practice.buttonIndex = (practice.buttonIndex + 1) % practice.players;
    const deck = window.Poker.shuffle(window.Poker.freshDeck());
    const flopA = deck.splice(0, 3), flopB = deck.splice(0, 3);
    const H = practice.handSize, n = practice.players;
    const cards = {};
    for (const id of practice.ring) cards[id] = deck.splice(0, H);
    const order = G.actionOrder(practice.ring, practice.buttonIndex);
    const h = practice.hand = {
      deck, flopA, flopB, n, order, cards, keep: {}, drawn: {}, actingIndex: 0, botKi: {}, botPending: null,
      results: null, peek: false, studyAnns: null, preset: practice.preset,
      solve: { status: 'running', progress: 0, result: null, error: null, startedAt: performance.now() }
    };
    renderTable();
    const solveFn = n === 3 ? window.SolverPool.solveFlop3 : window.SolverPool.solveFlop;
    solveFn({
      flopA, flopB, preset: practice.preset, handSize: H,
      observers: order.map((id, pos) => ({ id, seat: solverSeat(n, pos), cards: cards[id] })),
      onProgress: (p) => {
        if (practice && practice.hand === h) { h.solve.progress = p; updateProgress(); }
      }
    }).then((result) => {
      if (!practice || practice.hand !== h) return;
      h.solve.status = 'done';
      h.solve.result = result;
      h.solve.seconds = (performance.now() - h.solve.startedAt) / 1000;
      gradeMyDraw(h);
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
    const H = h.cards.me.length;
    const actingId = h.results ? null : h.order[h.actingIndex] || null;
    const botThinking = {};
    if (actingId && actingId !== 'me' && !h.keep[actingId]) {
      botThinking[actingId] = h.solve.status === 'running' ? `Solving the flop… ${Math.round(h.solve.progress * 100)}%` : 'Choosing…';
    }
    return {
      key: `practice-${practice.handNumber}`,
      mode: 'practice',
      handNumber: practice.handNumber,
      stake: practice.stake,
      handSize: H,
      n: h.n,
      meId: 'me', meName: 'You', mePos: h.order.indexOf('me'),
      seats: h.order.map((id, pos) => ({
        id, name: playerName(id), pos, isMe: id === 'me', connected: true,
        announce: h.keep[id] ? { discards: G.discardCount(h.keep[id].length, H), draws: h.drawn[id].length } : null
      })),
      ring: practice.ring,
      hand: h.cards.me, keep: h.keep.me || null, drawn: h.drawn.me || null,
      actingId,
      flopA: h.flopA, flopB: h.flopB,
      results: h.results,
      grade: h.grade || null,
      botThinking,
      cumulative: { ...practice.cumulative },
      history: practice.history
    };
  }

  function practiceHumanDraw(keep) {
    const h = practice.hand;
    if (h.keep.me || h.order[h.actingIndex] !== 'me') return;
    h.keep.me = keep;
    h.drawn.me = h.deck.splice(0, G.drawCount(keep.length));
    gradeMyDraw(h);
    advancePractice(h);
  }
  function advancePractice(h) {
    h.actingIndex += 1;
    if (h.actingIndex >= h.n) { finishPractice(); return; }
    renderTable();
    maybeBotAct();
  }

  // ---------- instant GTO feedback on your draw ----------
  // As soon as both your keep and the solve exist, grade the keep against the best one
  // (same comparison as the study panel: EV vs the equilibrium ranges, given every
  // announcement you heard). Ties within the error bar count as GTO.
  const GRADES = [
    { key: 'gto', label: 'GTO!', note: 'the solver’s play', max: 0, sound: 'gto' },
    { key: 'good', label: 'Good', note: 'close to the best', max: 0.10, sound: 'good' },
    { key: 'inacc', label: 'Inaccuracy', note: '', max: 0.30, sound: 'meh' },
    { key: 'mistake', label: 'Mistake', note: '', max: 0.75, sound: 'bad' },
    { key: 'blunder', label: 'Blunder', note: '', max: Infinity, sound: 'bad' }
  ];
  function gradeFor(loss, seDiff, isBest) {
    const tied = isBest || loss <= seDiff;
    return tied ? GRADES[0] : GRADES.find((g) => loss <= g.max) || GRADES[GRADES.length - 1];
  }

  // ---------- decision log (feeds mistake replay and rules of thumb) ----------
  // Each record: players (2|3), pos (place in the action order), anns (draw counts heard),
  // plus the heads-up fields seat ('oop'|'ip') and ann that older records carry.
  const DECISIONS_KEY = 'drawmaha-duel-decisions', MISTAKES_KEY = 'drawmaha-duel-mistakes';
  function loadJSON(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch (e) { return fallback; } }
  function saveJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } }
  // Older (heads-up only) records and spots have just seat/ann; fill in players/pos/anns.
  function normSpot(x) {
    if (x.players) return x;
    const ip = x.seat === 'ip';
    return { ...x, players: 2, pos: ip ? 1 : 0, anns: ip ? [x.ann] : [] };
  }
  function recordDecision(rec) {
    const r = { ...normSpot(rec), t: Date.now(), myDraw: 5 - rec.myKeep.length, bestDraw: 5 - rec.bestKeep.length };
    const log = loadJSON(DECISIONS_KEY, []);
    log.push(r);
    while (log.length > 1500) log.shift();
    saveJSON(DECISIONS_KEY, log);
    // Mistakes and blunders go into the replay deck (unless this was itself a replay).
    if ((r.grade === 'mistake' || r.grade === 'blunder') && r.source !== 'replay') {
      const deck = loadJSON(MISTAKES_KEY, []);
      deck.push({ id: `${r.t}-${Math.random().toString(36).slice(2, 7)}`,
        spot: { flopA: r.flopA, flopB: r.flopB, hand: r.hand, seat: r.seat, ann: r.ann, players: r.players, pos: r.pos, anns: r.anns },
        firstGrade: r.grade, firstLoss: r.loss, myKeep: r.myKeep, bestKeep: r.bestKeep, added: r.t, box: 0, due: r.t, attempts: 0, correct: 0 });
      while (deck.length > 300) deck.shift();
      saveJSON(MISTAKES_KEY, deck);
    }
    if (window.DDUI && window.DDUI.onDecision) window.DDUI.onDecision(r);
  }

  function gradeMyDraw(h) {
    if (!h || h.grade || !h.keep.me || h.solve.status !== 'done') return;
    const NK = S.layout(h.cards.me.length).NKEEPS;
    const me = h.solve.result.observers.find((o) => o.id === 'me');
    const pos = h.order.indexOf('me');
    // Everyone before me has announced by the time I draw: grade against what I heard.
    const anns = handAnns(h, pos);
    const off = blockOf(anns) * NK;
    let best = 0;
    for (let k = 1; k < NK; k++) if (me.ev[off + k] > me.ev[off + best]) best = k;
    const mine = keepIndexOf(h.cards.me, h.keep.me);
    const loss = me.ev[off + best] - me.ev[off + mine];
    const grade = gradeFor(loss, me.seDiff[off + mine], mine === best);
    h.grade = { key: grade.key, label: grade.label, loss, best, mine };
    recordDecision({
      source: 'game', flopA: h.flopA, flopB: h.flopB, hand: h.cards.me, players: h.n, pos, anns,
      seat: legacySeat(h.n, pos), ann: h.n === 2 && pos === 1 ? anns[0] : null, preset: h.preset,
      myKeep: h.keep.me, bestKeep: S.keepCards(h.cards.me, best), loss, grade: grade.key
    });
    // session tallies + streak
    practice.drawsGraded = (practice.drawsGraded || 0) + 1;
    if (grade.key === 'gto') { practice.gtoHits = (practice.gtoHits || 0) + 1; practice.streak = (practice.streak || 0) + 1; practice.bestStreak = Math.max(practice.bestStreak || 0, practice.streak); }
    else practice.streak = 0;
    showGradeToast(h);
    playGradeSound(grade.sound, practice.streak);
    renderTable();
  }
  let toastTimer = null;
  function showGradeToast(h) { showGradeToastFor(h.grade, practice.stake, practice.streak); }
  function showGradeToastFor(g, stake, streakCount) {
    const t = el('gradeToast');
    const streak = g.key === 'gto' && streakCount >= 2 ? `<span class="gt-streak">🔥 ${streakCount} in a row</span>` : '';
    const detail = g.key === 'gto'
      ? (g.mine === g.best ? 'You found the solver’s best draw.' : 'Statistically tied with the solver’s best draw.')
      : `Best draw was ${g.loss.toFixed(2)} stakes (${money(g.loss * stake, { sign: false })}) better.`;
    t.className = `grade-toast g-${g.key}`;
    t.innerHTML = `<span class="gt-label">${g.key === 'gto' ? '✓ ' : ''}${g.label}</span><span class="gt-detail">${detail}</span>${streak}`;
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }
  function playGradeSound(kind, streak) {
    if (!soundEnabled) return;
    const ctx = getAudioCtx(); if (!ctx) return;
    const now = ctx.currentTime;
    if (kind === 'gto') {
      // bright two-note "ding", a step higher with each extra in a streak (capped)
      const lift = Math.pow(2, Math.min(streak - 1, 5) / 12);
      playTone(ctx, 1318.51 * lift, now, 0.18, 0.16, 'triangle');
      playTone(ctx, 1975.53 * lift, now + 0.09, 0.32, 0.14, 'triangle');
    } else if (kind === 'good') {
      playTone(ctx, 987.77, now, 0.22, 0.12, 'triangle');
    } else if (kind === 'meh') {
      playTone(ctx, 392, now, 0.22, 0.12, 'sine');
    } else {
      // low descending "thud"
      playTone(ctx, 220, now, 0.18, 0.18, 'sine');
      playTone(ctx, 164.81, now + 0.12, 0.3, 0.16, 'sine');
    }
  }

  // A bot draws once it's its turn AND the flop solve has finished, sampling its keep from
  // the solver's mix for exactly the announcements it heard.
  function maybeBotAct() {
    const h = practice && practice.hand;
    if (!h || h.results) return;
    const id = h.order[h.actingIndex];
    if (!id || id === 'me' || h.keep[id] || h.botPending === id) return;
    if (h.solve.status === 'running') { renderTable(); return; }
    const NK = S.layout(h.cards[id].length).NKEEPS;
    let ki = 0; // solver failed (shouldn't happen): keep the first five dealt cards
    if (h.solve.status === 'done') {
      const o = h.solve.result.observers.find((x) => x.id === id);
      const b = blockOf(handAnns(h, h.actingIndex));
      ki = S.sampleMixed(o.freq.slice(b * NK, (b + 1) * NK));
    }
    h.botKi[id] = ki;
    h.botPending = id;
    const keep = S.keepCards(h.cards[id], ki);
    setTimeout(() => {
      if (!practice || practice.hand !== h) return;
      h.botPending = null;
      h.keep[id] = keep;
      h.drawn[id] = h.deck.splice(0, G.drawCount(keep.length));
      advancePractice(h);
    }, 500);
  }

  function finishPractice() {
    const h = practice.hand;
    const boardA = [...h.flopA, ...h.deck.splice(0, 2)];
    const boardB = [...h.flopB, ...h.deck.splice(0, 2)];
    const fin = (id) => [...h.keep[id], ...h.drawn[id]];
    let res;
    if (h.n === 2) {
      const [a, b] = h.order;
      res = G.scoreShowdown(a, fin(a), b, fin(b), boardA, boardB);
    } else {
      const finals = {};
      for (const id of h.order) finals[id] = fin(id);
      res = G.scoreTable(h.order, finals, boardA, boardB);
    }
    const dollars = {};
    for (const id of h.order) { dollars[id] = res.units[id] * practice.stake; practice.cumulative[id] += dollars[id]; }
    const scoops = res.matchups
      ? res.matchups.filter((m) => m.scoop).map((m) => ({ winner: m.scoop, loser: m.scoop === m.a ? m.b : m.a }))
      : res.scoop ? [{ winner: res.scoop, loser: h.order.find((x) => x !== res.scoop) }] : [];
    practice.history.push({ handNumber: practice.handNumber, me: dollars.me, scoops });
    practice.stats.push(handStats(h, dollars.me));
    h.results = {
      handNumber: practice.handNumber, stake: practice.stake, boardA, boardB, playerCount: h.n, order: h.order.slice(),
      players: h.order.map((id) => ({
        id, name: playerName(id), kept: h.keep[id], drawn: h.drawn[id], final: fin(id),
        discarded: h.cards[id].filter((c) => !h.keep[id].includes(c)),
        discards: G.discardCount(h.keep[id].length, h.cards[id].length), draws: h.drawn[id].length
      })),
      evals: res.evals, contests: res.contests, scoop: res.scoop || null, matchups: res.matchups || null,
      units: res.units, dollars, cumulative: { ...practice.cumulative }
    };
    renderTable();
  }

  // =====================================================================
  // SESSION GRAPH (practice): PnL, post-discard EV, GTO EV, GTO post-discard EV, EV lost
  // =====================================================================
  // Per-hand numbers, in dollars (3-handed: summed over both matchups):
  //   pnl            — what actually changed hands
  //   postDiscard    — my kept cards vs the bots' kept cards, averaged over everyone's
  //                    draws and every turn/river: the luck that comes after the decisions
  //   gto            — EV of the solver's best keep for my dealt cards vs the equilibrium ranges
  //   gtoPostDiscard — the solver's best keep vs the bots' kept cards, same averaging
  //                    (identical to postDiscard whenever I made the GTO keep)
  //   evLoss         — EV of the keep I chose minus that best keep (≤ 0)
  // "vs the equilibrium ranges" is given every announcement I heard, since that's what I
  // knew when I drew.
  const POST_DISCARD_SAMPLES = 12000;
  function handStats(h, pnl) {
    const stake = practice.stake;
    const others = h.order.filter((id) => id !== 'me');
    const dead = [...h.flopA, ...h.flopB, ...h.order.flatMap((id) => h.cards[id])];
    // One seed per hand: both post-discard numbers use the same shuffles, so the gap
    // between them is the keep, not sampling noise.
    const seed = (Math.random() * 2 ** 31) | 0;
    const equity = (meKeep, oppKeeps) => window.Solver3.keepEquityMulti({
      meKeep, meDraw: 5 - meKeep.length, opps: oppKeeps.map((k) => ({ keep: k, draw: 5 - k.length })),
      flopA: h.flopA, flopB: h.flopB, dead, samples: POST_DISCARD_SAMPLES, seed
    });
    const postDiscard = equity(h.keep.me, others.map((id) => h.keep[id]));
    let gto = null, mine = null, gtoPostDiscard = null;
    if (h.solve.status === 'done') {
      const L = S.layout(h.cards.me.length), NK = L.NKEEPS;
      const obs = (id) => h.solve.result.observers.find((o) => o.id === id);
      const me = obs('me'), pos = h.order.indexOf('me');
      const off = blockOf(handAnns(h, pos)) * NK;
      let bestK = 0;
      for (let k = 1; k < NK; k++) if (me.ev[off + k] > me.ev[off + bestK]) bestK = k;
      const myK = keepIndexOf(h.cards.me, h.keep.me);
      gto = me.ev[off + bestK];
      mine = me.ev[off + myK];
      if (bestK === myK) {
        gtoPostDiscard = postDiscard;
      } else {
        // Players after me hear the best keep's draw count instead of mine. Where that
        // changes what they heard, they answer it the solver's way (their most-played keep
        // for it); where it doesn't, their actual keep stands.
        const heard = handAnns(h, pos).concat([L.KEEP_DRAW[bestK]]);
        const keepFor = {};
        for (let p = pos + 1; p < h.n; p++) {
          const id = h.order[p], actual = handAnns(h, p);
          if (heard.every((d, i) => d === actual[i])) keepFor[id] = h.keep[id];
          else {
            const o = obs(id), b = blockOf(heard), NKo = S.layout(h.cards[id].length).NKEEPS;
            let bk = 0;
            for (let k = 1; k < NKo; k++) if (o.freq[b * NKo + k] > o.freq[b * NKo + bk]) bk = k;
            keepFor[id] = S.keepCards(h.cards[id], bk);
          }
          heard.push(5 - keepFor[id].length);
        }
        gtoPostDiscard = equity(S.keepCards(h.cards.me, bestK), others.map((id) => keepFor[id] || h.keep[id]));
      }
    }
    return {
      hand: practice.handNumber,
      grade: h.grade ? h.grade.label : null,
      pnl,
      postDiscard: postDiscard * stake,
      gto: gto === null ? null : gto * stake,
      gtoPostDiscard: gtoPostDiscard === null ? null : gtoPostDiscard * stake,
      evLoss: gto === null ? null : (mine - gto) * stake
    };
  }

  const SERIES = [
    { key: 'pnl', name: 'PnL', color: 'var(--series-1)' },
    { key: 'postDiscard', name: 'Post-discard EV', color: 'var(--series-2)' },
    { key: 'gto', name: 'GTO EV', color: 'var(--series-3)' },
    { key: 'evLoss', name: 'EV lost', color: 'var(--series-4)', dash: '6 4' },
    { key: 'gtoPostDiscard', name: 'GTO post-discard EV', color: 'var(--series-5)', dash: '1 4' }
  ];

  function cumulativeSeries(stats) {
    const out = {};
    for (const sr of SERIES) {
      let acc = 0;
      out[sr.key] = [0, ...stats.map((x) => (acc += x[sr.key] || 0))];
    }
    return out;
  }

  function niceTicks(min, max, count = 5) {
    if (min === max) { min -= 100; max += 100; }
    const span = max - min, raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => span / x <= count) || 10 * mag;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
    return ticks;
  }

  function renderSession(stage) {
    if (!practice) { hide('sessionPanel'); return; }
    // Hold the newest hand back until its reveal has finished, so the graph never spoils it.
    const h = practice.hand;
    const pendingReveal = h && h.results && stage < FINAL_STAGE;
    const stats = pendingReveal ? practice.stats.slice(0, -1) : practice.stats;
    show('sessionPanel');
    el('sessionCount').textContent = `${stats.length} hand${stats.length === 1 ? '' : 's'} · ${money(practice.stake, { sign: false })} stakes`;
    const sum = (k) => stats.reduce((a, x) => a + (x[k] || 0), 0);
    const tiles = [['PnL', sum('pnl')], ['Post-discard EV', sum('postDiscard')], ['GTO EV', sum('gto')], ['GTO post-discard EV', sum('gtoPostDiscard')], ['EV lost', sum('evLoss')]];
    const graded = stats.filter((x) => x.grade);
    const hits = graded.filter((x) => x.grade === 'GTO!').length;
    el('sessionTiles').innerHTML = tiles.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v"><span class="${cls(Math.round(v))}" style="font-variant-numeric:tabular-nums">${money(v)}</span></div></div>`).join('') +
      `<div class="stat"><div class="k">GTO draws</div><div class="v">${graded.length ? `${hits}/${graded.length} <span class="hint-inline" style="color:var(--muted)">(${Math.round(100 * hits / graded.length)}%)</span>` : '—'}</div>${practice.bestStreak ? `<div class="hint-inline" style="color:var(--muted)">best streak ${practice.bestStreak}${practice.streak ? ` · current ${practice.streak}` : ''}</div>` : ''}</div>`;
    el('chartLegend').innerHTML = SERIES.map((sr) => `<span class="key"><svg width="22" height="8"><line x1="1" y1="4" x2="21" y2="4" stroke="${sr.color}" stroke-width="2.5" stroke-linecap="round"${sr.dash ? ` stroke-dasharray="${sr.dash}"` : ''}/></svg>${sr.name}</span>`).join('');
    drawChart(stats);
    drawStrips(stats);
    el('sessionTable').innerHTML = stats.length
      ? `<div class="table-scroll"><table class="session-table"><tr><th>Hand</th><th>Draw grade</th>${SERIES.map((sr) => `<th>${sr.name}</th>`).join('')}</tr>` +
        stats.map((x) => `<tr><td>#${x.hand}</td><td>${x.grade || '—'}</td>${SERIES.map((sr) => `<td class="${x[sr.key] === null ? '' : cls(Math.round(x[sr.key]))}">${x[sr.key] === null ? '—' : money(x[sr.key])}</td>`).join('')}</tr>`).join('') +
        `<tr><td><strong>Total</strong></td><td>${hits}/${graded.length} GTO</td>${SERIES.map((sr) => `<td><strong>${money(sum(sr.key))}</strong></td>`).join('')}</tr></table></div>`
      : '<p class="hint">No hands yet.</p>';
  }

  let chartState = null;
  function drawChart(stats) {
    const svg = el('sessionChart'), wrap = el('chartWrap');
    const W = Math.max(280, wrap.clientWidth || 800), Hh = 260;
    const pad = { l: 62, r: 64, t: 12, b: 28 };
    svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    if (!stats.length) {
      svg.innerHTML = `<text x="${W / 2}" y="${Hh / 2}" text-anchor="middle" fill="var(--text-muted)" font-size="13">Finish a hand to start the graph.</text>`;
      chartState = null;
      return;
    }
    const cum = cumulativeSeries(stats);
    const n = stats.length;
    const all = SERIES.flatMap((sr) => cum[sr.key]);
    const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
    const yMin = ticks[0], yMax = ticks[ticks.length - 1];
    const x = (i) => pad.l + (n === 0 ? 0 : (i / n) * (W - pad.l - pad.r));
    const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (Hh - pad.t - pad.b);
    let g = '';
    // recessive grid + y labels
    for (const t of ticks) {
      g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" stroke="${t === 0 ? 'var(--axis)' : 'var(--grid)'}" stroke-width="1"/>`;
      g += `<text x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="var(--text-muted)">${money(t)}</text>`;
    }
    // x labels: a few hand numbers
    const xStep = Math.max(1, Math.ceil(n / 8));
    for (let i = 0; i <= n; i += xStep) g += `<text x="${x(i)}" y="${Hh - 8}" text-anchor="middle" font-size="11" fill="var(--text-muted)">${i}</text>`;
    if (n % xStep !== 0) g += `<text x="${x(n)}" y="${Hh - 8}" text-anchor="middle" font-size="11" fill="var(--text-muted)">${n}</text>`;
    // lines
    for (const sr of SERIES) {
      const pts = cum[sr.key].map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      g += `<polyline points="${pts}" fill="none" stroke="${sr.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${sr.dash ? ` stroke-dasharray="${sr.dash}"` : ''}/>`;
    }
    // direct end labels (values in text ink, a colored tick carries identity), de-overlapped
    const ends = SERIES.map((sr) => ({ sr, v: cum[sr.key][n], y: y(cum[sr.key][n]) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
    for (const e of ends) {
      g += `<line x1="${x(n) + 4}" x2="${x(n) + 12}" y1="${e.y}" y2="${e.y}" stroke="${e.sr.color}" stroke-width="2.5" stroke-linecap="round"/>`;
      g += `<text x="${x(n) + 15}" y="${e.y + 4}" font-size="11" font-weight="700" fill="var(--text-primary)">${money(e.v)}</text>`;
    }
    // hover layer
    g += `<line id="chartHoverLine" x1="0" x2="0" y1="${pad.t}" y2="${Hh - pad.b}" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/>`;
    g += `<g id="chartHoverDots"></g>`;
    g += `<rect x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${Hh - pad.t - pad.b}" fill="transparent" id="chartHit"/>`;
    svg.innerHTML = g;
    chartState = { cum, n, x, y, W, stats };
    const hit = el('chartHit');
    hit.addEventListener('mousemove', onChartHover);
    hit.addEventListener('mouseleave', hideChartHover);
    hit.addEventListener('touchstart', (e) => onChartHover(e.touches[0]), { passive: true });
  }

  // Per-hand strips: one small bar row per metric, every hand on a shared scale.
  const STRIP_ORDER = ['pnl', 'postDiscard', 'gto', 'gtoPostDiscard', 'evLoss'];
  let stripStats = [];
  function drawStrips(stats) {
    stripStats = stats;
    const box = el('handStrips');
    if (!stats.length) { hide('handStripsBox'); box.innerHTML = ''; return; }
    show('handStripsBox');
    const n = stats.length;
    const rows = STRIP_ORDER.map((k) => SERIES.find((sr) => sr.key === k));
    let m = 1;
    for (const x of stats) for (const sr of rows) if (x[sr.key] !== null) m = Math.max(m, Math.abs(x[sr.key]));
    const slot = 10, H = 44, mid = H / 2, half = mid - 2;
    const bw = n > 60 ? slot * 0.9 : slot * 0.7, off = (slot - bw) / 2;
    box.innerHTML = rows.map((sr) => {
      let bars = '';
      stats.forEach((x, i) => {
        const v = x[sr.key];
        if (v === null) return;
        const h = Math.max(v === 0 ? 0 : 0.8, (Math.abs(v) / m) * half);
        bars += `<rect class="hs-bar" data-i="${i}" x="${i * slot + off}" y="${v >= 0 ? mid - h : mid}" width="${bw}" height="${h}" fill="${sr.color}"/>`;
      });
      const vals = stats.map((x) => x[sr.key]).filter((v) => v !== null);
      const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      return `<div class="hs-row" data-key="${sr.key}">
        <span class="hs-name"><i style="background:${sr.color}"></i>${sr.name}</span>
        <span class="hs-val" data-key="${sr.key}"></span>
        <svg class="hs-svg" viewBox="0 0 ${n * slot} ${H}" preserveAspectRatio="none" role="img" aria-label="${sr.name} per hand">
          <line x1="0" x2="${n * slot}" y1="${mid}" y2="${mid}" stroke="var(--axis)" stroke-width="1" vector-effect="non-scaling-stroke"/>${bars}
        </svg>
        <span class="hs-avg">${avg === null ? '—' : `avg ${money(avg)}`}</span>
      </div>`;
    }).join('');
    box.querySelectorAll('.hs-svg').forEach((svg) => {
      const at = (ev) => {
        const r = svg.getBoundingClientRect();
        return Math.max(0, Math.min(n - 1, Math.floor(((ev.clientX - r.left) / r.width) * n)));
      };
      svg.addEventListener('mousemove', (ev) => setStripFocus(at(ev)));
      svg.addEventListener('mouseleave', () => setStripFocus(null));
      svg.addEventListener('touchstart', (ev) => setStripFocus(at(ev.touches[0])), { passive: true });
    });
    setStripFocus(null);
  }
  // Show hand i's values (or the latest hand when i is null) and highlight its bars.
  function setStripFocus(i) {
    const n = stripStats.length;
    if (!n) return;
    const idx = i === null ? n - 1 : i;
    const x = stripStats[idx];
    el('hsWhich').textContent = i === null ? `Last hand · #${x.hand}${x.grade ? ` · ${x.grade}` : ''}` : `Hand #${x.hand}${x.grade ? ` · ${x.grade}` : ''}`;
    document.querySelectorAll('#handStrips .hs-val').forEach((c) => {
      const v = x[c.dataset.key];
      c.className = `hs-val ${v === null ? '' : cls(Math.round(v))}`;
      c.textContent = v === null ? '—' : money(v);
    });
    const box = el('handStrips');
    box.classList.toggle('focusing', i !== null);
    box.querySelectorAll('.hs-bar.on').forEach((b) => b.classList.remove('on'));
    box.querySelectorAll(`.hs-bar[data-i="${idx}"]`).forEach((b) => b.classList.add('on'));
  }

  function onChartHover(ev) {
    if (!chartState) return;
    const svg = el('sessionChart');
    const rect = svg.getBoundingClientRect();
    const scale = chartState.W / rect.width;
    const px = (ev.clientX - rect.left) * scale;
    const { n, x, y, cum, stats } = chartState;
    let i = Math.round(((px - x(0)) / (x(n) - x(0))) * n);
    i = Math.max(0, Math.min(n, i));
    const line = el('chartHoverLine');
    line.setAttribute('x1', x(i)); line.setAttribute('x2', x(i)); line.setAttribute('visibility', 'visible');
    el('chartHoverDots').innerHTML = SERIES.map((sr) => `<circle cx="${x(i)}" cy="${y(cum[sr.key][i])}" r="4.5" fill="${sr.color}" stroke="var(--surface-1)" stroke-width="2"/>`).join('');
    const tip = el('chartTip');
    const hs = i > 0 ? stats[i - 1] : null;
    tip.innerHTML = `<div class="tip-h">${i === 0 ? 'Start' : `After hand #${hs.hand}`}</div>` +
      SERIES.map((sr) => `<div class="tip-row"><span><i style="background:${sr.color}"></i>${sr.name}</span><strong>${money(cum[sr.key][i])}</strong></div>`).join('') +
      (hs ? `<div class="tip-row" style="margin-top:4px;color:var(--text-muted)"><span>This hand</span><span>${money(hs.pnl)} PnL</span></div>` : '');
    show('chartTip');
    setStripFocus(i > 0 ? i - 1 : null);
    const left = (x(i) / scale) + 12;
    tip.style.left = `${Math.min(left, rect.width - tip.offsetWidth - 6)}px`;
    tip.style.top = '8px';
  }
  function hideChartHover() {
    const line = el('chartHoverLine');
    if (line) line.setAttribute('visibility', 'hidden');
    const dots = el('chartHoverDots');
    if (dots) dots.innerHTML = '';
    hide('chartTip');
    setStripFocus(null);
  }
  window.addEventListener('resize', () => { if (practice && mode === 'practice') renderSession(reveal.stage); });

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
    const id = h.order[h.actingIndex];
    if (id && id !== 'me' && !h.keep[id]) {
      const st = document.querySelector(`#oppSeats [data-seat-id="${id}"] .seat-status`);
      if (st) st.textContent = `Solving the flop… ${Math.round(h.solve.progress * 100)}%`;
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

  function evText(u, stake, se) {
    const err = se !== undefined ? ` <span class="ev-err">±${se.toFixed(2)}</span>` : '';
    return `<span class="${u > 0.005 ? 'ev-pos' : u < -0.005 ? 'ev-neg' : ''}">${units(u)}</span>${err} <span class="hint-inline" style="color:var(--muted)">(${money(u * stake)})</span>`;
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
    const decided = !!h.keep.me;
    const visible = !!h.results || h.peek;
    const n = h.n, pos = h.order.indexOf('me');
    const nm = (p) => playerName(h.order[p]);
    el('btnAdvice').textContent = h.peek ? 'Hide solver' : 'Peek at solver';

    if (sv.status === 'running') {
      show('solveProgress');
      el('solveProgressBar').style.width = `${Math.round(sv.progress * 100)}%`;
      el('studyStatus').textContent = `Solving this flop… ${Math.round(sv.progress * 100)}%`;
      const who = n === 3 ? 'The bots solve each flop pair for an approximate 3-handed equilibrium' : 'The bot solves each flop pair for an approximate equilibrium';
      body.innerHTML = `<p class="hint">${who} (${S.PRESETS[h.preset].M.toLocaleString()} sampled hands per seat, ${window.SolverPool.workerCount} worker thread${window.SolverPool.workerCount > 1 ? 's' : ''}) before ${n === 3 ? 'they draw' : 'it draws'}.${pos === 0 ? ' You act first, so go ahead — it will be ready by the time it’s needed.' : ''}</p>`;
      return;
    }
    hide('solveProgress');
    if (sv.status === 'error') {
      el('studyStatus').textContent = 'Solver error';
      body.innerHTML = `<p class="error">The solver failed on this hand: ${esc(sv.error)}</p>`;
      return;
    }
    el('studyStatus').textContent = `Solved in ${sv.seconds.toFixed(1)} s · ${h.preset} depth${n === 3 ? ' · 3-handed' : ''}`;
    if (!visible) {
      body.innerHTML = `<p class="hint">Solved and hidden until the hand is over. ${decided ? '' : 'Click <strong>Peek at solver</strong> if you want the answer before you draw.'}</p>`;
      return;
    }

    const res = sv.result;
    const L = S.layout(h.cards.me.length), NK = L.NKEEPS, KD = L.KEEP_DRAW;
    const meObs = res.observers.find((o) => o.id === 'me');
    const stake = practice.stake;
    const sum = res.summary;
    // Which announcements to view: the real ones once they're known, else a tab choice.
    const allHeard = h.order.slice(0, pos).every((id) => h.keep[id]);
    const actual = allHeard ? handAnns(h, pos) : null;
    if (!h.studyAnns || h.studyAnns.length !== pos) h.studyAnns = h.order.slice(0, pos).map((id) => (h.keep[id] ? h.drawn[id].length : 0));
    const ctxAnns = h.studyAnns;
    const off = blockOf(ctxAnns) * NK;
    const isActual = !!actual && actual.every((d, i) => d === ctxAnns[i]);
    const ctxText = (anns) => anns.map((d, p) => `${nm(p)} ${annLabel(d)}`).join(', ');
    const evOf = (ki) => meObs.ev[off + ki];
    const freqOf = (ki) => meObs.freq[off + ki];
    const seOf = (ki) => meObs.se[off + ki];
    const seDiffOf = (ki) => meObs.seDiff[off + ki];
    // How likely a context is at equilibrium (to flag rarely-reached announcements).
    const ctxProb = (anns) => {
      if (!anns.length) return 1;
      if (n === 2) return sum.oopDraw[anns[0]];
      return anns.length === 1 ? sum.draw0[anns[0]] : sum.ctxP[anns[0] * 4 + anns[1]];
    };

    const order = Array.from({ length: NK }, (_, i) => i).sort((a, b) => evOf(b) - evOf(a));
    const bestKi = order[0];
    const myKi = decided ? keepIndexOf(h.cards.me, h.keep.me) : -1;

    let html = '';

    // --- verdict on the keep you made ---
    if (decided && myKi >= 0 && (pos === 0 || isActual)) {
      const lost = evOf(bestKi) - evOf(myKi);
      const rank = order.indexOf(myKi) + 1;
      const tied = myKi !== bestKi && lost <= seDiffOf(myKi);
      html += `<div class="verdict">Your keep (${DRAW_NAMES[KD[myKi]].toLowerCase()}) has EV ${evText(evOf(myKi), stake, seOf(myKi))} per hand${n === 3 ? ' (both matchups)' : ''} — #${rank} of ${NK}.
        ${myKi === bestKi ? '<strong class="good">That’s the solver’s top choice.</strong>'
          : tied ? `<strong class="good">Statistically tied with the best keep</strong> (${evText(evOf(bestKi), stake)}; the ${lost.toFixed(2)} gap is within the ±${seDiffOf(myKi).toFixed(2)} error on the difference).`
          : `The best keep was worth ${evText(evOf(bestKi), stake, seOf(bestKi))}: <strong class="bad">you gave up ${lost.toFixed(2)} ±${seDiffOf(myKi).toFixed(2)} stakes (${money(lost * stake, { sign: false })})</strong>.`}</div>`;
    }

    // --- your keep options ---
    html += `<div class="study-section"><h4>Your keep options</h4>`;
    if (pos > 0) {
      html += `<p>${pos === 1 ? `You act after ${esc(nm(0))}` : `You act last, after ${esc(nm(0))} and ${esc(nm(1))}`}, so your best keep depends on what you heard. Pick the announcement${pos > 1 ? 's' : ''}:</p>`;
      for (let p = 0; p < pos; p++) {
        html += `<div class="study-tabs">` + [0, 1, 2, 3].map((x) => `<button class="study-tab${p > 0 ? ' sub' : ''}${ctxAnns[p] === x ? ' active' : ''}" data-p="${p}" data-d="${x}">${esc(nm(p))} ${annLabel(x)}${actual && actual[p] === x ? ' (actual)' : ''}</button>`).join('') + '</div>';
      }
    } else {
      html += `<p>You act first: your draw count is announced before ${n === 2 ? `${esc(nm(1))} decides` : `${esc(nm(1))} and ${esc(nm(2))} decide`}, and these EVs already account for how ${n === 2 ? 'it reacts' : 'they react'}.</p>`;
    }
    const rows = order.slice(0, 10);
    if (myKi >= 0 && !rows.includes(myKi)) rows.push(myKi);
    html += `<table class="ev-table"><tr><th>#</th><th>Keep</th><th>EV / hand</th><th>Draw</th><th>Solver plays</th></tr>`;
    rows.forEach((ki) => {
      const f = freqOf(ki);
      const tie = ki !== bestKi && evOf(bestKi) - evOf(ki) <= seDiffOf(ki);
      html += `<tr class="${ki === myKi ? 'chosen' : ''}${ki === bestKi ? ' best' : ''}" data-ki="${ki}"><td>${order.indexOf(ki) + 1}${ki === myKi ? ' <span class="tag-mini">you</span>' : ''}${tie ? ' <span class="tag-mini" title="Within the error bar of the best keep">tie</span>' : ''}</td><td class="keepcell"></td><td>${evText(evOf(ki), stake, seOf(ki))}</td><td>${DRAW_NAMES[KD[ki]]}</td><td>${f >= 0.005 ? `<span class="freq-bar" style="width:${Math.max(2, f * 70)}px"></span>${(f * 100).toFixed(0)}%` : '—'}</td></tr>`;
    });
    html += '</table>';
    // best per draw count
    html += `<p style="margin-top:10px"><strong>Best by draw count:</strong> ` + [0, 1, 2, 3].map((x) => {
      let b = -1;
      for (let ki = 0; ki < NK; ki++) if (KD[ki] === x && (b < 0 || evOf(ki) > evOf(b))) b = ki;
      return `${DRAW_NAMES[x]} ${evText(evOf(b), stake)}`;
    }).join(' · ') + '</p>';
    // hands like yours
    const sim = meObs.similar;
    if (sim) {
      const simMix = Array.isArray(sim.mix[0]) ? sim.mix[blockOf(ctxAnns)] : sim.mix;
      html += `<p style="margin-top:12px"><strong>Hands like yours</strong> <span class="hint-inline" style="color:var(--muted)">(the ${sim.n} sampled hands with the closest EV profile${pos > 0 ? `, after ${esc(ctxText(ctxAnns))}` : ''})</span> play:</p><div class="mix-row"><span>Equilibrium</span>${mixBar(simMix)}</div>`;
    }
    html += '</div>';

    // --- how the best keep shifts with the last announcement heard ---
    if (pos > 0) {
      const last = pos - 1, fixed = ctxAnns.slice(0, last);
      html += `<div class="study-section"><h4>How your best keep reacts to ${esc(nm(last))}'s announcement${fixed.length ? ` <span class="hint-inline" style="color:var(--muted)">(with ${esc(ctxText(fixed))})</span>` : ''}</h4><table class="ev-table"><tr><th>If ${esc(nm(last))}…</th><th>Best keep</th><th>EV / hand</th><th>Draw</th></tr>`;
      [0, 1, 2, 3].forEach((x) => {
        const anns = fixed.concat([x]), bo = blockOf(anns) * NK;
        let b = 0;
        for (let ki = 1; ki < NK; ki++) if (meObs.ev[bo + ki] > meObs.ev[bo + b]) b = ki;
        const isAct = actual && anns.every((d, i) => d === actual[i]);
        html += `<tr data-ki="${b}" class="${isAct ? 'chosen' : ''}"><td>${annLabel(x)}${isAct ? ' <span class="tag-mini">actual</span>' : ''}${ctxProb(anns) < 0.02 ? ' <span class="tag-mini" title="At equilibrium this announcement almost never happens, so these numbers lean on a small trembling-hand sample">rare</span>' : ''}</td><td class="keepcell"></td><td>${evText(meObs.ev[bo + b], stake)}</td><td>${DRAW_NAMES[KD[b]]}</td></tr>`;
      });
      html += '</table></div>';
    }

    // --- the flop's equilibrium ---
    if (n === 2) {
      const vO = sum.valueOop;
      html += `<div class="study-section"><h4>This flop's equilibrium</h4>
        <div class="stat-grid">
          <div class="stat"><div class="k">OOP value / hand</div><div class="v">${evText(vO, stake)}</div></div>
          <div class="stat"><div class="k">IP value / hand</div><div class="v">${evText(-vO, stake)}</div></div>
          <div class="stat"><div class="k">Avg gain from deviating</div><div class="v">${sum.exploitability.toFixed(3)} <span class="hint-inline" style="color:var(--muted)">stakes</span></div></div>
          <div class="stat"><div class="k">Sampled range</div><div class="v" style="font-size:.85rem">${sum.M.toLocaleString()} hands per seat · ${sum.groupsO} groups · ${sum.rounds} refinement rounds</div></div>
        </div>
        <p style="margin-top:12px"><strong>How often OOP announces each draw</strong> (across all hands it could hold here):</p>
        <div class="mix-row"><span>OOP</span>${mixBar(sum.oopDraw)}</div>
        <p style="margin-top:12px"><strong>How IP responds</strong> to each announcement:</p>
        ${[0, 1, 2, 3].map((x) => `<div class="mix-row"><span>OOP ${annLabel(x)} <span class="hint-inline" style="color:var(--muted)">IP ${units(sum.ipValueGiven[x])}</span></span>${mixBar(sum.ipDrawGiven[x])}</div>`).join('')}
        ${mixLegend()}
        <p class="hint" style="margin-top:8px">The number next to each announcement is IP's equilibrium EV after hearing it — the bigger it is, the more that announcement costs OOP.</p>
      </div>`;
    } else {
      const d0v = ctxAnns.length ? ctxAnns[0] : (h.keep[h.order[0]] ? h.drawn[h.order[0]].length : 0);
      html += `<div class="study-section"><h4>This flop's 3-handed equilibrium</h4>
        <div class="stat-grid">
          ${[0, 1, 2].map((p) => `<div class="stat"><div class="k">${G.seatLabel(3, p)} value / hand${h.order[p] === 'me' ? ' (you)' : ''}</div><div class="v">${evText(sum.values[p], stake, sum.valuesSe ? sum.valuesSe[p] : undefined)}</div></div>`).join('')}
          <div class="stat"><div class="k">Avg gain from deviating</div><div class="v">${sum.exploitability.toFixed(3)} <span class="hint-inline" style="color:var(--muted)">stakes</span></div></div>
          <div class="stat"><div class="k">Sampled range</div><div class="v" style="font-size:.85rem">${sum.M.toLocaleString()} hands per seat · ${sum.rounds} rounds</div></div>
        </div>
        <p style="margin-top:12px"><strong>How often the 1st player announces each draw:</strong></p>
        <div class="mix-row"><span>1st</span>${mixBar(sum.draw0)}</div>
        <p style="margin-top:12px"><strong>How the 2nd player responds</strong> to each announcement:</p>
        ${[0, 1, 2, 3].map((x) => `<div class="mix-row"><span>1st ${annLabel(x)}</span>${mixBar(sum.draw1Given[x])}</div>`).join('')}
        <p style="margin-top:12px"><strong>How the button responds</strong> when the 1st player ${annLabel(d0v)}:</p>
        ${[0, 1, 2, 3].map((x) => `<div class="mix-row"><span>2nd ${annLabel(x)}</span>${mixBar(sum.draw2Given[d0v * 4 + x])}</div>`).join('')}
        ${mixLegend()}
        <p class="hint" style="margin-top:8px">Seat values come from replaying the solved strategies against each other (± replay error) and sum to zero. They also carry the luck of which hands were sampled for each seat — roughly ±0.1 stakes on Fast, less on deeper settings — so small gaps between seats don't mean much.</p>
      </div>`;
    }

    // --- range viewer for this flop ---
    html += `<details class="rv-inline"${h.rvOpen ? ' open' : ''}><summary>🗺️ Range viewer for this flop</summary><div class="rv-host"></div></details>`;

    // --- the bots' play (only once their cards are visible) ---
    if (h.results) {
      for (const id of h.order) {
        if (id === 'me' || h.botKi[id] === undefined) continue;
        const botObs = res.observers.find((o) => o.id === id);
        const bp = h.order.indexOf(id), bAnns = handAnns(h, bp), bo = blockOf(bAnns) * NK;
        const bf = (ki) => botObs.freq[bo + ki], be = (ki) => botObs.ev[bo + ki], bse = (ki) => botObs.se[bo + ki];
        const mix = Array.from({ length: NK }, (_, i) => i).filter((ki) => bf(ki) >= 0.05).sort((a, b) => bf(b) - bf(a)).slice(0, 4);
        const heardTxt = bAnns.map((d, p) => (h.order[p] === 'me' ? `you ${annPast(d)}` : `${nm(p)} ${annPast(d)}`)).join(' and ');
        html += `<div class="study-section"><h4>${esc(playerName(id))}'s draw</h4><div class="bot-dealt" data-bot-dealt="${id}"><span class="discard-label">Dealt</span></div><p>${bp === 0 ? 'Acting first, it' : `After ${esc(heardTxt)}, it`} was choosing between:</p>
          <table class="ev-table"><tr><th>Keep</th><th>EV / hand</th><th>Draw</th><th>Mix</th></tr>
          ${mix.map((ki) => `<tr data-bot-ki="${ki}" data-bot-id="${id}" class="${ki === h.botKi[id] ? 'chosen' : ''}"><td class="keepcell"></td><td>${evText(be(ki), stake, bse(ki))}</td><td>${DRAW_NAMES[KD[ki]]}</td><td>${(bf(ki) * 100).toFixed(0)}%${ki === h.botKi[id] ? ' <span class="tag-mini">played</span>' : ''}</td></tr>`).join('')}
          </table></div>`;
      }
    }

    html += n === 2
      ? `<p class="study-foot">How this works: the solver deals ${sum.M.toLocaleString()} random hands to each seat on these two flops and races every keep of every hand over 100+ runouts to find its best keep at each draw count. It groups hands with similar EV profiles (${sum.groupsO} groups), solves the group game with CFR+ (OOP picks a draw count; IP sees it and picks its own), then lets every sampled hand re-optimize against the other side for ${sum.rounds} rounds. Your hand and the bot's are scored with all ${NK} keeps against ${sum.obs.toLocaleString()} opponent hands drawn from that solved range (per announcement, when in position); neither real hand is visible to the other side. EVs are stakes per hand (a contest = 1, a scoop = 6); ± is the sampling error of your hand's evaluation — re-solving with a fresh sample of hands moves EVs by roughly that much again on Deep, less on Max/Ultra. "Solver plays" is the best keep plus any keep statistically tied with it, which is also how the bot picks. "Avg gain from deviating" is how much a sampled hand could still gain by switching strategy — near zero means the solve has settled.</p>`
      : `<p class="study-foot">How this works: the solver deals ${sum.M.toLocaleString()} random hands to each of the three seats on these flops and races every keep of every hand over 100+ runouts. Starting from "everyone keeps their best made hand", the 1st player, the 2nd player and the button take turns re-scoring every keep against the other two seats' current play — the 2nd player against the 1st-seat hands that would have made the announcement it heard, the button against both — and nudging their strategy toward the best one, for ${sum.rounds} rounds (fictitious play; 3-player games have no single equilibrium, so this finds a stable approximate one). Your hand and the bots' are then scored with all ${NK} keeps against ${sum.obs.toLocaleString()} pairs of opponent hands per announcement, dealt together so card removal is exact. EVs are stakes per hand summed over your two matchups (a contest = 1, a scoop = 6); ± is sampling error. "Solver plays" is the best keep plus any keep statistically tied with it, which is also how the bots pick.</p>`;

    // Tables scroll sideways on narrow phones instead of crushing the card rows.
    html = html.replace(/<table class="ev-table">/g, '<div class="table-scroll"><table class="ev-table">').replace(/<\/table>/g, '</table></div>');
    body.innerHTML = html;
    body.querySelectorAll('tr[data-ki] .keepcell').forEach((td) => {
      const ki = Number(td.parentElement.dataset.ki);
      td.appendChild(miniCards(S.keepCards(h.cards.me, ki)));
    });
    body.querySelectorAll('[data-bot-dealt]').forEach((box) => {
      const id = box.dataset.botDealt;
      box.appendChild(miniCards(h.cards[id].filter((c) => h.keep[id].includes(c)).concat(h.cards[id].filter((c) => !h.keep[id].includes(c))), { highlight: h.keep[id] }));
    });
    body.querySelectorAll('tr[data-bot-ki] .keepcell').forEach((td) => {
      const tr = td.parentElement;
      td.appendChild(miniCards(S.keepCards(h.cards[tr.dataset.botId], Number(tr.dataset.botKi))));
    });
    body.querySelectorAll('.study-tab[data-d]').forEach((b) => b.addEventListener('click', () => {
      h.studyAnns[Number(b.dataset.p)] = Number(b.dataset.d);
      renderStudy();
    }));
    const rvHost = body.querySelector('.rv-host');
    if (rvHost && res.range && window.DDTrainer) {
      window.DDTrainer.renderRangeViewer(rvHost, res.range, { pos, anns: ctxAnns });
      const det = rvHost.closest('details');
      det.addEventListener('toggle', () => { h.rvOpen = det.open; });
    }
  }

  // Shared helpers for the training hub (public/trainer.js).
  window.DDUI = {
    el, show, hide, toggle, esc, money, units, cls, cardEl, miniCards, sortCards, bestFiveOrder,
    getSortMode: () => cardSortMode, DRAW_NAMES, evText, mixBar, mixLegend, keepIndexOf,
    gradeFor, GRADES, showGradeToastFor, playGradeSound, recordDecision, loadJSON, saveJSON,
    DECISIONS_KEY, MISTAKES_KEY, showScreen, normSpot, blockOf, annLabel, annPast, posClass, posChipHTML, positionBannerHTML,
    enterTrain: () => { if (practice) { window.SolverPool.cancel(); practice = null; } if (es) { es.close(); es = null; } mode = 'train'; },
    leaveTrain: () => { mode = null; },
    onSort: null, onDecision: null
  };

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
