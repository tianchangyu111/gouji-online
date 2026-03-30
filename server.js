const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

function findFirstExisting(paths) {
  for (const p of paths) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

function sendCustomJoker(res, name) {
  const candidates = [
    path.join(__dirname, 'public', 'assets', `${name}.jpg`),
    path.join(__dirname, 'public', 'assets', `${name}.jpeg`),
    path.join(__dirname, 'public', 'assets', `${name}.png`),
    path.join(__dirname, `publicassets${name}.jpg`),
    path.join(__dirname, `publicassets${name}.jpeg`),
    path.join(__dirname, `publicassets${name}.png`),
    path.join(__dirname, 'public', `${name}.jpg`),
    path.join(__dirname, 'public', `${name}.jpeg`),
    path.join(__dirname, 'public', `${name}.png`),
    path.join(__dirname, `${name}.jpg`),
    path.join(__dirname, `${name}.jpeg`),
    path.join(__dirname, `${name}.png`),
  ];
  const found = findFirstExisting(candidates);
  if (!found) return res.status(404).end();
  return res.sendFile(found);
}

app.get('/joker-big-custom', (req, res) => sendCustomJoker(res, 'joker-big'));
app.get('/joker-small-custom', (req, res) => sendCustomJoker(res, 'joker-small'));

app.use(express.static(path.join(__dirname, 'public')));

// ============ CONSTANTS ============
const TEAM_A = [0, 2, 4];
const TEAM_B = [1, 3, 5];

const rooms = {}; // roomCode -> room data

function getSeatPlayerName(room, seat) {
  return room?.players?.find(p => p.seat === seat)?.name || ('座位' + (seat + 1));
}

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
    players: [{ id: hostSocketId, name: hostName || '房主', seat: 0 }],
    hostId: hostSocketId,
    state: 'waiting',
    game: null,
    cheatArmed: false,
    nextRoundNumber: 1,
    pendingTribute: null,
    turnTimer: null,
    burnTributeDebt: [0,0,0,0,0,0],
    menTributeDebt: [0,0,0,0,0,0],
    dianTributeDebt: [0,0,0,0,0,0],
    dianSkipStreak: [0,0,0,0,0,0],
    forceKaiDianNextRound: [false,false,false,false,false,false],
    forceKaiDianThisRound: [false,false,false,false,false,false],
  };
  return code;
}

