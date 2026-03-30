
// ============ CONSTANTS ============
const RANK_NAMES = {3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A',15:'2',16:'小',17:'大'};
const SUIT_SYMBOLS = ['♠','♥','♦','♣'];
const SUIT_COLORS = ['black','red','red','black'];
const TEAM_A = [0,2,4], TEAM_B = [1,3,5];
const RANK_LABELS = ['','头科','二科','三科','四科','二落','大落'];

let socket = null;
let mySeat = -1;
let myRoom = '';
let isHost = false;
let selectedCards = [];
let currentState = null;
let countdownTimer = null;

// Cheat
let _cClicks = 0, _cTimer = null;

function unlockAudio() {
  audioUnlocked = true;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) {}
}
['click', 'touchend', 'keydown'].forEach(evt => {
  window.addEventListener(evt, unlockAudio, { passive: true, once: true });
});

function playToneSequence(tones, gainValue = 0.035) {
  try {
    if (!audioUnlocked) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    tones.forEach((tone, idx) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = tone.type || 'sine';
      osc.frequency.value = tone.freq;
      gain.gain.setValueAtTime(0.0001, now + tone.at);
      gain.gain.exponentialRampToValueAtTime(gainValue, now + tone.at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.at + tone.dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + tone.at);
      osc.stop(now + tone.at + tone.dur + 0.02);
    });
  } catch (_) {}
}

function playSecretSound() {
  playToneSequence([
    { freq: 880, at: 0.00, dur: 0.08, type: 'triangle' },
    { freq: 1174, at: 0.10, dur: 0.08, type: 'triangle' },
  ], 0.02);
}

function playCaughtSound() {
  playToneSequence([
    { freq: 520, at: 0.00, dur: 0.09, type: 'square' },
    { freq: 390, at: 0.11, dur: 0.11, type: 'square' },
  ], 0.03);
}

function playCardSound() {
  playToneSequence([
    { freq: 660, at: 0.00, dur: 0.04, type: 'triangle' },
    { freq: 820, at: 0.05, dur: 0.05, type: 'triangle' },
  ], 0.018);
}

function speakTurnPrompt() {
  try {
    if (!audioUnlocked || !('speechSynthesis' in window)) return;
    const ut = new SpeechSynthesisUtterance('出牌不要等');
    ut.lang = 'zh-CN';
    ut.rate = 1.08;
    ut.pitch = 1.0;
    ut.volume = 0.9;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(ut);
  } catch (_) {}
}

function onTitleClick() {
  if (!isHost) return;
  _cClicks++;
  clearTimeout(_cTimer);
  _cTimer = setTimeout(() => { _cClicks = 0; }, 500);
  if (_cClicks >= 3) {
    _cClicks = 0;
    socket.emit('cheat_toggle');
  }
}

// ============ CONNECTION ============
function connect() {
  socket = io();

  socket.on('room_joined', (data) => {
    myRoom = data.code;
    mySeat = data.seat;
    isHost = data.seat === 0;
    showWaiting(data.code, data.players);
  });

  socket.on('player_list', (data) => {
    renderPlayerList(data.players);
  });

  socket.on('game_state', (state) => {
    currentState = state;
    selectedCards = [];
    showGame(state);
  });

  socket.on('game_over', (data) => {
    showGameOver(data);
  });

  socket.on('back_to_lobby', (data) => {
    document.getElementById('gameover').classList.remove('show');
  hidePeekOverlay();
    document.getElementById('game').style.display = 'none';
    document.getElementById('waiting').style.display = 'flex';
    hidePeekOverlay();
    renderPlayerList(data.players);
  });

  socket.on('error_msg', (data) => {
    toast(data.msg);
  });

  socket.on('toast_msg', (data) => {
    if (data && data.msg) toast(data.msg);
  });

  socket.on('sound_cue', (data) => {
    const t = data?.type || 'secret';
    if (t === 'caught') playCaughtSound();
    else if (t === 'play') playCardSound();
    else playSecretSound();
  });

  socket.on('peek_result', (data) => {
    showPeekOverlay(data);
  });

  socket.on('strategist_result', (data) => {
    showStrategistPanel(data);
  });

  socket.on('cheat_status', (data) => {
    const el = document.getElementById('game-title');
    if (el) {
      el.style.color = data.armed ? '#e85d5d' : '';
      el.style.opacity = data.armed ? '0.85' : '';
    }
    toast(data.armed ? '已激活' : '已取消');
  });

  socket.on('player_disconnected', (data) => {
    toast('有玩家掉线了');
  });
}

