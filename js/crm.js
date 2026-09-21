/* CRM клуба: снимок турнира, показатели игроков, отчёт за период.

   Логика лежит отдельно от страницы по той же причине, что и ядро таймера:
   снимок пишет админка (admin.html), читает и сводит CRM (crm.html), и если
   развести это по двум файлам, форматы разойдутся на первой же правке.

   Все суммы — целые рубли, как в оплате. Очки призовой зоны — это очки
   рейтинга, не деньги: они считаются от входов (см. calcPayouts в ядре). */
(function (global) {
  "use strict";

  const VP = global.VP || {};
  const clampInt = VP.clampInt || ((x, min = 0) => Math.max(min, parseInt(x ?? 0, 10) || 0));
  const normName = VP.normName || ((s) => String(s ?? "").replace(/\s+/g, " ").trim());
  // Свёртка имени повторяет players.name_key из миграции: по ней CRM сшивает
  // игрока без player_id с самим собой в других турнирах.
  const nameKey = (s) => normName(s).toLowerCase().replace(/ё/g, "е").replace(/й/g, "и");

  const PAY_FIELDS = ["transfer", "cash", "card"];

  // ── Снимок турнира ─────────────────────────────────────────────────────────
  // Ключ пересохранения: комната + момент создания турнира. Вечер сохраняют
  // и посреди игры, и после разбора поста — это должна быть одна строка.
  function reportKey(state, roomId) {
    return `${roomId || "-"}__${state?.tournament?.createdAt || ""}`;
  }

  // Очки за место берутся из посчитанной призовой зоны. Не пересчитываем здесь
  // заново: в комнате зона могла считаться от другого числа входов (её гасят
  // при правке счётчиков), и снимок обязан повторить то, что видел зал.
  function pointsForPlace(state, place) {
    const payouts = state?.rating?.isActive ? state.rating.payouts : null;
    if (!Array.isArray(payouts) || !place || place < 1) return 0;
    const v = payouts[place - 1];
    return clampInt(typeof v === "object" ? (v?.points ?? v?.amount) : v, 0);
  }

  // Победитель — единственный, кого никто не выбивает, поэтому bustOrder у него
  // нет и place остаётся пустым: в CRM чемпион уезжал бы без победы, без ITM и
  // без очков. Турнир считается доигранным, когда в игре остался ровно один И
  // хоть кто-то уже вылетел — иначе первый пришедший в зал получал бы первое
  // место ещё до старта (пришёл один, вылетевших нет — alive тоже 1).
  function finishedWinner(state) {
    const present = (Array.isArray(state?.players) ? state.players : []).filter((p) => p && p.present);
    const alive = present.filter((p) => p.status !== "busted");
    const busted = present.length - alive.length;
    return (alive.length === 1 && busted > 0) ? alive[0] : null;
  }

  function playerSnapshot(p, state, winner) {
    const tour = state?.tournament;
    const byMethod = { transfer: 0, cash: 0, card: 0 };
    (VP.getPayments ? VP.getPayments(p) : (p.payments || [])).forEach((x) => {
      if (x && x.method in byMethod) byMethod[x.method] += clampInt(x.amount, 0);
    });
    const expected = VP.calcExpected ? VP.calcExpected(p, tour) : 0;
    const paid = VP.totalPaid ? VP.totalPaid(p) : 0;
    const own = Number.isFinite(Number(p.place)) && Number(p.place) > 0 ? Number(p.place) : null;
    const place = own ?? (winner && winner === p ? 1 : null);
    return {
      player_id: p.player_id ?? null,
      name: normName(p.name),
      place,
      entries: VP.entriesOf ? VP.entriesOf(p) : 1 + clampInt(p.reentries, 0),
      reentries: clampInt(p.reentries, 0),
      ko: clampInt(p.ko, 0),
      points: pointsForPlace(state, place),
      buy_in: VP.effectiveBuyIn ? VP.effectiveBuyIn(p, tour) : clampInt(tour?.defaultBuyIn, 0),
      expected,
      paid,
      debt: Math.max(0, expected - paid),
      transfer: byMethod.transfer,
      cash: byMethod.cash,
      card: byMethod.card,
    };
  }

  // Снимок = шапка + строка на каждого ПРИШЕДШЕГО. Записавшиеся, но не дошедшие
  // до стола, в историю не попадают: по ним нет ни места, ни оплаты, а в
  // показателях игрока они выглядели бы сыгранным турниром.
  function snapshotFromState(state, opts = {}) {
    const st = state || {};
    const tour = st.tournament || {};
    const present = (Array.isArray(st.players) ? st.players : []).filter((p) => p && p.present && normName(p.name));
    const winner = finishedWinner(st);
    const players = present.map((p) => playerSnapshot(p, st, winner));

    const sum = (f) => players.reduce((a, p) => a + clampInt(p[f], 0), 0);
    const playedAt = opts.playedAt || tour.createdAt || new Date().toISOString();
    return {
      result: {
        report_key: reportKey(st, opts.roomId),
        room_id: opts.roomId || null,
        tournament_id: opts.tournamentId ?? null,
        name: normName(tour.name) || "Без названия",
        played_at: new Date(playedAt).toISOString(),
        buy_in: clampInt(tour.defaultBuyIn, 0),
        players_count: players.length,
        entries: sum("entries"),
        reentries: sum("reentries"),
        expected: sum("expected"),
        paid: sum("paid"),
        debt: sum("debt"),
        transfer: sum("transfer"),
        cash: sum("cash"),
        card: sum("card"),
      },
      players,
    };
  }

  // ── Показатели игроков ─────────────────────────────────────────────────────
  // rows — строки tournament_result_players, results — шапки (для дат и имён).
  // Сшивка идёт по player_id, а при его отсутствии по свёрнутому имени: без
  // этого незаведённый игрок дробился бы на отдельную строку в каждом турнире.
  function aggregatePlayers(rows, results, playersById) {
    const byResult = new Map((Array.isArray(results) ? results : []).map((r) => [String(r.id), r]));
    const out = new Map();
    // Имя с player_id — главное: один человек может быть записан и «Петя»,
    // и «Пётр Иванов», но id у строк один.
    const idByKey = new Map();
    (Array.isArray(rows) ? rows : []).forEach((r) => {
      if (r?.player_id != null) idByKey.set(nameKey(r.name), `id:${r.player_id}`);
    });

    (Array.isArray(rows) ? rows : []).forEach((r) => {
      if (!r) return;
      const key = r.player_id != null ? `id:${r.player_id}` : (idByKey.get(nameKey(r.name)) || `nm:${nameKey(r.name)}`);
      if (!key || key === "nm:") return;
      let a = out.get(key);
      if (!a) {
        a = {
          key, player_id: r.player_id ?? null, name: normName(r.name),
          games: 0, entries: 0, reentries: 0, ko: 0, points: 0,
          wins: 0, top3: 0, itm: 0, placesSum: 0, placesCount: 0, bestPlace: null,
          expected: 0, paid: 0, debt: 0, transfer: 0, cash: 0, card: 0,
          lastPlayedAt: null, lastTournament: "",
        };
        out.set(key, a);
      }
      if (r.player_id != null) a.player_id = r.player_id;
      a.games += 1;
      a.entries += clampInt(r.entries, 0);
      a.reentries += clampInt(r.reentries, 0);
      a.ko += clampInt(r.ko, 0);
      a.points += clampInt(r.points, 0);
      a.expected += clampInt(r.expected, 0);
      a.paid += clampInt(r.paid, 0);
      a.debt += clampInt(r.debt, 0);
      PAY_FIELDS.forEach((f) => { a[f] += clampInt(r[f], 0); });

      const place = Number(r.place);
      if (Number.isFinite(place) && place > 0) {
        a.placesSum += place; a.placesCount += 1;
        if (a.bestPlace == null || place < a.bestPlace) a.bestPlace = place;
        if (place === 1) a.wins += 1;
        if (place <= 3) a.top3 += 1;
      }
      // В призах — по очкам призовой зоны: ITM без неё определить нечем,
      // число мест в зоне зависит от входов конкретного вечера.
      if (clampInt(r.points, 0) > 0) a.itm += 1;

      const head = byResult.get(String(r.result_id));
      const when = head?.played_at ? new Date(head.played_at) : null;
      if (when && !Number.isNaN(when.getTime()) && (!a.lastPlayedAt || when > a.lastPlayedAt)) {
        a.lastPlayedAt = when;
        a.lastTournament = head.name || "";
        // Самое свежее написание имени — оно же показывается в списке.
        a.name = normName(r.name) || a.name;
      }
    });

    return [...out.values()].map((a) => {
      const card = a.player_id != null && playersById ? playersById.get(a.player_id) : null;
      return {
        ...a,
        avgPlace: a.placesCount ? a.placesSum / a.placesCount : null,
        itmRate: a.games ? a.itm / a.games : 0,
        fullName: card?.full_name || "",
        phone: card?.phone || "",
      };
    });
  }

  const SORTS = {
    games: (a, b) => b.games - a.games || b.points - a.points,
    points: (a, b) => b.points - a.points || b.games - a.games,
    ko: (a, b) => b.ko - a.ko || b.games - a.games,
    wins: (a, b) => b.wins - a.wins || b.top3 - a.top3 || b.games - a.games,
    paid: (a, b) => b.paid - a.paid || b.games - a.games,
    debt: (a, b) => b.debt - a.debt || b.games - a.games,
    // Пустое среднее место (ни одного вылета) не должно всплывать наверх.
    avgPlace: (a, b) => (a.avgPlace ?? 1e9) - (b.avgPlace ?? 1e9) || b.games - a.games,
    last: (a, b) => (b.lastPlayedAt?.getTime() || 0) - (a.lastPlayedAt?.getTime() || 0),
    name: (a, b) => a.name.localeCompare(b.name, "ru"),
  };
  function sortPlayers(list, key) {
    return (list || []).slice().sort(SORTS[key] || SORTS.games);
  }

  // ── Период ─────────────────────────────────────────────────────────────────
  const pad2 = (n) => String(n).padStart(2, "0");
  const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const fmtDate = (d) => {
    const t = d instanceof Date ? d : new Date(d);
    return Number.isNaN(t.getTime()) ? "—" : `${pad2(t.getDate())}.${pad2(t.getMonth() + 1)}.${t.getFullYear()}`;
  };
  // Границы периода — по календарным дням клуба: «с 01.03 по 31.03» обязано
  // включать турнир, начатый 31.03 в 19:00.
  const dayStart = (key) => new Date(`${key}T00:00:00`);
  const dayEnd = (key) => new Date(`${key}T23:59:59.999`);

  function periodPreset(name, today = new Date()) {
    const end = dateKey(today);
    const d = new Date(today);
    if (name === "month") return { from: dateKey(new Date(d.getFullYear(), d.getMonth(), 1)), to: end };
    if (name === "prevMonth") {
      const first = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      const last = new Date(d.getFullYear(), d.getMonth(), 0);
      return { from: dateKey(first), to: dateKey(last) };
    }
    if (name === "week") { d.setDate(d.getDate() - 6); return { from: dateKey(d), to: end }; }
    if (name === "quarter") { d.setMonth(d.getMonth() - 3); return { from: dateKey(d), to: end }; }
    if (name === "year") { d.setFullYear(d.getFullYear() - 1); return { from: dateKey(d), to: end }; }
    return { from: "", to: "" };                        // «всё время»
  }

  const SUM_FIELDS = ["players_count", "entries", "reentries", "expected", "paid", "debt", "transfer", "cash", "card"];
  function periodTotals(results) {
    const out = { tournaments: 0 };
    SUM_FIELDS.forEach((f) => { out[f] = 0; });
    (Array.isArray(results) ? results : []).forEach((r) => {
      out.tournaments += 1;
      SUM_FIELDS.forEach((f) => { out[f] += clampInt(r[f], 0); });
    });
    out.avgEntries = out.tournaments ? out.entries / out.tournaments : 0;
    return out;
  }

  // ── Excel ──────────────────────────────────────────────────────────────────
  // Три листа: турниры вечер за вечером, показатели игроков и построчная
  // оплата. Оплата повторяет набор колонок старой выгрузки в Google Sheets —
  // бухгалтерия клуба уже привыкла к этому порядку.
  function buildWorkbook({ results, rows, from, to, playersById }) {
    const heads = (results || []).slice().sort((a, b) => new Date(a.played_at) - new Date(b.played_at));
    const byResult = new Map(heads.map((r) => [String(r.id), r]));
    const totals = periodTotals(heads);

    const tournaments = {
      name: "Турниры",
      columns: [
        { title: "Дата", width: 12, type: "date" }, { title: "Турнир", width: 30 },
        { title: "Комната", width: 10 }, { title: "Игроков", width: 10, type: "int" },
        { title: "Входов", width: 10, type: "int" }, { title: "Реентри", width: 10, type: "int" },
        { title: "Взнос", width: 10, type: "money" },
        { title: "К оплате", width: 12, type: "money" }, { title: "Оплачено", width: 12, type: "money" },
        { title: "Долг", width: 10, type: "money" }, { title: "Перевод", width: 12, type: "money" },
        { title: "Наличные", width: 12, type: "money" }, { title: "Карта", width: 10, type: "money" },
      ],
      rows: heads.map((r) => [
        new Date(r.played_at), r.name || "", r.room_id || "",
        clampInt(r.players_count, 0), clampInt(r.entries, 0), clampInt(r.reentries, 0),
        clampInt(r.buy_in, 0), clampInt(r.expected, 0), clampInt(r.paid, 0), clampInt(r.debt, 0),
        clampInt(r.transfer, 0), clampInt(r.cash, 0), clampInt(r.card, 0),
      ]),
    };
    tournaments.rows.push([
      null, "ИТОГО", "", totals.players_count, totals.entries, totals.reentries, null,
      totals.expected, totals.paid, totals.debt, totals.transfer, totals.cash, totals.card,
    ]);

    const agg = sortPlayers(aggregatePlayers(rows, heads, playersById), "games");
    const players = {
      name: "Игроки",
      columns: [
        { title: "Игрок", width: 26 }, { title: "ФИО", width: 26 }, { title: "Телефон", width: 16 },
        { title: "Турниров", width: 10, type: "int" },
        { title: "Входов", width: 10, type: "int" }, { title: "Реентри", width: 10, type: "int" },
        { title: "Победы", width: 10, type: "int" }, { title: "Топ-3", width: 10, type: "int" },
        { title: "В призах", width: 10, type: "int" }, { title: "Ср. место", width: 11 },
        { title: "Лучшее место", width: 13, type: "int" }, { title: "Ноки", width: 9, type: "int" },
        { title: "Очки", width: 10, type: "int" }, { title: "Оплачено", width: 12, type: "money" },
        { title: "Долг", width: 10, type: "money" }, { title: "Последняя игра", width: 14, type: "date" },
      ],
      rows: agg.map((p) => [
        p.name, p.fullName || "", p.phone || "", p.games, p.entries, p.reentries, p.wins, p.top3, p.itm,
        p.avgPlace == null ? "" : Math.round(p.avgPlace * 10) / 10,
        p.bestPlace ?? "", p.ko, p.points, p.paid, p.debt,
        p.lastPlayedAt || null,
      ]),
    };

    const payments = {
      name: "Оплата",
      columns: [
        { title: "Дата", width: 12, type: "date" }, { title: "Турнир", width: 26 },
        { title: "Игрок", width: 24 }, { title: "Место", width: 8, type: "int" },
        { title: "Входов", width: 9, type: "int" }, { title: "Взнос", width: 10, type: "money" },
        { title: "К оплате", width: 12, type: "money" },
        { title: "Оплачено", width: 12, type: "money" }, { title: "Долг", width: 10, type: "money" },
        { title: "Перевод", width: 11, type: "money" }, { title: "Наличные", width: 11, type: "money" },
        { title: "Карта", width: 10, type: "money" }, { title: "Ноки", width: 8, type: "int" },
      ],
      rows: (rows || []).slice().sort((a, b) => {
        const ra = byResult.get(String(a.result_id)), rb = byResult.get(String(b.result_id));
        const da = ra ? new Date(ra.played_at) - 0 : 0, db = rb ? new Date(rb.played_at) - 0 : 0;
        return da - db || String(a.name).localeCompare(String(b.name), "ru");
      }).map((r) => {
        const head = byResult.get(String(r.result_id));
        return [
          head?.played_at ? new Date(head.played_at) : null, head?.name || "",
          r.name, Number.isFinite(Number(r.place)) && r.place ? Number(r.place) : "",
          clampInt(r.entries, 0), clampInt(r.buy_in, 0),
          clampInt(r.expected, 0), clampInt(r.paid, 0), clampInt(r.debt, 0),
          clampInt(r.transfer, 0), clampInt(r.cash, 0), clampInt(r.card, 0), clampInt(r.ko, 0),
        ];
      }),
    };

    return { sheets: [tournaments, players, payments], totals, fileName: reportFileName(from, to) };
  }

  function reportFileName(from, to) {
    const part = (s) => String(s || "").split("-").reverse().join(".");
    if (from && to) return `Вятка — отчёт ${part(from)}—${part(to)}.xlsx`;
    if (from) return `Вятка — отчёт с ${part(from)}.xlsx`;
    if (to) return `Вятка — отчёт по ${part(to)}.xlsx`;
    return `Вятка — отчёт за всё время.xlsx`;
  }

  global.VPCrm = {
    nameKey, reportKey, snapshotFromState, playerSnapshot, pointsForPlace, finishedWinner,
    aggregatePlayers, sortPlayers, SORTS,
    periodPreset, periodTotals, dateKey, fmtDate, dayStart, dayEnd,
    buildWorkbook, reportFileName,
  };
})(typeof window !== "undefined" ? window : globalThis);
