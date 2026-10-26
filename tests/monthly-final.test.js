// Integration test: finals roster, player answers and admin decisions (migrations/033).
// VP_PGLITE_MODULE points to a temporary @electric-sql/pglite install.
const A = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.VP_PGLITE_MODULE || '@electric-sql/pglite');
const admin = '11111111-1111-1111-1111-111111111111';
const sql = (name) => fs.readFileSync(path.join(__dirname, '../migrations', name), 'utf8');

(async () => {
  const db = new PGlite();
  try {
    // Minimal stand-ins for the production schema the migration builds on.
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth; create schema net;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as $$
        select nullif(current_setting('test.uid', true), '')::uuid $$;
      create function public.is_admin() returns boolean language sql as $$
        select coalesce(auth.uid() = '${admin}'::uuid, false) $$;
      create table public.calls(body jsonb);
      create function net.http_post(url text, body jsonb, headers jsonb) returns bigint language sql as $$
        insert into public.calls values (body) returning 1::bigint $$;
      create table public._app_config(key text primary key, value text not null);
      insert into public._app_config values ('edge_url', 'x'), ('cron_secret', 'x'), ('anon_key', 'x');
      create table public.players(id bigint primary key, name text, name_key text, photo_url text,
        full_name text, phone text, tg_id bigint, tg_username text, vk_id bigint, vk_username text,
        email text, email_verified boolean default false, auth_provider text, games_played integer,
        pd_consent_at timestamptz, pd_consent_version text, photo_consent boolean,
        marketing_consent boolean, can_register_others boolean default false);
      create table public.tournaments(id bigint primary key, name text, date timestamptz, status text,
        slots integer, registered_count integer not null default 0,
        is_monthly_final boolean not null default false);
      create table public.registrations(tournament_id bigint, player_id bigint, status text,
        created_at timestamptz default now(), unique (tournament_id, player_id));
      create table public.tournament_results(id bigint primary key, tournament_id bigint, played_at timestamptz);
      create table public.tournament_result_players(result_id bigint, player_id bigint, name text,
        name_key text, points integer, place integer, ko integer);
      create table public.rating_adjustments(player_id bigint, points integer, awarded_at timestamptz);
      create table public.vp_xp_totals(player_id bigint, xp integer);
      create table public.vp_levels(level integer, xp_from integer, rank_key text);
      insert into public.vp_levels values (1, 0, 'fish');
      create function public.vp_session_player(p_token text) returns bigint language sql as $$
        select p_token::bigint $$;
      create function public.vp_unsync_registration(bigint, bigint) returns void language sql as $$ select $$;
      create function public.sync_count() returns trigger language plpgsql as $$ begin
        update public.tournaments t set registered_count = (select count(*) from public.registrations r
          where r.tournament_id = t.id and r.status = 'registered');
        return null; end $$;
      create trigger c after insert or update on public.registrations for each row execute function public.sync_count();
      create trigger n after insert or update of status on public.registrations
        for each row execute function public.sync_count();
    `);
    await db.exec(sql('033_monthly_final_roster.sql'));
    await db.exec(sql('033_monthly_final_roster.sql')); // reapplying must be safe
    await db.exec(sql('034_app_final_admin.sql'));
    await db.exec(sql('034_app_final_admin.sql'));
    await db.exec(`
      drop trigger n on public.registrations;
      create trigger n after insert or update of status on public.registrations
        for each row execute function public._notify_admin_on_registration();
    `);

    // September rating: players 1..5 with points 50..10; player 6 only in the final itself.
    await db.exec(`
      insert into public.players select g, 'P' || g, 'p' || g, null from generate_series(1, 6) g;
      insert into public.tournaments values
        (1, 'Sept game', '2026-09-10 16:00+00', 'past', null, 0, false),
        (2, 'Final', '2026-10-05 16:00+00', 'open', 3, 0, true),
        (3, 'Old final', '2026-09-20 16:00+00', 'past', 3, 0, true);
      insert into public.tournament_results values (1, 1, '2026-09-10 20:00+00'), (3, 3, '2026-09-20 20:00+00');
      insert into public.tournament_result_players
        select 1, g, 'P' || g, 'p' || g, 60 - g * 10, g, case when g = 3 then 5 else 0 end from generate_series(1, 5) g;
      -- Tie with player 3 on points but fewer knockouts.
      update public.tournament_result_players set points = 30 where player_id = 4;
      insert into public.tournament_result_players values (3, 6, 'P6', 'p6', 999, 1, 0);
    `);

    const roster = async () => (await db.query(
      'select player_id::int, seat, confirmed, declined, extra from public.vp_final_roster(2)')).rows;
    const respond = (pid, going) => db.query('select public.vp_app_final_respond($1, 2, $2)', [String(pid), going]);
    const asAdmin = (q, args) => db.exec(`set test.uid = '${admin}'`).then(() => db.query(q, args))
      .finally(() => db.exec("set test.uid = ''"));
    const adminSet = (pid, action) => asAdmin('select public.vp_final_admin_set(2, $1, $2)', [pid, action]);

    A.deepEqual((await db.query('select public.vp_final_period(2) as p')).rows[0].p, '2026-09');
    // The past final (999 points) is not in the rating; tie on points goes to more knockouts.
    let r = await roster();
    A.deepEqual(r.map((x) => x.player_id), [1, 2, 3]);
    A.ok(r.every((x) => !x.confirmed && !x.declined && !x.extra));
    const rating = (await db.query("select player_id::int from public.vp_app_rating('2026-09')")).rows;
    A.ok(!rating.some((x) => x.player_id === 6), 'finals give no rating points');

    // Gate closed: players cannot answer yet, admin can open it.
    await A.rejects(respond(1, true), /confirmations_closed/);
    await A.rejects(db.query('select public.vp_final_set_confirmations(2, true)'), /not_authorized/);
    await asAdmin('select public.vp_final_set_confirmations(2, true)');

    await A.rejects(respond(5, true), /not_in_final/);
    await respond(1, true);
    r = await roster();
    A.equal(r[0].confirmed, true);
    A.equal((await db.query('select registered_count from public.tournaments where id = 2')).rows[0].registered_count, 1);

    // Decline stays pending in the roster until the admin decides.
    await db.query('delete from public.calls');
    await respond(2, false);
    r = await roster();
    A.deepEqual(r.map((x) => [x.player_id, x.declined]), [[1, false], [2, true], [3, false]]);
    const ops = (await db.query("select body->>'op_type' as op from public.calls")).rows.map((x) => x.op);
    A.deepEqual(ops.filter((x) => x !== 'SILENT'), ['DECLINE'], 'decline sends one DECLINE notice');

    // Admin accepts the decline → next by rating slides in.
    await A.rejects(db.query("select public.vp_final_admin_set(2, 2, 'exclude')"), /not_authorized/);
    await adminSet(2, 'exclude');
    r = await roster();
    A.deepEqual(r.map((x) => [x.player_id, x.seat]), [[1, 1], [3, 2], [4, 3]]);
    A.deepEqual((await db.query('select player_id::int from public.vp_final_excluded(2)')).rows, []);

    // Player 1 changes mind; confirmed registration is cancelled.
    await respond(1, false);
    A.equal((await db.query('select registered_count from public.tournaments where id = 2')).rows[0].registered_count, 0);
    await adminSet(1, 'confirm');
    r = await roster();
    A.deepEqual(r[0], { player_id: 1, seat: 1, confirmed: true, declined: false, extra: false });

    // Admin adds someone beyond the top; reset brings an excluded player back.
    await adminSet(5, 'confirm');
    r = await roster();
    A.deepEqual(r.at(-1), { player_id: 5, seat: null, confirmed: true, declined: false, extra: true });
    await adminSet(2, 'reset');
    r = await roster();
    A.deepEqual(r.filter((x) => !x.extra).map((x) => x.player_id), [1, 2, 3]);
    const silent = (await db.query("select count(*)::int as n from public.calls where body->>'op_type' = 'SILENT'")).rows[0].n;
    A.ok(silent > 0, 'admin actions do not message the group');

    // Organizer in the player app (034): only players with can_manage_finals.
    const appSet = (pid, action) => db.query('select public.vp_app_final_admin_set($1, 2, $2, $3)', ['6', pid, action]);
    await A.rejects(appSet(3, 'exclude'), /not_allowed/);
    await A.rejects(db.query("select public.vp_app_final_set_confirmations('6', 2, false)"), /not_allowed/);
    await db.exec('update public.players set can_manage_finals = true where id = 6');
    A.equal((await db.query("select public.vp_player_json(6)->>'can_manage_finals' as f")).rows[0].f, 'true');
    await appSet(3, 'exclude');
    A.deepEqual((await db.query("select player_id::int from public.vp_app_final_excluded('6', 2)")).rows, [{ player_id: 3 }]);
    r = await roster();
    A.ok(!r.some((x) => x.player_id === 3), 'excluded from the app');
    await appSet(3, 'reset');
    await db.query("select public.vp_app_final_set_confirmations('6', 2, false)");
    await A.rejects(respond(3, true), /confirmations_closed/);
    // Admin entry points still work after the refactor.
    await asAdmin('select public.vp_final_set_confirmations(2, true)');
    await respond(3, true);

    console.log('Monthly final — checks passed');
  } finally {
    await db.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
