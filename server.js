const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ============ CONSTANTS ============
const TEAM_A = [0, 2, 4];
const TEAM_B = [1, 3, 5];

const rooms = {}; // roomCode -> room data

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
    results.push({ fromSeat: window.seat, toSeat: seat, ...payRes });
  }

  return { ok: true, results };
}

// ============ DEAL ============
function deal(cheatSeat = -1) {
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

  if (normalRanks.length > 1) return null;

  if (normalRanks.length === 0 && twos > 0 && bigJ === 0 && smallJ === 0) {
    return { count: cards.length, baseRank: 15, hasJoker: false, bigJokers: 0, smallJokers: 0, twos };
  }

  if (normalRanks.length === 0 && twos === 0 && (bigJ + smallJ) > 0) {
    return {
      count: cards.length,
      baseRank: bigJ > 0 ? 17 : 16,
      hasJoker: true,
      jokerLevel: bigJ > 0 ? 17 : 16,
      bigJokers: bigJ,
      smallJokers: smallJ,
      twos: 0,
    };
  }

  const baseRank = normalRanks.length ? normalRanks[0] : 15;
  if (normalRanks.length === 1) {
    const sameRankCount = counts[baseRank] || 0;
    if (sameRankCount + twos + bigJ + smallJ !== cards.length) return null;
    if (bigJ + smallJ > 0) {
      return {
        count: cards.length,
        baseRank,
        hasJoker: true,
        jokerLevel: bigJ > 0 ? 17 : 16,
        bigJokers: bigJ,
        smallJokers: smallJ,
        twos,
      };
    }
    return { count: cards.length, baseRank, hasJoker: false, bigJokers: 0, smallJokers: 0, twos };
  }

  return null;
}

function isValidPlay(cards) {
  return analyzePlay(cards) !== null;
}

function isExactlyAllRank(cards, rank) {
  return cards.length > 0 && cards.every(c => c.rank === rank);
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
  return false;
}

function canBeat(cards, tableCards) {
  const a = analyzePlay(cards);
  const t = analyzePlay(tableCards);
  if (!a || !t) return false;

  // 二杀一：两张大王压一张大王
  if (t.count === 1 && (t.bigJokers || 0) === 1 && (a.bigJokers || 0) === 2 && cards.length === 2) {
    return true;
  }

  if (a.count !== t.count) return false;

  if (a.hasJoker && t.hasJoker) {
    if ((a.bigJokers || 0) !== (t.bigJokers || 0)) return (a.bigJokers || 0) > (t.bigJokers || 0);
    if ((a.smallJokers || 0) !== (t.smallJokers || 0)) return (a.smallJokers || 0) > (t.smallJokers || 0);
    if ((a.twos || 0) !== (t.twos || 0)) return (a.twos || 0) > (t.twos || 0);
    return a.baseRank > t.baseRank;
  }

  if (a.hasJoker && !t.hasJoker) return true;
  if (!a.hasJoker && t.hasJoker) return false;

  if ((a.twos || 0) !== (t.twos || 0)) return (a.twos || 0) > (t.twos || 0);
  return a.baseRank > t.baseRank;
}

