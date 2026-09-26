const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
global.window = {};
global.crypto = require('node:crypto').webcrypto;
require('../js/core.js');
require('../js/crm.js');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const context = vm.createContext({ window, roomOf: () => context.state,
  resultCache: {}, me: null, escHtml: window.VP.escHtml,
  fmtInt: String, avatarHtml: () => '' });
for (const name of ['resultsFromRoom', 'resultsCard']) {
  vm.runInContext(html.match(new RegExp(`  function ${name}\\(t\\) \\{[\\s\\S]*?\\n  \\}`))[0], context);
}
const t = { id: 7, status: 'past', date: '2026-09-25T19:00:00+03:00' };
function reset() {
  context.resultCache = { 7: [] };
  context.state = {
    tournament: { createdAt: '2026-09-25T11:02:51.962Z' },
    rating: { isActive: true, payouts: [100, 50] },
    players: [
      { name: 'Second', present: true, status: 'busted', place: 2 },
      { name: 'Winner', player_id: 10, present: true, status: 'busted', place: 1 },
      { name: 'Absent', present: false },
    ],
  };
}
reset();
let rows = context.resultsFromRoom(t);
assert.equal(rows.length, 2);
assert.equal(rows[0].name, 'Winner');
assert.equal(rows[0].points, 100);
assert.equal(rows[0].player_id, 10);
assert.match(context.resultsCard(t), /2 игроков/);
assert.doesNotMatch(context.resultsCard(t), /ещё не выложили/);
context.state.players[1].place = null;
context.state.players[1].status = 'active';
assert.equal(context.resultsFromRoom(t)[0].place, 1, 'last survivor is the winner');
context.state.players[0].place = null;
context.state.players[0].status = 'active';
assert.equal(context.resultsFromRoom(t).length, 0, 'unfinished room is not a result');
reset();
context.state.players[1].place = 2;
assert.equal(context.resultsFromRoom(t).length, 0, 'duplicate places are incomplete');
reset();
context.state.tournament.createdAt = '2026-09-26T11:00:00Z';
assert.equal(context.resultsFromRoom(t).length, 0, 'reused room belongs to another evening');
reset();
assert.equal(context.resultsFromRoom({ ...t, status: 'cancelled' }).length, 0);
assert.equal(context.resultsFromRoom({ ...t, status: 'running' }).length, 0);
assert.equal(context.resultsFromRoom({ ...t, date: null }).length, 0);
context.resultCache[7] = [{ name: 'Published', place: 1, points: 200 }];
assert.match(context.resultsCard(t), /Published/);
assert.doesNotMatch(context.resultsCard(t), /Winner/);
context.resultCache[7] = null;
assert.match(context.resultsCard(t), /Winner/, 'complete room also survives an RPC error');
context.state = null;
assert.match(context.resultsCard(t), /Не удалось загрузить итоги/);
context.resultCache[7] = [];
assert.match(context.resultsCard(t), /ещё не выложили/);
console.log('Tournament results — checks passed');

(async () => {
  // Polling must retain the open past room and fetch the new publication status.
  let requestedRooms;
  context.tours = [{ id: 7, room_id: 'past-room', status: 'past' },
    { id: 8, room_id: 'live-room', status: 'running' },
    { id: 9, room_id: 'other-past-room', status: 'past' }];
  context.openId = 7;
  context.roomStates = {};
  context.TBL = { rooms: 'rooms' };
  context.normalizeState = (s) => s;
  context.sb = { from: () => ({ select: () => ({ in: async (_, ids) => {
    requestedRooms = ids;
    return { data: ids.map((room_id) => ({ room_id, state: { players: [] } })) };
  } }) }) };
  vm.runInContext(html.match(/  async function loadRooms\(\) \{[\s\S]*?\n  \}/)[0], context);
  await context.loadRooms();
  assert.deepEqual(Array.from(requestedRooms), ['past-room', 'live-room']);
  assert.ok(context.roomStates['past-room']);
  let poll, loaded = false, rendered = false;
  context.stopLive = () => {};
  context.setInterval = (fn, ms) => { if (ms === 20000) poll = fn; return ms; };
  context.document = { hidden: false };
  context.$ = () => ({ classList: { contains: () => true } });
  context.isPast = (t) => t.status === 'past';
  context.tours = [{ id: 7, status: 'running' }];
  context.loadTours = async () => { loaded = true; context.tours[0].status = 'past'; };
  context.rpc = async (name, args) => {
    assert.equal(name, 'vp_tournament_results'); assert.equal(args.p_tournament_id, 7);
    return [{ name: 'Published after finish', place: 1 }];
  };
  context.renderTourney = () => { rendered = true; };
  vm.runInContext(html.match(/  function startLive\(\) \{[\s\S]*?\n  \}/)[0], context);
  context.startLive();
  await poll();
  assert.ok(loaded && rendered);
  assert.equal(context.resultCache[7][0].name, 'Published after finish');
  console.log('Tournament publication polling — checks passed');
})().catch((e) => { console.error(e); process.exitCode = 1; });