// ============ LOBBY ACTIONS ============
function doCreate() {
  const name = document.getElementById('input-name').value.trim() || '房主';
  if (!socket) connect();
  socket.emit('create_room', { name });
}

function doJoin() {
  const name = document.getElementById('input-name').value.trim() || '玩家';
  const code = document.getElementById('input-code').value.trim().toUpperCase();
  if (!code || code.length < 4) { toast('请输入4位房间号'); return; }
  if (!socket) connect();
  socket.emit('join_room', { code, name });
}

function doStart() {
  socket.emit('start_game');
}

function doRestart() {
  if (isHost) socket.emit('restart_game');
}

// ============ WAITING ROOM ============
function showWaiting(code, players) {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('waiting').style.display = 'flex';
  document.getElementById('room-code-display').textContent = code;
  renderPlayerList(players);
}

function renderPlayerList(players) {
  const el = document.getElementById('player-list');
  let html = '';
  for (let i = 0; i < 6; i++) {
    const p = players.find(pp => pp.seat === i);
    const isTeamA = TEAM_A.includes(i);
    const teamClass = isTeamA ? 'team-a-bg' : 'team-b-bg';
    const teamLabel = isTeamA ? '红' : '蓝';
    html += `<div class="player-slot">
      <div class="seat-num ${teamClass}">${i+1}</div>
      <div class="pname ${p ? '' : 'empty'}">${p ? p.name : '等待加入...'}</div>
      ${p && p.seat === 0 ? '<span class="host-tag">房主</span>' : ''}
      ${p && p.seat === mySeat ? '<span class="host-tag">你</span>' : ''}
    </div>`;
  }
  el.innerHTML = html;

  const btn = document.getElementById('btn-start');
  if (isHost) {
    btn.style.display = '';
    btn.disabled = players.length < 6;
    document.getElementById('wait-hint').textContent = players.length < 6
      ? `等待玩家加入... (${players.length}/6)`
      : '人齐了，可以开始！';
  } else {
    btn.style.display = 'none';
    document.getElementById('wait-hint').textContent = `等待房主开始游戏 (${players.length}/6)`;
  }
}

// ============ GAME RENDERING ============
let _lastShownRound = 0;

