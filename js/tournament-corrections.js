(function (global) {
  'use strict';
  const VP = global.VP;
  function correct(original, action) {
    const st = structuredClone(original);
    VP.computeStatsFromPlayers(st);
    if (st.tournament?.finishedAt) {
      const alive = st.players.filter(p => p.present && p.status !== 'busted');
      if (alive.length === 1) {
        alive[0].status = 'busted';
        alive[0].bustOrder = st.players.filter(p => p.present).length;
        VP.computeStatsFromPlayers(st);
      }
    }
    const player = action.playerId == null ? undefined : st.players.find(p => String(p.player_id) === String(action.playerId));
    const finished = !!st.tournament?.finishedAt;
    let ranked = st.players.filter(p => p.present && p.status === 'busted').sort((a, b) => a.place - b.place);
    if (action.type === 'restore') {
      if (player?.present) throw new Error('Этот игрок уже участвует в турнире.');
      if (!action.person?.id || !action.person?.name) throw new Error('Выбери игрока из базы клуба.');
      const restored = player || {
        player_id: action.person.id, name: action.person.name, reentries: action.reentries,
        ko: 0, buyIn: action.buyIn, payments: action.paid ? [{ method: action.method, amount: action.paid }] : [],
      };
      if (!player) {
        for (const n of [action.reentries, action.buyIn, action.paid]) {
          if (!Number.isSafeInteger(n) || n < 0) throw new Error('Укажи взнос, реентри и оплату целыми числами от нуля.');
        }
        if (!['cash', 'transfer', 'card'].includes(action.method)) throw new Error('Выбери способ оплаты.');
        st.players.push(restored);
      }
      restored.present = true;
      if (action.place === null && !finished) {
        restored.status = 'active'; restored.place = null; restored.bustOrder = null;
      } else {
        restored.status = 'busted'; ranked.push(restored);
        move(restored, action.place);
      }
    } else {
      if (!player?.present) throw new Error('Выбери участника турнира.');
      if (action.type === 'return') {
        if (finished) throw new Error('Завершённый турнир нельзя вернуть в игру. Исправь итоговое место.');
        if (player.status !== 'busted') throw new Error('Игрок ещё в игре.');
        player.status = 'active'; player.bustOrder = null; player.place = null;
        ranked = ranked.filter(p => p !== player);
      } else if (action.type === 'ko') {
        if (!Number.isSafeInteger(action.ko) || action.ko < 0) throw new Error('Укажи число нокаутов от нуля.');
        player.ko = action.ko;
      } else if (action.type === 'swap') {
        const other = st.players.find(p => String(p.player_id) === String(action.otherId));
        const a = ranked.indexOf(player), b = ranked.indexOf(other);
        if (a < 0 || b < 0 || a === b) throw new Error('Выбери двух разных игроков с определёнными местами.');
        [ranked[a], ranked[b]] = [ranked[b], ranked[a]];
      } else if (action.type === 'move') {
        if (!ranked.includes(player)) throw new Error('Сначала отметь вылет игрока в таймере.');
        move(player, action.place);
      } else throw new Error('Неизвестное исправление.');
    }
    ranked.forEach((p, i) => { p.bustOrder = ranked.length - i; });
    VP.computeStatsFromPlayers(st);
    if (JSON.stringify(st.players) === JSON.stringify(original.players)) throw new Error('Изменений нет.');
    return st;

    function move(p, place) {
      const alive = st.players.filter(x => x.present && x.status !== 'busted').length;
      const total = st.players.filter(x => x.present).length;
      if (!Number.isInteger(place) || place <= alive || place > total) {
        throw new Error(`Допустимое место: от ${alive + 1} до ${total}. Места игроков, которые ещё в игре, не назначаются.`);
      }
      ranked = ranked.filter(x => x !== p);
      ranked.splice(place - alive - 1, 0, p);
    }
  }
  global.VPCorrections = { correct };
})(window);
