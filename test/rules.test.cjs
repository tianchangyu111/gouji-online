const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const repo = process.env.GOUJI_TEST_REPO || path.resolve(__dirname, '..');

function harness() {
  const realRequire = createRequire(path.join(repo, 'server.js'));
  const events = [], timers = new Map();
  let onConnection, clock = 100000, timerId = 0;
  let seed=123456789;
  const seededMath=Object.create(Math);
  seededMath.random=()=>{ seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; };
  class Clock extends Date { static now() { return clock; } }
  class SocketServer {
    on(name, fn) { if (name === 'connection') onConnection = fn; }
    to(id) { return { emit(name, data) { events.push({ id, name, data: JSON.parse(JSON.stringify(data)) }); } }; }
  }
  const ctx = vm.createContext({
    __dirname: repo, console, Date: Clock, Math: seededMath,
    require: name => name === 'socket.io' ? { Server: SocketServer } : realRequire(name),
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  const source = fs.readFileSync(path.join(repo, 'server.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('const PORT =')), ctx);
  const run = code => vm.runInContext(code, ctx);
  run(`let idSeq = 1000;
    function cards(ranks) { return ranks.map(rank => ({rank, suit: rank >= 16 ? -1 : 0, id: idSeq++})); }
    function fresh(ranks = [], seat = 0) {
      const room = rooms[createRoom('p0', '玩家0')];
      room.players = Array.from({length:6}, (_, seat) => ({id:'p'+seat, name:'玩家'+seat, seat}));
      room.game = createGameState(Array.from({length:6}, (_, i) => cards(ranks[i] || [8,4,3])), seat, 1, [], [], room.players);
      room.state = 'playing';
      return room;
    }
    let r;
  `);
  return {
    run, events, timers,
    json(code) { return JSON.parse(JSON.stringify(run(code))); },
    advance(ms) { clock += ms; },
    fire(id) { const timer = timers.get(id); assert.ok(timer, 'timer exists'); timers.delete(id); clock += timer.delay; timer.fn(); },
    socket(id) {
      const handlers = new Map();
      onConnection({id, on: (event, fn) => handlers.set(event, fn), join() {}, emit: (name, data) => events.push({id,name,data})});
      return { emit: (event, data) => handlers.get(event)(data), last: event => events.findLast(e => e.id === id && e.name === event)?.data };
    },
  };
}

test('two 2s require two strictly higher specials, independent of order', () => {
  const h = harness();
  for (const ranks of [[16,15], [15,16], [17,15], [15,15]]) assert.equal(h.run(`canBeat(cards(${JSON.stringify(ranks)}), cards([15,15]))`), false);
  for (const ranks of [[16,16], [17,16], [17,17]]) assert.equal(h.run(`canBeat(cards(${JSON.stringify(ranks)}), cards([15,15]))`), true);
  assert.equal(h.run('canBeat(cards([17,17]), cards([17]))'), true);
  assert.equal(h.run('canBeat(cards([16]), cards([15]))'), true);
});

test('2 fills an ordinary rank without increasing its strength or creating pure kaidian', () => {
  const h = harness();
  assert.equal(h.run('analyzePlay(cards([5,5,5,5,5,15])).coreCount'), 6);
  assert.equal(h.run('canBeat(cards([5,5,5,5,5,15]),cards([5,5,5,5,5,5]))'), false);
  assert.equal(h.run('canBeat(cards([6,6,6,6,6,15]),cards([5,5,5,5,5,15]))'), true);
  assert.equal(h.run('isGoujiPlay(cards([13,15]))'), true);
  assert.equal(h.run('isPureGoujiPlay(cards([13,15]))'), false);
  h.run('r=fresh([[5,5,5,5,5,15,3]]);');
  assert.equal(h.run('processPlay(r,0,r.game.hands[0].filter(c=>c.rank!==3).map(c=>c.id)).ok'), true);
});

test('every standard, lucky and good deal has 54 unique cards and exactly one 3 per seat', () => {
  const h = harness();
  h.run(`for(let i=0;i<120;i++) {
    const hands = deal(i%3 === 0 ? i%6 : -1, i%3 === 1 ? i%6 : -1, (i+1)%6);
    if(hands.some(hand=>hand.length!==54 || hand.filter(c=>c.rank===3).length!==1)) throw Error('Bad deal '+i);
    if(new Set(hands.flat().map(c=>c.id)).size!==324) throw Error('Duplicate cards');
  }`);
});

test('tributes, returns and point tribute draws preserve the reserved 3', () => {
  const h = harness();
  h.run('r=fresh(); r.pendingTribute=[{from:1,to:0,count:2,type:"落贡"}]; startRound(Object.assign(r,{state:"waiting"}));');
  h.run('while(getCurrentReturnTask(r.game)) { const t=getCurrentReturnTask(r.game); finalizeReturnTask(r,t,getLowestCards(r.game.hands[t.owedBy],t.count),true); }');
  assert.equal(h.run('r.game.hands.every(hand=>hand.filter(c=>c.rank===3).length===1)'), true);
  assert.equal(h.run('getRandomCardsExcludingTribute(cards([3,5,6]),3).some(c=>c.rank===3)'), false);
});

test('20 second turns retain their deadline across off-turn updates, including banwei', () => {
  const h = harness();
  h.run('r=fresh(); r.playerEquipment[0]={id:"banwei", used:false}; scheduleTurnTimer(r);');
  assert.equal(h.run('r.game.turnEndsAt'), 120000);
  const id = h.run('r.turnTimer');
  h.advance(3500);
  h.run('scheduleTurnTimer(r);');
  assert.equal(h.run('r.turnTimer'), id);
  assert.equal(h.run('getStateForPlayer(r,0).turnRemainingMs'), 16500);
  h.run('r.game.currentPlayer=5; scheduleTurnTimer(r);');
  assert.equal(h.run('r.game.turnEndsAt'), 123500);
});

test('opponents counts are omitted by default and unlocked only for the requesting player', () => {
  const h = harness(), host = h.socket('host');
  host.emit('create_bot_room', {name:'玩家',seriesMode:'five'});
  const code = host.last('room_joined').code;
  host.emit('cheat_toggle');
  assert.equal(h.run(`rooms['${code}'].cheatArmed`), false);
  host.emit('secret_unlock', {password:'wrong'});
  assert.equal(h.run(`rooms['${code}'].countViewers.size`), 0);
  host.emit('start_game');
  assert.deepEqual(host.last('game_state').handCounts.slice(1), [null,null,null,null,null]);
  host.emit('secret_unlock', {password:'765213830'});
  assert.equal(host.last('game_state').handCounts.every(Number.isInteger), true);
  assert.equal(h.run(`getStateForPlayer(rooms['${code}'],1).handCounts[0]`), null);
  host.emit('cheat_toggle');
  assert.equal(h.run(`rooms['${code}'].cheatArmed`), true);
  host.emit('secret_counts', {enabled:false});
  assert.equal(host.last('game_state').handCounts[1], null);
});

test('an exhausted team ends the game and remaining hands determine the final positions', () => {
  const h = harness();
  h.run('r=fresh([[5,6,7,8],[3],[5,6],[3],[5,6,7],[3]]); r.game.rankings=[1,3,5]; r.game.finished=[false,true,false,true,false,true];');
  assert.equal(h.run('maybeGameOver(r.game)'), true);
  assert.deepEqual(h.json('r.game.rankings'), [1,3,5,2,4,0]);
  assert.equal(h.run('r.game.finished.every(Boolean)'), true);
  assert.equal(h.run('r.game.winningTeam'), 'B');
  assert.equal(h.run('maybeGameOver(r.game)'), true);
  assert.equal(h.run('r.game.rankings.length'), 6);
});

test('five game series advances automatically and stops after game five; unlimited continues', () => {
  const h = harness();
  h.run('r=fresh();');
  for (let round=1; round<=5; round++) {
    h.run('r.game.rankings=[0,2,4,1,3,5]; r.game.finished.fill(true); finishGame(r);');
    assert.equal(h.run('r.seriesCompleted'), round);
    h.run('finishGame(r);');
    assert.equal(h.run('r.seriesCompleted'), round, 'settlement is idempotent');
    if(round<5) { const id=h.run('r.seriesTimer'); assert.equal(h.timers.get(id).delay,5000); h.fire(id); assert.equal(h.run('r.state'),'playing'); }
    else assert.equal(h.run('r.seriesTimer'), null);
  }
  h.run('r=fresh(); r.seriesMode="unlimited"; r.seriesCompleted=99; r.game.rankings=[0,2,4,1,3,5]; finishGame(r);');
  h.fire(h.run('r.seriesTimer'));
  assert.equal(h.run('r.state'), 'playing');
  assert.equal(h.run('r.seriesCompleted'),100);
});

test('pure gouji opens dian; attached 2 cannot open it; normal four and pass decline it', () => {
  const h = harness();
  for (const choice of ['kaidian','normal4','pass']) {
    h.run('r=fresh([[13,13,4,4,3]]); processPlay(r,0,r.game.hands[0].filter(c=>c.rank===13).map(c=>c.id)); processPass(r,3);');
    assert.equal(h.run('r.game.canKaiDian'),0);
    assert.equal(h.run(choice==='pass' ? 'processPass(r,0).ok' : `processPlay(r,0,r.game.hands[0].filter(c=>c.rank===4).map(c=>c.id),'${choice}').ok`),true);
    assert.equal(h.run('r.game.openedDian[0]'), choice==='kaidian');
    if(choice==='kaidian') assert.equal(h.run('r.game.playerActions[0].isKaiDian'),true);
  }
  h.run('r=fresh([[13,15,4,3]]); processPlay(r,0,r.game.hands[0].filter(c=>[13,15].includes(c.rank)).map(c=>c.id)); processPass(r,3);');
  assert.equal(h.run('r.game.canKaiDian'),-1);
});

test('burn continues as a new lead with a king; the final 3 completes the burn', () => {
  const h = harness();
  h.run('r=fresh([[5,16,3]]); r.game.activeBurns[0]={victim:1}; r.game.tablePlay={player:0,cards:cards([14,14,17]),isShao:true};');
  assert.equal(h.run('processPlay(r,0,r.game.hands[0].filter(c=>c.rank!==3).map(c=>c.id)).ok'),true);
  assert.equal(h.run('r.game.currentPlayer'),0);
  assert.equal(h.run('chooseTimeoutLeadIds(r.game,0).length'),1);
  assert.equal(h.run('processPlay(r,0,r.game.hands[0].map(c=>c.id)).ok'),true);
  assert.equal(h.run('r.game.finished[0]'),true);
  assert.equal(h.run('r.game.activeBurns[0]'),null);
  assert.equal(h.run('r.burnTributeDebt[1]'),1);
});

test('final 3 can finish on a new lead while mixing 3 with 2 is rejected', () => {
  const h = harness();
  h.run('r=fresh([[3]]);');
  assert.equal(h.run('processPlay(r,0,r.game.hands[0].map(c=>c.id)).ok'),true);
  h.run('r=fresh([[3,15]]);');
  assert.equal(h.run('processPlay(r,0,r.game.hands[0].map(c=>c.id)).ok'),false);
});

test('completed fan-shao cannot restore a burn or turn for a finished seat', () => {
  const h=harness();
  h.run('r=fresh([[13,16],[3,5],[8,3],[8,3],[8,3],[8,3]],1); r.game.tablePlay={player:1,cards:cards([12,16]),isShao:true}; r.game.activeBurns[1]={victim:0};');
  assert.equal(h.run('processPlay(r,0,r.game.hands[0].map(c=>c.id)).ok'),true);
  assert.equal(h.run('r.game.finished[0]'),true);
  assert.equal(h.run('r.game.activeBurns[0]'),null);
  assert.notEqual(h.run('r.game.currentPlayer'),0);
});

test('eligible players can interrupt for an initial burn; 2 does not replace a king', () => {
  const h=harness();
  h.run('r=fresh([[13,13,3],[8,4,3],[14,16,3],[8,4,3],[8,4,3],[8,4,3]],3); r.game.tablePlay={player:0,cards:cards([13,13]),isGouji:true,isPureGouji:true};');
  assert.equal(h.run('getStateForPlayer(r,0).canBurn'),false);
  assert.equal(h.run('getStateForPlayer(r,1).canBurn'),false);
  assert.equal(h.run('getStateForPlayer(r,2).canBurn'),true);
  assert.equal(h.run('processPlay(r,2,r.game.hands[2].filter(c=>c.rank!==3).map(c=>c.id)).ok'),true);
  assert.equal(h.run('r.game.activeBurns[2].victim'),0);
  assert.equal(h.run('isShaoPlay(cards([14,15]))'),false);
  assert.equal(h.run('isShaoPlay(cards([14,16]))'),true);
  assert.equal(h.run('chooseAutoBeatIds({hands:[cards([17,17,3])]},0,cards([17])).length'),2);
});

test('full bot games and automatic tribute rounds make progress to settlement', () => {
  const h=harness();
  h.run(`
    for(let sample=0;sample<20;sample++) {
      r=fresh(); r.state='waiting';
      r.players.forEach(p=>{p.isBot=true;}); r.botMode=true;
      startRound(r);
      for(let round=0;round<3;round++) {
        let previous='', unchanged=0, steps=0;
        while(r.state==='playing' && steps++<1200) {
          runBotStep(r);
          const snapshot=JSON.stringify([r.game.currentPlayer,r.game.tablePlay,r.game.passedThisRound,r.game.hands.map(h=>h.length),r.game.finished,r.game.canKaiDian,getCurrentReturnTask(r.game),getCurrentBuyFourTask(r.game)]);
          unchanged=snapshot===previous ? unchanged+1 : 0;
          if(unchanged>3) throw Error('Stalled bot game '+sample+': '+snapshot);
          previous=snapshot;
        }
        if(r.state!=='gameover') throw Error('Did not finish '+sample);
        if(r.game.rankings.length!==6 || new Set(r.game.rankings).size!==6) throw Error('Invalid final rankings');
        if(round<2) startRound(r);
      }
    }
  `);
});