function showGame(state) {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('waiting').style.display = 'none';
  document.getElementById('game').style.display = 'block';
  document.getElementById('gameover').classList.remove('show');
  hidePeekOverlay();

  renderLabels(state);
  renderPlayedAreas(state);
  renderMyHand(state);
  renderRankings(state);

  const isMyTurn = state.currentPlayer === state.mySeat && !state.finished[state.mySeat];
  const hasTable = !!state.tablePlay;
  const isKaiDianTurn = state.canKaiDian === state.mySeat && !state.finished[state.mySeat];
  document.getElementById('btn-play').disabled = !isMyTurn || isKaiDianTurn;
  document.getElementById('btn-play').style.display = isKaiDianTurn ? 'none' : '';
  document.getElementById('btn-normal4').style.display = isKaiDianTurn ? '' : 'none';
  document.getElementById('btn-normal4').disabled = !isKaiDianTurn;
  document.getElementById('btn-kaidian').style.display = isKaiDianTurn ? '' : 'none';
  document.getElementById('btn-kaidian').disabled = !isKaiDianTurn;
  document.getElementById('btn-pass').disabled = !isMyTurn || (!hasTable && !isKaiDianTurn);
  document.getElementById('btn-let').style.display = state.canLet ? '' : 'none';
  document.getElementById('btn-let').disabled = !state.canLet;
  document.getElementById('btn-naoji').disabled = state.finished[state.mySeat] || (state.naojiUses[state.mySeat] >= state.naojiMax[state.mySeat]);
  document.getElementById('btn-grab').disabled = state.finished[state.mySeat];
  document.getElementById('btn-callgong').style.display = 'none';
  document.getElementById('btn-callgong').disabled = true;
  document.getElementById('btn-peek').style.display = (state.peekMax?.[state.mySeat] || 0) > 0 ? '' : 'none';
  document.getElementById('btn-peek').disabled = !state.canPeek || state.finished[state.mySeat];
  document.getElementById('btn-strategist').style.display = state.canStrategist ? '' : 'none';
  document.getElementById('btn-strategist').disabled = !state.canStrategist;
  if (!state.canStrategist) hideStrategistPanel();
  renderTimer(state);

  const becameMyTurn = state.currentPlayer === state.mySeat && lastTurnPlayer !== state.mySeat;
  if (becameMyTurn) speakTurnPrompt();
  lastTurnPlayer = state.currentPlayer;

  const panelMeta = document.getElementById('panel-meta');
  if (panelMeta) {
    const peekUsed = state.peekUses?.[state.mySeat] ?? 0;
    const peekMax = state.peekMax?.[state.mySeat] ?? 0;
    const peekText = peekMax > 0 ? `　|　验牌：${peekUsed}/${peekMax}${state.canPeek ? '（可用）' : '（仅他人回合）'}` : '';
    const strategistText = state.canStrategist ? `　|　狗头军师：可看${(state.strategistTargets || []).length}名队友` : '';
    const tributeText = `　|　点贡:${state.dianTributeDebt?.[state.mySeat] ?? 0} 烧贡:${state.burnTributeDebt?.[state.mySeat] ?? 0} 闷贡:${state.menTributeDebt?.[state.mySeat] ?? 0}`;
    const letText = state.canLet ? '　|　可让牌' : '';
    const phaseText = state.isChaosPhase ? '　|　四人乱缠' : (state.noHeadSeat >= 0 ? `　|　无头：${getPlayerName(state, state.noHeadSeat)}` : '');
    panelMeta.innerHTML = `已出牌池：${state.playedPoolCount || 0}张　|　孬急：${state.naojiUses?.[state.mySeat] ?? 0}/${state.naojiMax?.[state.mySeat] ?? 5}${peekText}${strategistText}${tributeText}${letText}${phaseText}`;
  }

  const goBtn = document.getElementById('go-btn');
  goBtn.style.display = isHost ? '' : 'none';

  // Show tribute/buySan notification once per round
  if (state.roundNumber && state.roundNumber !== _lastShownRound) {
    _lastShownRound = state.roundNumber;
    const tLog = state.tributeLog || [];
    const bLog = state.buySanLog || [];
    if (tLog.length > 0 || bLog.length > 0) {
      showTributeOverlay(state, tLog, bLog);
    }
  }
}

function getRelativeSeat(absSeat, myS) {
  return (absSeat - myS + 6) % 6;
}

function getPlayerName(state, absSeat) {
  const p = state.players.find(pp => pp.seat === absSeat);
  return p ? p.name : ('座位' + (absSeat+1));
}

