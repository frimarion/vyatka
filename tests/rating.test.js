const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
// Exercise the sandbox RPC with explicit report fixtures, independent of seed data.
const source = fs.readFileSync(require.resolve('../js/devstub.js'), 'utf8');
const method = source.slice(source.indexOf('    vp_app_rating(db, args) {'), source.indexOf('    vp_tournament_results(db, args) {'));
const rpc = vm.runInNewContext(`({${method}}).vp_app_rating`, { nkey: s => s.toLowerCase(), Date });
const recent = new Date().toISOString();
const db = {
  players: [{id: 1, name: 'One'}, {id: 2, name: 'Two'}],
  tournaments: [{id: 7, status: 'running'}],
  tournament_results: [
    {id: 1, played_at: recent}, {id: 2, played_at: recent},
    {id: 3, played_at: recent, tournament_id: 7},
    {id: 4, played_at: '2000-01-01T00:00:00Z'},
  ],
  tournament_result_players: [
    {result_id: 1, player_id: 1, name: 'Old name', points: 20, place: 1, ko: 99},
    {result_id: 1, player_id: null, name: 'Two', points: 20, place: 2},
    {result_id: 2, player_id: 1, name: 'One', points: 500, place: null},
    {result_id: 3, player_id: 1, name: 'One', points: 500, place: 1},
    {result_id: 4, player_id: 2, name: 'Two', points: 10, place: 1},
  ],
};
const month = rpc(db, {p_period: 'month'}).data;
assert.equal(month.length, 2);
assert.equal(month[0].points, 20);
assert.equal(month[0].name, 'One');
assert.equal(month[1].player_id, 2);
assert.equal(month[0].rank, month[1].rank);
assert.equal(month[0].games, 1);
assert.equal(month[0].wins, 1);
const all = rpc(db, {p_period: 'all'}).data;
assert.equal(all[0].player_id, 2);
assert.equal(all[0].points, 30);
assert.equal(all[0].games, 2);
assert.equal(rpc(db, {p_period: 'invalid'}).data.length, 0);
assert.equal(rpc({...db, tournament_results: []}, {p_period: 'all'}).data.length, 0);
console.log('Rating — checks passed');

// Half-open month intervals use Moscow midnight, including the year boundary.
const dates = ['2024-12-31T20:59:59Z', '2024-12-31T21:00:00Z', '2025-01-31T20:59:59Z', '2025-01-31T21:00:00Z'];
const archiveDb = {...db, tournament_results: dates.map((played_at, i) => ({id: i, played_at})),
  tournament_result_players: dates.map((_, i) => ({result_id: i, player_id: 1, name: 'One', points: 10, place: 1}))};
assert.equal(rpc(archiveDb, {p_period: '2025-01'}).data[0].points, 20);
assert.equal(rpc(archiveDb, {p_period: '2024-12'}).data[0].games, 1);
assert.equal(rpc(archiveDb, {p_period: '2025-02'}).data[0].games, 1);
assert.equal(rpc(archiveDb, {p_period: '2025-03'}).data.length, 0);
for (const invalid of ['2025-13', '2025-00', '0000-01', '2025-1', 'garbage']) {
  assert.equal(rpc(archiveDb, {p_period: invalid}).data.length, 0);
}
console.log('Monthly rating — checks passed');
