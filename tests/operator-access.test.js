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
    // 039 restores the whole assigned room, keeping global CRM tables private.
    await db.exec(`reset role;
      alter table players alter column id type bigint;
      alter table players add column name text;
      alter table players add column name_key text generated always as (lower(name)) stored unique;
      alter table players add column full_name text;
      alter table players add column photo_url text;
      alter table players add column phone text;
      create sequence test_player_ids start 10;
      alter table players alter column id set default nextval('test_player_ids');
      update players set name='Local Player', phone='private contact' where id=3;
      insert into players(id,name,photo_url,phone) values (4,'Other Player','other.jpg','other contact');
      alter table registrations add column tournament_id bigint;
      alter table registrations add column player_id bigint;
      alter table registrations add column status text default 'registered';
      update registrations set tournament_id=1, player_id=3;
      insert into registrations values (2,2,4,'registered');
      drop policy rooms_update on rooms;
      create policy rooms_update_access on rooms for update to authenticated
        using (can_access_room(room_id)) with check (can_access_room(room_id));
      alter table tournaments enable row level security;
      create policy tournaments_select on tournaments for select to authenticated using (true);
      create policy tournaments_update_access on tournaments for update to authenticated using (true);
      grant select, update on tournaments to authenticated;
      update rooms set state=state #- '{tournament,finishedAt}' where room_id='ASSIGNED';
    `);
    const roomAdmin = fs.readFileSync(path.join(__dirname, '../migrations/039_operator_room_admin.sql'), 'utf8');
    await db.exec(roomAdmin);
    await db.exec(roomAdmin);
    await login(operator);
    A.deepEqual((await db.query('select room_id from rooms')).rows.map(r => r.room_id), ['ASSIGNED']);
    for (const tbl of ['players', 'tournament_results', 'tournament_result_players', 'final_declines']) {
      A.deepEqual((await db.query(`select * from ${tbl}`)).rows, [], 'global '+tbl+' remains closed');
    }
    A.equal((await db.query("select can_access_room('ASSIGNED') as ok")).rows[0].ok, true);
    A.equal((await db.query("select can_access_room('OTHER') as ok")).rows[0].ok, false);
    A.equal((await db.query('select can_access_tournament(1) as ok')).rows[0].ok, true);
    A.equal((await db.query('select can_access_tournament(2) as ok')).rows[0].ok, false);
    const changed = structuredClone(state);
    changed.tournament.defaultBuyIn = 900;
    changed.structure.levels[0].bb = 600;
    changed.players[0].reentries = 2;
    changed.players[0].addon = 1;
    changed.players[0].payments = [{ amount: 2700, method: 'cash' }];
    A.equal((await db.query('update rooms set state=$1 where room_id=$2 returning room_id', [JSON.stringify(changed),'ASSIGNED'])).rows.length, 1);
    A.deepEqual((await db.query("update rooms set state='{}' where room_id='OTHER' returning room_id")).rows, []);
    A.deepEqual((await db.query("update tournaments set room_id='OTHER' where id=1 returning id")).rows, [], 'cannot reassign room');
    A.deepEqual((await db.query('select tournament_id from registrations')).rows, [{tournament_id:1}]);
    await A.rejects(db.query("insert into registrations values (3,2,3,'registered')"), /row-level security/);
    await db.query("insert into registrations values (3,1,4,'registered')");
    A.equal((await db.query("update registrations set status='cancelled' where id=3 returning id")).rows.length, 1);
    const lookup = async (room, patterns = null, ids = null, regs = false) => (await db.query(
      'select * from vp_room_players($1,$2,$3,$4)', [room,patterns,ids,regs])).rows;
    A.deepEqual((await lookup('ASSIGNED',['Player'])).map(r=>r.name), ['Local Player','Other Player']);
    A.equal('phone' in (await lookup('ASSIGNED',['Local']))[0], false);
    A.deepEqual((await lookup('ASSIGNED',null,null,true)).map(r=>r.id), [3]);
    A.deepEqual(await lookup('ASSIGNED',null,[4]), [], 'cannot fetch arbitrary unrelated profiles by id');
    await A.rejects(lookup('OTHER',['Player']), /Нет доступа/);
    A.deepEqual(await lookup('ASSIGNED'), []);
    const ensured = (await db.query("select * from vp_room_ensure_player('ASSIGNED','New Player')")).rows;
    A.equal(ensured.length, 1);
    A.deepEqual((await db.query("select * from vp_room_ensure_player('ASSIGNED','New Player')")).rows, ensured);
    await A.rejects(db.query("select * from vp_room_ensure_player('OTHER','Forbidden')"), /Нет доступа/);
    await login(admin);
    const finalState = (await db.query("select state from rooms where room_id='ASSIGNED'")).rows[0].state;
    A.deepEqual(finalState, changed, 'all assigned room operations persist');
    A.equal((await db.query("select phone from players where id=3")).rows[0].phone, 'private contact');
    await login('', 'anon');
    A.deepEqual((await db.query('select * from rooms')).rows, []);
    await A.rejects(lookup('ASSIGNED',['Player']), /permission denied/);
    console.log('operator access: OK (full assigned room, players, registrations, CRM isolation, public TV)');
  } finally { await db.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