function renderLabels(state) {
  const container = document.getElementById('player-labels');
  let html = '';
  for (let abs = 0; abs < 6; abs++) {
    const rel = getRelativeSeat(abs, state.mySeat);
    const name = getPlayerName(state, abs);
    const isTeamA = TEAM_A.includes(abs);
    const isTurn = state.currentPlayer === abs && !state.finished[abs];
    const isDuiTou = (abs + 3) % 6 === state.mySeat;

    let extra = '';
    if (abs === state.mySeat) extra = '(我)';
    else if (isDuiTou) extra = '(对头)';
    if (state.noHeadSeat === abs) extra += '·无头';

    // 开点 badge
    let dianHtml = '';
    if (state.openedDian && state.openedDian[abs]) {
      dianHtml = '<span class="dian-badge dian-open">已开点</span>';
    }
    if (state.calledTributeSeats && state.calledTributeSeats[abs]) {
      dianHtml += '<span class="dian-badge dian-closed">下局叫贡</span>';
    }

    let statusHtml = '';
    if (state.finished[abs]) {
      const ri = state.rankings.indexOf(abs);
      statusHtml = `<div class="finish-text">${RANK_LABELS[ri+1]}</div>`;
    } else if (rel !== 0) {
      statusHtml = `<div class="card-info">${state.handCounts[abs]}张 ${dianHtml}</div>`;
    } else {
      statusHtml = `<div class="card-info">${dianHtml}</div>`;
    }

    let actionHtml = '';
    const act = state.playerActions[abs];
    if (act && act.type === 'pass') {
      actionHtml = '<div class="action-text" style="color:rgba(255,255,255,0.35)">过</div>';
    } else if (act && act.type === 'yield') {
      actionHtml = '<div class="action-text" style="color:rgba(255,220,120,0.8)">让</div>';
    } else if (act && act.type === 'timeout') {
      actionHtml = '<div class="action-text" style="color:rgba(255,255,255,0.35)">超时</div>';
    }

    html += `<div class="plabel pos-${rel}">
      <div class="name-tag ${isTurn ? 'is-turn' : ''}">
        <span class="team-indicator" style="background:${isTeamA ? '#cc4444' : '#3377cc'}"></span>
        ${name} ${extra}
      </div>
      ${statusHtml}
      ${actionHtml}
    </div>`;
  }
  container.innerHTML = html;
}

function renderPlayedAreas(state) {
  const container = document.getElementById('played-areas');
  let html = '';
  for (let abs = 0; abs < 6; abs++) {
    const rel = getRelativeSeat(abs, state.mySeat);
    const act = state.playerActions[abs];
    let content = '';
    if (act && act.type === 'play' && act.cards) {
      act.cards.forEach(c => { content += cardHTML(c, true); });
      if (act.isKaiDian) {
        content += '<span class="kaidian-tag">开 点 !</span>';
      } else if (act.isCallGong) {
        content += '<span class="kaidian-tag" style="color:#ffd6c6;background:rgba(240,109,75,0.18);border-color:rgba(255,178,141,0.4)">叫 贡 4</span>';
      } else if (act.isNormalFour) {
        content += '<span class="kaidian-tag" style="color:#c8f0ff;background:rgba(72,160,220,0.18);border-color:rgba(120,200,255,0.4)">平 出 4</span>';
      } else if (isGoujiPlayClient(act.cards)) {
        content += '<span class="gouji-tag">够级</span>';
      }
    }
    html += `<div class="played-area ppos-${rel}">${content}</div>`;
  }
  container.innerHTML = html;
}

function renderMyHand(state) {
  const container = document.getElementById('my-hand');
  container.innerHTML = '';
  const hand = state.myHand;
  if (!hand || hand.length === 0) return;

  const nonThreeCount = hand.filter(c => c.rank !== 3).length;
  const canPlay3 = nonThreeCount === 0;
  const isKaiDianTurn = state.canKaiDian === state.mySeat;

  const groups = [];
  let cur = null;
  for (const card of hand) {
    if (!cur || cur.rank !== card.rank) {
      cur = { rank: card.rank, cards: [] };
      groups.push(cur);
    }
    cur.cards.push(card);
  }

  groups.forEach(group => {
    const groupEl = document.createElement('div');
    groupEl.className = 'card-group';
    const ov = group.cards.length <= 4 ? 18 : 14;

    let isLocked = false;
    if (isKaiDianTurn) {
      isLocked = group.rank !== 4;
    } else {
      isLocked = (group.rank === 3 && !canPlay3);
    }

    group.cards.forEach((card, idx) => {
      const el = createCardEl(card);
      if (idx > 0) el.style.marginLeft = (-58 + ov) + 'px';
      if (selectedCards.some(c => c.id === card.id)) el.classList.add('selected');
      if (isLocked) el.classList.add('locked');

      if (!isLocked) {
        el.addEventListener('click', () => toggleSelect(card));
        let lastTap = 0;
        el.addEventListener('touchend', (e) => {
          const now = Date.now();
          if (now - lastTap < 300) { e.preventDefault(); toggleGroupSelect(group.cards); }
          lastTap = now;
        });
        el.addEventListener('dblclick', (e) => { e.preventDefault(); toggleGroupSelect(group.cards); });
      }

      groupEl.appendChild(el);
    });

    if (group.cards.length > 1) {
      const badge = document.createElement('div');
      badge.className = 'group-count';
      badge.textContent = '×' + group.cards.length;
      groupEl.appendChild(badge);
    }

    if (isLocked) {
      const lock = document.createElement('div');
      lock.className = 'group-count';
      lock.style.color = '#f87171';
      if (isKaiDianTurn && group.rank !== 4) lock.textContent = '🔒仅4';
      else lock.textContent = group.rank === 3 ? '🔒末手' : '🔒开点';
      groupEl.appendChild(lock);
    }

    container.appendChild(groupEl);
  });
}