// ============ CARD HELPERS ============
function createDeck(deckCount = 6) {
  const deck = [];
  let id = 0;
  for (let d = 0; d < deckCount; d++) {
    for (let r = 3; r <= 15; r++) {
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

function cloneCard(card) {
  return { rank: card.rank, suit: card.suit, id: card.id };
}

function countRank(hand, rank) {
  return hand.filter(c => c.rank === rank).length;
}

function getCardsByRank(hand, rank) {
  return hand.filter(c => c.rank === rank);
}

function takeCardsByIds(hand, ids) {
  const set = new Set(ids);
  return hand.filter(c => set.has(c.id));
}

function removeCardsByIds(hand, ids) {
  const set = new Set(ids);
  return hand.filter(c => !set.has(c.id));
}

function removeSpecificCards(hand, cardsToRemove) {
  const ids = new Set(cardsToRemove.map(c => c.id));
  return hand.filter(c => !ids.has(c.id));
}

function pushCards(hand, cards) {
  hand.push(...cards.map(cloneCard));
  sortHand(hand);
}

function cardText(card) {
  return {
    3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A',15:'2',16:'小王',17:'大王'
  }[card.rank] || String(card.rank);
}


function getNaojiLimit(name) {
  const vip = new Set(['李勇', '司马志邦', '范心钰']);
  return vip.has((name || '').trim()) ? 10 : 5;
}


function getLuckyBoostSeat(players = []) {
  const me = players.find(p => (p?.name || '').trim() === '梁金');
  return me ? me.seat : -1;
}

function getTeamSeats(seat) {
  return TEAM_A.includes(seat) ? TEAM_A.slice() : TEAM_B.slice();
}

function getRemainingTeammateSeats(game, seat) {
  return getTeamSeats(seat).filter(s => s !== seat && !game.finished[s]);
}

function pruneGrabClicks(game, now = Date.now()) {
  game.recentGrabClicks = (game.recentGrabClicks || []).filter(item => now - item.time <= 2200);
  game.activeNaojiWindows = (game.activeNaojiWindows || []).filter(item => item.expiresAt > now);
}

function getPenaltyCardAboveTwo(hand) {
  return [...hand]
    .filter(c => c.rank >= 15)
    .sort((a, b) => (a.rank !== b.rank) ? a.rank - b.rank : a.suit - b.suit)[0] || null;
}

function buildNaojiCandidates(game, seat) {
  const candidates = [];
  for (let s = 0; s < 6; s++) {
    if (s === seat) continue;
    for (const card of game.hands[s]) {
      candidates.push({ source: 'hand', fromSeat: s, card: cloneCard(card) });
    }
  }
  for (const card of game.playedPool || []) {
    candidates.push({ source: 'pool', fromSeat: -1, card: cloneCard(card) });
  }
  const preferred = candidates.filter(item => item.card.rank >= 10);
  return preferred.length ? preferred : candidates;
}

function removeOneCardById(cards, id) {
  let removed = null;
  const kept = [];
  for (const c of cards) {
    if (!removed && c.id === id) removed = c;
    else kept.push(c);
  }
  return { removed, kept };
}

function applyNaojiPenalty(room, fromSeat, toSeat) {
  const game = room.game;
  if (!game || fromSeat === toSeat) return { ok: false, msg: '无效抓取' };
  const pay = getPenaltyCardAboveTwo(game.hands[fromSeat]);
  if (!pay) {
    return { ok: false, msg: `${room.players.find(p => p.seat === fromSeat)?.name || ('座位' + (fromSeat+1))}没有2以上的牌可赔` };
  }
  game.hands[fromSeat] = removeSpecificCards(game.hands[fromSeat], [pay]);
  pushCards(game.hands[toSeat], [pay]);
  sortHand(game.hands[fromSeat]);
  sortHand(game.hands[toSeat]);
  maybeFinishPlayer(game, fromSeat);
  stabilizeCurrentPlayer(game);
  return { ok: true, card: pay };
}


function chooseTimeoutLeadIds(game, seat) {
  const hand = [...game.hands[seat]].sort((a, b) => (a.rank !== b.rank) ? a.rank - b.rank : a.suit - b.suit);
  const non34 = hand.filter(c => c.rank !== 3 && c.rank !== 4);
  if (non34.length > 0) return [non34[0].id];

  const threes = hand.filter(c => c.rank === 3);
  if (threes.length > 0 && threes.length === hand.length) {
    const check = canPlayFinalThree(game, seat, threes, []);
    if (check.ok) return threes.map(c => c.id);
  }
  return [];
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (room.game) room.game.turnEndsAt = 0;
}

function scheduleTurnTimer(room) {
  clearTurnTimer(room);
  if (!room || !room.game || room.state !== 'playing') return;
  const game = room.game;
  if (game.currentPlayer < 0 || game.finished[game.currentPlayer]) return;
  game.turnEndsAt = Date.now() + 10000;
  room.turnTimer = setTimeout(() => handleTurnTimeout(room), 10050);
}

function handleTurnTimeout(room) {
  if (!room || !room.game || room.state !== 'playing') return;
  const game = room.game;
  const seat = game.currentPlayer;
  const playerName = room.players.find(p => p.seat === seat)?.name || ('座位' + (seat + 1));
  let result = null;

  if (game.canKaiDian === seat || game.tablePlay) {
    result = processPass(room, seat);
    io.to(room.code).emit('toast_msg', { msg: `${playerName} 超时，自动过牌` });
  } else {
    const autoIds = chooseTimeoutLeadIds(game, seat);
    if (autoIds.length > 0) {
      result = processPlay(room, seat, autoIds);
      io.to(room.code).emit('toast_msg', { msg: `${playerName} 超时，已自动出牌` });
    } else {
      const next = nextActiveSeat(game, seat);
      game.playerActions[seat] = { type: 'timeout' };
      if (next >= 0 && next !== seat) game.currentPlayer = next;
      result = { ok: true };
      io.to(room.code).emit('toast_msg', { msg: `${playerName} 超时，跳过本轮领牌` });
    }
  }

  if (!result || !result.ok) {
    scheduleTurnTimer(room);
    return;
  }
  if (result.gameOver || maybeGameOver(game)) {
    finishGame(room);
    return;
  }
  broadcastState(room);
  scheduleTurnTimer(room);
}

function processNaoji(room, seat) {
  const game = room.game;
  if (!game || room.state !== 'playing') return { ok: false, msg: '游戏未开始' };
  if (game.finished[seat]) return { ok: false, msg: '你已经出完，不能再孬急' };
  if ((game.naojiUses[seat] || 0) >= (game.naojiMax[seat] || 5)) return { ok: false, msg: '孬急次数已用完' };

  pruneGrabClicks(game);
  const candidates = buildNaojiCandidates(game, seat);
  if (!candidates.length) return { ok: false, msg: '没有可抽的牌' };

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  let got = null;
  let sourceName = '已出牌区';

  if (pick.source === 'hand') {
    const fromSeat = pick.fromSeat;
    const res = removeOneCardById(game.hands[fromSeat], pick.card.id);
    if (!res.removed) return { ok: false, msg: '抽牌失败，请重试' };
    game.hands[fromSeat] = res.kept;
    got = res.removed;
    sourceName = room.players.find(p => p.seat === fromSeat)?.name || ('座位' + (fromSeat + 1));
    maybeFinishPlayer(game, fromSeat);
    stabilizeCurrentPlayer(game);
  } else {
    const res = removeOneCardById(game.playedPool, pick.card.id);
    if (!res.removed) return { ok: false, msg: '牌堆已变更，请重试' };
    game.playedPool = res.kept;
    got = res.removed;
  }

  pushCards(game.hands[seat], [got]);
  sortHand(game.hands[seat]);
  game.naojiUses[seat] = (game.naojiUses[seat] || 0) + 1;

  const now = Date.now();
  const window = {
    id: ++game.naojiWindowSeq,
    type: 'naoji',
    seat,
    startAt: now,
    expiresAt: now + 2000,
    paidTo: [],
  };

  const uniqueRecentGrabbers = [...new Set((game.recentGrabClicks || [])
    .filter(item => now - item.time <= 2000 && item.seat !== seat)
    .map(item => item.seat))];

  const penaltyLogs = [];
  for (const gSeat of uniqueRecentGrabbers) {
    const payRes = applyNaojiPenalty(room, seat, gSeat);
    window.paidTo.push(gSeat);
    penaltyLogs.push({ target: gSeat, ...payRes });
  }

  game.activeNaojiWindows.push(window);
  return {
    ok: true,
    source: pick.source,
    fromSeat: pick.fromSeat,
    card: got,
    sourceName,
    penalties: penaltyLogs,
  };
}

function processGrab(room, seat) {
  const game = room.game;
  if (!game || room.state !== 'playing') return { ok: false, msg: '游戏未开始' };
  if (game.finished[seat]) return { ok: false, msg: '你已经出完，不能再抓' };

  const now = Date.now();
  pruneGrabClicks(game, now);
  game.recentGrabClicks.push({ seat, time: now });

  const results = [];
  for (const window of game.activeNaojiWindows) {
    if (seat === window.seat) continue;
    if (now > window.expiresAt || now < window.startAt - 2000) continue;
    if (window.paidTo.includes(seat)) continue;
    const payRes = applyNaojiPenalty(room, window.seat, seat);
    window.paidTo.push(seat);
    results.push({ fromSeat: window.seat, toSeat: seat, windowType: window.type || 'naoji', ...payRes });
  }

  return { ok: true, results };
}

function processPeek(room, seat) {
  const game = room.game;
  if (!game || room.state !== 'playing') return { ok: false, msg: '游戏未开始' };
  const me = room.players.find(p => p.seat === seat);
  if ((me?.name || '').trim() !== '张哲') return { ok: false, msg: '只有张哲可以使用验牌' };
  if (game.finished[seat]) return { ok: false, msg: '你已经出完了，不能再验牌' };
  if (game.currentPlayer === seat) return { ok: false, msg: '自己的回合不能验牌' };
  if ((game.peekUses?.[seat] || 0) >= (game.peekMax?.[seat] || 0)) return { ok: false, msg: '验牌次数已用完' };

  game.peekUses[seat] = (game.peekUses[seat] || 0) + 1;
  const leftSeat = (seat + 5) % 6;
  const rightSeat = (seat + 1) % 6;

  pruneGrabClicks(game);
  const now = Date.now();
  const window = {
    id: ++game.naojiWindowSeq,
    type: 'peek',
    seat,
    startAt: now,
    expiresAt: now + 2000,
    paidTo: [],
  };

  const uniqueRecentGrabbers = [...new Set((game.recentGrabClicks || [])
    .filter(item => now - item.time <= 2000 && item.seat !== seat)
    .map(item => item.seat))];

  const penaltyLogs = [];
  for (const gSeat of uniqueRecentGrabbers) {
    const payRes = applyNaojiPenalty(room, seat, gSeat);
    window.paidTo.push(gSeat);
    penaltyLogs.push({ target: gSeat, ...payRes });
  }

  game.activeNaojiWindows.push(window);

  return {
    ok: true,
    penalties: penaltyLogs,
    uses: game.peekUses[seat],
    max: game.peekMax[seat],
    expiresAt: now + 3000,
    sides: [
      {
        seat: leftSeat,
        side: '左侧',
        name: getSeatPlayerName(room, leftSeat),
        cards: game.hands[leftSeat].map(cloneCard),
      },
      {
        seat: rightSeat,
        side: '右侧',
        name: getSeatPlayerName(room, rightSeat),
        cards: game.hands[rightSeat].map(cloneCard),
      },
    ],
  };
}


function processStrategistView(room, seat) {
  const game = room.game;
  if (!game || room.state !== 'playing') return { ok: false, msg: '游戏未开始' };
  const me = room.players.find(p => p.seat === seat);
  if ((me?.name || '').trim() !== '陈杰') return { ok: false, msg: '只有陈杰可以使用狗头军师' };
  if (!game.finished[seat]) return { ok: false, msg: '只有走了之后才能发动狗头军师' };
  const mateSeats = getRemainingTeammateSeats(game, seat);
  if (!mateSeats.length) return { ok: false, msg: '当前没有剩余队友可查看' };
  return {
    ok: true,
    teammates: mateSeats.map(s => ({
      seat: s,
      name: getSeatPlayerName(room, s),
      cards: game.hands[s].map(cloneCard),
    })),
  };
}

// ============ DEAL ============

function applyLuckyBuff(hands, luckySeat) {
  if (luckySeat < 0 || !hands[luckySeat]) return;
  const isHigh = c => c.rank >= 10;
  const rate = 0.10 + Math.random() * 0.05;
  const targetExtra = Math.max(1, Math.round(54 * rate));
  const donorSeats = [0,1,2,3,4,5].filter(s => s !== luckySeat);
  let upgrades = 0;
  while (upgrades < targetExtra) {
    const myLow = hands[luckySeat].filter(c => c.rank < 10).sort((a, b) => (a.rank !== b.rank) ? a.rank - b.rank : a.suit - b.suit);
    if (!myLow.length) break;
    donorSeats.sort((a, b) => hands[b].filter(isHigh).length - hands[a].filter(isHigh).length);
    let donor = -1;
    let donorHigh = null;
    for (const s of donorSeats) {
      const highs = hands[s].filter(isHigh).sort((a, b) => (a.rank !== b.rank) ? a.rank - b.rank : a.suit - b.suit);
      if (highs.length) {
        donor = s;
        donorHigh = highs[0];
        break;
      }
    }
    if (donor === -1 || !donorHigh) break;
    const myLowCard = myLow[0];
    hands[luckySeat] = removeSpecificCards(hands[luckySeat], [myLowCard]);
    hands[donor] = removeSpecificCards(hands[donor], [donorHigh]);
    pushCards(hands[luckySeat], [donorHigh]);
    pushCards(hands[donor], [myLowCard]);
    sortHand(hands[luckySeat]);
    sortHand(hands[donor]);
    upgrades += 1;
  }
}

function deal(cheatSeat = -1, luckySeat = -1) {
  const deck = createDeck(6);
  shuffle(deck);
  const hands = [[], [], [], [], [], []];

  if (cheatSeat >= 0) {
    const good = deck.filter(c => c.rank >= 12);
    const normal = deck.filter(c => c.rank < 12);
    shuffle(good);
    shuffle(normal);

    const goodCount = 36 + Math.floor(Math.random() * 6);
    const myGood = good.splice(0, Math.min(goodCount, good.length));
    const myNormal = normal.splice(0, 54 - myGood.length);
    hands[cheatSeat] = [...myGood, ...myNormal];

    const remaining = [...good, ...normal];
    shuffle(remaining);
    let idx = 0;
    for (let i = 0; i < 6; i++) {
      if (i === cheatSeat) continue;
      hands[i] = remaining.slice(idx, idx + 54);
      idx += 54;
    }
  } else {
    for (let i = 0; i < 6; i++) {
      hands[i] = deck.slice(i * 54, (i + 1) * 54);
    }
  }

  if (luckySeat >= 0 && luckySeat !== cheatSeat) applyLuckyBuff(hands, luckySeat);
  hands.forEach(sortHand);
  return hands;
}

// ============ ANALYZE PLAY ============
function analyzePlay(cards) {
  if (!cards || cards.length === 0) return null;
  const counts = {};
  for (const c of cards) counts[c.rank] = (counts[c.rank] || 0) + 1;

  const bigJ = counts[17] || 0;
  const smallJ = counts[16] || 0;
  const twos = counts[15] || 0;
  const normalRanks = Object.keys(counts).map(Number).filter(r => r >= 3 && r <= 14);

  if (normalRanks.length === 0) {
    if (twos > 0 && bigJ === 0 && smallJ === 0) {
      return { count: cards.length, baseRank: 15, baseCount: twos, coreCount: twos, flowerCount: 0, hasJoker: false, bigJokers: 0, smallJokers: 0, twos };
    }
    if ((bigJ + smallJ) > 0 && twos === 0) {
      return { count: cards.length, baseRank: bigJ > 0 ? 17 : 16, baseCount: 0, coreCount: bigJ + smallJ, flowerCount: 0, hasJoker: true, jokerLevel: bigJ > 0 ? 17 : 16, bigJokers: bigJ, smallJokers: smallJ, twos: 0 };
    }
    return null;
  }

  const baseRank = [...normalRanks].sort((a, b) => {
    const diff = (counts[b] || 0) - (counts[a] || 0);
    return diff !== 0 ? diff : b - a;
  })[0];
  const baseCount = counts[baseRank] || 0;
  const flowerCount = normalRanks.filter(r => r !== baseRank).reduce((sum, r) => sum + (counts[r] || 0), 0);
  const coreCount = baseCount + twos + smallJ + bigJ;
  return {
    count: cards.length,
    baseRank,
    baseCount,
    coreCount,
    flowerCount,
    hasJoker: (bigJ + smallJ) > 0,
    jokerLevel: bigJ > 0 ? 17 : (smallJ > 0 ? 16 : 0),
    bigJokers: bigJ,
    smallJokers: smallJ,
    twos,
  };
}

function isValidPlay(cards) {
  return analyzePlay(cards) !== null;
}

function isExactlyAllRank(cards, rank) {
  return cards.length > 0 && cards.every(c => c.rank === rank);
}

function goujiThreshold(rank) {
  if (rank === 10) return 5;
  if (rank === 11) return 4;
  if (rank === 12) return 3;
  if (rank === 13) return 2;
  if (rank === 14) return 2;
  if (rank === 15) return 1;
  if (rank >= 16) return 1;
  return Infinity;
}

function isPureGoujiPlay(cards) {
  const a = analyzePlay(cards);
  if (!a) return false;
  if (a.baseRank >= 16) return a.flowerCount === 0 && a.twos === 0;
  return a.flowerCount === 0 && a.twos === 0 && a.smallJokers === 0 && a.bigJokers === 0 && a.baseCount >= goujiThreshold(a.baseRank);
}

function isGoujiPlay(cards) {
  const a = analyzePlay(cards);
  if (!a) return false;
  if (a.baseRank >= 16) return true;
  if (a.baseRank === 15) return true;
  return a.coreCount >= goujiThreshold(a.baseRank);
}

function isShaoPlay(cards) {
  const a = analyzePlay(cards);
  if (!a) return false;
  if (a.flowerCount > 0) return true;
  if (a.baseRank >= 15) return true;
  return a.baseCount >= goujiThreshold(a.baseRank);
}

function canBeat(cards, tableCards) {
  const a = analyzePlay(cards);
  const t = analyzePlay(tableCards);
  if (!a || !t) return false;

  if (t.count === 1 && (t.bigJokers || 0) === 1 && (a.bigJokers || 0) === 2 && cards.length === 2) return true;
  if (a.count !== t.count) return false;
  if (a.coreCount !== t.coreCount) return a.coreCount > t.coreCount;
  if ((a.bigJokers || 0) !== (t.bigJokers || 0)) return (a.bigJokers || 0) > (t.bigJokers || 0);
  if ((a.smallJokers || 0) !== (t.smallJokers || 0)) return (a.smallJokers || 0) > (t.smallJokers || 0);
  if ((a.twos || 0) !== (t.twos || 0)) return (a.twos || 0) > (t.twos || 0);
  if ((a.baseCount || 0) !== (t.baseCount || 0)) return (a.baseCount || 0) > (t.baseCount || 0);
  return a.baseRank > t.baseRank;
}

function makeVirtualCards(baseRank, countBase, countTwo, countSmall, countBig, flowerCount = 0) {
  const cards = [];
  let id = -1;
  for (let i = 0; i < countBase; i++) cards.push({ rank: baseRank, suit: 0, id: id-- });
  for (let i = 0; i < countTwo; i++) cards.push({ rank: 15, suit: 0, id: id-- });
  for (let i = 0; i < countSmall; i++) cards.push({ rank: 16, suit: -1, id: id-- });
  for (let i = 0; i < countBig; i++) cards.push({ rank: 17, suit: -1, id: id-- });
  for (let i = 0; i < flowerCount; i++) {
    let fakeRank = ((baseRank + i - 3) % 12) + 3;
    if (fakeRank === baseRank) fakeRank = ((fakeRank - 2) % 12) + 3;
    cards.push({ rank: fakeRank, suit: i % 4, id: id-- });
  }
  return cards;
}

function handCanBeatPlay(hand, tableCards) {
  const target = analyzePlay(tableCards);
  if (!target) return false;
  const cnt = {};
  for (const c of hand) cnt[c.rank] = (cnt[c.rank] || 0) + 1;
  if (target.count === 1 && (target.bigJokers || 0) === 1 && (cnt[17] || 0) >= 2) return true;
  const need = target.count;
  for (let baseRank = 3; baseRank <= 15; baseRank++) {
    const maxBase = cnt[baseRank] || 0;
    for (let useBase = 1; useBase <= Math.min(maxBase, need); useBase++) {
      const remain1 = need - useBase;
      const maxTwo = baseRank === 15 ? 0 : Math.min(cnt[15] || 0, remain1);
      for (let useTwo = 0; useTwo <= maxTwo; useTwo++) {
        const remain2 = remain1 - useTwo;
        const maxSmall = Math.min(cnt[16] || 0, remain2);
        for (let useSmall = 0; useSmall <= maxSmall; useSmall++) {
          const remain3 = remain2 - useSmall;
          const maxBig = Math.min(cnt[17] || 0, remain3);
          for (let useBig = 0; useBig <= maxBig; useBig++) {
            const flowers = remain3 - useBig;
            if (flowers < 0) continue;
            const cards = makeVirtualCards(baseRank, useBase, useTwo, useSmall, useBig, flowers);
            if (canBeat(cards, tableCards)) return true;
          }
        }
      }
    }
  }
  return false;
}

function canPlayFinalThree(game, seat, cards, remainingAfterPlay) {
  if (!isExactlyAllRank(cards, 3)) return { ok: true };
  if (remainingAfterPlay.length !== 0) return { ok: false, msg: '3只能作为最后一手牌打出' };
  if (game.tablePlay) return { ok: false, msg: '3只能在新一轮作为最后一手牌打出' };
  for (let p = 0; p < 6; p++) {
    if (p === seat || game.finished[p]) continue;
    if (handCanBeatPlay(game.hands[p], cards)) return { ok: false, msg: '现在出3还会被管住，不能出' };
  }
  return { ok: true };
}

function nextActiveSeat(game, fromSeat) {
  for (let i = 1; i <= 6; i++) {
    const s = (fromSeat + i) % 6;
    if (!game.finished[s] && !game.passedThisRound.includes(s)) return s;
  }
  return -1;
}

function activeSeats(game) {
  return [0,1,2,3,4,5].filter(s => !game.finished[s]);
}

function allFoursSelectedIfKaiDian(hand, cards) {
  const all4 = hand.filter(c => c.rank === 4);
  return all4.length > 0 && cards.length === all4.length && cards.every(c => c.rank === 4);
}

function previousTwoPassedForSeat(game, seat, targetPlayer) {
  const p1 = (targetPlayer + 1) % 6;
  const p2 = (targetPlayer + 2) % 6;
  return game.passedThisRound.includes(p1) && game.passedThisRound.includes(p2) && seat === (targetPlayer + 3) % 6;
}

function canLetTeammate(game, seat) {
  if (!game || !game.tablePlay || game.finished[seat]) return false;
  const target = game.tablePlay.player;
  if (((seat + 3) % 6) !== target) return false;
  return previousTwoPassedForSeat(game, seat, target);
}

function resolveRoundEffects(room) {
  const game = room.game;
  if (!game) return [];
  const logs = [];
  if (game.pendingShao) {
    const { burner, victim } = game.pendingShao;
    if (victim >= 0) {
      room.burnTributeDebt[victim] = (room.burnTributeDebt[victim] || 0) + 1;
      game.mustFlowerAfterShao[burner] = true;
      logs.push({ type: '烧贡', burner, victim });
    }
  }
  game.pendingShao = null;
  game.menCandidate = null;
  game.letSeat = -1;
  return logs;
}

function canTriggerKaiDian(game, seat) {
  if (!game || game.finished[seat]) return false;
  if ((game.rankings?.length || 0) >= 2) return false;
  if (countRank(game.hands[seat], 4) <= 0) return false;
  if (game.openedDian?.[seat]) return false;
  if (game.lostKaiDian?.[seat]) return false;
  return true;
}

function stabilizeCurrentPlayer(game) {
  if (!game) return;
  if (game.currentPlayer >= 0 && game.finished[game.currentPlayer]) {
    const active = activeSeats(game);
    if (active.length > 0) game.currentPlayer = active[0];
  }
}

function resetRound(game, starter, preserveSeat = -1, preserveAction = null) {
  game.tablePlay = null;
  game.passedThisRound = [];
  game.isGoujiMode = false;
  game.goujiPair = [-1, -1];
  game.canKaiDian = -1;
  game.currentPlayer = starter;
  game.playerActions = [{},{},{},{},{},{}];
  if (preserveSeat >= 0 && preserveAction) game.playerActions[preserveSeat] = preserveAction;
  return { ok: true, newRound: true };
}

function maybeFinishPlayer(game, seat) {
  if (!game.finished[seat] && game.hands[seat].length === 0) {
    game.finished[seat] = true;
    game.rankings.push(seat);
  }
}

function maybeGameOver(game) {
  const active = activeSeats(game);
  if (active.length <= 1) {
    if (active.length === 1 && !game.rankings.includes(active[0])) game.rankings.push(active[0]);
    return true;
  }
  return false;
}

// ============ Tribute / Buy-Three ============
function getLowestCards(hand, n) {
  return [...hand].sort((a, b) => (a.rank !== b.rank) ? a.rank - b.rank : a.suit - b.suit).slice(0, n);
}

function getHighestCards(hand, n) {
  return [...hand].sort((a, b) => (a.rank !== b.rank) ? b.rank - a.rank : a.suit - b.suit).slice(0, n);
}

function computePendingTribute(rankings) {
  const topThree = rankings.slice(0, 3);
  const topAllA = topThree.every(s => TEAM_A.includes(s));
  const topAllB = topThree.every(s => TEAM_B.includes(s));

  if (topAllA || topAllB) {
    const losingTeam = topAllA ? TEAM_B : TEAM_A;
    return losingTeam.map(seat => ({ from: seat, to: (seat + 3) % 6, count: 1, type: '串贡' }));
  }

  return [
    { from: rankings[5], to: rankings[0], count: 2, type: '落贡' },
    { from: rankings[4], to: rankings[1], count: 1, type: '落贡' },
  ];
}

function buildRoundTributes(room) {
  const items = [...(room.pendingTribute || [])];
  room.pendingTribute = null;

  for (let seat = 0; seat < 6; seat++) {
    const burn = room.burnTributeDebt?.[seat] || 0;
    const men = room.menTributeDebt?.[seat] || 0;
    const dian = room.dianTributeDebt?.[seat] || 0;
    if (burn > 0) items.push({ from: seat, to: (seat + 3) % 6, count: burn, type: '烧贡' });
    if (men > 0) items.push({ from: seat, to: (seat + 3) % 6, count: men, type: '闷贡' });
    if (dian > 0) items.push({ from: (seat + 3) % 6, to: seat, count: dian, type: '点贡' });
  }

  room.forceKaiDianThisRound = [...(room.forceKaiDianNextRound || [false,false,false,false,false,false])];
  room.forceKaiDianNextRound = [false,false,false,false,false,false];
  room.dianSkipStreak = room.dianSkipStreak.map((v, i) => (room.forceKaiDianThisRound[i] ? 0 : v));
  room.burnTributeDebt = [0,0,0,0,0,0];
  room.menTributeDebt = [0,0,0,0,0,0];
  room.dianTributeDebt = [0,0,0,0,0,0];
  return items;
}


function applyTribute(hands, pendingTribute) {
  const tributeLog = [];
  if (!pendingTribute || pendingTribute.length === 0) return tributeLog;

  for (const item of pendingTribute) {
    const give = getHighestCards(hands[item.from], item.count);
    hands[item.from] = removeSpecificCards(hands[item.from], give);
    pushCards(hands[item.to], give);

    const back = getLowestCards(hands[item.to], item.count);
    hands[item.to] = removeSpecificCards(hands[item.to], back);
    pushCards(hands[item.from], back);

    sortHand(hands[item.from]);
    sortHand(hands[item.to]);

    tributeLog.push({
      type: item.type,
      from: item.from,
      to: item.to,
      count: item.count,
      give: give.map(cardText),
      back: back.map(cardText),
    });
  }

  return tributeLog;
}

function findThreeProvider(seat, hands) {
  const duiTou = (seat + 3) % 6;
  const teammates = TEAM_A.includes(seat) ? TEAM_A.filter(s => s !== seat) : TEAM_B.filter(s => s !== seat);
  const fallback = [0,1,2,3,4,5].filter(s => s !== seat && s !== duiTou && !teammates.includes(s));
  const candidates = [duiTou, ...teammates, ...fallback];
  for (const s of candidates) {
    if (countRank(hands[s], 3) > 1) return s;
  }
  return -1;
}

function chooseBuyThreePayment(hand) {
  const two = hand.find(c => c.rank === 15);
  if (two) return two;
  const small = hand.find(c => c.rank === 16);
  if (small) return small;
  const big = hand.find(c => c.rank === 17);
  if (big) return big;
  return null;
}

function applyBuyThree(hands) {
  const buySanLog = [];
  for (let seat = 0; seat < 6; seat++) {
    if (countRank(hands[seat], 3) > 0) continue;

    const provider = findThreeProvider(seat, hands);
    if (provider === -1) {
      buySanLog.push({ buyer: seat, seller: -1, paid: '无', note: '无人有多余3，跳过买三' });
      continue;
    }

    const boughtThree = getCardsByRank(hands[provider], 3).slice(-1);
    const payment = chooseBuyThreePayment(hands[seat]);

    hands[provider] = removeSpecificCards(hands[provider], boughtThree);
    pushCards(hands[seat], boughtThree);

    let paidText = '赠送';
    if (payment) {
      hands[seat] = removeSpecificCards(hands[seat], [payment]);
      pushCards(hands[provider], [payment]);
      paidText = cardText(payment);
    }

    sortHand(hands[seat]);
    sortHand(hands[provider]);
    buySanLog.push({ buyer: seat, seller: provider, paid: paidText, got: '3' });
  }
  return buySanLog;
}

// ============ GAME STATE ============
function createGameState(hands, firstPlayer, roundNumber, tributeLog = [], buySanLog = [], players = []) {
  return {
    hands,
    finished: [false, false, false, false, false, false],
    rankings: [],
    currentPlayer: firstPlayer,
    tablePlay: null,
    passedThisRound: [],
    roundStarter: firstPlayer,

    isGoujiMode: false,
    goujiPair: [-1, -1],
    canKaiDian: -1,
    openedDian: [false, false, false, false, false, false],
    lostKaiDian: [false, false, false, false, false, false],

    playerActions: [{},{},{},{},{},{}],
    roundNumber,
    tributeLog,
    buySanLog,
    playedPool: [],
    mustFlowerAfterShao: [false,false,false,false,false,false],
    pendingShao: null,
    menCandidate: null,
    letSeat: -1,
    forceKaiDianThisRound: [false,false,false,false,false,false],
    naojiUses: [0,0,0,0,0,0],
    naojiMax: [0,1,2,3,4,5].map(i => getNaojiLimit(players.find(p => p.seat === i)?.name || '')),
    recentGrabClicks: [],
    activeNaojiWindows: [],
    naojiWindowSeq: 0,
    turnEndsAt: 0,
    peekUses: [0,0,0,0,0,0],
    peekMax: [0,0,0,0,0,0].map((_, i) => ((players.find(p => p.seat === i)?.name || '').trim() === '张哲' ? 3 : 0)),
  };
}

function getStateForPlayer(room, seat) {
  const game = room.game;
  if (!game) return null;
  const me = room.players.find(pp => pp.seat === seat);

  return {
    myHand: game.hands[seat],
    mySeat: seat,
    myName: me?.name || '',
    handCounts: game.hands.map(h => h.length),
    finished: game.finished,
    rankings: game.rankings,
    currentPlayer: game.currentPlayer,
    tablePlay: game.tablePlay,
    isGoujiMode: game.isGoujiMode,
    goujiPair: game.goujiPair,
    playerActions: game.playerActions,
    players: room.players.map(p => ({ name: p.name, seat: p.seat })),
    isHost: room.hostId === me?.id,
    canKaiDian: game.canKaiDian,
    openedDian: game.openedDian,
    lostKaiDian: game.lostKaiDian || [false, false, false, false, false, false],
    roundNumber: game.roundNumber,
    tributeLog: game.tributeLog || [],
    buySanLog: game.buySanLog || [],
    naojiUses: game.naojiUses || [0,0,0,0,0,0],
    naojiMax: game.naojiMax || [5,5,5,5,5,5],
    turnEndsAt: game.turnEndsAt || 0,
    playedPoolCount: (game.playedPool || []).length,
    dianTributeDebt: room.dianTributeDebt || [0,0,0,0,0,0],
    dianSkipStreak: room.dianSkipStreak || [0,0,0,0,0,0],
    burnTributeDebt: room.burnTributeDebt || [0,0,0,0,0,0],
    menTributeDebt: room.menTributeDebt || [0,0,0,0,0,0],
    forceKaiDianThisRound: room.forceKaiDianThisRound || [false,false,false,false,false,false],
    peekUses: game.peekUses || [0,0,0,0,0,0],
    peekMax: game.peekMax || [0,0,0,0,0,0],
    canPeek: ((me?.name || '').trim() === '张哲') && game.currentPlayer !== seat && !game.finished[seat] && ((game.peekUses?.[seat] || 0) < (game.peekMax?.[seat] || 0)),
    canStrategist: ((me?.name || '').trim() === '陈杰') && !!game.finished[seat] && getRemainingTeammateSeats(game, seat).length > 0,
    strategistTargets: getRemainingTeammateSeats(game, seat),
    canLet: canLetTeammate(game, seat),
  };
}

function broadcastState(room) {
  room.players.forEach(p => io.to(p.id).emit('game_state', getStateForPlayer(room, p.seat)));
}

function finishGame(room) {
  clearTurnTimer(room);
  room.state = 'gameover';
  resolveRoundEffects(room);
  room.pendingTribute = computePendingTribute(room.game.rankings);
  room.players.forEach(p => {
    io.to(p.id).emit('game_over', {
      rankings: room.game.rankings,
      players: room.players.map(pp => ({ name: pp.name, seat: pp.seat })),
    });
  });
}

function executeFourChoice(room, seat, cards, kind = 'normal4') {
  const game = room.game;
  const hand = game.hands[seat];
  const cardIds = cards.map(c => c.id);
  game.hands[seat] = removeCardsByIds(hand, cardIds);
  game.playedPool.push(...cards.map(cloneCard));
  game.playerActions[seat] = { type: 'play', cards: [...cards], isKaiDian: kind === 'kaidian' || kind === 'autokaidian', isCallGong: kind === 'callgong', isNormalFour: kind === 'normal4', isAutoKaiDian: kind === 'autokaidian' };

  if (kind === 'kaidian' || kind === 'autokaidian') {
    game.openedDian[seat] = true;
    room.dianSkipStreak[seat] = 0;
    room.forceKaiDianThisRound[seat] = false;
  } else {
    room.dianTributeDebt[seat] = (room.dianTributeDebt[seat] || 0) + 1;
    room.dianSkipStreak[seat] = Math.min(3, (room.dianSkipStreak[seat] || 0) + 1);
    if (room.dianSkipStreak[seat] >= 3) room.forceKaiDianNextRound[seat] = true;
    game.lostKaiDian[seat] = true;
  }

  maybeFinishPlayer(game, seat);
  if (maybeGameOver(game)) return { ok: true, gameOver: true };
  const logs = resolveRoundEffects(room);
  const nextStarter = game.finished[seat] ? activeSeats(game)[0] : seat;
  const res = resetRound(game, nextStarter, seat, game.playerActions[seat]);
  return { ...res, roundEffectLogs: logs, autoKind: kind };
}

function processPlay(room, seat, cardIds, playMode = 'normal') {
  const game = room.game;
  if (!game || game.currentPlayer !== seat) return { ok: false, msg: '不是你的回合' };
  if (game.finished[seat]) return { ok: false, msg: '你已经出完了' };

  const hand = game.hands[seat];
  const cards = takeCardsByIds(hand, cardIds);
  if (cards.length !== cardIds.length) return { ok: false, msg: '无效的牌' };
  const analyzed = analyzePlay(cards);
  if (!analyzed) return { ok: false, msg: '无效出牌组合' };
  if (game.mustFlowerAfterShao?.[seat] && analyzed.flowerCount <= 0) return { ok: false, msg: '烧后出牌必须带花' };

  if (game.canKaiDian === seat) {
    const kind = (playMode === 'kaidian' || playMode === 'autokaidian') ? playMode : (playMode === 'callgong' ? 'callgong' : 'normal4');
    if (!cards.every(c => c.rank === 4)) return { ok: false, msg: '现在只能出4' };
    if (!allFoursSelectedIfKaiDian(hand, cards)) return { ok: false, msg: '此时必须把手里所有4一起打出' };
    return executeFourChoice(room, seat, cards, kind);
  }

  const remainingAfterPlay = hand.filter(c => !cardIds.includes(c.id));
  const threeCheck = canPlayFinalThree(game, seat, cards, remainingAfterPlay);
  if (!threeCheck.ok) return threeCheck;

  const prevPlay = game.tablePlay ? { ...game.tablePlay } : null;
  if (prevPlay && !canBeat(cards, prevPlay.cards)) return { ok: false, msg: '压不住！' };

  game.hands[seat] = remainingAfterPlay;
  game.playedPool.push(...cards.map(cloneCard));
  if (cards.some(c => c.rank === 4)) game.lostKaiDian[seat] = true;
  const isGouji = isGoujiPlay(cards);
  const isShao = !!prevPlay && isShaoPlay(cards);
  game.tablePlay = { cards: [...cards], player: seat, isGouji, isShao };
  game.passedThisRound = [];
  game.roundStarter = seat;
  game.playerActions[seat] = { type: 'play', cards: [...cards], isShao };
  game.canKaiDian = -1;
  game.letSeat = -1;

  if (prevPlay) {
    if (game.menCandidate && game.menCandidate.seat === prevPlay.player && seat !== prevPlay.player) {
      room.menTributeDebt[prevPlay.player] = (room.menTributeDebt[prevPlay.player] || 0) + 1;
      game.menCandidate = null;
      game.playerActions[seat].isMen = true;
    }
    if (isShao) {
      game.pendingShao = { burner: seat, victim: prevPlay.player };
      game.playerActions[seat].isFanShao = !!prevPlay.isShao;
    } else if (prevPlay.isShao) {
      game.pendingShao = null;
    }
  }

  if (remainingAfterPlay.length > 0 && remainingAfterPlay.every(c => c.rank === 3)) game.menCandidate = { seat };
  else if (game.menCandidate?.seat === seat) game.menCandidate = null;

  maybeFinishPlayer(game, seat);
  if (maybeGameOver(game)) return { ok: true, gameOver: true };

  if (isGouji && !game.finished[seat]) {
    const duiTou = (seat + 3) % 6;
    if (!game.finished[duiTou]) {
      game.isGoujiMode = true;
      game.goujiPair = [seat, duiTou];
      game.currentPlayer = duiTou;
      return { ok: true };
    }
  }

  if (game.finished[seat]) {
    const next = nextActiveSeat(game, seat);
    const logs = resolveRoundEffects(room);
    const res = resetRound(game, next === -1 ? activeSeats(game)[0] : next);
    return { ...res, roundEffectLogs: logs };
  }

  const next = nextActiveSeat(game, seat);
  if (next === -1 || next === game.tablePlay.player) {
    const logs = resolveRoundEffects(room);
    const starter = game.finished[seat] ? activeSeats(game)[0] : seat;
    const res = resetRound(game, starter);
    return { ...res, roundEffectLogs: logs };
  }

  game.currentPlayer = next;
  return { ok: true };
}

function processPass(room, seat) {
  const game = room.game;
  if (!game || game.currentPlayer !== seat) return { ok: false, msg: '不是你的回合' };

  if (game.canKaiDian === seat) {
    room.dianTributeDebt[seat] = (room.dianTributeDebt[seat] || 0) + 1;
    room.dianSkipStreak[seat] = Math.min(3, (room.dianSkipStreak[seat] || 0) + 1);
    if (room.dianSkipStreak[seat] >= 3) room.forceKaiDianNextRound[seat] = true;
    const logs = resolveRoundEffects(room);
    const starter = game.finished[seat] ? activeSeats(game)[0] : seat;
    const res = resetRound(game, starter);
    return { ...res, roundEffectLogs: logs };
  }

  if (!game.tablePlay) return { ok: false, msg: '现在不能过牌' };

  game.passedThisRound.push(seat);
  game.playerActions[seat] = { type: 'pass' };

  if (game.isGoujiMode && seat === game.goujiPair[1]) {
    game.isGoujiMode = false;
    const attacker = game.goujiPair[0];
    if (canTriggerKaiDian(game, attacker)) {
      if (game.forceKaiDianThisRound?.[attacker]) {
        const autoCards = getCardsByRank(game.hands[attacker], 4);
        return executeFourChoice(room, attacker, autoCards, 'autokaidian');
      }
      game.canKaiDian = attacker;
      game.currentPlayer = attacker;
      return { ok: true };
    }
    const logs = resolveRoundEffects(room);
    const starter = game.finished[attacker] ? activeSeats(game)[0] : attacker;
    const res = resetRound(game, starter);
    return { ...res, roundEffectLogs: logs };
  }

  const active = activeSeats(game);
  const candidates = active.filter(p => !game.passedThisRound.includes(p) && p !== game.tablePlay.player);
  if (candidates.length === 0) {
    const baseStarter = game.finished[game.tablePlay.player] ? active[0] : game.tablePlay.player;
    const starter = (game.letSeat >= 0 && !game.finished[game.letSeat]) ? game.letSeat : baseStarter;
    const logs = resolveRoundEffects(room);
    const res = resetRound(game, starter);
    return { ...res, roundEffectLogs: logs };
  }

  const next = nextActiveSeat(game, seat);
  if (next === -1 || next === game.tablePlay.player) {
    const baseStarter = game.finished[game.tablePlay.player] ? active[0] : game.tablePlay.player;
    const starter = (game.letSeat >= 0 && !game.finished[game.letSeat]) ? game.letSeat : baseStarter;
    const logs = resolveRoundEffects(room);
    const res = resetRound(game, starter);
    return { ...res, roundEffectLogs: logs };
  }

  game.currentPlayer = next;
  return { ok: true };
}

function processLet(room, seat) {
  const game = room.game;
  if (!game || game.currentPlayer !== seat) return { ok: false, msg: '不是你的回合' };
  if (!canLetTeammate(game, seat)) return { ok: false, msg: '当前不能让牌' };
  game.passedThisRound.push(seat);
  game.playerActions[seat] = { type: 'yield' };
  game.letSeat = seat;

  const next = nextActiveSeat(game, seat);
  if (next === -1 || next === game.tablePlay.player) {
    const logs = resolveRoundEffects(room);
    const res = resetRound(game, seat);
    return { ...res, roundEffectLogs: logs };
  }
  game.currentPlayer = next;
  return { ok: true };
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
    socket.emit('room_joined', {
      code,
      seat: 0,
      players: rooms[code].players.map(p => ({ name: p.name, seat: p.seat })),
    });
  });

  socket.on('join_room', ({ code, name }) => {
    const room = rooms[(code || '').toUpperCase()];
    if (!room) return socket.emit('error_msg', { msg: '房间不存在！' });
    if (room.state === 'playing') return socket.emit('error_msg', { msg: '游戏已开始！' });
    if (room.players.length >= 6) return socket.emit('error_msg', { msg: '房间已满！' });

    const seat = room.players.length;
    room.players.push({ id: socket.id, name: name || ('玩家' + (seat + 1)), seat });
    currentRoom = room.code;
    currentSeat = seat;
    socket.join(currentRoom);

    const playerList = room.players.map(p => ({ name: p.name, seat: p.seat }));
    socket.emit('room_joined', { code: currentRoom, seat, players: playerList });
    io.to(currentRoom).emit('player_list', { players: playerList });
  });

  socket.on('start_game', () => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('error_msg', { msg: '只有房主可以开始游戏' });
    if (room.players.length < 6) return socket.emit('error_msg', { msg: `需要6人才能开始！当前${room.players.length}人` });

    const cheatSeat = room.cheatArmed ? room.players.find(p => p.id === room.hostId)?.seat ?? -1 : -1;
    const luckySeat = getLuckyBoostSeat(room.players);
    const hands = deal(cheatSeat, luckySeat);

    const tributeLog = applyTribute(hands, buildRoundTributes(room));
    const buySanLog = applyBuyThree(hands);

    const firstPlayer = cheatSeat >= 0 ? cheatSeat : Math.floor(Math.random() * 6);
    room.game = createGameState(hands, firstPlayer, room.nextRoundNumber++, tributeLog, buySanLog, room.players);
    room.game.forceKaiDianThisRound = [...(room.forceKaiDianThisRound || [false,false,false,false,false,false])];
    room.state = 'playing';
    room.cheatArmed = false;

    broadcastState(room);
    scheduleTurnTimer(room);
  });

  socket.on('play_cards', ({ cardIds, mode }) => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const result = processPlay(room, currentSeat, cardIds || [], mode || 'normal');
    if (!result.ok) return socket.emit('error_msg', { msg: result.msg });
    if (result.gameOver) return finishGame(room);
    broadcastState(room);
    scheduleTurnTimer(room);
  });

  socket.on('pass', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const result = processPass(room, currentSeat);
    if (!result.ok) return socket.emit('error_msg', { msg: result.msg });
    broadcastState(room);
    scheduleTurnTimer(room);
  });

  socket.on('let_teammate', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const result = processLet(room, currentSeat);
    if (!result.ok) return socket.emit('error_msg', { msg: result.msg });
    broadcastState(room);
    scheduleTurnTimer(room);
  });

  socket.on('naoji', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const result = processNaoji(room, currentSeat);
    if (!result.ok) return socket.emit('error_msg', { msg: result.msg });

    const who = room.players.find(p => p.seat === currentSeat)?.name || ('座位' + (currentSeat + 1));
    const baseMsg = result.source === 'pool'
      ? `${who} 发动孬急，从已出牌区摸到 ${cardText(result.card)}`
      : `${who} 发动孬急，从 ${result.sourceName} 手里摸到 ${cardText(result.card)}`;
    io.to(currentRoom).emit('toast_msg', { msg: baseMsg });
    io.to(currentRoom).emit('sound_cue', { type: 'secret' });

    if (result.penalties && result.penalties.length) {
      for (const item of result.penalties) {
        const targetName = room.players.find(p => p.seat === item.target)?.name || ('座位' + (item.target + 1));
        if (item.ok) {
          io.to(currentRoom).emit('toast_msg', { msg: `${who} 被${targetName}抓中，赔出 ${cardText(item.card)}` });
          io.to(currentRoom).emit('sound_cue', { type: 'caught' });
        } else {
          io.to(currentRoom).emit('toast_msg', { msg: `${who} 被${targetName}抓中，但${item.msg.replace(/^.*?没有/, '没有')}` });
        }
      }
    }

    if (maybeGameOver(room.game)) return finishGame(room);
    broadcastState(room);
  });

  socket.on('grab', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const result = processGrab(room, currentSeat);
    if (!result.ok) return socket.emit('error_msg', { msg: result.msg });

    const who = room.players.find(p => p.seat === currentSeat)?.name || ('座位' + (currentSeat + 1));
    if (!result.results || result.results.length === 0) {
      return socket.emit('toast_msg', { msg: '已点击抓，2秒内有效' });
    }

    for (const item of result.results) {
      const fromName = room.players.find(p => p.seat === item.fromSeat)?.name || ('座位' + (item.fromSeat + 1));
      const actName = item.windowType === 'peek' ? '验牌' : '孬急';
      if (item.ok) {
        io.to(currentRoom).emit('toast_msg', { msg: `${who} 抓到 ${fromName} 的${actName}，获得 ${cardText(item.card)}` });
        io.to(currentRoom).emit('sound_cue', { type: 'caught' });
      } else {
        io.to(currentRoom).emit('toast_msg', { msg: `${who} 抓到 ${fromName} 的${actName}，但对方没有2以上的牌` });
      }
    }

    if (maybeGameOver(room.game)) return finishGame(room);
    broadcastState(room);
  });

  socket.on('peek_neighbors', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const result = processPeek(room, currentSeat);
    if (!result.ok) return socket.emit('error_msg', { msg: result.msg });

    const who = room.players.find(p => p.seat === currentSeat)?.name || ('座位' + (currentSeat + 1));
    socket.emit('peek_result', {
      expiresAt: result.expiresAt,
      uses: result.uses,
      max: result.max,
      sides: result.sides,
    });
    io.to(currentRoom).emit('toast_msg', { msg: `${who} 发动了验牌` });
    io.to(currentRoom).emit('sound_cue', { type: 'secret' });

    if (result.penalties && result.penalties.length) {
      for (const item of result.penalties) {
        const targetName = room.players.find(p => p.seat === item.target)?.name || ('座位' + (item.target + 1));
        if (item.ok) {
          io.to(currentRoom).emit('toast_msg', { msg: `${who} 验牌被${targetName}抓中，赔出 ${cardText(item.card)}` });
          io.to(currentRoom).emit('sound_cue', { type: 'caught' });
        } else {
          io.to(currentRoom).emit('toast_msg', { msg: `${who} 验牌被${targetName}抓中，但${item.msg.replace(/^.*?没有/, '没有')}` });
        }
      }
    }

    if (maybeGameOver(room.game)) return finishGame(room);
    broadcastState(room);
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
    clearTurnTimer(room);
    room.state = 'waiting';
    room.game = null;
    const playerList = room.players.map(p => ({ name: p.name, seat: p.seat }));
    io.to(currentRoom).emit('back_to_lobby', { players: playerList });
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const leaving = room.players.find(p => p.id === socket.id);

    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      clearTurnTimer(room);
      delete rooms[currentRoom];
      return;
    }

    if (room.hostId === socket.id) room.hostId = room.players[0].id;

    const playerList = room.players.map(p => ({ name: p.name, seat: p.seat }));
    io.to(currentRoom).emit('player_list', { players: playerList });

    if (room.state === 'playing') {
      io.to(currentRoom).emit('player_disconnected', {
        seat: leaving?.seat ?? -1,
        name: leaving?.name ?? '玩家',
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🀄 够级服务器已启动！`);
  console.log(`   本机访问: http://localhost:${PORT}`);
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
