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

function sameTeam(a, b) {
  return (TEAM_A.includes(a) && TEAM_A.includes(b)) || (TEAM_B.includes(a) && TEAM_B.includes(b));
}

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
    secretUsers: new Set(),
    countViewers: new Set(),
    seriesMode: 'five',
    seriesCompleted: 0,
    seriesTimer: null,
    nextRoundNumber: 1,
    pendingTribute: null,
    turnTimer: null,
    burnTributeDebt: [0,0,0,0,0,0],
    menTributeDebt: [0,0,0,0,0,0],
    dianTributeDebt: [0,0,0,0,0,0],
    dianSkipStreak: [0,0,0,0,0,0],
    forceKaiDianNextRound: [false,false,false,false,false,false],
    forceKaiDianThisRound: [false,false,false,false,false,false],
    nextStarterSeat: -1,
    returnTimer: null,
    botTimer: null,
    botMode: false,
    playerEquipment: [null, null, null, null, null, null],
    weiBufanSkipUsed: false,
  };
  return code;
}

const BOT_NAMES = ['阿海机', '小陈机', '老张机', '阿勇机', '小梁机', '阿哲机'];

// ============ CONSOLATION EQUIPMENT ============
// Whoever finishes last (大落) each round gets handed one random equipment
// card to use the following round — a comeback nudge for the friend who
// keeps getting stuck at the bottom. Every effect here is either a plain
// number bonus, a display-only field, or a one-time relaxation of a legality
// check — none of them touch currentPlayer / turn scheduling, on purpose,
// so this can't reopen the stuck-turn bugs that were just fixed.
const EQUIPMENT_DEFS = [
  { id: 'yanpai', name: '我要验牌', desc: '下一局白送 1 次验牌机会（不用是张哲也能用）' },
  { id: 'banwei', name: '班味', desc: '下一局轮到你时显示提醒，出牌时间统一20秒' },
  { id: 'aini_laoji', name: '爱你老己', desc: '下一局第一次孬急必定摸到对方点数最大的牌' },
  { id: 'jing_ziji', name: '敬自己一杯', desc: '下一局开局清空你的点贡/烧贡/闷贡欠账' },
  { id: 'saibo_duizhang', name: '赛博对账', desc: '下一局随时能看到大王/小王/2 已经出过几张' },
  { id: 'ruhe_ne', name: '如何呢又能怎', desc: '下一局手里的"3"随时能当废牌扔，不用等最后一手' },
  { id: 'bu_jichu', name: '万物皆可不基础', desc: '下一局你的够级门槛少算一张牌' },
  { id: 'zishujing', name: '紫薯精附体', desc: '下一局你抓/孬急/验牌/扔牌得手时会弹紫薯精特效' },
  { id: 'baba_yulu', name: '可灵AI·霸总语录', desc: '下一局你打出够级时会飘一句中二霸总台词' },
  { id: 'yuzhi_hu', name: '预制护体', desc: '下一局第一次被抓中要赔牌时，直接免赔一次' },
];

const BABA_LINES = [
  '你的牌，从见到我那一刻就注定要输。',
  '这局，我早就安排好了。',
  '不用谢我，谁让我们是队友呢。',
  '够级这种小场面，我闭着眼都能赢。',
  '你已经在我的掌控之中了。',
];

function pickRandomEquipment() {
  return EQUIPMENT_DEFS[Math.floor(Math.random() * EQUIPMENT_DEFS.length)];
}

function getSeatEquipment(room, seat) {
  if (!room || seat < 0) return null;
  return room.playerEquipment?.[seat] || null;
}

function hasEquip(room, seat, id) {
  const item = getSeatEquipment(room, seat);
  return !!item && item.id === id && !item.used;
}

function markEquipUsed(room, seat) {
  const item = getSeatEquipment(room, seat);
  if (item) item.used = true;
}

function grantConsolationEquipment(room) {
  room.playerEquipment = room.playerEquipment || [null, null, null, null, null, null];
  const rankings = room.game?.rankings || [];
  const loser = rankings.length === 6 ? rankings[5] : -1;
  for (let s = 0; s < 6; s++) {
    if (s !== loser) room.playerEquipment[s] = null;
  }
  if (loser >= 0 && loser <= 5) {
    const item = pickRandomEquipment();
    room.playerEquipment[loser] = { ...item, used: false };
    return { seat: loser, item };
  }
  return null;
}

function fillBotsForRoom(room) {
  if (!room) return;
  room.botMode = true;
  while (room.players.length < 6) {
    const seat = room.players.length;
    room.players.push({
      id: `bot:${room.code}:${seat}`,
      name: BOT_NAMES[seat % BOT_NAMES.length],
      seat,
      isBot: true,
    });
  }
}