function renderRankings(state) {
  const el = document.getElementById('rank-list');
  if (!state.rankings || state.rankings.length === 0) {
    el.innerHTML = '<div style="color:#666;font-size:11px">—</div>';
    return;
  }
  el.innerHTML = state.rankings.map((s, i) => {
    const name = getPlayerName(state, s);
    const team = TEAM_A.includes(s) ? '🔴' : '🔵';
    return `<div style="font-size:12px;padding:1px 0">${RANK_LABELS[i+1]} ${team} ${name}</div>`;
  }).join('');

  const myMeta = document.getElementById('my-meta');
  if (myMeta) {
    const used = state.naojiUses?.[state.mySeat] ?? 0;
    const max = state.naojiMax?.[state.mySeat] ?? 5;
    const peekUsed = state.peekUses?.[state.mySeat] ?? 0;
    const peekMax = state.peekMax?.[state.mySeat] ?? 0;
    const peekTxt = peekMax > 0 ? `<br>验牌：${peekUsed}/${peekMax}${state.canPeek ? '（可用）' : '（仅他人回合）'}` : '';
    const strategistTxt = state.canStrategist ? `<br>狗头军师：可看${(state.strategistTargets || []).length}名队友` : '';
    myMeta.innerHTML = `孬急：${used}/${max}${peekTxt}${strategistTxt}`;
  }
}

// ============ CARD HELPERS ============
function createCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  if (card.rank === 17) {
    el.classList.add('joker-big');
    el.innerHTML = '<div class="joker-face big"></div><span class="joker-text">大王</span>';
  } else if (card.rank === 16) {
    el.classList.add('joker-small');
    el.innerHTML = '<div class="joker-face small"></div><span class="joker-text">小王</span>';
  } else {
    el.classList.add(SUIT_COLORS[card.suit]);
    el.innerHTML = `<span class="rank">${RANK_NAMES[card.rank]}</span><span class="suit">${SUIT_SYMBOLS[card.suit]}</span>`;
  }
  return el;
}

function cardHTML(card, mini) {
  let cls = 'card';
  let inner = '';
  if (card.rank === 17) { cls += ' joker-big'; inner = '<div class="joker-face big"></div><span class="joker-text">大王</span>'; }
  else if (card.rank === 16) { cls += ' joker-small'; inner = '<div class="joker-face small"></div><span class="joker-text">小王</span>'; }
  else { cls += ' ' + SUIT_COLORS[card.suit]; inner = `<span class="rank">${RANK_NAMES[card.rank]}</span><span class="suit">${SUIT_SYMBOLS[card.suit]}</span>`; }
  return `<div class="${cls}">${inner}</div>`;
}

function isGoujiPlayClient(cards) {
  if (!cards || cards.length === 0) return false;
  const hasJoker = cards.some(c => c.rank >= 16);
  if (hasJoker) return true;
  const r = cards.filter(c => c.rank <= 14);
  if (r.length === 0) {
    if (cards.some(c => c.rank === 15)) return true;
    return false;
  }
  const baseRank = r[0].rank;
  const count = cards.length;
  if (baseRank === 10 && count >= 5) return true;
  if (baseRank === 11 && count >= 4) return true;
  if (baseRank === 12 && count >= 3) return true;
  if (baseRank === 13 && count >= 2) return true;
  if (baseRank === 14 && count >= 2) return true;
  if (baseRank === 15) return true;
  return false;
}

