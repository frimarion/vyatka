const A = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.VP_PGLITE_MODULE || '@electric-sql/pglite');
const admin = '11111111-1111-1111-1111-111111111111';
const operator = '22222222-2222-2222-2222-222222222222';

(async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      grant usage on schema public, auth to anon, authenticated;
      create function auth.uid() returns uuid language sql as $$
        select nullif(current_setting('test.uid', true), '')::uuid $$;
      create table profiles(id uuid primary key, role text);
      insert into profiles values ('${admin}', 'admin'), ('${operator}', 'operator');
      create function is_admin() returns boolean language sql stable security definer as $$
        select exists(select 1 from profiles where id = auth.uid() and role = 'admin') $$;
      create table rooms(room_id text primary key, state jsonb, created_at timestamptz default now(),
        lock_owner text, lock_expires_at timestamptz);
      create table tournaments(id bigint primary key, room_id text);
      create table tournament_operators(tournament_id bigint, profile_id uuid);
      insert into tournaments values (1, 'ASSIGNED'), (2, 'OTHER');
      insert into tournament_operators values (1, '${operator}');
      alter table rooms enable row level security;
      create policy rooms_select_all on rooms for select to anon, authenticated using (true);
      create policy rooms_update on rooms for update to authenticated using (is_admin());
      grant select on rooms to anon, authenticated;
      grant update on rooms to authenticated;
    `);
    const privateTables = ['players', 'tournament_results', 'tournament_result_players', 'registrations', 'final_declines'];
    for (const tbl of privateTables) {
      await db.exec(`create table ${tbl}(id integer); insert into ${tbl} values (1);
        alter table ${tbl} enable row level security;
        create policy legacy_staff on ${tbl} for all to authenticated using (true) with check (true);
        grant select, insert, update, delete on ${tbl} to authenticated;`);
    }
    const source = fs.readFileSync(path.join(__dirname, '../migrations/038_operator_timer_only.sql'), 'utf8');
    await db.exec(source);
    await db.exec(source); // Safe to apply again.
    const secret = 'PRIVATE_PAYMENT_PHONE';
    const state = {
      _savedAt: 100,
      tournament: { name: 'Evening', startStack: 30000, defaultBuyIn: 700, futurePrivateField: secret },
      timer: { isRunning: false, isPaused: false, levelIndex: 0, levelEndAt: null, pauseRemainingSec: null },
      structure: { levels: [{ min: 20, sb: 100, bb: 200, privateField: secret }] },
      stats: { registered: 1, alive: 1, busted: 0, reentries: 0, money: secret },
      players: [{ name: 'Public TV name', present: true, status: 'active', payments: [{ amount: secret }], phone: secret, player_id: 1 }],
      privateRoot: secret,
    };
    for (const room of ['ASSIGNED', 'OTHER']) {
      await db.query('insert into rooms(room_id,state) values ($1,$2)', [room, JSON.stringify(state)]);
    }
    const login = async (uid, role = 'authenticated') => {
      await db.exec(`reset role; set test.uid = '${uid}'; set role ${role};`);
    };
    const timer = async (room = 'ASSIGNED', value = null) => (await db.query(
      'select vp_operator_timer($1,$2) as state', [room, value === null ? null : JSON.stringify(value)]
    )).rows[0].state;
    await login(operator);
    for (const tbl of [...privateTables, 'rooms']) {
      A.deepEqual((await db.query(`select * from ${tbl}`)).rows, [], `operator cannot read ${tbl}`);
    }
    for (const tbl of privateTables) {
      await A.rejects(db.exec(`insert into ${tbl} values (2)`), /row-level security/);
      A.deepEqual((await db.query(`update ${tbl} set id=2 returning *`)).rows, []);
      A.deepEqual((await db.query(`delete from ${tbl} returning *`)).rows, []);
    }
    const list = (await db.query('select * from vp_operator_rooms()')).rows;
    A.deepEqual(list.map(r => r.room_id), ['ASSIGNED']);
    A.equal(JSON.stringify(list).includes(secret), false);
    A.deepEqual((await timer()).players, []);
    await A.rejects(timer('OTHER'), /Нет доступа/);
    await A.rejects(timer('ASSIGNED', { ...state.timer, payments: [] }), /только поля таймера/);
    await A.rejects(timer('ASSIGNED', { ...state.timer, levelIndex: 99 }), /уровень/);
    await A.rejects(timer('ASSIGNED', { ...state.timer, isRunning: 'yes' }), /флаг/);
    A.equal((await db.query("select can_access_room('ASSIGNED') as ok")).rows[0].ok, false);
    A.equal((await db.query('select can_access_tournament(1) as ok')).rows[0].ok, false);
    A.deepEqual((await db.query("update rooms set state='{}' where room_id='ASSIGNED' returning *")).rows, []);
    A.equal((await db.query("select * from try_acquire_room_lock('ASSIGNED','operator',6)")).rows[0].lock_owner, 'operator');
    A.deepEqual((await db.query("select * from try_acquire_room_lock('OTHER','operator',6)")).rows, []);
    const running = { ...state.timer, isRunning: true, levelEndAt: Date.now() + 60000 };
    A.deepEqual((await timer('ASSIGNED', running)).timer, running);
    await login(admin);
    A.equal((await db.query('select * from players')).rows.length, 1);
    const saved = (await db.query("select state from rooms where room_id='ASSIGNED'")).rows[0].state;
    A.deepEqual(saved.players, state.players);
    A.deepEqual(saved.tournament, state.tournament);
    A.deepEqual(saved.structure, state.structure);
    A.deepEqual(saved.timer, running);
    A.ok(saved._savedAt > state._savedAt);
    await db.exec("update players set id=3");
    await db.exec(`update rooms set state=jsonb_set(state,'{tournament,finishedAt}','"finished"') where room_id='ASSIGNED'`);
    await login(operator);
    await A.rejects(timer('ASSIGNED', running), /завершён/);
    await login('', 'anon');
    A.deepEqual((await db.query('select * from rooms')).rows, []);
    await A.rejects(timer(), /permission denied/);
    await A.rejects(db.query("select * from try_acquire_room_lock('ASSIGNED','anon',6)"), /permission denied/);
    const display = (await db.query("select * from vp_display_rooms(array['ASSIGNED'])")).rows;
    A.equal(display.length, 1);
    A.equal(display[0].state.players[0].name, 'Public TV name');
    A.equal(JSON.stringify(display).includes(secret), false, 'TV/public API never exposes finances or future private fields');
    A.equal('player_id' in display[0].state.players[0], false);
    await login('33333333-3333-3333-3333-333333333333');
    A.deepEqual((await db.query('select * from vp_operator_rooms()')).rows, []);
    await A.rejects(timer(), /Нет доступа/);
    console.log('operator access: OK (RLS, private fields, timer writes, assignments, TV, admin)');
  } finally { await db.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
