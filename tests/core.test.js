global.window={};global.crypto=require('crypto').webcrypto;
require(require('path').join(__dirname,'..','js','core.js'));
const VP=window.VP; const A=require('assert');

let st=VP.normalizeState(VP.initialState());
st.players=['A','B','C','D'].map(n=>({name:n,present:true,status:'registered'}));
VP.computeStatsFromPlayers(st);
A.equal(st.stats.registered,4); A.equal(st.stats.alive,4);

// старт → пауза → продолжение
VP.T.start(st);
A.ok(st.timer.isRunning && st.timer.levelEndAt>Date.now());
VP.T.pause(st);
A.ok(st.timer.isPaused && st.timer.levelEndAt===null && st.timer.pauseRemainingSec>0);
const remA=st.timer.pauseRemainingSec;
VP.T.plus60(st); A.equal(st.timer.pauseRemainingSec,remA+60);
VP.T.resume(st); A.ok(!st.timer.isPaused && st.timer.levelEndAt);

// брейк замораживает остаток уровня и возвращает его
VP.T.breakStart(st);
A.ok(VP.isOnBreak(st) && st.timer.breakUntil>Date.now());
const saved=st.timer.savedRemainingSec;
VP.T.breakFinish(st);
A.ok(!VP.isOnBreak(st) && Math.abs(VP.remainingSec(st)-saved)<=1);

// авто-переход: уровень просрочен на 3 уровня подряд
st.timer.levelEndAt = Date.now() - (st.structure.levels[1].min+st.structure.levels[2].min)*60000 - 1000;
const before=st.timer.levelIndex;
VP.advanceExpiredLevels(st);
A.ok(st.timer.levelIndex>before, 'levelIndex продвинулся');
A.ok(st.timer.levelEndAt>Date.now(), 'новый дедлайн в будущем');

// места считаются от bustOrder, реентри не ломает нумерацию
const p=n=>st.players.find(x=>x.name===n);
p('A').status='busted'; p('A').bustOrder=VP.nextBustOrder(st);
VP.computeStatsFromPlayers(st);
A.equal(p('A').place,4); A.equal(st.stats.alive,3);
p('B').status='busted'; p('B').bustOrder=VP.nextBustOrder(st);
VP.computeStatsFromPlayers(st);
A.equal(p('B').place,3);
// A возвращается по реентри → его место освобождается, у B оно пересчитывается
p('A').status='registered'; p('A').bustOrder=null; p('A').reentries=1;
VP.computeStatsFromPlayers(st);
A.equal(p('A').place,null); A.equal(p('B').place,4); A.equal(st.stats.alive,3);
A.equal(VP.calcEntries(st),5,'входы = пришедшие + реентри');

// откат вылета снимает только прибавку последнего вылета
const c=p('C'); c.ko=3; c.koPts=6; c.koDelta={ko:1,koPts:2};
VP.rollbackBustKo(c); A.equal(c.ko,2); A.equal(c.koPts,4);

// призовая зона как в Дойле
const r=VP.calcPayouts(100,0.8);
A.equal(r.TOTAL,1000); A.equal(r.KO_POOL,200); A.equal(r.P,15);
A.equal(r.payouts.reduce((a,b)=>a+b,0),800);
const rp=VP.calcPayouts(100,0.8,800,0,true);
A.equal(rp.KO_POOL,400); A.equal(rp.payouts.reduce((a,b)=>a+b,0),600);

// поздняя регистрация: остаток = текущий уровень + следующие до ПР
st.tournament.lateRegUntilLevel=6; st.timer.levelIndex=0; st.timer.isRunning=true; st.timer.isPaused=false;
st.timer.levelEndAt=Date.now()+60000;
const lr=VP.lateRegRemainingSec(st);
A.ok(lr>60 && lr<6*20*60, 'ПР считается по уровням: '+lr);

console.log('все проверки прошли');

// ── Пост для Telegram ──────────────────────────────────────────────────────
{
  const s2 = VP.normalizeState(VP.initialState());
  s2.players = ['Аня','Боря','Вова','Гена','Дима','Женя','Зина'].map(n=>({name:n,present:true,status:'registered'}));
  VP.computeStatsFromPlayers(s2);
  const g = n => s2.players.find(x => x.name === n);
  // вылеты по хронологии: Зина первой, Женя второй
  g('Зина').status='busted'; g('Зина').bustOrder=1;
  g('Женя').status='busted'; g('Женя').bustOrder=2; g('Женя').ko=1;
  VP.computeStatsFromPlayers(s2);
  const post = VP.buildTelegramPost(s2);
  const lines = post.split('\n');
  A.ok(lines[0].endsWith('Аня'), 'первым идёт оставшийся в игре');
  A.ok(post.includes('6. Женя (1 ko)'), 'ноки в строке: ' + post);
  A.ok(post.endsWith('7. Зина'), 'первый вылетевший — последним');
  A.ok(post.includes('\n\n'), 'призовая зона отбита пустой строкой');
  // ПКО добавляет очки за головы
  s2.tournament.pko = true; g('Женя').koPts = 14;
  A.ok(VP.buildTelegramPost(s2).includes('(1 ko · 14 очк)'), 'формат ПКО');
}

