/* Ядро таймера клуба «Вятка».
   Модель состояния и расчёты повторяют doyle timer: комната живёт в таблице
   rooms (JSONB state), admin.html пишет, display.html читает.
   Общий файл, чтобы админка и дисплей считали уровни и места одинаково —
   в Дойле этот код продублирован в двух файлах и расходится при правках. */
(function (global) {
  "use strict";

  const NF = new Intl.NumberFormat("ru-RU");
  const BREAK_MINUTES = 15;          // длительность брейка по кнопке
  const BRANCH = "VYATKA";           // rooms.branch — отделяет комнаты клуба от дойловских

  const clampInt = (x, min = 0) => {
    x = parseInt(x ?? 0, 10);
    return Number.isFinite(x) ? Math.max(min, x) : min;
  };
  const fmtInt = (n) => NF.format(clampInt(n, 0));
  const fmtTime = (sec) => {
    sec = Math.max(0, sec | 0);
    return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  };
  // Часы, скорректированные на серверный offset (js/config.js): levelEndAt пишется
  // часами админского устройства, часы ТВ могут врать на десятки секунд.
  const nowMs = () => (global.serverNowMs ? global.serverNowMs() : Date.now());
  const escHtml = (s) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const normName = (s) => (s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  const keyName = (s) => normName(s).toLowerCase();

  function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  // ── Структура блайндов ────────────────────────────────────────────────────
  const FALLBACK_LEVELS = [
    { min: 16, sb: 100, bb: 100, anteMode: "BB" }, { min: 16, sb: 100, bb: 200, anteMode: "BB" },
    { min: 16, sb: 100, bb: 300, anteMode: "BB" }, { min: 16, sb: 200, bb: 400, anteMode: "BB" },
    { min: 16, sb: 300, bb: 600, anteMode: "BB" }, { min: 16, sb: 400, bb: 800, anteMode: "BB" },
    { isBreak: true, min: 15, label: "Перерыв" },
    { min: 16, sb: 500, bb: 1000, anteMode: "BB" }, { min: 16, sb: 600, bb: 1200, anteMode: "BB" },
    { min: 16, sb: 800, bb: 1600, anteMode: "BB" }, { min: 12, sb: 1000, bb: 2000, anteMode: "BB" },
    { min: 12, sb: 1000, bb: 3000, anteMode: "BB" }, { min: 12, sb: 2000, bb: 4000, anteMode: "BB" },
    { min: 12, sb: 3000, bb: 6000, anteMode: "BB" }, { min: 12, sb: 4000, bb: 8000, anteMode: "BB" },
    { min: 12, sb: 5000, bb: 10000, anteMode: "BB" }, { min: 12, sb: 6000, bb: 12000, anteMode: "BB" },
    { min: 12, sb: 8000, bb: 16000, anteMode: "BB" }, { min: 10, sb: 10000, bb: 20000, anteMode: "BB" },
    { min: 10, sb: 15000, bb: 30000, anteMode: "BB" }, { min: 10, sb: 20000, bb: 40000, anteMode: "BB" },
    { min: 10, sb: 30000, bb: 60000, anteMode: "BB" }, { min: 10, sb: 40000, bb: 80000, anteMode: "BB" },
    { min: 10, sb: 50000, bb: 100000, anteMode: "BB" }, { min: 10, sb: 75000, bb: 150000, anteMode: "BB" },
    { min: 10, sb: 100000, bb: 200000, anteMode: "BB" }, { min: 10, sb: 150000, bb: 300000, anteMode: "BB" },
    { min: 10, sb: 200000, bb: 400000, anteMode: "BB" }, { min: 10, sb: 300000, bb: 600000, anteMode: "BB" },
    { min: 10, sb: 400000, bb: 800000, anteMode: "BB" }, { min: 10, sb: 500000, bb: 1000000, anteMode: "BB" },
  ];

  // Ускоренная сетка: тот же рост блайндов, но короче уровни.
  const turboLevels = () =>
    FALLBACK_LEVELS.map((l) => (l.isBreak ? { ...l, min: 10 } : { ...l, min: Math.max(8, Math.round(l.min * 0.6)) }));

  // Макеты турниров. В Дойле они лежат в таблице tournament_blueprints; здесь
  // зашиты в код — своей таблицы у клуба пока нет, структура правится в админке.
  const PRESETS = {
    daily: { id: "daily", name: "Вятский Дейли", startStack: 30000, lateRegUntilLevel: 9, defaultBuyIn: 1000, levels: FALLBACK_LEVELS.map((l) => ({ ...l })) },
    turbo: { id: "turbo", name: "Турбо", startStack: 20000, lateRegUntilLevel: 6, defaultBuyIn: 1000, levels: turboLevels() },
    deep:  { id: "deep",  name: "Глубокий стек", startStack: 50000, lateRegUntilLevel: 12, defaultBuyIn: 2000, levels: FALLBACK_LEVELS.map((l) => ({ ...l, min: l.isBreak ? l.min : Math.round(l.min * 1.25) })) },
  };

  function normalizeLevels(levels) {
    return (Array.isArray(levels) ? levels : []).map((l) => {
      const x = { ...l };
      x.isBreak = !!x.isBreak;
      x.label = (x.label ?? "").toString().slice(0, 40);
      x.min = clampInt(x.min, 0);
      x.sb = clampInt(x.sb, 0);
      x.bb = clampInt(x.bb, 0);
      x.anteMode = x.anteMode === "BB" ? "BB" : "NONE";
      return x;
    });
  }

  const defaultLevels = () => FALLBACK_LEVELS.map((l) => ({ ...l }));

  const DEFAULT_BONUS_HAND = "T♥ 2♣";
  const DEFAULT_BONUS_COMMENT = "Победа с 10-2 на вскрытии — бонус 12 ББ!";

  function initialState() {
    return {
      tournament: { createdAt: new Date().toISOString(), name: "", startStack: 30000, defaultBuyIn: 1000, lateRegUntilLevel: 0 },
      stats: { registered: 0, busted: 0, alive: 0, reentries: 0 },
      structure: { levels: defaultLevels() },
      timer: { isRunning: false, isPaused: false, levelIndex: 0, levelEndAt: null, pauseRemainingSec: null },
      players: [],
      info: { bonusHand: DEFAULT_BONUS_HAND, comment: DEFAULT_BONUS_COMMENT },
    };
  }

  function normalizeState(st) {
    if (!st) return null;
    st.tournament = st.tournament || { createdAt: new Date().toISOString(), startStack: 0 };
    st.stats = st.stats || { registered: 0, alive: 0, busted: 0, reentries: 0 };
    st.structure = st.structure || { levels: [] };
    st.timer = st.timer || { isRunning: false, isPaused: false, levelIndex: 0, levelEndAt: null, pauseRemainingSec: null };
    st.rating = st.rating || { isActive: false, entries: null, r: 0.8, guarantee: 800, addons: 0, P: 0, TOTAL: 0, KO_POOL: 0, ITM_POOL: 0, payouts: [], calculatedAt: null };

    const t = st.tournament;
    t.name = (t.name ?? "").toString().slice(0, 80);
    t.startStack = clampInt(t.startStack, 0);
    t.lateRegUntilLevel = clampInt(t.lateRegUntilLevel ?? 0, 0);
    t.defaultBuyIn = clampInt(t.defaultBuyIn ?? 1000, 0);
    t.addonEnabled = !!t.addonEnabled;
    t.addonChips = clampInt(t.addonChips ?? 0, 0);
    t.addonCost = clampInt(t.addonCost ?? 0, 0);
    t.pko = !!t.pko;

    const ti = st.timer;
    // Битые/протухшие метки времени — сбрасываем, иначе таймер «зависает» в прошлом.
    if (ti.breakUntil != null) {
      const ts = Number(ti.breakUntil);
      if (!Number.isFinite(ts) || ts < 1e12 || ts > nowMs() + 7200000) ti.breakUntil = null;
    }
    if (ti.levelEndAt != null) {
      const ts = Number(ti.levelEndAt);
      if (!Number.isFinite(ts) || ts < 1e12 || ts > nowMs() + 86400000) { ti.levelEndAt = null; ti.isRunning = false; }
    }
    ti.finalTableActive = !!ti.finalTableActive;

    if (!Array.isArray(st.structure.levels)) st.structure.levels = [];
    st.structure.levels = normalizeLevels(st.structure.levels);
    ti.levelIndex = clampInt(ti.levelIndex, 0);
    ti.levelIndex = st.structure.levels.length ? Math.min(ti.levelIndex, st.structure.levels.length - 1) : 0;

    ensurePlayers(st);
    if (st.players.length) computeStatsFromPlayers(st);
    else {
      st.stats.registered = clampInt(st.stats.registered, 0);
      st.stats.reentries = clampInt(st.stats.reentries, 0);
      st.stats.busted = Math.min(clampInt(st.stats.busted, 0), st.stats.registered);
      st.stats.alive = Math.max(0, st.stats.registered - st.stats.busted);
    }

    const r = st.rating;
    r.isActive = !!r.isActive;
    r.entries = r.entries == null ? null : clampInt(r.entries, 1);
    r.r = Number(r.r ?? 0.8);
    if (!Number.isFinite(r.r) || r.r <= 0 || r.r >= 1) r.r = 0.8;
    r.guarantee = clampInt(r.guarantee ?? 800, 0);
    r.addons = clampInt(r.addons ?? 0, 0);
    if (!Array.isArray(r.payouts)) r.payouts = [];
    r.autoShown = !!r.autoShown;

    if (st.info == null || typeof st.info !== "object") st.info = { bonusHand: DEFAULT_BONUS_HAND, comment: DEFAULT_BONUS_COMMENT };
    st.info.bonusHand = (st.info.bonusHand ?? "").toString().slice(0, 20);
    st.info.comment = (st.info.comment ?? "").toString().slice(0, 200);
    st.presetKey = st.presetKey || "";
    return st;
  }

  // ── Игроки ────────────────────────────────────────────────────────────────
  function ensurePlayers(st) {
    if (!Array.isArray(st.players)) st.players = [];
    st.players = st.players
      .map((p) => ({
        name: normName(p?.name || ""),
        present: !!p?.present,
        reentries: clampInt(p?.reentries ?? 0, 0),
        status: p?.status || "registered",
        bustOrder: p?.bustOrder ?? null,
        place: p?.place ?? null,
        ko: clampInt(p?.ko ?? 0, 0),
        koPts: clampInt(p?.koPts ?? 0, 0),
        // прибавка последнего вылета — чтобы «отменить вылет» сняло только её
        koDelta: p?.koDelta && typeof p.koDelta === "object"
          ? { ko: clampInt(p.koDelta.ko ?? 0, 0), koPts: clampInt(p.koDelta.koPts ?? 0, 0) }
          : null,
        addon: !!p?.addon,
        // ── оплата ──
        buyIn: p?.buyIn == null ? null : clampInt(p.buyIn, 0),   // null = взнос турнира
        freeEntries: clampInt(p?.freeEntries ?? 0, 0),
        addonFree: !!p?.addonFree,
        payments: normalizePayments(p?.payments),
        player_id: p?.player_id ?? null,
      }))
      .filter((p) => p.name);
    return st;
  }

  // Хронология вылетов — источник правды для мест. У старых состояний её может
  // не быть, только place: восстанавливаем порядок из мест (хуже место = раньше вылет).
  function backfillBustOrder(st) {
    const busted = st.players.filter((p) => p.present && p.status === "busted");
    if (!busted.length) return;
    const hasOrder = (p) => Number.isFinite(Number(p.bustOrder)) && Number(p.bustOrder) > 0;
    if (busted.every(hasOrder)) return;
    busted.slice().sort((a, b) => {
      const ap = Number.isFinite(Number(a.place)) ? Number(a.place) : -1;
      const bp = Number.isFinite(Number(b.place)) ? Number(b.place) : -1;
      if (ap !== bp) return bp - ap;
      return (Number(a.bustOrder) || 0) - (Number(b.bustOrder) || 0);
    }).forEach((p, i) => { p.bustOrder = i + 1; });
  }

  // place выводится из bustOrder, а не хранится снимком «сколько было живых»:
  // снимок ломался при реентри и не переживал исправление вылета.
  function recomputePlaces(st) {
    backfillBustOrder(st);
    const present = st.players.filter((p) => p.present);
    st.players.forEach((p) => { if (!p.present || p.status !== "busted") p.place = null; });
    present.filter((p) => p.status === "busted")
      .sort((a, b) => (Number(a.bustOrder) || 0) - (Number(b.bustOrder) || 0))
      .forEach((p, i) => { p.place = present.length - i; });
    return st;
  }

  function computeStatsFromPlayers(st) {
    ensurePlayers(st);
    const present = st.players.filter((p) => p.present).length;
    const busted = st.players.filter((p) => p.present && p.status === "busted").length;
    st.stats.registered = present;
    st.stats.busted = busted;
    st.stats.alive = Math.max(0, present - busted);
    st.stats.reentries = st.players.reduce((a, p) => a + clampInt(p.reentries ?? 0, 0), 0);
    recomputePlaces(st);
    return st;
  }

  function nextBustOrder(st) {
    return st.players.reduce((m, p) => Math.max(m, clampInt(p.bustOrder ?? 0, 0)), 0) + 1;
  }

  // Откат ошибочного BUSTED: ноки накопительные за турнир, поэтому снимаем
  // только прибавку отменяемого вылета.
  function rollbackBustKo(p) {
    const d = p.koDelta;
    if (d) {
      p.ko = Math.max(0, clampInt(p.ko ?? 0, 0) - clampInt(d.ko ?? 0, 0));
      p.koPts = Math.max(0, clampInt(p.koPts ?? 0, 0) - clampInt(d.koPts ?? 0, 0));
    } else { p.ko = 0; p.koPts = 0; }
    p.koDelta = null;
    return p;
  }

  // ── Оплата ────────────────────────────────────────────────────────────────
  // Перевод идёт первым и стоит по умолчанию: в клубе платят переводом,
  // карта и наличные — исключения.
  const PAY_METHODS = [
    { key: "transfer", label: "📲", title: "Перевод" },
    { key: "cash", label: "💵", title: "Наличные" },
    { key: "card", label: "💳", title: "Карта" },
  ];
  const DEFAULT_PAY_METHOD = "transfer";
  const isPayMethod = (m) => PAY_METHODS.some((x) => x.key === m);
  const payMethodTitle = (m) => PAY_METHODS.find((x) => x.key === m)?.title || m;
  const payMethodLabel = (m) => PAY_METHODS.find((x) => x.key === m)?.label || "";

  // Нулевые и битые платежи выкидываем: они не влияют на суммы, но ломают
  // разбивку «1000 📲 + 0 💳» в подписи и отчёте.
  function normalizePayments(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map((x) => ({ method: isPayMethod(x?.method) ? x.method : DEFAULT_PAY_METHOD, amount: clampInt(x?.amount, 0) }))
      .filter((x) => x.amount > 0);
  }

  const getPayments = (p) => (Array.isArray(p?.payments) ? p.payments : []);
  const totalPaid = (p) => getPayments(p).reduce((s, x) => s + clampInt(x.amount, 0), 0);
  const entriesOf = (p) => 1 + clampInt(p?.reentries ?? 0, 0);

  // tour передаётся явно: внутри мутатора saveWithReload считать надо по свежему
  // клону состояния, а не по глобальному state.
  function effectiveBuyIn(p, tour) {
    const def = clampInt(tour?.defaultBuyIn ?? 1000, 0);
    return p?.buyIn == null ? def : clampInt(p.buyIn, 0);
  }
  // Бесплатных входов не может быть больше, чем самих входов.
  function effectiveFreeEntries(p) {
    return Math.max(0, Math.min(entriesOf(p), clampInt(p?.freeEntries ?? 0, 0)));
  }
  // Комп аддона: фишки игрок получает, но платит за них 0.
  function addonCostFor(p, tour) {
    if (p?.addonFree) return 0;
    return (p?.addon && tour?.addonEnabled) ? clampInt(tour?.addonCost ?? 0, 0) : 0;
  }
  function calcExpected(p, tour) {
    const billable = Math.max(0, entriesOf(p) - effectiveFreeEntries(p));
    return billable * effectiveBuyIn(p, tour) + addonCostFor(p, tour);
  }
  function remainingAmount(p, tour) {
    return Math.max(0, calcExpected(p, tour) - totalPaid(p));
  }
  function payStatus(p, tour) {
    const expected = calcExpected(p, tour);
    if (expected === 0) return "free";
    const paid = totalPaid(p);
    if (paid <= 0) return "none";
    if (paid >= expected) return "paid";
    return "part";
  }

  // Тариф — производное от buyIn игрока, отдельно не хранится.
  const halfBuyIn = (tour) => Math.round(clampInt(tour?.defaultBuyIn ?? 1000, 0) / 2);
  function tariffOf(p, tour) {
    if (p?.buyIn == null) return "full";
    const b = clampInt(p.buyIn, 0);
    if (b === 0) return "free";
    if (b === halfBuyIn(tour)) return "half";
    return "custom";
  }
  function buyInForTariff(tariff, tour) {
    if (tariff === "half") return halfBuyIn(tour);
    if (tariff === "free") return 0;
    return null;                                  // full → взнос турнира
  }

  // Итоги по способам оплаты — считаются только по пришедшим.
  function calcPayTotals(st) {
    const tour = st?.tournament;
    const out = { transfer: 0, cash: 0, card: 0, total: 0, expected: 0, paid: 0, debt: 0, players: 0, settled: 0 };
    (Array.isArray(st?.players) ? st.players : []).filter((p) => p.present).forEach((p) => {
      out.players += 1;
      const expected = calcExpected(p, tour);
      const paid = totalPaid(p);
      out.expected += expected;
      out.paid += paid;
      out.debt += Math.max(0, expected - paid);
      if (paid >= expected) out.settled += 1;
      getPayments(p).forEach((x) => {
        const amt = clampInt(x.amount, 0);
        if (isPayMethod(x.method)) out[x.method] += amt;
        out.total += amt;
      });
    });
    return out;
  }

  // ── Счётчики ──────────────────────────────────────────────────────────────
  function calcEntries(st) {
    if (Array.isArray(st?.players) && st.players.length > 0) {
      const present = st.players.filter((p) => p.present).length;
      const byPlayer = st.players.filter((p) => p.present).reduce((a, p) => a + clampInt(p.reentries ?? 0, 0), 0);
      // максимум — защита от реентри, внесённых только в общий счётчик
      return present + Math.max(byPlayer, clampInt(st?.stats?.reentries ?? 0, 0));
    }
    return clampInt(st?.stats?.registered ?? 0, 0) + clampInt(st?.stats?.reentries ?? 0, 0);
  }
  function calcAddonCount(st) {
    if (!st?.tournament?.addonEnabled || !Array.isArray(st?.players)) return 0;
    return st.players.filter((p) => p.present && p.addon).length;
  }
  function calcAddonChips(st) {
    const chips = clampInt(st?.tournament?.addonChips ?? 0, 0);
    return chips ? calcAddonCount(st) * chips : 0;
  }
  function calcTotalChips(st) {
    const reg = clampInt(st?.stats?.registered ?? 0, 0);
    const re = clampInt(st?.stats?.reentries ?? 0, 0);
    const ss = clampInt(st?.tournament?.startStack ?? 0, 0);
    return (reg + re) * ss + calcAddonChips(st);
  }
  function calcAvg(st) {
    const alive = clampInt(st?.stats?.alive ?? 0, 0);
    const avg = alive > 0 ? Math.floor(calcTotalChips(st) / alive) : 0;
    return Number.isFinite(avg) ? avg : 0;
  }
  function curLevel(st) {
    return st?.structure?.levels?.[st?.timer?.levelIndex ?? 0] || { min: 0, sb: 0, bb: 0, anteMode: "NONE" };
  }
  // Порядковый номер игрового уровня (перерывы не считаются), 1-based.
  function playLevelNum(levels, idx) {
    let n = 0;
    for (let i = 0; i <= idx && i < (levels?.length || 0); i++) if (!levels[i].isBreak) n++;
    return n;
  }
  // Индекс n-го игрового уровня; levels.length, если такого нет.
  function playLevelIdx(levels, n) {
    let c = 0;
    for (let i = 0; i < levels.length; i++) { if (!levels[i].isBreak) c++; if (c >= n) return i; }
    return levels.length;
  }

  // ── Призовая зона (очки рейтинга) ────────────────────────────────────────
  // Вход = 10 очков; 2 из них уходят под ноки, в ПКО — 4 (голова игрока).
  function calcPayouts(entries, r = 0.8, guarantee = 800, addons = 0, pko = false) {
    const E = clampInt(entries, 1), rr = Number(r);
    if (!Number.isFinite(rr) || rr <= 0 || rr >= 1) throw new Error("r должен быть между 0 и 1");
    const guar = Math.max(0, Math.floor(Number(guarantee) || 0));
    const A = clampInt(addons, 0);
    const P = Math.max(3, Math.floor(0.15 * E));
    const TOTAL = Math.max(guar, 10 * E + 20 * A);
    const KO_POOL = (pko ? 4 : 2) * E;
    const ITM_POOL = TOTAL - KO_POOL;
    const weights = Array.from({ length: P }, (_, i) => Math.pow(rr, i));
    const wsum = weights.reduce((a, b) => a + b, 0);
    const base = weights.map((w) => Math.round(ITM_POOL * w / wsum));
    const payouts = base.slice();
    payouts[0] += ITM_POOL - base.reduce((a, b) => a + b, 0);
    return { P, TOTAL, KO_POOL, ITM_POOL, r: rr, payouts };
  }

  function recalcRating(st) {
    if (!st?.rating?.isActive) return st;
    const ent = calcEntries(st) || 1;
    const rr = Number.isFinite(Number(st?.rating?.r)) ? Number(st.rating.r) : 0.8;
    const guar = clampInt(st?.rating?.guarantee ?? 800, 0);
    const addons = calcAddonCount(st);
    const res = calcPayouts(ent, rr, guar, addons, !!st?.tournament?.pko);
    st.rating = { ...st.rating, entries: ent, r: rr, guarantee: guar, addons, P: res.P,
      TOTAL: res.TOTAL, KO_POOL: res.KO_POOL, ITM_POOL: res.ITM_POOL,
      payouts: res.payouts, calculatedAt: new Date().toISOString() };
    return st;
  }

  // ── Действия таймера ──────────────────────────────────────────────────────
  const T = {
    start(st) {
      const ti = st.timer; ti.isRunning = true; ti.isPaused = false; ti.pauseRemainingSec = null;
      ti.levelEndAt = nowMs() + clampInt((st.structure.levels[ti.levelIndex] || {}).min, 0) * 60000;
      return st;
    },
    pause(st) {
      const ti = st.timer; if (!ti.isRunning || ti.isPaused) return st;
      ti.isPaused = true;
      ti.pauseRemainingSec = Math.max(0, Math.floor((ti.levelEndAt - nowMs()) / 1000));
      ti.levelEndAt = null; return st;
    },
    resume(st) {
      const ti = st.timer; if (!ti.isRunning || !ti.isPaused) return st;
      ti.isPaused = false;
      ti.levelEndAt = nowMs() + clampInt(ti.pauseRemainingSec, 0) * 1000;
      ti.pauseRemainingSec = null; return st;
    },
    next(st) {
      const ti = st.timer;
      ti.levelIndex = Math.min(st.structure.levels.length - 1, (ti.levelIndex ?? 0) + 1);
      if (ti.isRunning && !ti.isPaused)
        ti.levelEndAt = nowMs() + clampInt((st.structure.levels[ti.levelIndex] || {}).min, 0) * 60000;
      return st;
    },
    prev(st) {
      const ti = st.timer;
      ti.levelIndex = Math.max(0, (ti.levelIndex ?? 0) - 1);
      if (ti.isRunning && !ti.isPaused)
        ti.levelEndAt = nowMs() + clampInt((st.structure.levels[ti.levelIndex] || {}).min, 0) * 60000;
      return st;
    },
    reset(st) {
      st.timer = { isRunning: false, isPaused: false, levelIndex: 0, levelEndAt: null, pauseRemainingSec: null };
      if (st.rating) st.rating.autoShown = false;
      return st;
    },
    minus60(st) {
      const ti = st.timer; if (!ti.isRunning) return st;
      if (ti.isPaused) ti.pauseRemainingSec = Math.max(0, (ti.pauseRemainingSec ?? 0) - 60);
      else if (ti.levelEndAt) ti.levelEndAt = Number(ti.levelEndAt) - 60000;
      return st;
    },
    plus60(st) {
      const ti = st.timer; if (!ti.isRunning) return st;
      if (ti.isPaused) ti.pauseRemainingSec = (ti.pauseRemainingSec ?? 0) + 60;
      else if (ti.levelEndAt) ti.levelEndAt = Number(ti.levelEndAt) + 60000;
      return st;
    },
    // Брейк: замораживаем остаток уровня и запускаем отдельный отсчёт.
    breakStart(st) {
      const ti = st.timer;
      if (!ti.isRunning) return st;
      if (ti.breakUntil && nowMs() < ti.breakUntil) return st;
      if (!ti.isPaused && ti.levelEndAt) ti.savedRemainingSec = Math.max(0, Math.floor((Number(ti.levelEndAt) - nowMs()) / 1000));
      else if (ti.isPaused) ti.savedRemainingSec = Math.max(0, clampInt(ti.pauseRemainingSec, 0));
      else ti.savedRemainingSec = 0;
      ti.breakUntil = nowMs() + BREAK_MINUTES * 60 * 1000;
      ti.isPaused = true; ti.pauseRemainingSec = ti.savedRemainingSec; ti.levelEndAt = null;
      return st;
    },
    breakFinish(st) {
      const ti = st.timer;
      if (!ti.breakUntil) return st;
      ti.breakUntil = null;
      const rem = clampInt(ti.savedRemainingSec ?? ti.pauseRemainingSec ?? 0, 0);
      ti.savedRemainingSec = null;
      ti.isPaused = false; ti.isRunning = true;
      ti.levelEndAt = nowMs() + rem * 1000; ti.pauseRemainingSec = null;
      return st;
    },
    finalTableOn(st) { st.timer.finalTableActive = true; return st; },
    finalTableOff(st) { st.timer.finalTableActive = false; return st; },
  };

  const isOnBreak = (st) => !!(st?.timer?.isPaused && st?.timer?.savedRemainingSec != null);
  const breakRemainingSec = (st) => {
    const ti = st?.timer; if (!ti?.breakUntil) return null;
    return Math.max(0, Math.floor((Number(ti.breakUntil) - nowMs()) / 1000));
  };
  const remainingSec = (st) => {
    const ti = st?.timer; if (!ti?.isRunning) return null;
    if (ti.isPaused) return ti.pauseRemainingSec ?? null;
    if (!ti.levelEndAt) return null;
    return Math.max(0, Math.floor((ti.levelEndAt - nowMs()) / 1000));
  };
  // Остаток уровня — во время брейка он заморожен на savedRemainingSec.
  const levelRemainingSec = (st) => {
    const ti = st?.timer; if (!ti?.isRunning) return null;
    if (ti.breakUntil) return clampInt(ti.savedRemainingSec ?? ti.pauseRemainingSec ?? 0, 0);
    return remainingSec(st);
  };

  // Сколько ещё открыта поздняя регистрация (сек).
  function lateRegRemainingSec(st) {
    const levels = Array.isArray(st?.structure?.levels) ? st.structure.levels : [];
    const lateRegLvl = clampInt(st?.tournament?.lateRegUntilLevel ?? 0, 0);
    if (!lateRegLvl || !levels.length) return 0;
    const lastIdx = playLevelIdx(levels, lateRegLvl);
    const curIdx = clampInt(st?.timer?.levelIndex ?? 0, 0);
    if (curIdx > lastIdx) return 0;
    let total = Math.max(0, (breakRemainingSec(st) !== null || levels[curIdx]?.isBreak)
      ? (levelRemainingSec(st) ?? 0) : (remainingSec(st) ?? 0));
    for (let i = curIdx + 1; i <= lastIdx && i < levels.length; i++) total += clampInt(levels[i]?.min ?? 0, 0) * 60;
    return total;
  }

  // Сколько до ближайшего перерыва по структуре (сек) или null.
  function nextBreakInSec(st) {
    const ti = st?.timer;
    if (!ti?.isRunning || ti.isPaused) return null;
    const levels = st.structure.levels;
    const cur = ti.levelIndex ?? 0;
    let brk = -1;
    for (let i = cur + 1; i < levels.length; i++) if (levels[i]?.isBreak) { brk = i; break; }
    if (brk < 0) return null;
    let total = Math.max(0, remainingSec(st) ?? 0);
    for (let i = cur + 1; i < brk; i++) total += clampInt(levels[i]?.min ?? 0, 0) * 60;
    return total;
  }

  function fmtDuration(sec) {
    const mins = Math.ceil(Math.max(0, sec) / 60);
    if (mins >= 60) {
      const h = Math.floor(mins / 60), m = mins % 60;
      return m > 0 ? `${h} ч ${m} мин` : `${h} ч`;
    }
    return `${mins} мин`;
  }

  // Локальное продвижение уровня: когда levelEndAt истёк, не ждём БД.
  // Новый уровень отсчитывается от ГРАНИЦЫ предыдущего, а не от now — иначе
  // опоздавший тик растягивает уровень и дисплей расходится с админкой.
  function advanceExpiredLevels(st) {
    const ti = st?.timer;
    if (!ti?.isRunning || ti.isPaused || ti.breakUntil || !ti.levelEndAt) return false;
    const levels = st.structure.levels;
    let changed = false;
    let end = Number(ti.levelEndAt);
    while (nowMs() >= end) {
      const nextIdx = (ti.levelIndex ?? 0) + 1;
      if (!levels[nextIdx]) {
        ti.isRunning = false; ti.isPaused = false; ti.levelEndAt = null; ti.pauseRemainingSec = null;
        return true;
      }
      ti.levelIndex = nextIdx;
      end += clampInt(levels[nextIdx].min, 0) * 60000;
      ti.levelEndAt = end;
      changed = true;
    }
    return changed;
  }

  // ── Пост для Telegram ─────────────────────────────────────────────────────
  // Порядок строк — от победителя вниз: сначала оставшиеся в игре, потом
  // вылетевшие по bustOrder убыванием (позже вылетел — выше в списке).
  // place не используем: при реентри он расходится с хронологией.
  function buildTelegramPost(raw) {
    const st = normalizeState(structuredClone(raw || {}));
    const entries = calcEntries(st);
    const present = st.players.filter((p) => p.present);
    const sorted = present.slice().sort((a, b) => {
      const aAlive = a.status !== "busted", bAlive = b.status !== "busted";
      if (aAlive !== bAlive) return aAlive ? -1 : 1;
      return (Number(b.bustOrder) || 0) - (Number(a.bustOrder) || 0);
    });
    // Граница призовой зоны: считанная зона, иначе те же 15% входов.
    const itmCount = (st.rating?.isActive && st.rating?.payouts?.length)
      ? st.rating.payouts.length
      : Math.max(3, Math.floor(0.15 * entries));
    const fmtPlace = (n) => (n === 1 ? "1\u20e3" : n === 2 ? "2\u20e3" : n === 3 ? "3\u20e3" : `${n}.`)
      .replace(/^(\d)\u20e3$/, "$1\ufe0f\u20e3");
    const lines = sorted.map((p, i) => {
      const place = i + 1;
      const ko = clampInt(p.ko ?? 0, 0), koPts = clampInt(p.koPts ?? 0, 0);
      const koStr = st.tournament?.pko
        ? ((ko > 0 || koPts > 0) ? ` (${ko} ko \u00b7 ${koPts} \u043e\u0447\u043a)` : "")
        : (ko > 0 ? ` (${ko} ko)` : "");
      let line = `${fmtPlace(place)} ${p.name}${koStr}`;
      // Пустая строка отбивает призовую зону от остальных
      if (place === itmCount && itmCount > 0 && place < sorted.length) line += "\n";
      return line;
    }).join("\n");
    return lines || "(Пока нет пришедших игроков)";
  }

  // Слияние списков. replace сохраняет пришедших и вылетевших — иначе повторный
  // импорт из TG стирал бы уже отмеченных за столом.
  function mergePlayers(st, incoming, mode) {
    ensurePlayers(st);
    const list = (Array.isArray(incoming) ? incoming : [])
      .map((p) => ({ name: normName(p.name || ""), player_id: p.player_id ?? null,
        present: !!p.present, reentries: 0, status: "registered", ko: 0, koPts: 0 }))
      .filter((p) => p.name);
    const byKey = new Map(st.players.map((p) => [keyName(p.name), p]));
    if (mode === "replace") {
      const keep = st.players.filter((p) => p.present || p.status === "busted");
      const keepKeys = new Set(keep.map((p) => keyName(p.name)));
      st.players = [...keep, ...list.filter((p) => !keepKeys.has(keyName(p.name)))];
    } else {
      for (const p of list) {
        const k = keyName(p.name);
        const old = byKey.get(k);
        if (!old) { st.players.push(p); byKey.set(k, p); }
        else if (p.player_id && !old.player_id) old.player_id = p.player_id; // доклеиваем id из БД
      }
    }
    return computeStatsFromPlayers(st);
  }

  // ── Комнаты (Supabase, та же схема rooms, что у Дойла) ───────────────────
  function genRoomId(len = 6) {
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    let out = "";
    for (const v of arr) out += abc[v % abc.length];
    return out;
  }

  global.VP = {
    NF, BRANCH, BREAK_MINUTES, PRESETS, DEFAULT_BONUS_HAND, DEFAULT_BONUS_COMMENT,
    clampInt, fmtInt, fmtTime, fmtDuration, nowMs, escHtml, normName, keyName, initials,
    defaultLevels, normalizeLevels, initialState, normalizeState,
    ensurePlayers, recomputePlaces, computeStatsFromPlayers, nextBustOrder, rollbackBustKo,
    buildTelegramPost, mergePlayers,
    PAY_METHODS, DEFAULT_PAY_METHOD, isPayMethod, payMethodTitle, payMethodLabel,
    normalizePayments, getPayments, totalPaid, entriesOf, effectiveBuyIn, effectiveFreeEntries,
    addonCostFor, calcExpected, remainingAmount, payStatus, tariffOf, buyInForTariff, calcPayTotals,
    calcEntries, calcAddonCount, calcAddonChips, calcTotalChips, calcAvg,
    curLevel, playLevelNum, playLevelIdx, calcPayouts, recalcRating,
    T, isOnBreak, breakRemainingSec, remainingSec, levelRemainingSec,
    lateRegRemainingSec, nextBreakInSec, advanceExpiredLevels, genRoomId,
  };

  // Самопроверка призовой зоны — та же, что в Дойле: 100 входов → 1000 очков.
  try {
    const t = calcPayouts(100, 0.8);
    console.assert(t.TOTAL === 1000 && t.KO_POOL === 200 && t.ITM_POOL === 800 && t.P === 15
      && t.payouts.reduce((a, b) => a + b, 0) === 800, "[rating] self-test FAILED");
  } catch (e) { console.error("[rating] self-test FAILED", e); }
})(window);
