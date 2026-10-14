// server.js — zero-dependency Node HTTP server for Drawmaha Duel (no express/socket.io).
// Real-time push via Server-Sent Events; client actions via POST /api/*.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const G = require('./lib/game.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const LIB_DIR = path.join(__dirname, 'lib');
// Shared rule/evaluator/solver code is UMD and served straight to the browser, so the
// client scores and solves with exactly the same code as the server.
const SHARED_LIB = new Set(['poker.js', 'game.js', 'fasteval.js', 'solver.js']);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
const STAKE_OPTIONS = [1, 5, 10, 25, 50, 100, 200, 500, 1000];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/**
 * In-memory room store (rooms vanish on restart — fine for a casual game). Shape:
 * rooms[code] = {
 *   code, stake, handSize (7–10 cards dealt), phase: 'lobby'|'drawing'|'results', hostId, handNumber,
 *   players: [{ id, token, name, sseRes, connected, hand, keep, drawn }],
 *   buttonId,            // player in position this hand (alternates every hand)
 *   acting: 'oop'|'ip',  // who must draw next while phase === 'drawing'
 *   deck, flopA, flopB, boardA, boardB,
 *   announce: { [playerId]: { discards, draws } },  // public once a player has drawn
 *   cumulative: { [playerId]: dollars }, history: [...], lastResults
 * }
 */
const rooms = new Map();

function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const oopId = (room) => room.players.find((p) => p.id !== room.buttonId).id;
const ipId = (room) => room.buttonId;
const findPlayer = (room, id) => room.players.find((p) => p.id === id);

function publicRoomState(room) {
  const drawing = room.phase === 'drawing' || room.phase === 'results';
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    handNumber: room.handNumber,
    stake: room.stake,
    handSize: room.handSize,
    players: room.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
    cumulative: room.cumulative,
    oopId: drawing ? oopId(room) : null,
    ipId: drawing ? ipId(room) : null,
    acting: room.phase === 'drawing' ? room.acting : null,
    flopA: drawing ? room.flopA : null,
    flopB: drawing ? room.flopB : null,
    announce: room.announce,
    history: room.history
  };
}

function sendEvent(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) { /* connection may already be closed */ }
}
function broadcast(room, event, data) {
  for (const p of room.players) if (p.sseRes) sendEvent(p.sseRes, event, data);
}
function sendTo(player, event, data) {
  if (player.sseRes) sendEvent(player.sseRes, event, data);
}
function broadcastState(room) {
  broadcast(room, 'room_state', publicRoomState(room));
}
function privateHand(p) {
  return { hand: p.hand, keep: p.keep, drawn: p.drawn };
}

function dealNewHand(room) {
  room.handNumber += 1;
  // Button alternates every hand; the very first button is random.
  if (!room.buttonId) room.buttonId = room.players[Math.random() < 0.5 ? 0 : 1].id;
  else room.buttonId = room.players.find((p) => p.id !== room.buttonId).id;
  const { deck, flopA, flopB, hands } = G.dealHand(room.players.map((p) => p.id), room.handSize);
  Object.assign(room, { deck, flopA, flopB, boardA: null, boardB: null, phase: 'drawing', acting: 'oop', announce: {}, lastResults: null });
  for (const p of room.players) {
    p.hand = hands[p.id];
    p.keep = null;
    p.drawn = null;
    sendTo(p, 'your_hand', privateHand(p));
  }
  broadcastState(room);
}