// ============ INTERACTIONS ============
function toggleSelect(card) {
  const idx = selectedCards.findIndex(c => c.id === card.id);
  if (idx >= 0) selectedCards.splice(idx, 1);
  else selectedCards.push(card);
  if (currentState) renderMyHand(currentState);
}

function toggleGroupSelect(cards) {
  const allSel = cards.every(c => selectedCards.some(s => s.id === c.id));
  if (allSel) {
    selectedCards = selectedCards.filter(s => !cards.some(c => c.id === s.id));
  } else {
    cards.forEach(c => { if (!selectedCards.some(s => s.id === c.id)) selectedCards.push(c); });
  }
  if (currentState) renderMyHand(currentState);
}

function doPlay() {
  if (selectedCards.length === 0) { toast('请先选牌'); return; }
  socket.emit('play_cards', { cardIds: selectedCards.map(c => c.id), mode: 'normal' });
  selectedCards = [];
}

function doNormalFour() {
  if (selectedCards.length === 0) { toast('请先选4'); return; }
  socket.emit('play_cards', { cardIds: selectedCards.map(c => c.id), mode: 'normal4' });
  selectedCards = [];
}

function doKaiDian() {
  if (selectedCards.length === 0) { toast('请先选中所有4'); return; }
  socket.emit('play_cards', { cardIds: selectedCards.map(c => c.id), mode: 'kaidian' });
  selectedCards = [];
}

function doCallGong() {
  if (selectedCards.length === 0) { toast('请先选中所有4'); return; }
  socket.emit('play_cards', { cardIds: selectedCards.map(c => c.id), mode: 'callgong' });
  selectedCards = [];
}

function doPass() {
  socket.emit('pass');
  selectedCards = [];
}

function doLet() {
  socket.emit('let_teammate');
}