function makeVirtualCards(baseRank, countBase, countTwo, countSmall, countBig) {
  const cards = [];
  let id = -1;
  for (let i = 0; i < countBase; i++) cards.push({ rank: baseRank, suit: 0, id: id-- });
  for (let i = 0; i < countTwo; i++) cards.push({ rank: 15, suit: 0, id: id-- });
  for (let i = 0; i < countSmall; i++) cards.push({ rank: 16, suit: -1, id: id-- });
  for (let i = 0; i < countBig; i++) cards.push({ rank: 17, suit: -1, id: id-- });
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
          const useBig = remain2 - useSmall;
          if (useBig < 0 || useBig > (cnt[17] || 0)) continue;
          const cards = makeVirtualCards(baseRank, useBase, useTwo, useSmall, useBig);
          if (canBeat(cards, tableCards)) return true;
        }
      }
    }
  }

  if ((cnt[15] || 0) >= need) {
    const pureTwo = makeVirtualCards(15, need, 0, 0, 0);
    if (canBeat(pureTwo, tableCards)) return true;
  }

  for (let useSmall = 0; useSmall <= Math.min(cnt[16] || 0, need); useSmall++) {
    const useBig = need - useSmall;
    if (useBig <= (cnt[17] || 0)) {
      const jokerOnly = makeVirtualCards(15, 0, 0, useSmall, useBig);
      if (analyzePlay(jokerOnly) && canBeat(jokerOnly, tableCards)) return true;
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
    if (handCanBeatPlay(game.hands[p], cards)) {
      return { ok: false, msg: '现在出3还会被管住，不能出' };
    }
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

    playerActions: [{},{},{},{},{},{}],
    roundNumber,
    tributeLog,
    buySanLog,
    playedPool: [],
    naojiUses: [0,0,0,0,0,0],
    naojiMax: [0,1,2,3,4,5].map(i => getNaojiLimit(players.find(p => p.seat === i)?.name || '')),
    recentGrabClicks: [],
    activeNaojiWindows: [],
    naojiWindowSeq: 0,
    turnEndsAt: 0,
  };
}

function getStateForPlayer(room, seat) {
  const game = room.game;
  if (!game) return null;

  return {
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
    canKaiDian: game.canKaiDian,
    openedDian: game.openedDian,
    roundNumber: game.roundNumber,
    tributeLog: game.tributeLog || [],
    buySanLog: game.buySanLog || [],
    naojiUses: game.naojiUses || [0,0,0,0,0,0],
    naojiMax: game.naojiMax || [5,5,5,5,5,5],
    turnEndsAt: game.turnEndsAt || 0,
    playedPoolCount: (game.playedPool || []).length,
  };
}

function broadcastState(room) {
  room.players.forEach(p => io.to(p.id).emit('game_state', getStateForPlayer(room, p.seat)));
}

function finishGame(room) {
  clearTurnTimer(room);
  room.state = 'gameover';
  room.pendingTribute = computePendingTribute(room.game.rankings);
  room.players.forEach(p => {
    io.to(p.id).emit('game_over', {
      rankings: room.game.rankings,
      players: room.players.map(pp => ({ name: pp.name, seat: pp.seat })),
    });
  });
}

function processPlay(room, seat, cardIds) {
  const game = room.game;
  if (!game || game.currentPlayer !== seat) return { ok: false, msg: '不是你的回合' };
  if (game.finished[seat]) return { ok: false, msg: '你已经出完了' };

  const hand = game.hands[seat];
  const cards = takeCardsByIds(hand, cardIds);
  if (cards.length !== cardIds.length) return { ok: false, msg: '无效的牌' };

  if (game.canKaiDian === seat) {
    if (!cards.every(c => c.rank === 4)) return { ok: false, msg: '现在只能出4开点' };
    if (!allFoursSelectedIfKaiDian(hand, cards)) return { ok: false, msg: '开点时必须把手里所有4一起打出' };

    game.hands[seat] = removeCardsByIds(hand, cardIds);
    game.playedPool.push(...cards.map(cloneCard));
    game.playerActions[seat] = { type: 'play', cards: [...cards], isKaiDian: true };
    game.openedDian[seat] = true;
    maybeFinishPlayer(game, seat);

    if (maybeGameOver(game)) return { ok: true, gameOver: true };

    const nextStarter = game.finished[seat] ? activeSeats(game)[0] : seat;
    return resetRound(game, nextStarter, seat, game.playerActions[seat]);
  }

  if (cards.some(c => c.rank === 4)) return { ok: false, msg: '4只能在够级对头管不住后开点时出' };
  if (!isValidPlay(cards)) return { ok: false, msg: '无效出牌组合' };

  const remainingAfterPlay = hand.filter(c => !cardIds.includes(c.id));
  const threeCheck = canPlayFinalThree(game, seat, cards, remainingAfterPlay);
  if (!threeCheck.ok) return threeCheck;

  if (game.tablePlay && !canBeat(cards, game.tablePlay.cards)) return { ok: false, msg: '压不住！' };

  game.hands[seat] = remainingAfterPlay;
  game.playedPool.push(...cards.map(cloneCard));
  const isGouji = isGoujiPlay(cards);
  game.tablePlay = { cards: [...cards], player: seat, isGouji };
  game.passedThisRound = [];
  game.roundStarter = seat;
  game.playerActions[seat] = { type: 'play', cards: [...cards] };
  game.canKaiDian = -1;

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
    return resetRound(game, next === -1 ? activeSeats(game)[0] : next);
  }

  const next = nextActiveSeat(game, seat);
  if (next === -1 || next === game.tablePlay.player) {
    const starter = game.finished[seat] ? activeSeats(game)[0] : seat;
    return resetRound(game, starter);
  }

  game.currentPlayer = next;
  return { ok: true };
}