function finishHand(room) {
  room.boardA = [...room.flopA, ...room.deck.splice(0, 2)];
  room.boardB = [...room.flopB, ...room.deck.splice(0, 2)];
  const o = findPlayer(room, oopId(room)), i = findPlayer(room, ipId(room));
  const finalOf = (p) => [...p.keep, ...p.drawn];
  const res = G.scoreShowdown(o.id, finalOf(o), i.id, finalOf(i), room.boardA, room.boardB);
  const dollars = {};
  for (const p of room.players) {
    dollars[p.id] = res.units[p.id] * room.stake;
    room.cumulative[p.id] = (room.cumulative[p.id] || 0) + dollars[p.id];
  }
  room.phase = 'results';
  room.lastResults = {
    handNumber: room.handNumber,
    stake: room.stake,
    handSize: room.handSize,
    boardA: room.boardA,
    boardB: room.boardB,
    oopId: o.id,
    ipId: i.id,
    players: [o, i].map((p) => ({
      id: p.id, name: p.name, kept: p.keep, drawn: p.drawn, final: finalOf(p),
      // Discards are shown at showdown (after the hand they give nothing away, and
      // seeing them is how you learn what the other player was thinking).
      discarded: p.hand.filter((c) => !p.keep.includes(c)),
      discards: G.discardCount(p.keep.length, room.handSize), draws: p.drawn.length
    })),
    evals: res.evals,
    contests: res.contests,
    scoop: res.scoop,
    units: res.units,
    dollars,
    cumulative: { ...room.cumulative }
  };
  room.history.push({ handNumber: room.handNumber, dollars, scoop: res.scoop });
  if (room.history.length > 50) room.history.shift();
  broadcast(room, 'results', room.lastResults);
  broadcastState(room);
}

function handleDisconnect(room, player) {
  if (!player) return;
  player.connected = false;
  player.sseRes = null;
  broadcastState(room);
  setTimeout(() => {
    const stillThere = rooms.get(room.code);
    if (stillThere && stillThere.players.every((p) => !p.connected)) rooms.delete(room.code);
  }, 10 * 60 * 1000);
}

// ---------------- HTTP plumbing ----------------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e5) { reject(new Error('Payload too large')); req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function authPlayer(body) {
  const room = rooms.get(String(body.code || '').toUpperCase());
  if (!room) return { error: 'Room not found.' };
  const player = room.players.find((p) => p.id === body.playerId && p.token === body.token);
  if (!player) return { error: 'Not authorized for this room.' };
  return { room, player };
}

function newPlayer(name) {
  return { id: crypto.randomUUID(), token: crypto.randomUUID(), name, sseRes: null, connected: false, hand: null, keep: null, drawn: null };
}

const API_HANDLERS = {
  '/api/create_room': (body) => {
    const name = String(body.name || 'Host').trim().slice(0, 20) || 'Host';
    const stake = STAKE_OPTIONS.includes(Number(body.stake)) ? Number(body.stake) : 100;
    const handSize = G.HAND_SIZES.includes(Number(body.handSize)) ? Number(body.handSize) : G.HAND_SIZE;
    const host = newPlayer(name);
    const code = makeRoomCode();
    rooms.set(code, {
      code, stake, handSize, phase: 'lobby', hostId: host.id, handNumber: 0,
      players: [host], buttonId: null, acting: null,
      deck: null, flopA: null, flopB: null, boardA: null, boardB: null,
      announce: {}, cumulative: { [host.id]: 0 }, history: [], lastResults: null
    });
    return { ok: true, code, playerId: host.id, token: host.token };
  },

  '/api/join_room': (body) => {
    const room = rooms.get(String(body.code || '').toUpperCase());
    if (!room) return { ok: false, error: 'Room not found.' };
    if (room.phase !== 'lobby') return { ok: false, error: 'That game has already started.' };
    if (room.players.length >= 2) return { ok: false, error: 'Room is full — Drawmaha Duel is heads-up only.' };
    const name = String(body.name || 'Player').trim().slice(0, 20) || 'Player';
    const p = newPlayer(name);
    room.players.push(p);
    room.cumulative[p.id] = 0;
    broadcastState(room);
    return { ok: true, code: room.code, playerId: p.id, token: p.token };
  },

  '/api/start_game': (body) => {
    const { room, error, player } = authPlayer(body);
    if (error) return { ok: false, error };
    if (player.id !== room.hostId) return { ok: false, error: 'Only the host can start the game.' };
    if (room.players.length < 2) return { ok: false, error: 'Waiting for an opponent to join.' };
    if (room.phase !== 'lobby') return { ok: false, error: 'Game already started.' };
    dealNewHand(room);
    return { ok: true };
  },

  // Submit your keep. OOP must act first; the number of cards they draw becomes public
  // the moment they do, and only then may IP act.
  '/api/draw': (body) => {
    const { room, error, player } = authPlayer(body);
    if (error) return { ok: false, error };
    if (room.phase !== 'drawing') return { ok: false, error: 'Not in the draw phase.' };
    const seat = player.id === oopId(room) ? 'oop' : 'ip';
    if (player.keep) return { ok: false, error: 'You already drew this hand.' };
    if (seat !== room.acting) return { ok: false, error: 'Wait for the player out of position to announce first.' };
    const err = G.validateKeep(player.hand, body.keep);
    if (err) return { ok: false, error: err };
    // Keep in dealt order so the hand reads the way the player saw it.
    player.keep = player.hand.filter((c) => body.keep.includes(c));
    player.drawn = room.deck.splice(0, G.drawCount(player.keep.length));
    room.announce[player.id] = { discards: G.discardCount(player.keep.length, room.handSize), draws: player.drawn.length };
    sendTo(player, 'your_hand', privateHand(player));
    if (seat === 'oop') {
      room.acting = 'ip';
      broadcastState(room);
    } else {
      finishHand(room);
    }
    return { ok: true };
  },

  // Heads-up, so either player may deal the next hand once results are in.
  '/api/next_hand': (body) => {
    const { room, error } = authPlayer(body);
    if (error) return { ok: false, error };
    if (room.phase !== 'results') return { ok: false, error: 'Not ready for the next hand.' };
    if (room.players.length < 2) return { ok: false, error: 'Your opponent left.' };
    dealNewHand(room);
    return { ok: true };
  }
};

