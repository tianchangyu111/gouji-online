const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ============ GAME CONSTANTS ============
const RANK_NAMES = {3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A',15:'2',16:'小王',17:'大王'};
const TEAM_A = [0, 2, 4];
const TEAM_B = [1, 3, 5];
const PLAYER_LABELS = ['玩家①', '玩家②', '玩家③', '玩家④', '玩家⑤', '玩家⑥'];

// ============ ROOMS ============
const rooms = {}; // roomCode -> RoomState

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoom(hostSocketId, hostName) {
  let code;
  do { code = generateRoomCode(); } while (rooms[code]);
  rooms[code] = {
    code,
    players: [{ id: hostSocketId, name: hostName, seat: 0 }],
    hostId: hostSocketId,
    state: 'waiting', // waiting | playing
    game: null,
    cheatArmed: false,
  };
  return code;
}

// ============ CARD LOGIC ============
function createDeck() {
  let deck = [], id = 0;
  for (let d = 0; d < 4; d++) {
    for (let r = 3; r <= 14; r++) {
      for (let s = 0; s < 4; s++) {
        deck.push({ rank: r, suit: s, id: id++ });
      }
    }
    deck.push({ rank: 16, suit: -1, id: id++ });
    deck.push({ rank: 17, suit: -1, id: id++ });
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function sortHand(hand) {
  hand.sort((a, b) => (a.rank !== b.rank) ? b.rank - a.rank : a.suit - b.suit);
}

function deal(cheatSeat) {
  const deck = createDeck();
  shuffle(deck);
  const hands = [[], [], [], [], [], []];

  if (cheatSeat >= 0) {
    // Rigged deal for cheatSeat
    const good = deck.filter(c => c.rank >= 12);
    const normal = deck.filter(c => c.rank < 12);
    shuffle(good); shuffle(normal);
    const goodCount = 25 + Math.floor(Math.random() * 5);
    const myGood = good.splice(0, Math.min(goodCount, good.length));
    const myNormal = normal.splice(0, 36 - myGood.length);
    hands[cheatSeat] = [...myGood, ...myNormal];
    const remaining = [...good, ...normal];
    shuffle(remaining);
    let idx = 0;
    for (let i = 0; i < 6; i++) {
      if (i === cheatSeat) continue;
      hands[i] = remaining.slice(idx, idx + 36);
      idx += 36;
    }
  } else {
    for (let i = 0; i < 6; i++) {
      hands[i] = deck.slice(i * 36, (i + 1) * 36);
    }
  }

  hands.forEach(h => sortHand(h));
  return hands;
}

function analyzePlay(cards) {
  if (!cards || cards.length === 0) return null;
  const bigJ = cards.filter(c => c.rank === 17).length;
  const smallJ = cards.filter(c => c.rank === 16).length;
  const twos = cards.filter(c => c.rank === 15).length;
  const others = cards.filter(c => c.rank <= 14);

  if (others.length === 0 && twos === 0) {
    return { count: cards.length, baseRank: bigJ > 0 ? 17 : 16, hasJoker: true, jokerLevel: bigJ > 0 ? 17 : 16, bigJokers: bigJ, smallJokers: smallJ };
  }
  if (others.length === cards.length) {
    const r = others[0].rank;
    if (!others.every(c => c.rank === r)) return null;
    return { count: cards.length, baseRank: r, hasJoker: false };
  }
  if (twos === cards.length) {
    return { count: cards.length, baseRank: 15, hasJoker: false };
  }
  // with 2s but no jokers
  if ((bigJ + smallJ) === 0 && twos > 0 && others.length > 0) {
    const r = others[0].rank;
    if (!others.every(c => c.rank === r)) return null;
    return { count: cards.length, baseRank: r, hasJoker: false, has2: true };
  }
  // with jokers (挂花)
  if (bigJ > 0 || smallJ > 0) {
    const base = others.length > 0 ? others : cards.filter(c => c.rank === 15);
    if (base.length > 0) {
      const r = base[0].rank;
      if (!base.every(c => c.rank === r)) return null;
      return { count: cards.length, baseRank: r, hasJoker: true, jokerLevel: bigJ > 0 ? 17 : 16, bigJokers: bigJ, smallJokers: smallJ };
    }
    return { count: cards.length, baseRank: 15, hasJoker: true, jokerLevel: bigJ > 0 ? 17 : 16, bigJokers: bigJ, smallJokers: smallJ };
  }
  return null;
}

function isValidPlay(cards) { return analyzePlay(cards) !== null; }

function canBeat(cards, tableCards) {
  const a = analyzePlay(cards), t = analyzePlay(tableCards);
  if (!a || !t || a.count !== t.count) return false;
  if (a.hasJoker && t.hasJoker) {
    if (a.jokerLevel !== t.jokerLevel) return a.jokerLevel > t.jokerLevel;
    if (a.bigJokers !== undefined && t.bigJokers !== undefined) {
      if (a.bigJokers < t.bigJokers) return false;
    }
    return a.baseRank > t.baseRank;
  }
  if (a.hasJoker && !t.hasJoker) return true;
  if (!a.hasJoker && t.hasJoker) return false;
  return a.baseRank > t.baseRank;
}

function isGoujiPlay(cards) {
  const a = analyzePlay(cards);
  if (!a) return false;
  if (a.hasJoker) return true;
  const { count, baseRank } = a;
  if (baseRank === 10 && count >= 5) return true;
  if (baseRank === 11 && count >= 4) return true;
  if (baseRank === 12 && count >= 3) return true;
  if (baseRank === 13 && count >= 2) return true;
  if (baseRank === 14 && count >= 2) return true;
  if (baseRank === 15) return true;
  if (baseRank >= 16) return true;
  return false;
}

// ============ GAME STATE ============
function createGameState(hands, firstPlayer) {
  return {
    hands,
    finished: [false,false,false,false,false,false],
    rankings: [],
    currentPlayer: firstPlayer,
    tablePlay: null,
    passedThisRound: [],
    roundStarter: firstPlayer,
    isGoujiMode: false,
    goujiPair: [-1, -1],
    lastAction: null, // for display
    playerActions: [{},{},{},{},{},{}], // last action per player
  };
}

function getNextActiveAfter(game, player) {
  for (let i = 1; i <= 6; i++) {
    const p = (player + i) % 6;
    if (!game.finished[p] && !game.passedThisRound.includes(p)) return p;
  }
  return -1;
}

function processPlay(room, seat, cardIds) {
  const game = room.game;
  if (!game || game.currentPlayer !== seat) return { ok: false, msg: '不是你的回合' };
  if (game.finished[seat]) return { ok: false, msg: '你已经出完了' };

  const hand = game.hands[seat];
  const idSet = new Set(cardIds);
  const cards = hand.filter(c => idSet.has(c.id));
  if (cards.length !== cardIds.length) return { ok: false, msg: '无效的牌' };

  if (!isValidPlay(cards)) return { ok: false, msg: '无效出牌组合' };
  if (game.tablePlay && !canBeat(cards, game.tablePlay.cards)) return { ok: false, msg: '压不住！' };

  // Remove from hand
  game.hands[seat] = hand.filter(c => !idSet.has(c.id));
  const isGouji = isGoujiPlay(cards);
  game.tablePlay = { cards: [...cards], player: seat, isGouji };
  game.passedThisRound = [];
  game.roundStarter = seat;
  game.playerActions[seat] = { type: 'play', cards };

  // Check finish
  if (game.hands[seat].length === 0) {
    game.finished[seat] = true;
    game.rankings.push(seat);
  }

  const active = [0,1,2,3,4,5].filter(i => !game.finished[i]);
  if (active.length <= 1) {
    if (active.length === 1) game.rankings.push(active[0]);
    return { ok: true, gameOver: true };
  }

  // Gouji mode
  if (isGouji && !game.finished[seat]) {
    const duiTou = (seat + 3) % 6;
    if (!game.finished[duiTou]) {
      game.isGoujiMode = true;
      game.goujiPair = [seat, duiTou];
    }
  }

  // Next player
  if (game.finished[seat]) {
    if (game.isGoujiMode) {
      game.isGoujiMode = false;
      let next = game.goujiPair[1];
      if (game.finished[next]) next = getNextActiveAfter(game, seat);
      return newRound(game, next === -1 ? active[0] : next);
    } else {
      const next = getNextActiveAfter(game, seat);
      return newRound(game, next === -1 ? active[0] : next);
    }
  }

  if (game.isGoujiMode) {
    game.currentPlayer = game.goujiPair[1];
  } else {
    game.currentPlayer = getNextActiveAfter(game, seat);
    if (game.currentPlayer === -1) return newRound(game, seat);
  }

  return { ok: true };
}

function processPass(room, seat) {
  const game = room.game;
  if (!game || game.currentPlayer !== seat) return { ok: false, msg: '不是你的回合' };

  game.passedThisRound.push(seat);
  game.playerActions[seat] = { type: 'pass' };

  if (game.isGoujiMode && seat === game.goujiPair[1]) {
    game.isGoujiMode = false;
    return newRound(game, game.goujiPair[0]);
  }

  const active = [0,1,2,3,4,5].filter(i => !game.finished[i]);
  const canStill = active.filter(p => !game.passedThisRound.includes(p) && p !== game.tablePlay?.player);

  if (canStill.length === 0) {
    const starter = game.tablePlay ? game.tablePlay.player : game.roundStarter;
    return newRound(game, game.finished[starter] ? active[0] : starter);
  }

  let next = getNextActiveAfter(game, seat);
  if (next === game.tablePlay?.player) {
    return newRound(game, next);
  }
  if (next === -1) {
    const starter = game.tablePlay ? game.tablePlay.player : active[0];
    return newRound(game, game.finished[starter] ? active[0] : starter);
  }

  game.currentPlayer = next;
  return { ok: true };
}

function newRound(game, starter) {
  game.tablePlay = null;
  game.passedThisRound = [];
  game.isGoujiMode = false;
  game.goujiPair = [-1, -1];
  game.currentPlayer = starter;
  game.playerActions = [{},{},{},{},{},{}];
  return { ok: true, newRound: true };
}

// Build state snapshot for a specific player (hide others' cards)
function getStateForPlayer(room, seat) {
  const game = room.game;
  if (!game) return null;
  const state = {
    myHand: game.hands[seat],
    mySeat: seat,
    handCounts: game.hands.map(h => h.length),
    finished: game.finished,
    rankings: game.rankings,
    currentPlayer: game.currentPlayer,
    tablePlay: game.tablePlay,
    isGoujiMode: game.isGoujiMode,
    goujiPair: game.goujiPair,
    playerActions: game.playerActions,
    players: room.players.map(p => ({ name: p.name, seat: p.seat })),
    isHost: room.hostId === room.players.find(pp => pp.seat === seat)?.id,
  };
  return state;
}

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentSeat = -1;

  socket.on('create_room', ({ name }) => {
    const code = createRoom(socket.id, name || '房主');
    currentRoom = code;
    currentSeat = 0;
    socket.join(code);
    socket.emit('room_joined', { code, seat: 0, players: rooms[code].players.map(p => ({ name: p.name, seat: p.seat })) });
    console.log(`Room ${code} created by ${name}`);
  });

  socket.on('join_room', ({ code, name }) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) return socket.emit('error_msg', { msg: '房间不存在！' });
    if (room.state === 'playing') return socket.emit('error_msg', { msg: '游戏已开始！' });
    if (room.players.length >= 6) return socket.emit('error_msg', { msg: '房间已满！' });

    const seat = room.players.length;
    room.players.push({ id: socket.id, name: name || ('玩家' + (seat + 1)), seat });
    currentRoom = code.toUpperCase();
    currentSeat = seat;
    socket.join(currentRoom);

    const playerList = room.players.map(p => ({ name: p.name, seat: p.seat }));
    socket.emit('room_joined', { code: currentRoom, seat, players: playerList });
    io.to(currentRoom).emit('player_list', { players: playerList });
    console.log(`${name} joined room ${currentRoom} as seat ${seat}`);
  });

  socket.on('start_game', () => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('error_msg', { msg: '只有房主可以开始游戏' });
    if (room.players.length < 6) return socket.emit('error_msg', { msg: '需要6人才能开始！当前' + room.players.length + '人' });

    const cheatSeat = room.cheatArmed ? room.players.find(p => p.id === room.hostId)?.seat ?? -1 : -1;
    const hands = deal(cheatSeat);
    const firstPlayer = cheatSeat >= 0 ? cheatSeat : Math.floor(Math.random() * 6);
    room.game = createGameState(hands, firstPlayer);
    room.state = 'playing';
    room.cheatArmed = false;

    // Send each player their own view
    room.players.forEach(p => {
      io.to(p.id).emit('game_state', getStateForPlayer(room, p.seat));
    });
    console.log(`Game started in room ${currentRoom}`);
  });

  socket.on('play_cards', ({ cardIds }) => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const result = processPlay(room, currentSeat, cardIds);
    if (!result.ok) return socket.emit('error_msg', { msg: result.msg });

    if (result.gameOver) {
      room.state = 'gameover';
      room.players.forEach(p => {
        io.to(p.id).emit('game_over', {
          rankings: room.game.rankings,
          players: room.players.map(pp => ({ name: pp.name, seat: pp.seat })),
        });
      });
    } else {
      room.players.forEach(p => {
        io.to(p.id).emit('game_state', getStateForPlayer(room, p.seat));
      });
    }
  });

  socket.on('pass', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const result = processPass(room, currentSeat);
    if (!result.ok) return socket.emit('error_msg', { msg: result.msg });

    room.players.forEach(p => {
      io.to(p.id).emit('game_state', getStateForPlayer(room, p.seat));
    });
  });

  socket.on('cheat_toggle', () => {
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id) return;
    room.cheatArmed = !room.cheatArmed;
    socket.emit('cheat_status', { armed: room.cheatArmed });
  });

  socket.on('restart_game', () => {
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id) return;
    room.state = 'waiting';
    room.game = null;
    const playerList = room.players.map(p => ({ name: p.name, seat: p.seat }));
    io.to(currentRoom).emit('back_to_lobby', { players: playerList });
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      delete rooms[currentRoom];
      console.log(`Room ${currentRoom} deleted`);
    } else {
      // Reassign host if needed
      if (room.hostId === socket.id) {
        room.hostId = room.players[0].id;
      }
      const playerList = room.players.map(p => ({ name: p.name, seat: p.seat }));
      io.to(currentRoom).emit('player_list', { players: playerList });
      if (room.state === 'playing') {
        io.to(currentRoom).emit('player_disconnected', { seat: currentSeat, name: '玩家' });
      }
    }
    console.log(`Player disconnected from room ${currentRoom}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🀄 够级服务器已启动！`);
  console.log(`   本机访问: http://localhost:${PORT}`);
  // Show local IP
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`   局域网访问: http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(`\n   朋友们用手机浏览器打开上面的地址即可加入！\n`);
});
