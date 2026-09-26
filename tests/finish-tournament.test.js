// Integration test: VP_PGLITE_MODULE points to a temporary @electric-sql/pglite install.
const A = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.VP_PGLITE_MODULE || '@electric-sql/pglite');
global.window = {};
global.crypto = require('node:crypto').webcrypto;
require('../js/core.js');
require('../js/crm.js');
const CRM = window.VPCrm;
delete global.window; // PGlite must detect Node, not our browser-library fixture.
const owner = '11111111-1111-1111-1111-111111111111';
const sql = (name) => fs.readFileSync(path.join(__dirname, '../migrations', name), 'utf8');

(async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create table auth.users(id uuid primary key);
      insert into auth.users values ('${owner}');
      create function auth.uid() returns uuid language sql as $$
        select nullif(current_setting('test.uid', true), '')::uuid $$;
      create function public.is_admin() returns boolean language sql as $$ select auth.uid() = '${owner}'::uuid $$;
      create function public.can_access_room(text) returns boolean language sql as $$ select coalesce(public.is_admin(), false) $$;
      create function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
      create table public.tournaments(id bigint primary key, room_id text, name text, status text);
      create table public.rooms(room_id text primary key, state jsonb);
      create table public.players(id bigint primary key);
      insert into public.players values (1), (2);
      insert into public.tournaments values (7, 'ROOM', 'Final', 'running');
      set test.uid = '${owner}';
    `);
    await db.exec(sql('004_results.sql'));
    await db.exec(sql('020_finish_tournament.sql'));
    // Reapplying a migration must be safe.
    await db.exec(sql('020_finish_tournament.sql'));
    const state = {
      // Clock synchronization can produce fractional milliseconds (production regression).
      _savedAt: 1790379576169.5,
      tournament: { name: 'Final', createdAt: '2026-09-25T11:00:00Z', defaultBuyIn: 700 },
      players: [
        { player_id: 1, name: 'Winner', present: true, status: 'active', payments: [{ method: 'cash', amount: 700 }] },
        { player_id: 2, name: 'Second', present: true, status: 'busted', place: 2, payments: [] },
        { name: 'Absent', present: false },
      ],
      rating: { isActive: true, payouts: [100, 50] },
      timer: { isRunning: true, isPaused: true, levelIndex: 5, levelEndAt: 123,
        breakUntil: 456, pauseRemainingSec: 60, savedRemainingSec: 60, finalTableActive: true },
    };
    const snap = CRM.completionSnapshot(state, { roomId: 'ROOM', tournamentId: 7 });
    A.equal(snap.players[0].place, 1);
    const unfinished = structuredClone(state);
    unfinished.players[1].status = 'active'; unfinished.players[1].place = null;
    A.throws(() => CRM.completionSnapshot(unfinished), /места/);
    const empty = { ...state, players: [] };
    A.throws(() => CRM.completionSnapshot(empty), /места/);
    await db.query('insert into public.rooms values ($1, $2)', ['ROOM', JSON.stringify(state)]);
    const call = async (expected = state, snapshot = snap) => (await db.query(
      'select public.vp_finish_tournament($1, $2, $3, $4) as result',
      ['ROOM', 7, JSON.stringify(expected), JSON.stringify(snapshot)]
    )).rows[0].result;
    const all = async () => ({
      rooms: (await db.query('select * from rooms')).rows,
      tournaments: (await db.query('select * from tournaments')).rows,
      results: (await db.query('select * from tournament_results')).rows,
      players: (await db.query('select * from tournament_result_players order by place')).rows,
    });
    const before = await all();
    await db.exec("set test.uid = ''");
    await A.rejects(call(), /Нет доступа/);
    await db.exec(`set test.uid = '${owner}'`);
    await A.rejects(call({ ...state, _savedAt: 100 }), /изменились/);
    const badPlaces = structuredClone(snap); badPlaces.players[1].place = 1;
    await A.rejects(call(state, badPlaces), /места/);
    const badRoster = structuredClone(snap); badRoster.players[1].name = 'Someone else';
    await A.rejects(call(state, badRoster), /Состав/);
    A.deepEqual(await all(), before, 'rejected requests have no side effects');

    const result = await call();
    let saved = await all();
    A.equal(saved.tournaments[0].status, 'past');
    A.equal(saved.results.length, 1);
    A.equal(saved.results[0].paid, 700);
    A.equal(saved.results[0].debt, 700);
    A.equal(saved.players.length, 2);
    A.equal(saved.players[0].points, 100);
    A.equal(saved.players[0].place, 1);
    A.equal(result.state.timer.levelIndex, 5, 'finishing does not reset the level');
    for (const key of ['isRunning', 'isPaused', 'finalTableActive']) A.equal(result.state.timer[key], false);
    for (const key of ['levelEndAt', 'breakUntil', 'savedRemainingSec', 'pauseRemainingSec']) A.equal(result.state.timer[key], null);
    A.ok(result.state.tournament.finishedAt);
    A.ok(Number.isInteger(result.state._savedAt));
    A.ok(result.state._savedAt > state._savedAt);
    const again = await call(result.state);
    A.equal(again.result_id, result.result_id);
    saved = await all();
    A.equal(saved.results.length, 1, 'retry upserts the same report');
    A.equal(saved.players.length, 2, 'retry replaces the same player rows');
    const invalidPlayer = structuredClone(snap); invalidPlayer.players[1].player_id = 999;
    await A.rejects(call(again.state, invalidPlayer), /foreign key/);
    A.deepEqual(await all(), saved, 'failure after deleting player rows rolls back the whole transaction');
    await db.query('update rooms set state = $1 where room_id = $2', [JSON.stringify(state), 'ROOM']);
    const staleWrite = (await all()).rooms[0].state;
    A.equal(staleWrite.timer.isRunning, false, 'an old tab cannot restart the completed timer');
    A.equal(staleWrite.timer.breakUntil, null);
    A.equal(staleWrite.tournament.finishedAt, again.state.tournament.finishedAt);
    await db.exec("update tournaments set room_id = 'OTHER'");
    await A.rejects(call(again.state), /Привязка/);
    await db.exec("update tournaments set room_id = 'ROOM', status = 'cancelled'");
    await A.rejects(call(staleWrite), /Отменённый/);
    const grants = (await db.query(`select
      has_function_privilege('anon', 'public.vp_finish_tournament(text,bigint,jsonb,jsonb)', 'EXECUTE') as anon,
      has_function_privilege('authenticated', 'public.vp_finish_tournament(text,bigint,jsonb,jsonb)', 'EXECUTE') as staff`)).rows[0];
    A.equal(grants.anon, false); A.equal(grants.staff, true);
    console.log('Finish tournament — transaction, rollback, retry, access and results checks passed');
  } finally { await db.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