function renderTimer(state) {
  const el = document.getElementById('turn-timer');
  if (!el) return;
  clearInterval(countdownTimer);
  const tick = () => {
    if (!currentState || !currentState.turnEndsAt) {
      el.textContent = '倒计时：--';
      return;
    }
    const left = Math.max(0, Math.ceil((currentState.turnEndsAt - Date.now()) / 1000));
    const isMine = currentState.currentPlayer === currentState.mySeat && !currentState.finished[currentState.mySeat];
    el.textContent = `倒计时：${left}s${isMine ? '（你的回合）' : ''}`;
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

function doNaoji() {
  socket.emit('naoji');
}

function doGrab() {
  socket.emit('grab');
}

function doPeek() {
  socket.emit('peek_neighbors');
}

function doStrategist() {
  socket.emit('strategist_view_teammates');
}

// ============ GAME OVER ============
function showGameOver(data) {
  const { rankings, players } = data;
  const myRankIdx = rankings.indexOf(mySeat);

  const topThree = rankings.slice(0, 3);
  const myTeam = TEAM_A.includes(mySeat) ? TEAM_A : TEAM_B;
  const allMine = topThree.every(s => myTeam.includes(s));
  const allTheirs = topThree.every(s => !myTeam.includes(s));

  const teamASum = rankings.map((s,i) => TEAM_A.includes(s) ? i+1 : 0).reduce((a,b)=>a+b,0);
  const teamBSum = rankings.map((s,i) => TEAM_B.includes(s) ? i+1 : 0).reduce((a,b)=>a+b,0);
  const myTeamIsA = TEAM_A.includes(mySeat);
  const mySum = myTeamIsA ? teamASum : teamBSum;
  const theirSum = myTeamIsA ? teamBSum : teamASum;

  let title;
  if (allMine) title = '🎉 串三户！大胜！';
  else if (allTheirs) title = '😢 被串三户...';
  else if (mySum < theirSum) title = '🎉 胜利！';
  else if (mySum > theirSum) title = '😢 败了...';
  else title = '🤝 平局';

  let detail = '';
  rankings.forEach((s, i) => {
    const p = players.find(pp => pp.seat === s);
    const name = p ? p.name : '?';
    const team = TEAM_A.includes(s) ? '🔴' : '🔵';
    const me = s === mySeat ? ' ← 你' : '';
    detail += `${RANK_LABELS[i+1]}: ${team} ${name}${me}\n`;
  });

  document.getElementById('go-title').textContent = title;
  document.getElementById('go-detail').textContent = detail;
  document.getElementById('go-btn').style.display = isHost ? '' : 'none';
  document.getElementById('gameover').classList.add('show');
}


let peekTimer = null;

function showPeekOverlay(data) {
  const grid = document.getElementById('peek-grid');
  const overlay = document.getElementById('peek-overlay');
  if (!grid || !overlay || !data?.sides) return;

  grid.innerHTML = data.sides.map(side => `
    <div class="peek-side">
      <div class="peek-side-title">${side.side} · ${side.name}（${side.cards.length}张）</div>
      <div class="peek-cards">${side.cards.map(card => cardHTML(card, true)).join('')}</div>
    </div>
  `).join('');

  const note = document.getElementById('peek-note');
  if (note) {
    const uses = data.uses ?? 0;
    const max = data.max ?? 3;
    note.textContent = `3秒后自动关闭｜验牌 ${uses}/${max}`;
  }

  overlay.classList.add('show');
  clearTimeout(peekTimer);
  const delay = Math.max(500, (data.expiresAt || (Date.now() + 3000)) - Date.now());
  peekTimer = setTimeout(hidePeekOverlay, delay);
}

function hidePeekOverlay() {
  document.getElementById('peek-overlay')?.classList.remove('show');
}

function showStrategistPanel(data) {
  const panel = document.getElementById('strategist-panel');
  const body = document.getElementById('strategist-body');
  const note = document.getElementById('strategist-note');
  if (!panel || !body) return;
  const mates = data?.teammates || [];
  body.innerHTML = mates.map(item => `
    <div class="strategist-side">
      <div class="strategist-side-title">队友 · ${item.name}（${item.cards.length}张）</div>
      <div class="strategist-cards">${item.cards.map(card => cardHTML(card, true)).join('')}</div>
    </div>
  `).join('') || '<div class="strategist-note">当前没有剩余队友可查看</div>';
  if (note) note.textContent = '可随时刷新，不会遮住桌面中央的出牌';
  panel.classList.add('show');
}

function hideStrategistPanel() {
  document.getElementById('strategist-panel')?.classList.remove('show');
}

function showTributeOverlay(state, tLog, bLog) {
  const overlay = document.getElementById('tribute-overlay');
  const title = document.getElementById('tribute-title');
  const content = document.getElementById('tribute-content');

  const lines = [];
  if (tLog && tLog.length) {
    title.textContent = '进贡 / 还贡';
    tLog.forEach(item => {
      lines.push(`<div class="tribute-item"><span class="t-type">${item.type}</span>${getPlayerName(state, item.from)} → ${getPlayerName(state, item.to)} ：进 ${Array.isArray(item.give) ? item.give.join('、') : ''}　还 ${Array.isArray(item.back) ? item.back.join('、') : ''}</div>`);
    });
  }
  if (bLog && bLog.length) {
    if (!tLog || !tLog.length) title.textContent = '买三';
    bLog.forEach(item => {
      if (item.seller === -1) {
        lines.push(`<div class="tribute-item"><span class="t-type">买三</span>${getPlayerName(state, item.buyer)}：${item.note || '跳过'}</div>`);
      } else {
        lines.push(`<div class="tribute-item"><span class="t-type">买三</span>${getPlayerName(state, item.buyer)} 向 ${getPlayerName(state, item.seller)} 买3，支付：${item.paid}</div>`);
      }
    });
  }

  if (!lines.length) return;
  content.innerHTML = lines.join('');
  overlay.classList.add('show');
}

function closeTribute() {
  document.getElementById('tribute-overlay').classList.remove('show');
}

// ============ TOAST ============
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1800);
}

// ============ INIT ============
connect();

// Enter key support
document.getElementById('input-code').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
document.getElementById('input-name').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('input-code').focus(); });