// ── Слияние списков ────────────────────────────────────────────────────────
{
  const s3 = VP.normalizeState(VP.initialState());
  s3.players = [
    {name:'Пришёл', present:true, status:'registered'},
    {name:'Вылетел', present:true, status:'busted', bustOrder:1},
    {name:'Не пришёл', present:false, status:'registered'},
  ];
  VP.computeStatsFromPlayers(s3);
  VP.mergePlayers(s3, [{name:'Новый', player_id:7}, {name:'Пришёл', player_id:3}], 'replace');
  const names = s3.players.map(p=>p.name);
  A.ok(names.includes('Пришёл') && names.includes('Вылетел'), 'replace сохраняет пришедших и вылетевших');
  A.ok(!names.includes('Не пришёл'), 'replace выкидывает неотмеченных');
  A.ok(names.includes('Новый'), 'replace добавляет новых из списка');
  A.equal(s3.players.find(p=>p.name==='Пришёл').present, true, 'отметка «пришёл» не сбилась');
  VP.mergePlayers(s3, [{name:'Вылетел', player_id:9}], 'add');
  A.equal(s3.players.find(p=>p.name==='Вылетел').player_id, 9, 'add доклеивает player_id');
  A.equal(s3.players.filter(p=>p.name==='Вылетел').length, 1, 'add не дублирует');
}

// ── Оплата ─────────────────────────────────────────────────────────────────
{
  const s4 = VP.normalizeState(VP.initialState());
  s4.tournament.defaultBuyIn = 1000;
  s4.tournament.addonEnabled = true;
  s4.tournament.addonCost = 500;
  s4.players = [{name:'Игрок', present:true, status:'registered'}];
  VP.computeStatsFromPlayers(s4);
  const t = s4.tournament;
  const p = () => s4.players[0];

  A.equal(VP.DEFAULT_PAY_METHOD, 'transfer', 'по умолчанию платят переводом');
  A.equal(VP.PAY_METHODS[0].key, 'transfer', 'перевод — первый в списке способов');

  A.equal(VP.calcExpected(p(), t), 1000, 'один вход по взносу турнира');
  p().reentries = 1;
  A.equal(VP.calcExpected(p(), t), 2000, 'реентри удваивает сумму');
  p().freeEntries = 1;
  A.equal(VP.calcExpected(p(), t), 1000, 'free entry снимает один вход');
  p().addon = true;
  A.equal(VP.calcExpected(p(), t), 1500, 'платный аддон прибавляется');
  p().addonFree = true;
  A.equal(VP.calcExpected(p(), t), 1000, 'бесплатный аддон не стоит ничего');

  p().buyIn = VP.buyInForTariff('half', t);
  A.equal(VP.tariffOf(p(), t), 'half', 'половинный тариф распознаётся');
  A.equal(VP.calcExpected(p(), t), 500, 'половинный взнос');
  p().buyIn = VP.buyInForTariff('free', t);
  A.equal(VP.calcExpected(p(), t), 0, 'free-тариф обнуляет сумму');
  p().buyIn = VP.buyInForTariff('full', t);
  A.equal(p().buyIn, null, 'полный тариф = взнос турнира');

  p().payments = [{method:'transfer', amount:600}];
  A.equal(VP.totalPaid(p()), 600);
  A.equal(VP.remainingAmount(p(), t), 400, 'остаток после частичной оплаты');
  A.equal(VP.payStatus(p(), t), 'part');
  p().payments.push({method:'cash', amount:400});
  A.equal(VP.payStatus(p(), t), 'paid', 'две части закрывают сумму');

  const totals = VP.calcPayTotals(s4);
  A.equal(totals.transfer, 600); A.equal(totals.cash, 400); A.equal(totals.card, 0);
  A.equal(totals.total, 1000); A.equal(totals.debt, 0); A.equal(totals.settled, 1);

  // нормализация: битый способ чинится на перевод, нулевые платежи отбрасываются
  s4.players[0].payments = [{method:'btc', amount:100}, {method:'card', amount:0}];
  VP.normalizeState(s4);
  A.deepEqual(s4.players[0].payments, [{method:'transfer', amount:100}], 'платежи нормализуются');
}

console.log('пост, слияние и оплата — проверки прошли');
