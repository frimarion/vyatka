(async function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, { global: { fetch: window.sbFetchFailover } });
  let tournament, original, staged, undoId, history = [], people = [], loadToken = 0, searchToken = 0, busy = false;
  const money = n => new Intl.NumberFormat('ru-RU').format(n || 0) + ' ₽';
  const fail = e => { $('notice').textContent = e.message || String(e); $('notice').className = 'err'; };
  const say = s => { $('notice').textContent = s; $('notice').className = ''; };
  const run = fn => async e => { e?.preventDefault(); try { await fn(); } catch (error) { fail(error); } };
  const opts = list => '<option value="">Выбери игрока</option>' + list.map(p => `<option value="${esc(p.player_id)}">${esc(p.name)} — ${p.place || 'в игре'}</option>`).join('');
  function snapshot(st) {
    const normalized = structuredClone(st); VP.computeStatsFromPlayers(normalized);
    return st.tournament?.finishedAt || tournament.status === 'past'
      ? VPCrm.completionSnapshot(normalized, { roomId: tournament.room_id, tournamentId: tournament.id })
      : VPCrm.snapshotFromState(normalized, { roomId: tournament.room_id, tournamentId: tournament.id });
  }
  async function load() {
    if (busy) return;
    const token = ++loadToken;
    ++searchToken; clearTimeout(searchTimer);
    people = []; $('person').innerHTML = '<option value="">Сначала введи имя</option>'; $('search').value = '';
    $('newPlayerMoney').hidden = false; $('existingPlayer').textContent = '';
    staged = null; $('preview').hidden = true; $('loaded').hidden = true;
    const { data: t, error: te } = await sb.from('tournaments').select('id,name,date,status,room_id').eq('id', $('tournament').value).single();
    if (te) throw te;
    const { data: room, error } = await sb.from('rooms').select('state').eq('room_id', t.room_id || '').maybeSingle();
    if (token !== loadToken) return;
    if (error) throw error;
    if (!room) throw new Error('Комната турнира удалена или не создана. Исправление недоступно.');
    tournament = t; original = room.state;
    const normalized = structuredClone(original); VP.computeStatsFromPlayers(normalized);
    if (t.status === 'past' || original.tournament?.finishedAt) {
      const winner = VPCrm.finishedWinner(normalized); if (winner) winner.place = 1;
    }
    const rows = normalized.players.filter(p => p.present).sort((a,b) => (a.place || 0) - (b.place || 0));
    $('player').innerHTML = $('other').innerHTML = opts(rows.filter(p => p.player_id != null));
    $('roster').innerHTML = '<table><thead><tr><th>Место</th><th>Игрок</th><th>Очки</th></tr></thead><tbody>' + rows.map(p => `<tr><td>${p.place || 'В игре'}</td><td>${esc(p.name)}</td><td>${VPCrm.pointsForPlace(normalized,p.place)}</td></tr>`).join('') + '</tbody></table>';
    $('roomLink').href = 'admin.html?room=' + encodeURIComponent(t.room_id);
    $('tournamentInfo').textContent = `${t.name} · ${rows.length} участников · ${t.status === 'past' || original.tournament?.finishedAt ? 'завершён' : 'текущий турнир'}`;
    const { data: logs, error: he } = await sb.from('tournament_corrections').select('id,reason,created_at,undo_of,before_state,after_state').eq('tournament_id', t.id).order('id', { ascending: false }).limit(20);
    if (token !== loadToken) return;
    if (he) throw new Error('Не удалось загрузить историю. Обнови страницу; если ошибка повторится, сообщи владельцу сайта.');
    history = logs || [];
    $('history').innerHTML = history.length ? history.map(h => `<div class="history-entry"><strong>${esc(new Date(h.created_at).toLocaleString('ru-RU'))}</strong><br>${esc(h.reason)}${h.undo_of ? ' (отмена правки)' : ''}</div>`).join('') : '<p class="muted">Исправлений пока нет.</p>';
    $('undo').hidden = !history.length || !!history[0].undo_of;
    $('loaded').hidden = false; fields(); say('Турнир загружен. Выбери действие.');
  }
  function fields() {
    const type = $('operation').value;
    $('playerField').hidden = type === 'restore'; $('restoreFields').hidden = type !== 'restore';
    $('otherField').hidden = type !== 'swap'; $('placeField').hidden = !['move','restore'].includes(type); $('koField').hidden = type !== 'ko';
    staged = null; $('preview').hidden = true;
  }
  function preview(next, undo = null) {
    staged = next; undoId = undo;
    const before = snapshot(original), after = snapshot(next);
    const diffs = [];
    for (const p of after.players) {
      const old = before.players.find(x => x.player_id === p.player_id && x.name === p.name);
      if (!old) diffs.push(`${p.name}: восстановлен, ${p.place ? 'место ' + p.place : 'в игре'}, ${p.points} очков`);
      else if (old.place !== p.place || old.points !== p.points || old.ko !== p.ko) diffs.push(`${p.name}: место ${old.place || 'в игре'} → ${p.place || 'в игре'}, очки ${old.points} → ${p.points}, нокауты ${old.ko} → ${p.ko}`);
    }
    for (const p of before.players) if (!after.players.some(x => x.player_id === p.player_id && x.name === p.name)) diffs.push(`${p.name}: участие будет отменено`);
    $('changes').innerHTML = '<ul>' + diffs.map(s => `<li>${esc(s)}</li>`).join('') + '</ul>';
    $('moneyChanges').textContent = `К оплате: ${money(before.result.expected)} → ${money(after.result.expected)}. Оплачено: ${money(before.result.paid)} → ${money(after.result.paid)}. Долг: ${money(before.result.debt)} → ${money(after.result.debt)}.`;
    $('preview').hidden = false; $('preview').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('save').focus();
  }
  $('correctionForm').onsubmit = run(() => {
    const type = $('operation').value;
    const integer = id => $(id).value.trim() === '' ? NaN : Number($(id).value);
    const person = people.find(p => String(p.id) === $('person').value);
    preview(VPCorrections.correct(original, {
      type, playerId: type === 'restore' ? person?.id : $('player').value,
      otherId: $('other').value, person,
      place: type === 'restore' && $('place').value === '' ? null : integer('place'),
      ko: integer('ko'), buyIn: integer('buyIn'), paid: integer('paid'), reentries: integer('reentries'), method: $('method').value,
    }));
  });
  $('operation').onchange = fields;
  $('correctionForm').addEventListener('input', () => { staged = null; $('preview').hidden = true; });
  $('cancel').onclick = () => { staged = null; $('preview').hidden = true; };
  $('person').onchange = () => {
    const existing = original.players.find(p => String(p.player_id) === $('person').value);
    $('newPlayerMoney').hidden = !!existing;
    $('existingPlayer').textContent = existing ? 'Существующие входы и оплаты этого игрока будут сохранены.' : '';
  };
  let searchTimer;
  $('search').oninput = () => {
    clearTimeout(searchTimer); const token = ++searchToken;
    people = []; $('person').innerHTML = '<option value="">Поиск…</option>';
    searchTimer = setTimeout(run(async () => {
      const q = $('search').value.trim().replace(/[%_\\]/g, '');
      if (q.length < 2) { $('person').innerHTML = '<option value="">Введи минимум 2 символа</option>'; return; }
      const { data, error } = await sb.from('players').select('id,name').ilike('name', '%' + q + '%').order('name').limit(40);
      if (token !== searchToken) return;
      if (error) throw error;
      people = (data || []).filter(p => !original.players.some(x => x.present && String(x.player_id) === String(p.id)));
      $('person').innerHTML = '<option value="">' + (people.length ? 'Выбери игрока' : 'Нет пропущенных игроков с таким именем') + '</option>' + people.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
      $('person').onchange();
    }), 300);
  };
  $('save').onclick = run(async () => {
    if (!staged || busy) return;
    const reason = $('reason').value.trim();
    if (reason.length < 3) throw new Error('Укажи причину исправления.');
    busy = true; $('save').disabled = true; $('tournament').disabled = true; $('previewButton').disabled = true; say('Сохраняю исправление…');
    try {
      const { error } = await sb.rpc('vp_correct_tournament', {
        p_tournament_id: tournament.id, p_expected_state: original,
        p_players: staged.players, p_snapshot: snapshot(staged), p_reason: reason, p_undo_id: undoId,
      });
      if (error) throw error;
      busy = false; await load();
      say(tournament.status === 'past' || original.tournament?.finishedAt ? 'Исправление сохранено. Итоги и рейтинг обновлены.' : 'Исправление сохранено. Турнир продолжается; итоги опубликуются при завершении.');
    } finally { busy = false; $('save').disabled = false; $('tournament').disabled = false; $('previewButton').disabled = false; }
  });
  $('undo').onclick = run(() => {
    const h = history[0]; if (!h || h.undo_of) return;
    if (JSON.stringify(original.players) !== JSON.stringify(h.after_state.players) || JSON.stringify(original.rating) !== JSON.stringify(h.after_state.rating)) throw new Error('После правки данные изменились. Автоматическая отмена недоступна.');
    $('reason').value = 'Отмена исправления №' + h.id;
    preview({ ...structuredClone(original), players: structuredClone(h.before_state.players) }, h.id);
  });
  $('refresh').onclick = run(load); $('tournament').onchange = run(load);
  try {
    const { data: { session }, error } = await sb.auth.getSession(); if (error) throw error;
    if (!session) { $('notice').innerHTML = 'Сначала <a href="admin.html">войди в админку</a> под своей учётной записью, затем вернись сюда.'; return; }
    const { data: profile, error: pe } = await sb.from('profiles').select('role').eq('id', session.user.id).single();
    if (pe) throw pe;
    if (profile?.role !== 'admin') throw new Error('Этот раздел доступен администратору клуба.');
    const { data, error: te } = await sb.from('tournaments').select('id,name,date,status,room_id').neq('status','cancelled').order('date', { ascending:false }).limit(500);
    if (te) throw te;
    const list = (data || []).filter(t => t.room_id);
    if (!list.length) throw new Error('Нет турниров с привязанными комнатами.');
    $('tournament').innerHTML = list.map(t => `<option value="${t.id}">${esc(new Date(t.date).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'}))} · ${esc(t.name)}</option>`).join('');
    const requested = new URLSearchParams(location.search).get('room');
    const match = list.find(t => t.room_id === requested); if (match) $('tournament').value = match.id;
    $('editor').hidden = false; await load();
  } catch (e) { fail(e); }
})();