// ============ CARD HELPERS ============
function createDeck(deckCount = 6) {
  const deck = [];
  let id = 0;
  const fillerRanks = [5, 7, 9]; // 本地“只留6张3”规则未给替换牌，先用中张补足到54张/副
  for (let d = 0; d < deckCount; d++) {
    deck.push({ rank: 3, suit: d % 4, id: id++ });
    for (let r = 4; r <= 15; r++) {
      for (let s = 0; s < 4; s++) {
        deck.push({ rank: r, suit: s, id: id++ });
      }
    }
    fillerRanks.forEach((rank, idx) => deck.push({ rank, suit: idx % 4, id: id++ }));
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
  return { ...card };
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
  const me = players.find(p => ['梁金', '李昊'].includes((p?.name || '').trim()));
  return me ? me.seat : -1;
}

function getLaotianSeat(players = []) {
  const me = players.find(p => (p?.name || '').trim() === '老田');
  return me ? me.seat : -1;
}

function getTeamSeats(seat) {
  return TEAM_A.includes(seat) ? TEAM_A.slice() : TEAM_B.slice();
}

function getRemainingTeammateSeats(game, seat) {
  return getTeamSeats(seat).filter(s => s !== seat && !game.finished[s]);
}

// 老田金钟罩: invisible to 军师, even though the team-slot logic otherwise
// treats him like any other remaining teammate.
function getVisibleTeammateSeats(room, game, seat) {
  return getRemainingTeammateSeats(game, seat)
    .filter(s => (room.players.find(p => p.seat === s)?.name || '').trim() !== '老田');
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

// 扔牌被抓时优先赔2，没有2再赔小王、大王。
function getPenaltyCardTwoFirst(hand) {
  return getPenaltyCardAboveTwo(hand);
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

const HONEST_TEAMMATE_NAMES = ['刘灿强', '大成'];

// 老好人: if the seat about to pay a penalty has an active teammate named
// 刘灿强 or 大成, they step in and pay instead — with any card of theirs
// (not limited to 2-or-above), since they're just being nice, not following
// the strict rule.
function findHonestTeammate(room, seat) {
  const game = room.game;
  if (!game) return -1;
  // 老田金钟罩: even a teammate's good intentions bounce off — he pays himself.
  if ((room.players.find(p => p.seat === seat)?.name || '').trim() === '老田') return -1;
  const teammates = getTeamSeats(seat).filter(s => s !== seat && !game.finished[s]);
  for (const s of teammates) {
    const name = (room.players.find(p => p.seat === s)?.name || '').trim();
    if (HONEST_TEAMMATE_NAMES.includes(name) && (game.hands[s]?.length || 0) > 0) return s;
  }
  return -1;
}

function getAnyLowestCard(hand) {
  return [...(hand || [])].sort((a, b) => (a.rank !== b.rank) ? a.rank - b.rank : a.suit - b.suit)[0] || null;
}

function applyNaojiPenalty(room, fromSeat, toSeat) {
  const game = room.game;
  if (!game || fromSeat === toSeat) return { ok: false, msg: '无效抓取' };
  if (hasEquip(room, fromSeat, 'yuzhi_hu')) {
    markEquipUsed(room, fromSeat);
    return { ok: true, shielded: true, card: null };
  }
  const honestSeat = findHonestTeammate(room, fromSeat);
  const payerSeat = honestSeat >= 0 ? honestSeat : fromSeat;
  const pay = honestSeat >= 0 ? getAnyLowestCard(game.hands[payerSeat]) : getPenaltyCardAboveTwo(game.hands[payerSeat]);
  if (!pay) {
    return { ok: false, msg: `${room.players.find(p => p.seat === payerSeat)?.name || ('座位' + (payerSeat+1))}没有牌可赔` };
  }
  game.hands[payerSeat] = removeSpecificCards(game.hands[payerSeat], [pay]);
  pushCards(game.hands[toSeat], [pay]);
  sortHand(game.hands[payerSeat]);
  sortHand(game.hands[toSeat]);
  maybeFinishPlayer(game, payerSeat, room);
  stabilizeCurrentPlayer(game);
  return { ok: true, card: pay, honestPayer: honestSeat >= 0 ? honestSeat : null };
}

function applyJiangThrowPenalty(room, fromSeat, toSeat) {
  const game = room.game;
  if (!game || fromSeat === toSeat) return { ok: false, msg: '无效抓取' };
  if (hasEquip(room, fromSeat, 'yuzhi_hu')) {
    markEquipUsed(room, fromSeat);
    return { ok: true, shielded: true, card: null };
  }
  const honestSeat = findHonestTeammate(room, fromSeat);
  const payerSeat = honestSeat >= 0 ? honestSeat : fromSeat;
  const pay = honestSeat >= 0 ? getAnyLowestCard(game.hands[payerSeat]) : getPenaltyCardTwoFirst(game.hands[payerSeat]);
  if (!pay) {
    return { ok: false, msg: `${room.players.find(p => p.seat === payerSeat)?.name || ('座位' + (payerSeat+1))}没有牌可赔`, honestPayer: honestSeat >= 0 ? honestSeat : null };
  }
  game.hands[payerSeat] = removeSpecificCards(game.hands[payerSeat], [pay]);
  pushCards(game.hands[toSeat], [pay]);
  sortHand(game.hands[payerSeat]);
  sortHand(game.hands[toSeat]);
  maybeFinishPlayer(game, payerSeat, room);
  stabilizeCurrentPlayer(game);
  return { ok: true, card: pay, honestPayer: honestSeat >= 0 ? honestSeat : null };
}

function splitJiangThrowGroups(cards) {
  if (!cards || cards.length < 2) return null;
  const groups = new Map();
  for (const card of cards) {
    const k = String(card.rank);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(card);
  }
  if (groups.size !== 2) return null;
  return [...groups.values()].map(group => group.map(cloneCard));
}

function botRankValue(rank) {
  if (rank === 3) return 100;
  if (rank === 4) return 70;
  if (rank === 15) return 80;
  if (rank >= 16) return 90;
  return rank;
}

function botLeadGroupScore(rank, size, handCount) {
  const goujiRisk = size >= goujiThreshold(rank) ? 40 : 0;
  const longGroupPenalty = size >= 4 ? 8 : (size === 3 ? 4 : 0);
  const preserveSingles = handCount <= 6 && size > 1 ? 10 : 0;
  return botRankValue(rank) + goujiRisk + longGroupPenalty + preserveSingles;
}

function botBeatScore(cards, tableCards, requireShao = false) {
  const a = analyzePlay(cards);
  const target = analyzePlay(tableCards);
  if (!a || !target) return Infinity;
  const jokerCost = ((a.bigJokers || 0) * 40) + ((a.smallJokers || 0) * 28);
  const twoCost = (a.twos || 0) * 18;
  const rankCost = a.specialOnly ? (a.baseRank * 3) : (a.baseRank * 2);
  const overkillPenalty = Math.max(0, (a.baseCount || 0) - (target.baseCount || 0)) * 10;
  const burnPenalty = requireShao && !a.hasJoker ? 50 : 0;
  return jokerCost + twoCost + rankCost + overkillPenalty + burnPenalty + cards.length;
}


function chooseTimeoutLeadIds(game, seat) {
  const hand = [...game.hands[seat]].sort((a, b) => (a.rank !== b.rank) ? a.rank - b.rank : a.suit - b.suit);
  const byRankIds = (rank) => hand.filter(c => c.rank === rank).map(c => c.id);
  const rankCounts = new Map();
  hand.forEach((card) => rankCounts.set(card.rank, (rankCounts.get(card.rank) || 0) + 1));

  if (game.activeBurns?.[seat]) {
    if (isExactlyAllRank(hand, 3)) return hand.map(c => c.id);
    const jokers = hand.filter(c => c.rank >= 16);
    if (jokers.length === 0) return [];

    const normalLead = hand.find(c => c.rank >= 5 && c.rank <= 14);
    if (normalLead) {
      const sameRank = byRankIds(normalLead.rank);
      return [...sameRank, jokers[0].id];
    }

    if (jokers.length > 0) {
      const same = hand.filter(c => c.rank === jokers[0].rank).map(c => c.id);
      return same.length ? same : [jokers[0].id];
    }

    return [];
  }

  const leadCandidates = [...rankCounts.entries()]
    .filter(([rank]) => rank !== 3 && rank !== 4 && rank < 15)
    .sort((a, b) => {
      const scoreA = botLeadGroupScore(a[0], a[1], hand.length);
      const scoreB = botLeadGroupScore(b[0], b[1], hand.length);
      return scoreA !== scoreB ? scoreA - scoreB : a[0] - b[0];
    });
  if (leadCandidates.length) return byRankIds(leadCandidates[0][0]);

  const fours = hand.filter(c => c.rank === 4);
  if (fours.length > 0) return fours.map(c => c.id);

  const twos = hand.filter(c => c.rank === 15);
  if (twos.length > 0) return twos.map(c => c.id);

  const jokers = hand.filter(c => c.rank >= 16);
  if (jokers.length > 0) return [jokers[0].id];

  const threes = hand.filter(c => c.rank === 3);
  if (threes.length > 0 && threes.length === hand.length) {
    const check = canPlayFinalThree(game, seat, threes, []);
    if (check.ok) return threes.map(c => c.id);
  }
  return [];
}

function chooseAutoBeatIds(game, seat, tableCards, requireShao = false) {
  const hand = [...(game?.hands?.[seat] || [])];
  const target = analyzePlay(tableCards);
  if (!target) return [];
  const byRank = new Map();
  hand.forEach((card) => {
    if (!byRank.has(card.rank)) byRank.set(card.rank, []);
    byRank.get(card.rank).push(card);
  });
  const takeIds = (rank, count) => (byRank.get(rank) || []).slice(0, count).map(card => card.id);
  const need = target.count;
  const rankCandidates = target.specialOnly ? [15, 16, 17] : [target.baseRank, 15, 16, 17, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4];
  let best = null;
  let bestScore = Infinity;

  for (const baseRank of rankCandidates) {
    const maxBase = baseRank >= 15 ? 0 : Math.min((byRank.get(baseRank) || []).length, need);
    const baseStart = baseRank >= 15 ? 0 : 1;
    for (let useBase = maxBase; useBase >= baseStart; useBase--) {
      const remain1 = need - useBase;
      if (remain1 < 0) continue;
      const maxTwo = Math.min((byRank.get(15) || []).length, remain1);
      for (let useTwo = maxTwo; useTwo >= 0; useTwo--) {
        const remain2 = remain1 - useTwo;
        const maxSmall = Math.min((byRank.get(16) || []).length, remain2);
        for (let useSmall = maxSmall; useSmall >= 0; useSmall--) {
          const remain3 = remain2 - useSmall;
          const maxBig = Math.min((byRank.get(17) || []).length, remain3);
          for (let useBig = maxBig; useBig >= 0; useBig--) {
            if (useBase + useTwo + useSmall + useBig !== need) continue;
            const ids = [
              ...takeIds(baseRank, useBase),
              ...takeIds(15, useTwo),
              ...takeIds(16, useSmall),
              ...takeIds(17, useBig),
            ];
            if (new Set(ids).size !== ids.length) continue;
            const cards = takeCardsByIds(hand, ids);
            if (cards.length !== need) continue;
            if (!canBeat(cards, tableCards)) continue;
            if (requireShao && !isShaoPlay(cards)) continue;
            const score = botBeatScore(cards, tableCards, requireShao);
            if (score < bestScore) {
              bestScore = score;
              best = ids;
            }
          }
        }
      }
    }
  }

  if (!best && !requireShao && target.count === 1 && target.bigJokers === 1 && (byRank.get(17) || []).length >= 2) return takeIds(17, 2);
  return best || [];
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (room.game) room.game.turnEndsAt = 0;
}

function clearReturnTimer(room) {
  if (room.returnTimer) {
    clearTimeout(room.returnTimer);
    room.returnTimer = null;
  }
  if (room.game) room.game.returnEndsAt = 0;
}

function clearBotTimer(room) {
  if (room?.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
}

function getCurrentReturnTask(game) {
  if (!game || !Array.isArray(game.returnTasks)) return null;
  return game.returnTasks.find(t => !t.done) || null;
}

function getCurrentBuyFourTask(game) {
  if (!game || !Array.isArray(game.buyFourTasks)) return null;
  return game.buyFourTasks.find(t => !t.done) || null;
}

function finalizeReturnTask(room, task, selectedCards, auto = false) {
  const game = room.game;
  if (!game || !task) return false;
  game.hands[task.owedBy] = removeSpecificCards(game.hands[task.owedBy], selectedCards);
  const delivered = selectedCards.map(c => ({ ...cloneCard(c), tributeReceived: false }));
  pushCards(game.hands[task.to], delivered);
  sortHand(game.hands[task.owedBy]);
  sortHand(game.hands[task.to]);
  task.back = delivered.map(cardText);
  task.done = true;
  task.auto = !!auto;
  const item = (game.tributeLog || []).find(x => x.id === task.itemId);
  if (item) item.back = task.back.slice();
  clearReturnTimer(room);
  const nextTask = getCurrentReturnTask(game);
  if (nextTask) scheduleReturnTimer(room);
  else scheduleTurnTimer(room);
  return true;
}

function handleReturnTimeout(room) {
  if (!room || !room.game || room.state !== 'playing') return;
  const game = room.game;
  const task = getCurrentReturnTask(game);
  if (!task) return;
  const chosen = getLowestCards(game.hands[task.owedBy] || [], task.count);
  finalizeReturnTask(room, task, chosen, true);
  io.to(room.code).emit('toast_msg', { msg: `${getSeatPlayerName(room, task.owedBy)} 还贡超时，已自动返还最小牌` });
  broadcastState(room);
}

function scheduleReturnTimer(room) {
  clearReturnTimer(room);
  clearTurnTimer(room);
  if (!room || !room.game || room.state !== 'playing') return;
  const task = getCurrentReturnTask(room.game);
  if (!task) return;
  room.game.returnEndsAt = Date.now() + 12000;
  room.returnTimer = setTimeout(() => handleReturnTimeout(room), 12050);
}

function scheduleTurnTimer(room) {
  if (room?.game && room.state === 'playing') {
    ensureTurnSeatValid(room);
    if (maybeGameOver(room.game)) { finishGame(room); return; }
    const g = room.game;
    const task = getCurrentBuyFourTask(g);
    const key = JSON.stringify([g.roundNumber, task ? ['buy', task.buyer, g.buyFourTasks.indexOf(task)] : ['play', g.currentPlayer, g.canKaiDian, g.tablePlay?.player, g.tablePlay?.cards.map(c => c.id)]]);
    if (room.turnTimer && g.turnTimerKey === key && g.turnEndsAt > Date.now()) return;
    clearTurnTimer(room);
    g.turnTimerKey = key;
  } else clearTurnTimer(room);
  if (!room || !room.game || room.state !== 'playing') return;
  if (getCurrentReturnTask(room.game)) return;
  const buyFourTask = getCurrentBuyFourTask(room.game);
  if (buyFourTask) {
    room.game.currentPlayer = buyFourTask.buyer;
    room.game.turnEndsAt = Date.now() + 12000;
    room.turnTimer = setTimeout(() => handleTurnTimeout(room), 12050);
    return;
  }
  ensureTurnSeatValid(room);
  const game = room.game;
  if (game.currentPlayer < 0 || game.finished[game.currentPlayer]) return;
  game.turnEndsAt = Date.now() + 20000;
  room.turnTimer = setTimeout(() => handleTurnTimeout(room), 20050);
}

function handleTurnTimeout(room) {
  if (!room || !room.game || room.state !== 'playing') return;
  if (getCurrentReturnTask(room.game)) { scheduleReturnTimer(room); return; }
  const buyFourTask = getCurrentBuyFourTask(room.game);
  if (buyFourTask) {
    finalizeBuyFourTask(room, buyFourTask, false);
    io.to(room.code).emit('toast_msg', { msg: `${getSeatPlayerName(room, buyFourTask.buyer)} 买4超时，已自动跳过` });
    broadcastState(room);
    return;
  }
  const game = room.game;
  const seat = game.currentPlayer;
  const playerName = room.players.find(p => p.seat === seat)?.name || ('座位' + (seat + 1));
  let result = null;

  if (game.canKaiDian === seat) {
    result = processPass(room, seat);
    io.to(room.code).emit('toast_msg', { msg: `${playerName} 超时，自动过牌` });
  } else if (game.activeBurns?.[seat]) {
    // A burning player is not allowed to pass (processPass rejects it), so the
    // old code (which routed any tablePlay-truthy timeout straight to
    // processPass) would fail forever here and re-schedule the same 20s timer
    // on every timeout — a permanent stuck turn if this player never acts.
    // Mirror the bot's handling instead: auto-continue the burn if possible,
    // otherwise fail the burn out so the game can move on.
    const autoIds = chooseTimeoutLeadIds(game, seat);
    if (autoIds.length > 0) {
      result = processPlay(room, seat, autoIds);
      io.to(room.code).emit('toast_msg', { msg: `${playerName} 超时，已自动续烧` });
      io.to(room.code).emit('sound_cue', { type: getSoundCueForLastAction(room, seat, result) });
    } else {
      maybeFailActiveBurnAtTurnStart(room, seat);
      io.to(room.code).emit('toast_msg', { msg: `${playerName} 超时，烧牌失败` });
      result = { ok: true };
    }
  } else if (game.tablePlay) {
    result = processPass(room, seat);
    io.to(room.code).emit('toast_msg', { msg: `${playerName} 超时，自动过牌` });
  } else {
    const autoIds = chooseTimeoutLeadIds(game, seat);
    if (autoIds.length > 0) {
      result = processPlay(room, seat, autoIds);
      io.to(room.code).emit('toast_msg', { msg: `${playerName} 超时，已自动出牌` });
      io.to(room.code).emit('sound_cue', { type: getSoundCueForLastAction(room, seat, result) });
    } else {
      const next = nextActiveSeat(game, seat);
      game.playerActions[seat] = { type: 'timeout' };
      if (next >= 0 && next !== seat) game.currentPlayer = next;
      result = { ok: true };
      io.to(room.code).emit('toast_msg', { msg: `${playerName} 超时，跳过本轮领牌` });
    }
  }

  if (!result || !result.ok) { scheduleTurnTimer(room); return; }
  if (result.gameOver || maybeGameOver(game)) { finishGame(room); return; }
  scheduleTurnTimer(room);
  broadcastState(room);
}

function processNaoji(room, seat) {
  const game = room.game;
  if (!game || room.state !== 'playing') return { ok: false, msg: '游戏未开始' };
  if (getCurrentBuyFourTask(game)) return { ok: false, msg: '买4阶段不能孬急' };
  if (game.finished[seat]) return { ok: false, msg: '你已经出完，不能再孬急' };
  if ((game.naojiUses[seat] || 0) >= (game.naojiMax[seat] || 5)) return { ok: false, msg: '孬急次数已用完' };

  pruneGrabClicks(game);
  const candidates = buildNaojiCandidates(game, seat);
  if (!candidates.length) return { ok: false, msg: '没有可抽的牌' };

  // 爱你老己: the first 孬急 this round always lands the single highest-rank
  // candidate card instead of a random one. 老田金钟罩: his hand is never the
  // guaranteed target — if only his cards qualify, fall back to random.
  let pick;
  if (hasEquip(room, seat, 'aini_laoji')) {
    const eligible = candidates.filter(c => !(c.source === 'hand' && (room.players.find(p => p.seat === c.fromSeat)?.name || '').trim() === '老田'));
    const pool = eligible.length ? eligible : candidates;
    pick = pool.reduce((best, c) => (!best || c.card.rank > best.card.rank) ? c : best, null);
    markEquipUsed(room, seat);
  } else {
    pick = candidates[Math.floor(Math.random() * candidates.length)];
  }
  let got = null;
  let sourceName = '已出牌区';

  if (pick.source === 'hand') {
    const fromSeat = pick.fromSeat;
    const res = removeOneCardById(game.hands[fromSeat], pick.card.id);
    if (!res.removed) return { ok: false, msg: '抽牌失败，请重试' };
    game.hands[fromSeat] = res.kept;
    got = res.removed;
    sourceName = room.players.find(p => p.seat === fromSeat)?.name || ('座位' + (fromSeat + 1));
    maybeFinishPlayer(game, fromSeat, room);
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
  if (getCurrentBuyFourTask(game)) return { ok: false, msg: '买4阶段不能抓牌' };
  if (game.finished[seat]) return { ok: false, msg: '你已经出完，不能再抓' };

  const now = Date.now();
  pruneGrabClicks(game, now);
  game.recentGrabClicks.push({ seat, time: now });

  const results = [];
  for (const window of game.activeNaojiWindows) {
    if (seat === window.seat) continue;
    if (now > window.expiresAt || now < window.startAt - 2000) continue;
    if (window.paidTo.includes(seat)) continue;
    const payRes = (window.type === 'throw2')
      ? applyJiangThrowPenalty(room, window.seat, seat)
      : applyNaojiPenalty(room, window.seat, seat);
    window.paidTo.push(seat);
    results.push({ fromSeat: window.seat, toSeat: seat, windowType: window.type || 'naoji', ...payRes });
  }

  return { ok: true, results };
}

function processPeek(room, seat) {
  const game = room.game;
  if (!game || room.state !== 'playing') return { ok: false, msg: '游戏未开始' };
  if (getCurrentBuyFourTask(game)) return { ok: false, msg: '买4阶段不能验牌' };
  const me = room.players.find(p => p.seat === seat);
  if ((me?.name || '').trim() !== '张哲' && !hasEquip(room, seat, 'yanpai')) return { ok: false, msg: '只有张哲可以使用验牌' };
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

  // 老田金钟罩: 验牌看不到他的牌，反而他能偷看一眼张哲的牌。
  const reflectedSeats = [];
  const buildSide = (targetSeat, label) => {
    const targetName = (room.players.find(p => p.seat === targetSeat)?.name || '').trim();
    if (targetName === '老田') {
      const laotianId = room.players.find(p => p.seat === targetSeat)?.id;
      if (laotianId) {
        io.to(laotianId).emit('peek_result', {
          expiresAt: now + 3000,
          displayMs: 3000,
          noteOverride: `🛡️ 金钟罩反弹：偷看了 ${getSeatPlayerName(room, seat)} 的牌`,
          sides: [{ seat, side: '反弹', name: getSeatPlayerName(room, seat), cards: game.hands[seat].map(cloneCard) }],
        });
      }
      reflectedSeats.push(targetSeat);
      return { seat: targetSeat, side: label, name: getSeatPlayerName(room, targetSeat), cards: [], blocked: true };
    }
    return { seat: targetSeat, side: label, name: getSeatPlayerName(room, targetSeat), cards: game.hands[targetSeat].map(cloneCard) };
  };

  return {
    ok: true,
    penalties: penaltyLogs,
    uses: game.peekUses[seat],
    max: game.peekMax[seat],
    expiresAt: now + 3000,
    displayMs: 3000,
    reflectedSeats,
    sides: [
      buildSide(leftSeat, '左侧'),
      buildSide(rightSeat, '右侧'),
    ],
  };
}

function processJiangThrow(room, seat, cardIds) {
  const game = room.game;
  if (!game || room.state !== 'playing') return { ok: false, msg: '游戏未开始' };
  if (getCurrentBuyFourTask(game)) return { ok: false, msg: '买4阶段不能扔牌' };
  const me = room.players.find(p => p.seat === seat);
  if ((me?.name || '').trim() !== '姜海涛') return { ok: false, msg: '只有姜海涛可以使用扔牌' };
  if (game.finished[seat]) return { ok: false, msg: '你已经出完了，不能再扔牌' };
  if ((game.jiangThrowUses?.[seat] || 0) >= (game.jiangThrowMax?.[seat] || 0)) return { ok: false, msg: '扔牌次数已用完' };
  if ((activeSeats(game).length || 0) <= 2) return { ok: false, msg: '场上剩余人数必须大于2人才能扔牌' };
  if (getCurrentReturnTask(game)) return { ok: false, msg: '还贡阶段不能扔牌' };

  const hand = game.hands[seat] || [];
  const cards = takeCardsByIds(hand, cardIds || []);
  if (cards.length !== (cardIds || []).length) return { ok: false, msg: '无效的牌' };

  const groups = splitJiangThrowGroups(cards);
  if (!groups) return { ok: false, msg: '必须恰好选择两组牌（两种点数）' };

  game.hands[seat] = removeSpecificCards(hand, cards);
  game.playedPool.push(...cards.map(c => ({ ...cloneCard(c), hiddenThrow: true })));
  sortHand(game.hands[seat]);
  game.jiangThrowUses[seat] = (game.jiangThrowUses[seat] || 0) + 1;

  pruneGrabClicks(game);
  const now = Date.now();
  const window = {
    id: ++game.naojiWindowSeq,
    type: 'throw2',
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
    const payRes = applyJiangThrowPenalty(room, seat, gSeat);
    window.paidTo.push(gSeat);
    penaltyLogs.push({ target: gSeat, ...payRes });
  }

  game.activeNaojiWindows.push(window);
  maybeFinishPlayer(game, seat, room);
  stabilizeCurrentPlayer(game);

  return {
    ok: true,
    penalties: penaltyLogs,
    uses: game.jiangThrowUses[seat],
    max: game.jiangThrowMax[seat],
    removedCount: cards.length,
    groups: groups.map(g => g.map(cardText)),
  };
}

function processStrategistView(room, seat) {
  const game = room.game;
  if (!game || room.state !== 'playing') return { ok: false, msg: '游戏未开始' };
  const me = room.players.find(p => p.seat === seat);
  if ((me?.name || '').trim() !== '陈杰') return { ok: false, msg: '只有陈杰可以使用狗头军师' };
  if (!game.finished[seat]) return { ok: false, msg: '只有走了之后才能发动狗头军师' };
  // 老田金钟罩: he's invisible to 军师 too. (No reversal here — 陈杰 is already
  // out of cards at this point, so there's nothing meaningful to reflect.)
  const mateSeats = getVisibleTeammateSeats(room, game, seat);
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

function applyLuckyBuff(hands, luckySeat, laotianSeat = -1) {
  if (luckySeat < 0 || !hands[luckySeat]) return { reflected: false };
  const isHigh = c => c.rank >= 10;
  const rate = 0.10 + Math.random() * 0.05;
  const targetExtra = Math.max(1, Math.round(54 * rate));
  // 老田金钟罩: he's never picked as a donor for the lucky buff.
  const donorSeats = [0,1,2,3,4,5].filter(s => s !== luckySeat && s !== laotianSeat);
  let upgrades = 0;
  while (upgrades < targetExtra) {
    const myLow = hands[luckySeat].filter(c => c.rank > 3 && c.rank < 10).sort((a, b) => (a.rank !== b.rank) ? a.rank - b.rank : a.suit - b.suit);
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

  // ...and trying it on him backfires: one reversed exchange where the lucky
  // seat loses a high card to 老田 instead, no matter how the loop above went.
  let reflected = false;
  if (laotianSeat >= 0 && laotianSeat !== luckySeat && (hands[laotianSeat]?.length || 0) > 0) {
    const myLow = hands[laotianSeat].filter(c => c.rank !== 3).sort((a, b) => (a.rank !== b.rank) ? a.rank - b.rank : a.suit - b.suit)[0];
    const theirHigh = [...hands[luckySeat]].filter(isHigh).sort((a, b) => (a.rank !== b.rank) ? b.rank - a.rank : a.suit - b.suit)[0];
    if (myLow && theirHigh) {
      hands[laotianSeat] = removeSpecificCards(hands[laotianSeat], [myLow]);
      hands[luckySeat] = removeSpecificCards(hands[luckySeat], [theirHigh]);
      pushCards(hands[laotianSeat], [theirHigh]);
      pushCards(hands[luckySeat], [myLow]);
      sortHand(hands[laotianSeat]);
      sortHand(hands[luckySeat]);
      reflected = true;
    }
  }
  return { reflected };
}

function deal(cheatSeat = -1, luckySeat = -1, laotianSeat = -1) {
  const fullDeck = createDeck(6);
  const threes = fullDeck.filter(c => c.rank === 3);
  const deck = fullDeck.filter(c => c.rank !== 3);
  shuffle(deck);
  shuffle(threes);
  const hands = [[], [], [], [], [], []];

  if (cheatSeat >= 0) {
    const good = deck.filter(c => c.rank >= 12);
    const normal = deck.filter(c => c.rank < 12);
    shuffle(good);
    shuffle(normal);

    const goodCount = 36 + Math.floor(Math.random() * 6);
    const myGood = good.splice(0, Math.min(goodCount, good.length));
    const myNormal = normal.splice(0, 53 - myGood.length);
    hands[cheatSeat] = [...myGood, ...myNormal];

    const remaining = [...good, ...normal];
    shuffle(remaining);
    let idx = 0;
    for (let i = 0; i < 6; i++) {
      if (i === cheatSeat) continue;
      hands[i] = remaining.slice(idx, idx + 53);
      idx += 53;
    }
  } else {
    for (let i = 0; i < 6; i++) {
      hands[i] = deck.slice(i * 53, (i + 1) * 53);
    }
  }

  hands.forEach((hand, seat) => hand.push(threes[seat]));
  if (luckySeat >= 0 && luckySeat !== cheatSeat) applyLuckyBuff(hands, luckySeat, laotianSeat);
  hands.forEach(sortHand);
  return hands;
}

// ============ ANALYZE PLAY ============
function analyzePlay(cards) {
  if (!cards || cards.length === 0) return null;
  const normals = cards.filter(c => c.rank >= 3 && c.rank <= 14);
  const twos = cards.filter(c => c.rank === 15).length;
  const smallJ = cards.filter(c => c.rank === 16).length;
  const bigJ = cards.filter(c => c.rank === 17).length;

  if (normals.length === 0) {
    const totalSpecial = twos + smallJ + bigJ;
    if (totalSpecial === 0) return null;
    const baseRank = bigJ > 0 ? 17 : (smallJ > 0 ? 16 : 15);
    return {
      count: cards.length,
      baseRank,
      baseCount: 0,
      coreCount: 0,
      flowerCount: totalSpecial,
      hasJoker: (smallJ + bigJ) > 0,
      bigJokers: bigJ,
      smallJokers: smallJ,
      twos,
      specialOnly: true,
    };
  }

  const baseRank = normals[0].rank;
  if (normals.some(c => c.rank !== baseRank)) return null;

  return {
    count: cards.length,
    baseRank,
    baseCount: normals.length + twos,
    coreCount: normals.length + twos,
    flowerCount: twos + smallJ + bigJ,
    hasJoker: (smallJ + bigJ) > 0,
    bigJokers: bigJ,
    smallJokers: smallJ,
    twos,
    specialOnly: false,
  };
}

function isValidPlay(cards) {
  return analyzePlay(cards) !== null;
}

function isSpecialOnlyPlay(input) {
  const a = input && input.count !== undefined ? input : analyzePlay(input);
  return !!a && !!a.specialOnly;
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

function isPureGoujiPlay(cards, thresholdOverride = null) {
  const a = analyzePlay(cards);
  if (!a) return false;
  if (a.baseRank >= 16) return a.flowerCount === 0 && a.twos === 0;
  const need = thresholdOverride != null ? thresholdOverride : goujiThreshold(a.baseRank);
  return a.flowerCount === 0 && a.twos === 0 && a.smallJokers === 0 && a.bigJokers === 0 && a.baseCount >= need;
}

function isGoujiPlay(cards, thresholdOverride = null) {
  const a = analyzePlay(cards);
  if (!a) return false;
  if (a.baseRank >= 16) return true;
  if (a.baseRank === 15) return true;
  const need = thresholdOverride != null ? thresholdOverride : goujiThreshold(a.baseRank);
  return a.coreCount >= need;
}

function isShaoPlay(cards) {
  const a = analyzePlay(cards);
  return !!a && !a.specialOnly && a.hasJoker;
}

function compareMixedPlay(a, t) {
  if (a.baseRank !== t.baseRank) return a.baseRank > t.baseRank;
  if ((a.baseCount || 0) !== (t.baseCount || 0)) return (a.baseCount || 0) > (t.baseCount || 0);
  if ((a.bigJokers || 0) !== (t.bigJokers || 0)) return (a.bigJokers || 0) > (t.bigJokers || 0);
  if ((a.smallJokers || 0) !== (t.smallJokers || 0)) return (a.smallJokers || 0) > (t.smallJokers || 0);
  return false;
}

function canBeat(cards, tableCards) {
  const a = analyzePlay(cards);
  const t = analyzePlay(tableCards);
  if (!a || !t) return false;

  if (t.count === 1 && (t.bigJokers || 0) === 1 && (a.bigJokers || 0) === 2 && cards.length === 2) return true;
  if (a.count !== t.count) return false;

  if (a.specialOnly && t.specialOnly) {
    // Each special card must beat its counterpart; a spare 2 cannot cover another 2.
    const ascending = list => list.map(c => c.rank).sort((x, y) => x - y);
    const ours = ascending(cards), theirs = ascending(tableCards);
    return ours.every((rank, i) => rank > theirs[i]);
  }
  if (a.specialOnly && !t.specialOnly) {
    const pseudo = { baseRank: a.baseRank, baseCount: 0, twos: a.twos || 0, smallJokers: a.smallJokers || 0, bigJokers: a.bigJokers || 0 };
    return compareMixedPlay(pseudo, t);
  }
  if (!a.specialOnly && t.specialOnly) {
    const pseudo = { baseRank: t.baseRank, baseCount: 0, twos: t.twos || 0, smallJokers: t.smallJokers || 0, bigJokers: t.bigJokers || 0 };
    return compareMixedPlay(a, pseudo);
  }

  return compareMixedPlay(a, t);
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

  if (target.specialOnly || target.baseRank >= 16 || target.baseRank === 15) {
    for (let useBig = 0; useBig <= Math.min(cnt[17] || 0, need); useBig++) {
      for (let useSmall = 0; useSmall <= Math.min(cnt[16] || 0, need - useBig); useSmall++) {
        const useTwo = need - useBig - useSmall;
        if (useTwo < 0 || useTwo > (cnt[15] || 0)) continue;
        if (useBig + useSmall + useTwo !== need) continue;
        const cards = makeVirtualCards(15, 0, useTwo, useSmall, useBig);
        if (canBeat(cards, tableCards)) return true;
      }
    }
    return false;
  }

  for (let baseRank = target.baseRank; baseRank <= 14; baseRank++) {
    const maxBase = cnt[baseRank] || 0;
    for (let useBase = 1; useBase <= Math.min(maxBase, need); useBase++) {
      const remain1 = need - useBase;
      const maxTwo = Math.min(cnt[15] || 0, remain1);
      for (let useTwo = 0; useTwo <= maxTwo; useTwo++) {
        const remain2 = remain1 - useTwo;
        const maxSmall = Math.min(cnt[16] || 0, remain2);
        for (let useSmall = 0; useSmall <= maxSmall; useSmall++) {
          const remain3 = remain2 - useSmall;
          const maxBig = Math.min(cnt[17] || 0, remain3);
          for (let useBig = 0; useBig <= maxBig; useBig++) {
            if (useBase + useTwo + useSmall + useBig != need) continue;
            const cards = makeVirtualCards(baseRank, useBase, useTwo, useSmall, useBig);
            if (canBeat(cards, tableCards)) return true;
          }
        }
      }
    }
  }
  return false;
}

function canPlayFinalThree(game, seat, cards, remainingAfterPlay, room = null) {
  if (!cards.some(c => c.rank === 3)) return { ok: true };
  if (!isExactlyAllRank(cards, 3)) return { ok: false, msg: '3不能搭配其他牌' };
  // 如何呢又能怎: this round, the equipped seat can dump 3s any time — no
  // need to wait for their literal last hand. Purely a legality-gate bypass;
  // the cards still flow through the normal play/beat pipeline afterward.
  if (room && hasEquip(room, seat, 'ruhe_ne')) return { ok: true };
  if (remainingAfterPlay.length !== 0) return { ok: false, msg: '3只能作为最后一手牌打出' };
  if (game.tablePlay && !game.activeBurns?.[seat]) return { ok: false, msg: '3只能在新一轮作为最后一手牌打出' };
  return { ok: true };
}

function nextActiveSeat(game, fromSeat) {
  for (let i = 1; i <= 6; i++) {
    const s = (fromSeat - i + 6) % 6;
    if (!game.finished[s] && !game.passedThisRound.includes(s)) return s;
  }
  return -1;
}

function nextActiveSeatIgnorePass(game, fromSeat) {
  for (let i = 1; i <= 6; i++) {
    const s = (fromSeat - i + 6) % 6;
    if (!game.finished[s]) return s;
  }
  return -1;
}

function pickCounterClockwiseStarter(game, preferredSeat) {
  if (!game) return -1;
  if (preferredSeat >= 0 && !game.finished[preferredSeat]) return preferredSeat;
  const next = nextActiveSeatIgnorePass(game, preferredSeat >= 0 ? preferredSeat : 0);
  if (next >= 0) return next;
  const active = activeSeats(game);
  return active.length ? active[0] : -1;
}

function activeSeats(game) {
  return [0,1,2,3,4,5].filter(s => !game.finished[s]);
}

function getNoHeadSeat(game) {
  if (!game || !Array.isArray(game.rankings) || game.rankings.length < 1) return -1;
  return (game.rankings[0] + 3) % 6;
}

function isChaosPhase(game) {
  return !!game && (game.rankings?.length || 0) >= 2;
}

function useGoujiRestrictions(game, attacker, responder = -1) {
  if (!game) return false;
  if (isChaosPhase(game)) return false;
  const noHead = getNoHeadSeat(game);
  if (noHead >= 0 && (attacker === noHead || responder === noHead)) return false;
  return true;
}

function burnSortWeight(attacker, seat) {
  return (attacker - seat + 6) % 6;
}

function buildBurnQueue(game, attacker) {
  const opposite = (attacker + 3) % 6;
  const seats = activeSeats(game).filter(s => s !== attacker && s !== opposite);
  const mates = seats.filter(s => sameTeam(s, attacker)).sort((a, b) => burnSortWeight(attacker, a) - burnSortWeight(attacker, b));
  const others = seats.filter(s => !sameTeam(s, attacker)).sort((a, b) => burnSortWeight(attacker, a) - burnSortWeight(attacker, b));
  return [...mates, ...others];
}

function nextBurnResponder(game) {
  if (!game?.isGoujiMode) return -1;
  if ((activeSeats(game).length || 0) < 5) return game.goujiPair?.[1] ?? -1;
  for (const s of (game.burnQueue || [])) {
    if (game.finished[s] || game.passedThisRound.includes(s)) continue;
    // 非对头想管够级时走烧牌；若其仍持有未处理的4，则不满足烧牌条件，自动跳过。
    if (hasPendingUnplayedFourProtection(game, s)) {
      game.passedThisRound.push(s);
      game.playerActions[s] = { type: 'pass', autoSkip: true, reason: 'has4_no_burn' };
      continue;
    }
    return s;
  }
  const opposite = game.goujiPair?.[1] ?? -1;
  // 对头正常管牌，不参与“有4自动跳过”的烧牌限制。
  if (opposite >= 0 && !game.finished[opposite] && !game.passedThisRound.includes(opposite)) return opposite;
  return -1;
}

function isResponderOpposite(prevPlayer, seat) {
  return ((prevPlayer + 3) % 6) === seat;
}

function hasAnyJoker(hand) {
  return hand.some(c => c.rank >= 16);
}

function maybeFailActiveBurnAtTurnStart(room, seat) {
  const game = room?.game;
  if (!game || seat < 0 || game.finished[seat]) return false;
  if (!game.activeBurns?.[seat]) return false;
  const hand = game.hands[seat] || [];
  if (hasAnyJoker(hand)) return false;
  if (hand.length > 0 && hand.every(c => c.rank === 3)) return false;
  markBurnFailure(room, seat, -1);
  return true;
}

function ensureTurnSeatValid(room) {
  const game = room?.game;
  if (!game) return;
  let guard = 0;
  while (game.currentPlayer >= 0 && guard < 8) {
    guard++;
    if (!game.finished[game.currentPlayer] && !maybeFailActiveBurnAtTurnStart(room, game.currentPlayer)) break;
    if (maybeGameOver(game)) break;
    const next = nextActiveSeat(game, game.currentPlayer);
    game.currentPlayer = next === -1 ? pickCounterClockwiseStarter(game, game.currentPlayer) : next;
  }
}

function finalizeFailedLastQueue(game) {
  if (!game || !Array.isArray(game.failedLastQueue)) return;
  game.failedLastQueue.forEach(seat => {
    if (!game.rankings.includes(seat)) game.rankings.push(seat);
  });
}

function markBurnFailure(room, seat, bySeat = -1) {
  const game = room?.game;
  if (!game) return false;
  if (seat < 0 || seat > 5) return false;
  if (game.finished[seat]) return false;
  game.finished[seat] = true;
  game.rankings = game.rankings.filter(s => s !== seat);
  game.failedLastQueue = game.failedLastQueue || [];
  if (!game.failedLastQueue.includes(seat)) game.failedLastQueue.push(seat);
  game.playerActions[seat] = { type: 'burn_fail', bySeat };
  game.passedThisRound = game.passedThisRound.filter(s => s !== seat);
  if (game.currentPlayer === seat) {
    const next = pickCounterClockwiseStarter(game, seat);
    game.currentPlayer = next ?? -1;
  }
  if (game.menCandidate?.seat === seat) game.menCandidate = null;
  if (game.activeBurns?.[seat]) game.activeBurns[seat] = null;
  return true;
}

function allFoursSelectedIfKaiDian(hand, cards) {
  const all4 = hand.filter(c => c.rank === 4);
  return all4.length > 0 && cards.length === all4.length && cards.every(c => c.rank === 4);
}

function allFoursSelectedIfPlayingFour(hand, cards) {
  if (!cards.some(c => c.rank === 4)) return true;
  const all4 = hand.filter(c => c.rank === 4);
  return all4.length > 0 && cards.length === all4.length && cards.every(c => c.rank === 4);
}

function isSeatResolvedForPass(game, seat) {
  return !!game.finished?.[seat] || game.passedThisRound.includes(seat);
}

function previousTwoPassedForSeat(game, seat, targetPlayer) {
  const p1 = (targetPlayer + 1) % 6;
  const p2 = (targetPlayer + 2) % 6;
  return isSeatResolvedForPass(game, p1) && isSeatResolvedForPass(game, p2) && seat === (targetPlayer + 3) % 6;
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
  game.pendingShao = null;
  game.menCandidate = null;
  game.letSeat = -1;
  game.letAwaitingReturn = false;
  game.burnQueue = [];
  return logs;
}

function canTriggerKaiDian(game, seat) {
  if (!game || game.finished[seat]) return false;
  if ((activeSeats(game).length || 0) < 5) return false;
  const duiTou = (seat + 3) % 6;
  if (game.finished[duiTou]) return false;
  if (countRank(game.hands[seat], 4) <= 0) return false;
  if (game.openedDian?.[seat]) return false;
  if (game.lostKaiDian?.[seat]) return false;
  if (!game.tablePlay?.isPureGouji) return false;
  return true;
}

function hasPendingUnplayedFourProtection(game, seat) {
  if (!game || game.finished?.[seat]) return false;
  if ((activeSeats(game).length || 0) < 5) return false;
  if (game.openedDian?.[seat]) return false;
  if (game.lostKaiDian?.[seat]) return false;
  return countRank(game.hands?.[seat] || [], 4) > 0;
}

function getBurnOppositeSeat(game, burnerSeat) {
  if (!game?.activeBurns?.[burnerSeat]) return -1;
  return (burnerSeat + 3) % 6;
}

function canVictimFanShao(game, burnerSeat) {
  const info = game?.activeBurns?.[burnerSeat];
  if (!info) return false;
  const victim = info.victim;
  if (victim < 0 || game.finished[victim]) return false;
  if (hasPendingUnplayedFourProtection(game, victim)) return false;
  return true;
}

function canSeatTakeOverBurn(game, burnerSeat, seat) {
  const info = game?.activeBurns?.[burnerSeat];
  if (!info) return false;
  if (seat < 0 || seat === burnerSeat || game.finished[seat]) return false;
  if (sameTeam(seat, burnerSeat)) return false;
  if (seat === getBurnOppositeSeat(game, burnerSeat)) return false;
  if (seat === info.victim) return false;
  if (hasPendingUnplayedFourProtection(game, seat)) return false;
  return true;
}

function getEligibleRespondersToBurn(game, burnerSeat) {
  const info = game?.activeBurns?.[burnerSeat];
  if (!info) return [];
  const responders = [];
  const opp = getBurnOppositeSeat(game, burnerSeat);
  if (opp >= 0 && !game.finished[opp] && !game.passedThisRound.includes(opp)) responders.push(opp);
  const victim = info.victim;
  if (canVictimFanShao(game, burnerSeat) && !game.passedThisRound.includes(victim)) responders.push(victim);
  for (const seat of activeSeats(game)) {
    if (canSeatTakeOverBurn(game, burnerSeat, seat) && !game.passedThisRound.includes(seat)) responders.push(seat);
  }
  return responders;
}

function stabilizeCurrentPlayer(game) {
  if (!game) return;
  if (game.currentPlayer >= 0 && game.finished[game.currentPlayer]) {
    const active = activeSeats(game);
    if (active.length > 0) game.currentPlayer = pickCounterClockwiseStarter(game, game.currentPlayer);
  }
}

function resetRound(game, starter) {
  game.tablePlay = null;
  game.passedThisRound = [];
  game.isGoujiMode = false;
  game.goujiPair = [-1, -1];
  game.burnQueue = [];
  game.pendingShao = null;
  game.canKaiDian = -1;
  game.letSeat = -1;
  game.letAwaitingReturn = false;
  game.currentPlayer = starter;
  game.playerActions = [{},{},{},{},{},{}];
  return { ok: true, newRound: true };
}

function maybeFinishPlayer(game, seat, room = null) {
  if (!game.finished[seat] && game.hands[seat].length === 0) {
    game.finished[seat] = true;
    game.rankings.push(seat);
    if (room && game.activeBurns?.[seat]) {
      const victim = game.activeBurns[seat].victim;
      if (victim >= 0) room.burnTributeDebt[victim] = (room.burnTributeDebt[victim] || 0) + 1;
      game.activeBurns[seat] = null;
    }
  }
}

function maybeGameOver(game) {
  if (game.ended) return true;
  const active = activeSeats(game);
  if (active.length > 1 && !active.every(seat => sameTeam(seat, active[0]))) return false;
  // Preserve players who already finished; rank the remaining team by hand size.
  game.remainingCounts = game.hands.map(hand => hand.length);
  game.winningTeam = active.length ? (TEAM_A.includes(active[0]) ? 'B' : 'A') : null;
  active.sort((a, b) => game.hands[a].length - game.hands[b].length || a - b);
  for (const seat of active) {
    if (!game.rankings.includes(seat)) game.rankings.push(seat);
    game.finished[seat] = true;
    game.activeBurns[seat] = null;
  }
  finalizeFailedLastQueue(game);
  game.ended = true;
  return true;
}

// ============ Tribute / Buy-Three ============
function chooseCardsExcludingTribute(hand, n, dir = 'low') {
  const safe = hand.filter(c => c.rank !== 3 && !c.tributeReceived);
  const source = safe;
  const sorted = [...source].sort((a, b) => dir === 'low'
    ? ((a.rank !== b.rank) ? a.rank - b.rank : a.suit - b.suit)
    : ((a.rank !== b.rank) ? b.rank - a.rank : a.suit - b.suit));
  return sorted.slice(0, n);
}

function getLowestCards(hand, n) {
  return chooseCardsExcludingTribute(hand, n, 'low');
}

function getHighestCards(hand, n) {
  return chooseCardsExcludingTribute(hand, n, 'high');
}

function getRandomCardsExcludingTribute(hand, n) {
  const safe = hand.filter(c => c.rank !== 3 && !c.tributeReceived);
  const source = [...safe];
  for (let i = source.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [source[i], source[j]] = [source[j], source[i]];
  }
  return source.slice(0, n);
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
  const pointItems = [];
  const menItems = [];
  const burnItems = [];
  const laItems = [...(room.pendingTribute || [])];
  room.pendingTribute = null;

  // 敬自己一杯: wipe the equipped seat's carried-over 点贡/烧贡/闷贡 debt
  // before it gets converted into this round's tribute items.
  for (let seat = 0; seat < 6; seat++) {
    if (hasEquip(room, seat, 'jing_ziji')) {
      room.burnTributeDebt[seat] = 0;
      room.menTributeDebt[seat] = 0;
      room.dianTributeDebt[seat] = 0;
      markEquipUsed(room, seat);
    }
  }

  for (let seat = 0; seat < 6; seat++) {
    const burn = room.burnTributeDebt?.[seat] || 0;
    const men = room.menTributeDebt?.[seat] || 0;
    const dian = room.dianTributeDebt?.[seat] || 0;
    if (dian > 0) pointItems.push({ from: (seat + 3) % 6, to: seat, count: dian, type: '点贡' });
    if (men > 0) menItems.push({ from: seat, to: (seat + 3) % 6, count: men, type: '闷贡' });
    if (burn > 0) burnItems.push({ from: seat, to: (seat + 3) % 6, count: burn, type: '烧贡' });
  }

  room.forceKaiDianThisRound = [...(room.forceKaiDianNextRound || [false,false,false,false,false,false])];
  room.forceKaiDianNextRound = [false,false,false,false,false,false];
  room.burnTributeDebt = [0,0,0,0,0,0];
  room.menTributeDebt = [0,0,0,0,0,0];
  room.dianTributeDebt = [0,0,0,0,0,0];
  return [...pointItems, ...menItems, ...burnItems, ...laItems];
}

function applyPointTributeSteal(hands, pendingTribute) {
  const logs = [];
  if (!pendingTribute || pendingTribute.length === 0) return logs;

  for (const item of pendingTribute) {
    if (item.type !== '点贡' || item.count <= 0) continue;
    const stolen = getRandomCardsExcludingTribute(hands[item.from], item.count);
    if (!stolen.length) {
      logs.push({ type: '点贡抽牌', from: item.from, to: item.to, count: 0, stolen: [], note: '无可抽牌' });
      continue;
    }
    hands[item.from] = removeSpecificCards(hands[item.from], stolen);
    pushCards(hands[item.to], stolen.map(cloneCard));
    sortHand(hands[item.from]);
    sortHand(hands[item.to]);
    logs.push({ type: '点贡抽牌', from: item.from, to: item.to, count: stolen.length, stolen: stolen.map(cardText) });
  }

  return logs;
}

function applyTribute(hands, pendingTribute) {
  const tributeLog = [];
  const returnTasks = [];
  if (!pendingTribute || pendingTribute.length === 0) return { tributeLog, returnTasks };

  hands.forEach(hand => hand.forEach(card => { delete card.tributeReceived; }));
  let seq = 1;
  for (const item of pendingTribute) {
    const give = getHighestCards(hands[item.from], item.count);
    if (!give.length) continue;
    hands[item.from] = removeSpecificCards(hands[item.from], give);
    const received = give.map(card => ({ ...cloneCard(card), tributeReceived: true }));
    pushCards(hands[item.to], received);
    sortHand(hands[item.from]);
    sortHand(hands[item.to]);
    const id = `rt_${seq++}`;
    tributeLog.push({ id, type: item.type, from: item.from, to: item.to, count: give.length, give: give.map(cardText), back: [] });
    if (item.type === '落贡') {
      returnTasks.push({ itemId: id, owedBy: item.to, to: item.from, count: give.length, type: item.type, done: false, back: [] });
    }
  }
  return { tributeLog, returnTasks };
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

function findFourProvider(seat, hands) {
  const duiTou = (seat + 3) % 6;
  const teammates = TEAM_A.includes(seat) ? TEAM_A.filter(s => s !== seat) : TEAM_B.filter(s => s !== seat);
  const fallback = [0,1,2,3,4,5].filter(s => s !== seat && s !== duiTou && !teammates.includes(s));
  const candidates = [duiTou, ...teammates, ...fallback];
  for (const s of candidates) {
    if (countRank(hands[s], 4) > 0) return s;
  }
  return -1;
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

function buildBuyFourTasks(hands) {
  const tasks = [];
  const logs = [];
  for (let seat = 0; seat < 6; seat++) {
    if (countRank(hands[seat], 4) > 0) continue;
    const provider = findFourProvider(seat, hands);
    if (provider === -1) {
      logs.push({ buyer: seat, seller: -1, paid: '无', got: '4', note: '无人可卖4，跳过' });
      continue;
    }
    tasks.push({ buyer: seat, seller: provider, done: false, skipped: false });
  }
  return { tasks, logs };
}

function finalizeBuyFourTask(room, task, take) {
  const game = room?.game;
  if (!game || !task) return false;
  const log = game.buySanLog || [];
  if (!take) {
    task.done = true;
    task.skipped = true;
    log.push({ buyer: task.buyer, seller: task.seller, paid: '无', got: '4', note: '主动跳过买4' });
    scheduleTurnTimer(room);
    return true;
  }

  const sellerHand = game.hands[task.seller] || [];
  const buyerHand = game.hands[task.buyer] || [];
  const boughtFour = getCardsByRank(sellerHand, 4).slice(-1);
  if (!boughtFour.length) {
    task.done = true;
    task.skipped = true;
    log.push({ buyer: task.buyer, seller: task.seller, paid: '无', got: '4', note: '卖家已无4，自动跳过' });
    scheduleTurnTimer(room);
    return true;
  }

  const payment = chooseBuyThreePayment(buyerHand);
  game.hands[task.seller] = removeSpecificCards(sellerHand, boughtFour);
  pushCards(game.hands[task.buyer], boughtFour);

  let paidText = '赠送';
  if (payment) {
    game.hands[task.buyer] = removeSpecificCards(game.hands[task.buyer], [payment]);
    pushCards(game.hands[task.seller], [payment]);
    paidText = cardText(payment);
  }

  sortHand(game.hands[task.buyer]);
  sortHand(game.hands[task.seller]);
  task.done = true;
  log.push({ buyer: task.buyer, seller: task.seller, paid: paidText, got: '4' });
  scheduleTurnTimer(room);
  return true;
}

// ============ GAME STATE ============
function createGameState(hands, firstPlayer, roundNumber, tributeLog = [], buySanLog = [], players = [], returnTasks = [], buyFourTasks = []) {
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
    buyFourTasks,
    playedPool: [],
    activeBurns: [null,null,null,null,null,null],
    failedLastQueue: [],
    pendingShao: null,
    burnQueue: [],
    menCandidate: null,
    letSeat: -1,
    letAwaitingReturn: false,
    forceKaiDianThisRound: [false,false,false,false,false,false],
    naojiUses: [0,0,0,0,0,0],
    naojiMax: [0,1,2,3,4,5].map(i => getNaojiLimit(players.find(p => p.seat === i)?.name || '')),
    recentGrabClicks: [],
    activeNaojiWindows: [],
    naojiWindowSeq: 0,
    turnEndsAt: 0,
    returnEndsAt: 0,
    returnTasks: returnTasks || [],
    peekUses: [0,0,0,0,0,0],
    peekMax: [0,0,0,0,0,0].map((_, i) => ((players.find(p => p.seat === i)?.name || '').trim() === '张哲' ? 3 : 0)),
    jiangThrowUses: [0,0,0,0,0,0],
    jiangThrowMax: [0,0,0,0,0,0].map((_, i) => ((players.find(p => p.seat === i)?.name || '').trim() === '姜海涛' ? 1 : 0)),
    alphaStrikeUsed: [false,false,false,false,false,false],
  };
}

function getStateForPlayer(room, seat) {
  const game = room.game;
  if (!game) return null;
  const me = room.players.find(pp => pp.seat === seat);

  const currentReturnTask = getCurrentReturnTask(game);
  const currentBuyFourTask = getCurrentBuyFourTask(game);
  const prevPlay = game.tablePlay;
  const burnSourceSeat = (prevPlay && game.activeBurns?.[prevPlay.player]) ? prevPlay.player : -1;
  const burnEligible = burnSourceSeat >= 0 ? getEligibleRespondersToBurn(game, burnSourceSeat) : [];
  const canBurnNow = seat !== prevPlay?.player && !game.passedThisRound.includes(seat) && !hasPendingUnplayedFourProtection(game, seat) && !currentReturnTask && !currentBuyFourTask && !game.finished[seat] && !!prevPlay && (activeSeats(game).length || 0) >= 5 && (
    (burnSourceSeat >= 0 && burnEligible.includes(seat) && seat !== getBurnOppositeSeat(game, burnSourceSeat)) ||
    (burnSourceSeat < 0 && !isResponderOpposite(prevPlay.player, seat) && (prevPlay.isGouji && useGoujiRestrictions(game, prevPlay.player, seat)))
  );
  const canJieShaoNow = !currentReturnTask && !currentBuyFourTask && !game.finished[seat] && !!prevPlay && burnSourceSeat >= 0 && seat === getBurnOppositeSeat(game, burnSourceSeat);
  return {
    myHand: game.hands[seat],
    mySeat: seat,
    myName: me?.name || '',
    handCounts: game.hands.map((h, i) => i === seat || room.countViewers.has(me?.id) ? h.length : null),
    showHandCounts: room.countViewers.has(me?.id),
    seriesMode: room.seriesMode,
    seriesCompleted: room.seriesCompleted,
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
    buyFourTasks: game.buyFourTasks || [],
    naojiUses: game.naojiUses || [0,0,0,0,0,0],
    naojiMax: game.naojiMax || [5,5,5,5,5,5],
    serverNow: Date.now(),
    turnRemainingMs: Math.max(0, (game.turnEndsAt || 0) - Date.now()),
    returnRemainingMs: Math.max(0, (game.returnEndsAt || 0) - Date.now()),
    turnEndsAt: game.turnEndsAt || 0,
    playedPoolCount: (game.playedPool || []).length,
    noHeadSeat: getNoHeadSeat(game),
    isChaosPhase: isChaosPhase(game),
    activeBurns: game.activeBurns || [null,null,null,null,null,null],
    dianTributeDebt: room.dianTributeDebt || [0,0,0,0,0,0],
    dianSkipStreak: room.dianSkipStreak || [0,0,0,0,0,0],
    burnTributeDebt: room.burnTributeDebt || [0,0,0,0,0,0],
    menTributeDebt: room.menTributeDebt || [0,0,0,0,0,0],
    forceKaiDianThisRound: room.forceKaiDianThisRound || [false,false,false,false,false,false],
    peekUses: game.peekUses || [0,0,0,0,0,0],
    peekMax: game.peekMax || [0,0,0,0,0,0],
    jiangThrowUses: game.jiangThrowUses || [0,0,0,0,0,0],
    jiangThrowMax: game.jiangThrowMax || [0,0,0,0,0,0],
    canPeek: (((me?.name || '').trim() === '张哲') || hasEquip(room, seat, 'yanpai')) && game.currentPlayer !== seat && !game.finished[seat] && ((game.peekUses?.[seat] || 0) < (game.peekMax?.[seat] || 0)),
    canJiangThrow: ((me?.name || '').trim() === '姜海涛') && !game.finished[seat] && ((activeSeats(game).length || 0) > 2) && ((game.jiangThrowUses?.[seat] || 0) < (game.jiangThrowMax?.[seat] || 0)) && !currentReturnTask,
    canStrategist: ((me?.name || '').trim() === '陈杰') && !!game.finished[seat] && getVisibleTeammateSeats(room, game, seat).length > 0,
    strategistTargets: getVisibleTeammateSeats(room, game, seat),
    canLet: canLetTeammate(game, seat),
    returnEndsAt: game.returnEndsAt || 0,
    pendingReturnTask: currentReturnTask && currentReturnTask.owedBy === seat ? currentReturnTask : null,
    hasPendingReturn: !!currentReturnTask,
    pendingBuyFourTask: currentBuyFourTask && currentBuyFourTask.buyer === seat ? currentBuyFourTask : null,
    hasPendingBuyFour: !!currentBuyFourTask,
    canBurn: canBurnNow,
    canJieShao: canJieShaoNow,
    myEquipment: getSeatEquipment(room, seat),
    poolStats: hasEquip(room, seat, 'saibo_duizhang') ? getPlayedPoolStats(game) : null,
    canForceSkip: canForceSkipNow(room, seat),
    forceSkipUsed: !!room.weiBufanSkipUsed,
    canAlphaStrike: ((me?.name || '').trim() === '王晓') && !game.finished[seat] && !game.finished[(seat + 3) % 6] && !game.alphaStrikeUsed?.[seat] && !currentReturnTask && !currentBuyFourTask,
  };
}

// 点名: 魏不凡整局限一次，只能在完全正常的回合（有牌可接、非够级围攻、目标没在
// 烧牌、不是开点阶段、没有还贡/买4任务）对当前正在出牌的人使用，逼他跳过这轮。
function canForceSkipNow(room, seat) {
  const game = room.game;
  if (!game) return false;
  const me = room.players.find(p => p.seat === seat);
  if ((me?.name || '').trim() !== '魏不凡') return false;
  if (room.weiBufanSkipUsed) return false;
  const target = game.currentPlayer;
  if (target < 0 || target === seat || game.finished[target]) return false;
  if (!game.tablePlay || game.isGoujiMode || game.activeBurns?.[target] || game.canKaiDian === target) return false;
  if (getCurrentReturnTask(game) || getCurrentBuyFourTask(game)) return false;
  return true;
}

function getPlayedPoolStats(game) {
  const pool = game.playedPool || [];
  const count = (rank) => pool.filter(c => c.rank === rank).length;
  return { bigJokers: count(17), smallJokers: count(16), twos: count(15) };
}

function getSoundCueForLastAction(room, seat, result = null) {
  if (result?.autoKind === 'kaidian' || result?.autoKind === 'autokaidian') return 'kaidian';
  if (result?.autoKind === 'normal4') return 'play';
  const act = room?.game?.playerActions?.[seat];
  if (act?.type === 'pass' || act?.type === 'yield') return 'pass';
  if (!act || act.type !== 'play') return 'play';
  if (act.isShao || act.isFanShao) return 'burn';
  if (act.isJieShao) return 'jieshao';
  if (act.cards && isGoujiPlay(act.cards)) return 'gouji';
  return 'play';
}

function isBotSeat(room, seat) {
  return !!room?.players?.find(p => p.seat === seat && p.isBot);
}

function runBotStep(room) {
  if (!room || !room.game || room.state !== 'playing') return;
  const game = room.game;

  const currentReturnTask = getCurrentReturnTask(game);
  if (currentReturnTask && isBotSeat(room, currentReturnTask.owedBy)) {
    const chosen = getLowestCards(game.hands[currentReturnTask.owedBy] || [], currentReturnTask.count);
    finalizeReturnTask(room, currentReturnTask, chosen, true);
    io.to(room.code).emit('toast_msg', { msg: `${getSeatPlayerName(room, currentReturnTask.owedBy)} 自动完成还贡` });
    broadcastState(room);
    return;
  }

  const buyFourTask = getCurrentBuyFourTask(game);
  if (buyFourTask && isBotSeat(room, buyFourTask.buyer)) {
    const buyerHand = game.hands[buyFourTask.buyer] || [];
    const payment = chooseBuyThreePayment(buyerHand);
    const shouldBuy = !!buyFourTask.seller && !!payment && payment.rank <= 16;
    finalizeBuyFourTask(room, buyFourTask, shouldBuy);
    io.to(room.code).emit('toast_msg', { msg: `${getSeatPlayerName(room, buyFourTask.buyer)} ${shouldBuy ? '自动选择买4' : '自动跳过买4'}` });
    broadcastState(room);
    return;
  }

  const seat = game.currentPlayer;
  if (!isBotSeat(room, seat) || game.finished[seat]) return;

  let result = null;
  if (game.canKaiDian === seat) {
    const fourIds = getCardsByRank(game.hands[seat], 4).map(card => card.id);
    const mode = room.forceKaiDianThisRound?.[seat] ? 'kaidian' : 'normal4';
    result = processPlay(room, seat, fourIds, mode);
  } else if (game.activeBurns?.[seat]) {
    const autoIds = chooseTimeoutLeadIds(game, seat);
    if (autoIds.length) {
      result = processPlay(room, seat, autoIds, 'normal');
    } else {
      maybeFailActiveBurnAtTurnStart(room, seat);
      if (maybeGameOver(game)) {
        finishGame(room);
        return;
      }
      scheduleTurnTimer(room);
      broadcastState(room);
      return;
    }
  } else if (game.tablePlay) {
    const prevPlay = game.tablePlay;
    const respondingToBurn = !!game.activeBurns?.[prevPlay.player];
    const isOpposite = respondingToBurn && seat === getBurnOppositeSeat(game, prevPlay.player);
    const needBurnResponse = respondingToBurn ? !isOpposite : activeSeats(game).length >= 5 && prevPlay.isGouji && !isResponderOpposite(prevPlay.player, seat) && useGoujiRestrictions(game, prevPlay.player, seat);
    const beatIds = chooseAutoBeatIds(game, seat, prevPlay.cards, needBurnResponse);
    result = beatIds.length ? processPlay(room, seat, beatIds, 'normal') : processPass(room, seat);
  } else {
    const autoIds = chooseTimeoutLeadIds(game, seat);
    result = autoIds.length ? processPlay(room, seat, autoIds, 'normal') : processPass(room, seat);
  }

  if (!result || !result.ok) {
    const fallback = processPass(room, seat);
    if (!fallback.ok) return;
    result = fallback;
  }

  if (result.gameOver || maybeGameOver(game)) {
    finishGame(room);
    return;
  }

  io.to(room.code).emit('sound_cue', { type: getSoundCueForLastAction(room, seat, result) });
  scheduleTurnTimer(room);
  broadcastState(room);
}

function scheduleBotAction(room) {
  clearBotTimer(room);
  if (!room?.botMode || !room.game || room.state !== 'playing') return;
  const game = room.game;
  const currentReturnTask = getCurrentReturnTask(game);
  const currentBuyFourTask = getCurrentBuyFourTask(game);
  const shouldRun =
    (currentReturnTask && isBotSeat(room, currentReturnTask.owedBy)) ||
    (currentBuyFourTask && isBotSeat(room, currentBuyFourTask.buyer)) ||
    isBotSeat(room, game.currentPlayer);
  if (!shouldRun) return;
  room.botTimer = setTimeout(() => runBotStep(room), 450);
}

function broadcastState(room) {
  if (!room?.game || room.state !== 'playing') return;
  ensureTurnSeatValid(room);
  if (maybeGameOver(room.game)) { finishGame(room); return; }
  room.players.forEach(p => io.to(p.id).emit('game_state', getStateForPlayer(room, p.seat)));
  scheduleBotAction(room);
}

function settleDianTributes(room) {
  const game = room?.game;
  if (!game) return;
  const pairs = [[0,3],[1,4],[2,5]];
  for (const [a,b] of pairs) {
    const aOpen = !!game.openedDian?.[a];
    const bOpen = !!game.openedDian?.[b];
    if (aOpen && !bOpen) room.dianTributeDebt[a] = (room.dianTributeDebt[a] || 0) + 1;
    if (!aOpen && bOpen) room.dianTributeDebt[b] = (room.dianTributeDebt[b] || 0) + 1;
    if (!aOpen && !bOpen) {
      room.dianTributeDebt[a] = (room.dianTributeDebt[a] || 0) + 1;
      room.dianTributeDebt[b] = (room.dianTributeDebt[b] || 0) + 1;
    }

    if (aOpen) room.dianSkipStreak[a] = 0;
    else room.dianSkipStreak[a] = (room.dianSkipStreak[a] || 0) + 1;
    if (bOpen) room.dianSkipStreak[b] = 0;
    else room.dianSkipStreak[b] = (room.dianSkipStreak[b] || 0) + 1;

    if (room.dianSkipStreak[a] >= 3) {
      room.forceKaiDianNextRound[a] = true;
      room.dianSkipStreak[a] = 0;
    }
    if (room.dianSkipStreak[b] >= 3) {
      room.forceKaiDianNextRound[b] = true;
      room.dianSkipStreak[b] = 0;
    }
  }
}

function finishGame(room) {
  if (!room?.game || room.state !== 'playing') return;
  clearTurnTimer(room);
  clearReturnTimer(room);
  clearBotTimer(room);
  room.state = 'gameover';
  room.seriesCompleted++;
  const continueSeries = room.seriesMode === 'unlimited' || room.seriesCompleted < 5;
  const nextRoundAt = continueSeries && room.players.length === 6 ? Date.now() + 5000 : 0;
  resolveRoundEffects(room);
  settleDianTributes(room);
  room.pendingTribute = computePendingTribute(room.game.rankings);
  room.nextStarterSeat = room.game.rankings?.[5] ?? -1;
  const equipGrant = grantConsolationEquipment(room);
  room.players.forEach(p => {
    io.to(p.id).emit('game_over', {
      rankings: room.game.rankings,
      winningTeam: room.game.winningTeam,
      remainingCounts: room.game.remainingCounts || room.game.hands.map(h => h.length),
      seriesMode: room.seriesMode,
      seriesCompleted: room.seriesCompleted,
      nextRoundDelayMs: nextRoundAt ? 5000 : 0,
      players: room.players.map(pp => ({ name: pp.name, seat: pp.seat })),
    });
  });
  if (equipGrant) {
    const seatName = room.players.find(p => p.seat === equipGrant.seat)?.name || `${equipGrant.seat + 1}号`;
    io.to(room.code).emit('toast_msg', { msg: `${seatName} 垫底获得装备卡：${equipGrant.item.name}，下一局生效` });
  }
  if (nextRoundAt) {
    clearTimeout(room.seriesTimer);
    room.seriesTimer = setTimeout(() => {
      room.seriesTimer = null;
      if (rooms[room.code] === room && room.state === 'gameover' && room.players.length === 6) startRound(room);
    }, 5000);
  }
}

function executeFourChoice(room, seat, cards, kind = 'normal4') {
  const game = room.game;
  const hand = game.hands[seat];
  const cardIds = cards.map(c => c.id);
  game.hands[seat] = removeCardsByIds(hand, cardIds);
  game.playedPool.push(...cards.map(cloneCard));
  game.playerActions[seat] = { type: 'play', cards: [...cards], isKaiDian: kind === 'kaidian' || kind === 'autokaidian', isNormalFour: kind === 'normal4', isAutoKaiDian: kind === 'autokaidian' };

  if (kind === 'kaidian' || kind === 'autokaidian') {
    game.openedDian[seat] = true;
    room.dianSkipStreak[seat] = 0;
    room.forceKaiDianThisRound[seat] = false;
  } else {
    game.lostKaiDian[seat] = true;
    room.forceKaiDianThisRound[seat] = false;
  }

  maybeFinishPlayer(game, seat, room);
  if (maybeGameOver(game)) return { ok: true, gameOver: true };
  const logs = resolveRoundEffects(room);
  const nextStarter = game.finished[seat] ? pickCounterClockwiseStarter(game, seat) : seat;
  const action = game.playerActions[seat];
  const res = resetRound(game, nextStarter);
  game.playerActions[seat] = action;
  return { ...res, roundEffectLogs: logs, autoKind: kind };
}

function processPlay(room, seat, cardIds, playMode = 'normal') {
  if (!room || room.state !== 'playing') return { ok: false, msg: '对局不存在' };
  const game = room.game;
  if (getCurrentReturnTask(game)) return { ok: false, msg: '还贡阶段，暂不能出牌' };
  if (getCurrentBuyFourTask(game)) return { ok: false, msg: '买4阶段，暂不能出牌' };
  if (!game) return { ok: false, msg: '对局不存在' };
  const prevPlay = game.tablePlay ? { ...game.tablePlay } : null;
  const respondingToBurnEarly = !!prevPlay && !!game.activeBurns?.[prevPlay.player];
  const burnOppSeatEarly = respondingToBurnEarly ? getBurnOppositeSeat(game, prevPlay.player) : -1;
  const burnVictimSeatEarly = respondingToBurnEarly ? game.activeBurns[prevPlay.player].victim : -1;
  const canInterruptBurn = respondingToBurnEarly && seat !== game.currentPlayer && (
    seat === burnOppSeatEarly ||
    seat === burnVictimSeatEarly ||
    canSeatTakeOverBurn(game, prevPlay.player, seat)
  );
  const canInterruptGouji = !!prevPlay && !respondingToBurnEarly && seat !== prevPlay.player && !isResponderOpposite(prevPlay.player, seat) && activeSeats(game).length >= 5 && prevPlay.isGouji && useGoujiRestrictions(game, prevPlay.player, seat) && !hasPendingUnplayedFourProtection(game, seat) && !game.passedThisRound.includes(seat);
  if (game.currentPlayer !== seat && !canInterruptBurn && !canInterruptGouji) return { ok: false, msg: '不是你的回合' };
  if (game.finished[seat]) return { ok: false, msg: '你已经出完了' };

  const hand = game.hands[seat];
  const cards = takeCardsByIds(hand, cardIds);
  if (cards.length !== cardIds.length) return { ok: false, msg: '无效的牌' };
  if (!allFoursSelectedIfPlayingFour(hand, cards)) return { ok: false, msg: '出4时必须把手里所有4一起打出' };
  const analyzed = analyzePlay(cards);
  if (!analyzed) return { ok: false, msg: '无效出牌组合' };
  if (game.currentPlayer !== seat && canInterruptGouji && !isShaoPlay(cards)) return { ok: false, msg: '抢烧必须带王' };
  const remainingAfterPlayEarly = hand.filter(c => !cardIds.includes(c.id));
  const isLastThreeBurnException = !!game.activeBurns?.[seat] && isExactlyAllRank(cards, 3) && remainingAfterPlayEarly.length === 0;
  if (game.activeBurns?.[seat] && (analyzed.bigJokers + analyzed.smallJokers) <= 0 && !isLastThreeBurnException) return { ok: false, msg: '烧牌后每手都必须至少带一张王' };

  if (game.canKaiDian === seat) {
    const kind = (playMode === 'kaidian' || playMode === 'autokaidian') ? playMode : 'normal4';
    if (!cards.every(c => c.rank === 4)) return { ok: false, msg: '现在只能出4' };
    if (!allFoursSelectedIfKaiDian(hand, cards)) return { ok: false, msg: '此时必须把手里所有4一起打出' };
    return executeFourChoice(room, seat, cards, kind);
  }

  const remainingAfterPlay = remainingAfterPlayEarly;
  const threeCheck = canPlayFinalThree(game, seat, cards, remainingAfterPlay, room);
  if (!threeCheck.ok) return threeCheck;

  const oppositeOfPrev = prevPlay ? ((prevPlay.player + 3) % 6) : -1;
  const burnActive = !!prevPlay && !!game.activeBurns?.[prevPlay.player];
  const goujiRestricted = !!prevPlay && activeSeats(game).length >= 5 && prevPlay.isGouji && useGoujiRestrictions(game, prevPlay.player, seat);
  const respondingToBurn = !!prevPlay && burnActive;
  const burnOppSeat = respondingToBurn ? getBurnOppositeSeat(game, prevPlay.player) : -1;
  const burnVictimSeat = respondingToBurn ? game.activeBurns[prevPlay.player].victim : -1;
  const isOppositeResponse = !!prevPlay && respondingToBurn && seat === burnOppSeat;
  const isVictimFanShao = !!prevPlay && respondingToBurn && seat === burnVictimSeat;
  const isOtherBurnTakeover = !!prevPlay && respondingToBurn && canSeatTakeOverBurn(game, prevPlay.player, seat);
  const specialOnlyBypass = !!prevPlay && !respondingToBurn && !isResponderOpposite(prevPlay.player, seat) && goujiRestricted && isSpecialOnlyPlay(analyzed);
  const isBurnResponse = !!prevPlay && activeSeats(game).length >= 5 && (
    (respondingToBurn && isVictimFanShao) ||
    (respondingToBurn && isOtherBurnTakeover) ||
    (!respondingToBurn && !isResponderOpposite(prevPlay.player, seat) && goujiRestricted && !specialOnlyBypass)
  );

  if (respondingToBurn && seat !== prevPlay.player && !getEligibleRespondersToBurn(game, prevPlay.player).includes(seat)) {
    return { ok: false, msg: '当前只能解烧、反烧或接管烧牌' };
  }
  if (prevPlay && !(respondingToBurn && seat === prevPlay.player) && !canBeat(cards, prevPlay.cards)) return { ok: false, msg: '压不住！' };
  if (isBurnResponse && !isShaoPlay(cards)) return { ok: false, msg: '现在只能按烧牌规则上牌' };
  if (respondingToBurn && isVictimFanShao && hasPendingUnplayedFourProtection(game, seat)) return { ok: false, msg: '你还没出4，暂时不能反烧' };

  game.hands[seat] = remainingAfterPlay;
  game.playedPool.push(...cards.map(cloneCard));
  if (cards.some(c => c.rank === 4)) game.lostKaiDian[seat] = true;

  // 万物皆可不基础: this round the equipped seat's 够级 threshold is 1 card
  // lower. Only feeds the two boolean checks below — the actual cards played,
  // canBeat/analyzePlay validation, and every downstream burn/turn handoff
  // are the same already-hardened code path a normal gouji play takes.
  const goujiThresholdOverride = hasEquip(room, seat, 'bu_jichu') ? Math.max(1, goujiThreshold(analyzed.baseRank) - 1) : null;
  const pureGouji = isPureGoujiPlay(cards, goujiThresholdOverride);
  const triggersGouji = isGoujiPlay(cards, goujiThresholdOverride) && activeSeats(game).length >= 5 && useGoujiRestrictions(game, seat, (seat + 3) % 6);
  const isShao = isBurnResponse;
  const isJieShao = respondingToBurn && isOppositeResponse;

  game.tablePlay = { cards: [...cards], player: seat, isGouji: triggersGouji, isPureGouji: pureGouji, isShao, isJieShao };
  game.passedThisRound = [];
  game.roundStarter = seat;
  game.playerActions[seat] = { type: 'play', cards: [...cards], isShao, isJieShao, isFanShao: respondingToBurn && isVictimFanShao, isTakeBurn: respondingToBurn && isOtherBurnTakeover };
  if (respondingToBurn && prevPlay?.player >= 0 && game.activeBurns?.[prevPlay.player]) {
    if (isOppositeResponse) {
      game.playerActions[seat].isJieShao = true;
      game.activeBurns[prevPlay.player] = null;
    } else if (isBurnResponse) {
      game.playerActions[seat].isFanShao = true;
      game.activeBurns[prevPlay.player] = null;
    }
  }
  game.canKaiDian = -1;
  game.letSeat = -1;
  game.isGoujiMode = false;
  game.goujiPair = [-1, -1];
  game.burnQueue = [];

  if (prevPlay) {
    if (game.menCandidate && game.menCandidate.seat === prevPlay.player && seat !== prevPlay.player) {
      room.menTributeDebt[prevPlay.player] = (room.menTributeDebt[prevPlay.player] || 0) + 1;
      game.menCandidate = null;
      game.playerActions[seat].isMen = true;
    }
    if (isShao) {
      game.activeBurns[seat] = { victim: prevPlay.player };
      game.pendingShao = { burner: seat, victim: prevPlay.player };
    } else {
      game.pendingShao = null;
    }
  }

  if (remainingAfterPlay.length > 0 && remainingAfterPlay.every(c => c.rank === 3)) game.menCandidate = { seat };
  else if (game.menCandidate?.seat === seat) game.menCandidate = null;

  maybeFinishPlayer(game, seat, room);
  if (maybeGameOver(game)) return { ok: true, gameOver: true };

  if (game.activeBurns?.[seat]) {
    game.currentPlayer = seat;
    return { ok: true };
  }

  if (respondingToBurn && isOppositeResponse) {
    const next = nextActiveSeat(game, seat);
    if (next === -1 || next === seat) {
      const logs = resolveRoundEffects(room);
      const starter = game.finished[seat] ? pickCounterClockwiseStarter(game, seat) : seat;
      const res = resetRound(game, starter);
      return { ...res, roundEffectLogs: logs };
    }
    game.currentPlayer = next;
    return { ok: true };
  }

  if (!game.finished[seat] && respondingToBurn && !isOppositeResponse && (isVictimFanShao || isOtherBurnTakeover)) {
    game.activeBurns[seat] = { victim: prevPlay.player };
    game.pendingShao = { burner: seat, victim: prevPlay.player };
    game.currentPlayer = seat;
    return { ok: true };
  }

  if (respondingToBurn && prevPlay?.player >= 0 && !game.activeBurns?.[prevPlay.player] && !game.activeBurns?.[seat]) {
    const starter = game.finished[seat] ? pickCounterClockwiseStarter(game, seat) : seat;
    const logs = resolveRoundEffects(room);
    const res = resetRound(game, starter);
    return { ...res, roundEffectLogs: logs };
  }

  if (triggersGouji && !game.finished[seat]) {
    const duiTou = (seat + 3) % 6;
    if (!game.finished[duiTou]) {
      game.isGoujiMode = true;
      game.goujiPair = [seat, duiTou];
      game.burnQueue = buildBurnQueue(game, seat);
      game.currentPlayer = nextBurnResponder(game);
      if (game.currentPlayer < 0) game.currentPlayer = duiTou;
      return { ok: true };
    }
  }

  if (game.finished[seat]) {
    const next = nextActiveSeat(game, seat);
    const logs = resolveRoundEffects(room);
    const res = resetRound(game, next === -1 ? pickCounterClockwiseStarter(game, seat) : next);
    return { ...res, roundEffectLogs: logs };
  }

  const next = nextActiveSeat(game, seat);
  if (next === -1 || next === game.tablePlay.player) {
    const logs = resolveRoundEffects(room);
    const starter = game.finished[seat] ? pickCounterClockwiseStarter(game, seat) : seat;
    const res = resetRound(game, starter);
    return { ...res, roundEffectLogs: logs };
  }

  game.currentPlayer = next;
  return { ok: true };
}

function processPass(room, seat) {
  if (!room || room.state !== 'playing') return { ok: false, msg: '对局不存在' };
  const game = room.game;
  if (getCurrentReturnTask(game)) return { ok: false, msg: '还贡阶段，暂不能过牌' };
  if (getCurrentBuyFourTask(game)) return { ok: false, msg: '买4阶段，暂不能过牌' };
  if (!game || game.currentPlayer !== seat) return { ok: false, msg: '不是你的回合' };

  if (game.canKaiDian === seat) {
    game.lostKaiDian[seat] = true;
    room.forceKaiDianThisRound[seat] = false;
    const logs = resolveRoundEffects(room);
    const starter = game.finished[seat] ? pickCounterClockwiseStarter(game, seat) : seat;
    const res = resetRound(game, starter);
    return { ...res, roundEffectLogs: logs };
  }

  if (!game.tablePlay) return { ok: false, msg: '现在不能过牌' };
  if (game.activeBurns?.[seat]) return { ok: false, msg: '烧牌过程中不能过牌' };

  game.passedThisRound.push(seat);
  game.playerActions[seat] = { type: 'pass' };

  if (game.tablePlay && game.activeBurns?.[game.tablePlay.player]) {
    return { ok: false, msg: '烧牌过程中不能过牌' };
  }

  if (game.isGoujiMode) {
    const opposite = game.goujiPair[1];
    let endGouji = seat === opposite;
    if (!endGouji) {
      const nextResponder = nextBurnResponder(game);
      if (nextResponder >= 0) {
        game.currentPlayer = nextResponder;
        return { ok: true };
      }
      // nextBurnResponder found nobody left (e.g. the designated "opposite"
      // finished their hand out-of-turn via some other skill mid-queue).
      // Previously this fell through into the normal non-gouji passing logic
      // below while leaving isGoujiMode/burnQueue set — a corrupted state
      // that could misbehave on the next pass. Close the gouji phase out
      // properly instead, exactly like the "opposite passes" case does.
      endGouji = true;
    }
    if (endGouji) {
      game.isGoujiMode = false;
      game.burnQueue = [];
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
      const starter = game.finished[attacker] ? pickCounterClockwiseStarter(game, attacker) : attacker;
      const res = resetRound(game, starter);
      return { ...res, roundEffectLogs: logs };
    }
  }

  const active = activeSeats(game);
  const candidates = active.filter(p => !game.passedThisRound.includes(p) && p !== game.tablePlay.player);
  if (candidates.length === 0) {
    if (game.letSeat >= 0 && !game.letAwaitingReturn && !game.finished[game.letSeat]) {
      game.currentPlayer = game.letSeat;
      game.letAwaitingReturn = true;
      game.passedThisRound = game.passedThisRound.filter(s => s !== game.letSeat);
      return { ok: true };
    }
    const baseStarter = game.finished[game.tablePlay.player] ? pickCounterClockwiseStarter(game, game.tablePlay.player) : game.tablePlay.player;
    const logs = resolveRoundEffects(room);
    const res = resetRound(game, baseStarter);
    return { ...res, roundEffectLogs: logs };
  }

  const next = nextActiveSeat(game, seat);
  if (next === -1 || next === game.tablePlay.player) {
    if (game.letSeat >= 0 && !game.letAwaitingReturn && !game.finished[game.letSeat]) {
      game.currentPlayer = game.letSeat;
      game.letAwaitingReturn = true;
      game.passedThisRound = game.passedThisRound.filter(s => s !== game.letSeat);
      return { ok: true };
    }
    const baseStarter = game.finished[game.tablePlay.player] ? pickCounterClockwiseStarter(game, game.tablePlay.player) : game.tablePlay.player;
    const logs = resolveRoundEffects(room);
    const res = resetRound(game, baseStarter);
    return { ...res, roundEffectLogs: logs };
  }

  game.currentPlayer = next;
  return { ok: true };
}

function processLet(room, seat) {
  if (!room || room.state !== 'playing') return { ok: false, msg: '对局不存在' };
  const game = room.game;
  if (getCurrentReturnTask(game)) return { ok: false, msg: '还贡阶段，暂不能让牌' };
  if (getCurrentBuyFourTask(game)) return { ok: false, msg: '买4阶段，暂不能让牌' };
  if (!game || game.currentPlayer !== seat) return { ok: false, msg: '不是你的回合' };
  if (!canLetTeammate(game, seat)) return { ok: false, msg: '当前不能让牌' };
  game.passedThisRound.push(seat);
  game.playerActions[seat] = { type: 'yield' };
  game.letSeat = seat;
  game.letAwaitingReturn = false;

  const next = nextActiveSeat(game, seat);
  if (next === -1 || next === game.tablePlay.player) {
    game.currentPlayer = seat;
    game.letAwaitingReturn = true;
    game.passedThisRound = game.passedThisRound.filter(s => s !== seat);
    return { ok: true };
  }
  game.currentPlayer = next;
  return { ok: true };
}

function startRound(room) {
  if (!room || room.players.length !== 6 || room.state === 'playing') return false;
  clearTimeout(room.seriesTimer);
  room.seriesTimer = null;
  const cheatSeat = room.cheatArmed ? room.players.find(p => p.id === room.hostId)?.seat ?? -1 : -1;
  const luckySeat = getLuckyBoostSeat(room.players);
  const laotianSeat = getLaotianSeat(room.players);
  const hands = deal(cheatSeat, luckySeat, laotianSeat);
  if (luckySeat >= 0 && luckySeat !== cheatSeat && laotianSeat >= 0 && laotianSeat !== luckySeat) {
    const luckyName = room.players.find(p => p.seat === luckySeat)?.name || ('座位' + (luckySeat + 1));
    io.to(room.code).emit('toast_msg', { msg: `🛡️ 老田金钟罩：${luckyName} 的幸运光环对他没用，还倒贴了一张好牌给老田` });
  }

  const roundTributes = buildRoundTributes(room);
  const stealLog = applyPointTributeSteal(hands, roundTributes);
  const tributeRes = applyTribute(hands, roundTributes);
  const tributeLog = [...stealLog, ...tributeRes.tributeLog];
  const buySanLog = applyBuyThree(hands);
  const buyFourRes = buildBuyFourTasks(hands);
  buySanLog.push(...buyFourRes.logs);

  const firstPlayer = (room.nextStarterSeat >= 0 && room.nextStarterSeat < 6)
    ? room.nextStarterSeat
    : (cheatSeat >= 0 ? cheatSeat : Math.floor(Math.random() * 6));
  room.game = createGameState(hands, firstPlayer, room.nextRoundNumber++, tributeLog, buySanLog, room.players, tributeRes.returnTasks, buyFourRes.tasks);
  room.game.forceKaiDianThisRound = [...(room.forceKaiDianThisRound || [false,false,false,false,false,false])];
  room.state = 'playing';
  room.cheatArmed = false;

  // 我要验牌: grant one free peek even if this seat isn't 张哲.
  for (let s = 0; s < 6; s++) {
    if (hasEquip(room, s, 'yanpai') && room.game.peekMax[s] < 1) room.game.peekMax[s] = 1;
  }

  if (getCurrentReturnTask(room.game)) scheduleReturnTimer(room);
  else scheduleTurnTimer(room);
  broadcastState(room);
  if (room.secretUsers.has(room.hostId)) io.to(room.hostId).emit('cheat_status', { armed: false });
  return true;
}

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentSeat = -1;

  socket.on('create_room', ({ name, seriesMode }) => {
    const code = createRoom(socket.id, name || '房主');
    rooms[code].seriesMode = seriesMode === 'unlimited' ? 'unlimited' : 'five';
    currentRoom = code;
    currentSeat = 0;
    socket.join(code);
    socket.emit('room_joined', {
      code,
      seat: 0,
      seriesMode: rooms[code].seriesMode,
      players: rooms[code].players.map(p => ({ name: p.name, seat: p.seat })),
    });
  });

  socket.on('create_bot_room', ({ name, seriesMode }) => {
    const code = createRoom(socket.id, name || '房主');
    rooms[code].seriesMode = seriesMode === 'unlimited' ? 'unlimited' : 'five';
    fillBotsForRoom(rooms[code]);
    currentRoom = code;
    currentSeat = 0;
    socket.join(code);
    const players = rooms[code].players.map(p => ({ name: p.name, seat: p.seat, isBot: !!p.isBot }));
    socket.emit('room_joined', { code, seat: 0, players, seriesMode: rooms[code].seriesMode });
    io.to(code).emit('player_list', { players });
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
    socket.emit('room_joined', { code: currentRoom, seat, players: playerList, seriesMode: room.seriesMode });
    io.to(currentRoom).emit('player_list', { players: playerList });
  });

  socket.on('start_game', () => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('error_msg', { msg: '只有房主可以开始游戏' });
    if (room.players.length < 6) return socket.emit('error_msg', { msg: `需要6人才能开始！当前${room.players.length}人` });

    if (room.state !== 'waiting') return socket.emit('error_msg', { msg: '当前不能重复开始游戏' });
    startRound(room);
  });

  socket.on('return_tribute', ({ cardIds }) => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const task = getCurrentReturnTask(room.game);
    if (!task) return socket.emit('error_msg', { msg: '当前无需还贡' });
    if (task.owedBy !== currentSeat) return socket.emit('error_msg', { msg: '现在不是你还贡' });
    const hand = room.game.hands[currentSeat] || [];
    const cards = takeCardsByIds(hand, cardIds || []);
    if (cards.length !== task.count) return socket.emit('error_msg', { msg: `请选择${task.count}张牌返还` });
    if (cards.some(c => c.rank === 3)) return socket.emit('error_msg', { msg: '3不能用来还贡' });
    if (cards.some(c => c.tributeReceived)) return socket.emit('error_msg', { msg: '收到的贡牌本局不能再被进贡/还贡' });
    finalizeReturnTask(room, task, cards, false);
    io.to(currentRoom).emit('toast_msg', { msg: `${getSeatPlayerName(room, currentSeat)} 已完成还贡` });
    broadcastState(room);
  });

  socket.on('buy_four', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const task = getCurrentBuyFourTask(room.game);
    if (!task) return socket.emit('error_msg', { msg: '当前无需买4' });
    if (task.buyer !== currentSeat) return socket.emit('error_msg', { msg: '现在轮不到你决定买4' });
    finalizeBuyFourTask(room, task, true);
    io.to(currentRoom).emit('toast_msg', { msg: `${getSeatPlayerName(room, currentSeat)} 选择买4` });
    broadcastState(room);
  });

  socket.on('skip_buy_four', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const task = getCurrentBuyFourTask(room.game);
    if (!task) return socket.emit('error_msg', { msg: '当前无需买4' });
    if (task.buyer !== currentSeat) return socket.emit('error_msg', { msg: '现在轮不到你决定买4' });
    finalizeBuyFourTask(room, task, false);
    io.to(currentRoom).emit('toast_msg', { msg: `${getSeatPlayerName(room, currentSeat)} 选择跳过买4` });
    broadcastState(room);
  });

  socket.on('play_cards', ({ cardIds, mode }) => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const result = processPlay(room, currentSeat, cardIds || [], mode || 'normal');
    if (!result.ok) return socket.emit('error_msg', { msg: result.msg });
    if (result.gameOver) return finishGame(room);
    io.to(currentRoom).emit('sound_cue', { type: getSoundCueForLastAction(room, currentSeat, result) });
    // 可灵AI·霸总语录: purely cosmetic toast, fires whenever the equipped
    // seat's own play is the one currently flagged as a gouji attack.
    if (room.game?.tablePlay?.player === currentSeat && room.game.tablePlay.isGouji && hasEquip(room, currentSeat, 'baba_yulu')) {
      const who = room.players.find(p => p.seat === currentSeat)?.name || ('座位' + (currentSeat + 1));
      const line = BABA_LINES[Math.floor(Math.random() * BABA_LINES.length)];
      io.to(currentRoom).emit('toast_msg', { msg: `👑 ${who}：「${line}」` });
    }
    scheduleTurnTimer(room);
    broadcastState(room);
  });

  socket.on('pass', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const result = processPass(room, currentSeat);
    if (!result.ok) return socket.emit('error_msg', { msg: result.msg });
    if (result.gameOver) return finishGame(room);
    io.to(currentRoom).emit('sound_cue', { type: result.autoKind ? getSoundCueForLastAction(room, currentSeat, result) : 'pass' });
    scheduleTurnTimer(room);
    broadcastState(room);
  });

  socket.on('let_teammate', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const result = processLet(room, currentSeat);
    if (!result.ok) return socket.emit('error_msg', { msg: result.msg });
    io.to(currentRoom).emit('sound_cue', { type: 'pass' });
    scheduleTurnTimer(room);
    broadcastState(room);
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
    if (hasEquip(room, currentSeat, 'zishujing')) {
      io.to(currentRoom).emit('toast_msg', { msg: `🍠 紫薯精附体：${who} 孬急得手！` });
    }

    if (result.penalties && result.penalties.length) {
      for (const item of result.penalties) {
        const targetName = room.players.find(p => p.seat === item.target)?.name || ('座位' + (item.target + 1));
        if (item.shielded) {
          io.to(currentRoom).emit('toast_msg', { msg: `🛡️ 预制护体：${who} 被${targetName}抓中，但免赔了` });
        } else if (item.ok && item.honestPayer != null) {
          const honestName = room.players.find(p => p.seat === item.honestPayer)?.name || ('座位' + (item.honestPayer + 1));
          io.to(currentRoom).emit('toast_msg', { msg: `🤝 老好人：${who} 被${targetName}抓中，队友${honestName}主动顶上，赔出 ${cardText(item.card)}` });
          io.to(currentRoom).emit('sound_cue', { type: 'caught' });
        } else if (item.ok) {
          io.to(currentRoom).emit('toast_msg', { msg: `${who} 被${targetName}抓中，赔出 ${cardText(item.card)}` });
          io.to(currentRoom).emit('sound_cue', { type: 'caught' });
        } else {
          io.to(currentRoom).emit('toast_msg', { msg: `${who} 被${targetName}抓中，但${item.msg.replace(/^.*?没有/, '没有')}` });
        }
      }
    }

    if (maybeGameOver(room.game)) return finishGame(room);
    // A naoji penalty payout can empty someone's hand and finish them
    // out-of-turn, which shifts game.currentPlayer without the running turn
    // timer knowing about it — resync so the clock always matches whoever
    // is actually up.
    scheduleTurnTimer(room);
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
      const actName = item.windowType === 'peek' ? '验牌' : (item.windowType === 'throw2' ? '扔牌' : '孬急');
      if (item.shielded) {
        io.to(currentRoom).emit('toast_msg', { msg: `🛡️ 预制护体：${who} 抓到 ${fromName} 的${actName}，但对方免赔了` });
      } else if (item.ok && item.honestPayer != null) {
        const honestName = room.players.find(p => p.seat === item.honestPayer)?.name || ('座位' + (item.honestPayer + 1));
        io.to(currentRoom).emit('toast_msg', { msg: `🤝 老好人：${who} 抓到 ${fromName} 的${actName}，队友${honestName}主动顶上，赔出 ${cardText(item.card)}` });
        io.to(currentRoom).emit('sound_cue', { type: 'caught' });
      } else if (item.ok) {
        io.to(currentRoom).emit('toast_msg', { msg: `${who} 抓到 ${fromName} 的${actName}，获得 ${cardText(item.card)}` });
        io.to(currentRoom).emit('sound_cue', { type: 'caught' });
        if (hasEquip(room, currentSeat, 'zishujing')) {
          io.to(currentRoom).emit('toast_msg', { msg: `🍠 紫薯精附体：${who} 抓牌得手！` });
        }
      } else {
        io.to(currentRoom).emit('toast_msg', { msg: `${who} 抓到 ${fromName} 的${actName}，但对方没有2以上的牌` });
      }
    }

    if (maybeGameOver(room.game)) return finishGame(room);
    scheduleTurnTimer(room);
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
    if (hasEquip(room, currentSeat, 'zishujing')) {
      io.to(currentRoom).emit('toast_msg', { msg: `🍠 紫薯精附体：${who} 验牌得手！` });
    }
    if (result.reflectedSeats && result.reflectedSeats.length) {
      const laoName = room.players.find(p => p.seat === result.reflectedSeats[0])?.name || '老田';
      io.to(currentRoom).emit('toast_msg', { msg: `🛡️ 老田金钟罩：${who} 没看成${laoName}的牌，反被${laoName}偷看了一眼` });
    }

    if (result.penalties && result.penalties.length) {
      for (const item of result.penalties) {
        const targetName = room.players.find(p => p.seat === item.target)?.name || ('座位' + (item.target + 1));
        if (item.shielded) {
          io.to(currentRoom).emit('toast_msg', { msg: `🛡️ 预制护体：${who} 验牌被${targetName}抓中，但免赔了` });
        } else if (item.ok && item.honestPayer != null) {
          const honestName = room.players.find(p => p.seat === item.honestPayer)?.name || ('座位' + (item.honestPayer + 1));
          io.to(currentRoom).emit('toast_msg', { msg: `🤝 老好人：${who} 验牌被${targetName}抓中，队友${honestName}主动顶上，赔出 ${cardText(item.card)}` });
          io.to(currentRoom).emit('sound_cue', { type: 'caught' });
        } else if (item.ok) {
          io.to(currentRoom).emit('toast_msg', { msg: `${who} 验牌被${targetName}抓中，赔出 ${cardText(item.card)}` });
          io.to(currentRoom).emit('sound_cue', { type: 'caught' });
        } else {
          io.to(currentRoom).emit('toast_msg', { msg: `${who} 验牌被${targetName}抓中，但${item.msg.replace(/^.*?没有/, '没有')}` });
        }
      }
    }

    if (maybeGameOver(room.game)) return finishGame(room);
    scheduleTurnTimer(room);
    broadcastState(room);
  });

  socket.on('jiang_throw', ({ cardIds }) => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const result = processJiangThrow(room, currentSeat, cardIds || []);
    if (!result.ok) return socket.emit('error_msg', { msg: result.msg });

    socket.emit('toast_msg', { msg: `已发动扔牌，悄悄扔出 ${result.removedCount} 张` });
    io.to(currentRoom).emit('sound_cue', { type: 'throw2' });
    if (hasEquip(room, currentSeat, 'zishujing')) {
      const who0 = room.players.find(p => p.seat === currentSeat)?.name || ('座位' + (currentSeat + 1));
      io.to(currentRoom).emit('toast_msg', { msg: `🍠 紫薯精附体：${who0} 扔牌得手！` });
    }

    if (result.penalties && result.penalties.length) {
      const who = room.players.find(p => p.seat === currentSeat)?.name || ('座位' + (currentSeat + 1));
      for (const item of result.penalties) {
        const targetName = room.players.find(p => p.seat === item.target)?.name || ('座位' + (item.target + 1));
        if (item.shielded) {
          io.to(currentRoom).emit('toast_msg', { msg: `🛡️ 预制护体：${who} 扔牌被${targetName}抓中，但免赔了` });
        } else if (item.ok && item.honestPayer != null) {
          const honestName = room.players.find(p => p.seat === item.honestPayer)?.name || ('座位' + (item.honestPayer + 1));
          io.to(currentRoom).emit('toast_msg', { msg: `🤝 老好人：${who} 扔牌被${targetName}抓中，队友${honestName}主动顶上，赔出 ${cardText(item.card)}` });
          io.to(currentRoom).emit('sound_cue', { type: 'caught' });
        } else if (item.ok) {
          io.to(currentRoom).emit('toast_msg', { msg: `${who} 扔牌被${targetName}抓中，赔出 ${cardText(item.card)}` });
          io.to(currentRoom).emit('sound_cue', { type: 'caught' });
        } else {
          io.to(currentRoom).emit('toast_msg', { msg: `${who} 扔牌被${targetName}抓中，但${item.msg.replace(/^.*?没有/, '没有')}` });
        }
      }
    }

    if (maybeGameOver(room.game)) return finishGame(room);
    scheduleTurnTimer(room);
    broadcastState(room);
  });

  socket.on('force_skip', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const game = room.game;
    const me = room.players.find(p => p.seat === currentSeat);
    if ((me?.name || '').trim() !== '魏不凡') return socket.emit('error_msg', { msg: '只有魏不凡可以使用「点名」' });
    if (room.weiBufanSkipUsed) return socket.emit('error_msg', { msg: '「点名」整局只能用一次，已经用过了' });
    const target = game.currentPlayer;
    if (target < 0 || target === currentSeat || game.finished[target]) {
      return socket.emit('error_msg', { msg: '现在没有合适的目标' });
    }
    // Only usable on a completely normal turn — same conditions processPass
    // itself already enforces (no active burn, no gouji chase, no kaidian,
    // no return/buy-four task) — reusing processPass below means this can
    // never desync currentPlayer/timers any differently than a real pass would.
    if (!game.tablePlay || game.isGoujiMode || game.activeBurns?.[target] || game.canKaiDian === target || getCurrentReturnTask(game) || getCurrentBuyFourTask(game)) {
      return socket.emit('error_msg', { msg: '现在不是完全正常的回合，不能用「点名」（够级/烧牌/开点时不行）' });
    }
    const targetName0 = (room.players.find(p => p.seat === target)?.name || '').trim();
    if (targetName0 === '老田') {
      // 老田金钟罩: immune, and the attempt still burns 魏不凡's one-and-only
      // use. No queued/deferred effect on 魏不凡 himself — it's not his turn
      // right now, and faking a "skip his future turn" state is exactly the
      // kind of deferred-effect complexity that risks a stuck turn later.
      room.weiBufanSkipUsed = true;
      io.to(currentRoom).emit('toast_msg', { msg: `🛡️ 老田金钟罩：${me.name} 的「点名」被弹开了，白白浪费了整局唯一一次机会！` });
      broadcastState(room);
      return;
    }
    const result = processPass(room, target);
    if (!result.ok) return socket.emit('error_msg', { msg: result.msg || '现在不能对TA使用「点名」' });
    room.weiBufanSkipUsed = true;
    const targetName = room.players.find(p => p.seat === target)?.name || ('座位' + (target + 1));
    io.to(currentRoom).emit('toast_msg', { msg: `📣 ${me.name} 发动「点名」，强制 ${targetName} 跳过这一轮！（整局仅此一次）` });
    scheduleTurnTimer(room);
    broadcastState(room);
  });

  socket.on('alpha_strike', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const game = room.game;
    const me = room.players.find(p => p.seat === currentSeat);
    if ((me?.name || '').trim() !== '王晓') return socket.emit('error_msg', { msg: '只有王晓可以使用「阿尔法突袭」' });
    if (game.finished[currentSeat]) return socket.emit('error_msg', { msg: '你已经出完了' });
    if (game.alphaStrikeUsed?.[currentSeat]) return socket.emit('error_msg', { msg: '「阿尔法突袭」这局已经用过了' });
    if (getCurrentReturnTask(game) || getCurrentBuyFourTask(game)) return socket.emit('error_msg', { msg: '当前阶段不能用' });
    const oppositeSeat = (currentSeat + 3) % 6;
    if (game.finished[oppositeSeat]) return socket.emit('error_msg', { msg: '对家已经出完了，抢不到' });
    const oppName = room.players.find(p => p.seat === oppositeSeat)?.name || ('座位' + (oppositeSeat + 1));

    // 老田金钟罩: if the opposite seat is 老田, the raid bounces — roles swap
    // and 老田 raids 王晓 instead, using the exact same swap logic below.
    const reflected = oppName.trim() === '老田';
    const actingSeat = reflected ? oppositeSeat : currentSeat;
    const losingSeat = reflected ? currentSeat : oppositeSeat;

    const grabbed = getHighestCards(game.hands[losingSeat], 1);
    if (!grabbed.length) return socket.emit('error_msg', { msg: reflected ? '你没有牌可以被抢' : '对家没有牌可抢' });
    const given = getLowestCards(game.hands[actingSeat], 1);
    if (!given.length) return socket.emit('error_msg', { msg: reflected ? '老田没有牌可以补偿你' : '你没有牌可以补偿对家' });

    game.hands[losingSeat] = removeSpecificCards(game.hands[losingSeat], grabbed);
    game.hands[actingSeat] = removeSpecificCards(game.hands[actingSeat], given);
    pushCards(game.hands[actingSeat], grabbed);
    pushCards(game.hands[losingSeat], given);
    sortHand(game.hands[actingSeat]);
    sortHand(game.hands[losingSeat]);
    game.alphaStrikeUsed[currentSeat] = true;

    if (reflected) {
      io.to(currentRoom).emit('toast_msg', { msg: `🛡️ 老田金钟罩：${me.name} 的「阿尔法突袭」被弹开，反被老田抢走 ${cardText(grabbed[0])}，倒贴了一张 ${cardText(given[0])}` });
    } else {
      io.to(currentRoom).emit('toast_msg', { msg: `⚡ ${me.name} 发动「阿尔法突袭」，从 ${oppName} 手里抢走 ${cardText(grabbed[0])}，补偿了一张 ${cardText(given[0])}` });
    }
    broadcastState(room);
  });

  socket.on('strategist_view_teammates', () => {
    const room = rooms[currentRoom];
    if (!room || !room.game) return;
    const result = processStrategistView(room, currentSeat);
    if (!result.ok) return socket.emit('error_msg', { msg: result.msg });
    socket.emit('strategist_result', result);
  });

  socket.on('set_series_mode', ({ mode } = {}) => {
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id || room.state !== 'waiting') return;
    room.seriesMode = mode === 'unlimited' ? 'unlimited' : 'five';
    io.to(room.code).emit('series_settings', { mode: room.seriesMode });
  });

  socket.on('secret_unlock', ({ password } = {}) => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (password !== '765213830') return socket.emit('error_msg', { msg: '口令不正确' });
    room.secretUsers.add(socket.id);
    room.countViewers.add(socket.id);
    socket.emit('secret_status', { unlocked: true, showCounts: true, armed: room.cheatArmed, isHost: room.hostId === socket.id });
    if (room.game && room.state === 'playing') socket.emit('game_state', getStateForPlayer(room, currentSeat));
  });

  socket.on('secret_counts', ({ enabled } = {}) => {
    const room = rooms[currentRoom];
    if (!room?.secretUsers.has(socket.id)) return;
    if (enabled) room.countViewers.add(socket.id); else room.countViewers.delete(socket.id);
    if (room.game && room.state === 'playing') socket.emit('game_state', getStateForPlayer(room, currentSeat));
  });

  socket.on('cheat_toggle', () => {
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id || !room.secretUsers.has(socket.id)) return;
    room.cheatArmed = !room.cheatArmed;
    socket.emit('cheat_status', { armed: room.cheatArmed });
  });

  socket.on('restart_game', () => {
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id || room.state !== 'gameover') return;
    clearTimeout(room.seriesTimer);
    room.seriesTimer = null;
    room.seriesCompleted = 0;
    clearTurnTimer(room);
    clearReturnTimer(room);
    clearBotTimer(room);
    room.state = 'waiting';
    room.game = null;
    const playerList = room.players.map(p => ({ name: p.name, seat: p.seat }));
    io.to(currentRoom).emit('back_to_lobby', { players: playerList });
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const leaving = room.players.find(p => p.id === socket.id);

    room.secretUsers.delete(socket.id);
    room.countViewers.delete(socket.id);
    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      clearTurnTimer(room);
      clearReturnTimer(room);
      clearBotTimer(room);
      clearTimeout(room.seriesTimer);
      delete rooms[currentRoom];
      return;
    }

    const humanPlayers = room.players.filter(p => !p.isBot);
    if (humanPlayers.length === 0) {
      clearTurnTimer(room);
      clearReturnTimer(room);
      clearBotTimer(room);
      clearTimeout(room.seriesTimer);
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
