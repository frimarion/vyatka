const A = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
global.window = {}; global.crypto = require('node:crypto').webcrypto;
require('../js/core.js'); require('../js/crm.js'); require('../js/tournament-corrections.js');
const { VP, VPCrm: CRM, VPCorrections: C } = window;
delete global.window;
const owner = '11111111-1111-1111-1111-111111111111';
const state = {
  tournament: { name:'Test', createdAt:'2026-11-01T14:00:00Z', defaultBuyIn:700, reentryCost:500 },
  stats:{}, timer:{isRunning:true,levelEndAt:99999999}, _savedAt:1,
  rating:{isActive:true,payouts:[100,70,40,20]},
  players:[1,2,3].map((id,i)=>({player_id:id,name:'Player '+id,present:true,status:'busted',place:id,bustOrder:3-i,reentries:0,buyIn:700,payments:[{amount:700,method:'cash'}]})),
};
VP.computeStatsFromPlayers(state);
const places = st => st.players.filter(p=>p.present).sort((a,b)=>a.place-b.place).map(p=>p.player_id);
const moved = C.correct(state,{type:'move',playerId:3,place:1});
A.deepEqual(places(moved),[3,1,2]); A.deepEqual(places(state),[1,2,3]);
A.deepEqual(places(C.correct(state,{type:'swap',playerId:1,otherId:3})),[3,2,1]);
const guest=structuredClone(state); guest.players[1].player_id=null;
A.equal(C.correct(guest,{type:'move',playerId:'name:Player 2',place:1}).players[1].place,1);
const restored=C.correct(state,{type:'restore',playerId:4,person:{id:4,name:'Fourth'},place:2,reentries:0,buyIn:700,paid:700,method:'cash'});
A.deepEqual(places(restored),[1,4,2,3]);
A.deepEqual(restored.rating,state.rating);
A.throws(()=>C.correct(state,{type:'restore',person:{id:4,name:'Fourth'},place:2,reentries:0,buyIn:NaN,paid:0,method:'cash'}),/взнос/);
const live=structuredClone(state); live.players[0].status='active'; live.players[0].place=null; live.players[0].bustOrder=null; VP.computeStatsFromPlayers(live);
A.throws(()=>C.correct(live,{type:'move',playerId:3,place:1}),/Допустимое место/);
const returned=C.correct(live,{type:'return',playerId:2}); A.equal(returned.stats.alive,2); A.equal(returned.players[1].place,null);
const completed=structuredClone(state); completed.tournament.finishedAt='2026-11-01T20:00:00Z';
A.throws(()=>C.correct(completed,{type:'return',playerId:2}),/Завершённый/);
A.equal(C.correct(completed,{type:'ko',playerId:2,ko:5}).players[1].ko,5);

(async()=>{
  const { PGlite }=require(process.env.VP_PGLITE_MODULE || '@electric-sql/pglite');
  const db=new PGlite();
  const sql=name=>fs.readFileSync(path.join(__dirname,'../migrations',name),'utf8');
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key); insert into auth.users values('${owner}');
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
      create function is_admin() returns boolean language sql as $$select auth.uid()='${owner}'::uuid$$;
      create function can_access_room(text) returns boolean language sql as $$select coalesce(is_admin(),false)$$;
      create function touch_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;
      create table tournaments(id bigint primary key,room_id text,name text,status text,date timestamptz);
      create table rooms(room_id text primary key,state jsonb);
      create table players(id bigint primary key,name text);
      insert into players values(1,'Player 1'),(2,'Player 2'),(3,'Player 3'),(4,'Fourth');
      insert into tournaments values(7,'ROOM','Test','running',now());
      set test.uid='${owner}';`);
    await db.exec(sql('004_results.sql')); await db.exec(sql('020_finish_tournament.sql'));
    await db.exec(sql('036_tournament_corrections.sql')); await db.exec(sql('036_tournament_corrections.sql'));
    await db.query('insert into rooms values($1,$2)',['ROOM',JSON.stringify(state)]);
    const snap=st=>CRM.completionSnapshot(st,{roomId:'ROOM',tournamentId:7});
    const call=async(before,next,undo=null,reason='Test correction')=>(await db.query('select vp_correct_tournament($1,$2,$3,$4,$5,$6) as answer',[7,JSON.stringify(before),JSON.stringify(next.players),JSON.stringify(snap(next)),reason,undo])).rows[0].answer;
    const read=async()=>(await db.query('select state from rooms')).rows[0].state;
    // A running timer is preserved; edits do not end the tournament.
    const result=await call(state,moved); A.equal(result.state.timer.isRunning,true);
    A.equal((await db.query('select count(*)::int n from tournament_results')).rows[0].n,0);
    await A.rejects(()=>call(state,restored),/изменились/);
    await db.exec("set test.uid=''"); await A.rejects(()=>call(result.state,state),/администратору/); await db.exec(`set test.uid='${owner}'`);
    const undo=await call(result.state,state,result.correction_id); A.deepEqual(undo.state.players,state.players);
    await A.rejects(()=>call(undo.state,moved,result.correction_id),/Отмена недоступна/);
    // Final results and room change together. The payout scale stays fixed.
    const finished=await db.query('select vp_finish_tournament($1,$2,$3,$4) as answer',['ROOM',7,JSON.stringify(undo.state),JSON.stringify(snap(undo.state))]);
    const before=finished.rows[0].answer.state;
    const next=C.correct(before,{type:'restore',playerId:4,person:{id:4,name:'Fourth'},place:2,reentries:0,buyIn:700,paid:700,method:'cash'});
    const saved=await call(before,next);
    const rows=(await db.query('select player_id,place,points from tournament_result_players order by place')).rows;
    A.deepEqual(rows.map(p=>p.player_id),[1,4,2,3]); A.deepEqual(rows.map(p=>p.points),[100,70,40,20]);
    A.equal(saved.state.timer.isRunning,false); A.deepEqual(saved.state.rating,state.rating);
    A.equal((await db.query('select players_count from tournament_results')).rows[0].players_count,4);
    // A malformed final report must roll back the room and audit, too.
    const bad=C.correct(saved.state,{type:'move',playerId:4,place:1}); const invalid=snap(bad); invalid.players.pop();
    await A.rejects(()=>db.query('select vp_correct_tournament($1,$2,$3,$4,$5,null)',[7,JSON.stringify(saved.state),JSON.stringify(bad.players),JSON.stringify(invalid),'Invalid report']),/совпадает|места/);
    A.deepEqual((await read()).players,saved.state.players);
    const restoredBefore=await call(saved.state,before,saved.correction_id);
    A.deepEqual(restoredBefore.state.players,before.players);
    A.equal((await db.query('select count(*)::int n from tournament_result_players')).rows[0].n,3);
    console.log('tournament-corrections: operations, live timer, permissions, conflicts, atomic final results and undo passed');
  }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