function processPass(room, seat) {
  const game = room.game;
  if (!game || game.currentPlayer !== seat) return { ok: false, msg: '不是你的回合' };

  if (game.canKaiDian === seat) {
    const starter = game.finished[seat] ? activeSeats(game)[0] : seat;
    return resetRound(game, starter);
  }

  if (!game.tablePlay) return { ok: false, msg: '现在不能过牌' };

  game.passedThisRound.push(seat);
  game.playerActions[seat] = { type: 'pass' };

  if (game.isGoujiMode && seat === game.goujiPair[1]) {
    game.isGoujiMode = false;
    const attacker = game.goujiPair[0];

    if (!game.finished[attacker] && countRank(game.hands[attacker], 4) > 0 && !game.openedDian[attacker]) {
      game.canKaiDian = attacker;
      game.currentPlayer = attacker;
      return { ok: true };
    }

    const starter = game.finished[attacker] ? activeSeats(game)[0] : attacker;
    return resetRound(game, starter);
  }

  const active = activeSeats(game);
  const candidates = active.filter(p => !game.passedThisRound.includes(p) && p !== game.tablePlay.player);
  if (candidates.length === 0) {
    const starter = game.finished[game.tablePlay.player] ? active[0] : game.tablePlay.player;
    return resetRound(game, starter);
  }

  const next = nextActiveSeat(game, seat);
  if (next === -1 || next === game.tablePlay.player) {
    const starter = game.finished[game.tablePlay.player] ? active[0] : game.tablePlay.player;
    return resetRound(game, starter);
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
    const hands = deal(cheatSeat);

    const tributeLog = applyTribute(hands, room.pendingTribute);
    const buySanLog = applyBuyThree(hands);

    const firstPlayer = cheatSeat >= 0 ? cheatSeat : Math.floor(Math.random() * 6);
    room.game = createGameState(hands, firstPlayer, room.nextRoundNumber++, tributeLog, buySanLog, room.players);
    room.state = 'playing';
    room.cheatArmed = false;

    broadcastState(room);
    scheduleTurnTimer(room);
  });

  socket.on('play_cards', ({ cardIds }) => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const result = processPlay(room, currentSeat, cardIds || []);
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

    if (result.penalties && result.penalties.length) {
      for (const item of result.penalties) {
        const targetName = room.players.find(p => p.seat === item.target)?.name || ('座位' + (item.target + 1));
        if (item.ok) {
          io.to(currentRoom).emit('toast_msg', { msg: `${who} 被${targetName}抓中，赔出 ${cardText(item.card)}` });
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
      if (item.ok) {
        io.to(currentRoom).emit('toast_msg', { msg: `${who} 抓到 ${fromName} 的孬急，获得 ${cardText(item.card)}` });
      } else {
        io.to(currentRoom).emit('toast_msg', { msg: `${who} 抓到 ${fromName} 的孬急，但对方没有2以上的牌` });
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