function handleStream(req, res, parsedUrl) {
  const code = String(parsedUrl.searchParams.get('code') || '').toUpperCase();
  const playerId = parsedUrl.searchParams.get('playerId');
  const token = parsedUrl.searchParams.get('token');
  const room = rooms.get(code);
  if (!room) { res.writeHead(404); res.end('Room not found'); return; }
  const player = findPlayer(room, playerId);
  if (!player || player.token !== token) { res.writeHead(403); res.end('Not authorized'); return; }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('\n');

  player.sseRes = res;
  player.connected = true;
  broadcastState(room);

  // Initial snapshot for this connection (also how a refresh/reconnect resumes).
  sendEvent(res, 'room_state', publicRoomState(room));
  if (room.phase === 'drawing' && player.hand) sendEvent(res, 'your_hand', privateHand(player));
  if (room.phase === 'results' && room.lastResults) sendEvent(res, 'results', room.lastResults);

  const ping = setInterval(() => {
    try { res.write(':ping\n\n'); } catch (_) { clearInterval(ping); }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    if (player.sseRes === res) handleDisconnect(room, player);
  });
}

function serveFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(500); res.end('Server error'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  serveFile(filePath, res);
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/stream' && req.method === 'GET') {
    handleStream(req, res, parsedUrl);
    return;
  }

  if (pathname.startsWith('/lib/') && req.method === 'GET') {
    const name = pathname.slice(5);
    if (!SHARED_LIB.has(name)) { res.writeHead(404); res.end('Not found'); return; }
    serveFile(path.join(LIB_DIR, name), res);
    return;
  }

  if (pathname.startsWith('/api/') && req.method === 'POST') {
    const handler = API_HANDLERS[pathname];
    if (!handler) { json(res, 404, { ok: false, error: 'Unknown endpoint.' }); return; }
    readJsonBody(req)
      .then((body) => {
        let result;
        try {
          result = handler(body);
        } catch (e) {
          console.error(e);
          result = { ok: false, error: 'Server error.' };
        }
        json(res, 200, result);
      })
      .catch(() => json(res, 400, { ok: false, error: 'Malformed request.' }));
    return;
  }

  if (req.method === 'GET') {
    serveStatic(pathname, res);
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Drawmaha Duel listening on http://localhost:${PORT}`);
  });
}

module.exports = { server, rooms };
