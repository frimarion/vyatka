// Локальная песочница: админка без Supabase.
//
// Включается только на localhost и только с ?dev=1 — на боевом домене флаг
// ничего не делает. Это сознательно: подменённый клиент выглядит как настоящая
// админка, и запустить в ней турнир, думая что пишешь в базу, значит потерять
// вечер. Пара «localhost + флаг» такую ошибку исключает.
//
// Что делает: заменяет supabase.createClient на клиент поверх localStorage и
// глушит sbFetchFailover, чтобы из песочницы физически не уходил запрос в
// боевую базу Дойла. Realtime между вкладками — через BroadcastChannel, так что
// admin.html?dev=1&room=… и display.html?dev=1&room=… живут одной комнатой.
(() => {
  "use strict";
  const isLocal = ["localhost", "127.0.0.1", "[::1]", "::1", ""].includes(location.hostname);
  if (!isLocal) return;

  // Флаг залипает: внутренняя навигация (создание комнаты, список, ссылка на ТВ)
  // ведёт на голый admin.html?room=…, и разовый ?dev=1 терялся бы на первом же
  // переходе — песочница выключалась посреди сценария. ?dev=0 выключает.
  const ON_KEY = "vp_dev_on";
  const flag = new URLSearchParams(location.search).get("dev");
  try {
    if (flag === "0" || flag === "off") localStorage.removeItem(ON_KEY);
    else if (flag !== null) localStorage.setItem(ON_KEY, "1");
    if (localStorage.getItem(ON_KEY) !== "1") return;
  } catch (_) { if (flag === null) return; }

  const DB_KEY = "vp_dev_db";
  const ME_KEY = "vp_dev_profile";

  // ── Таблицы ────────────────────────────────────────────────────────────────
  // Фронт ходит то в дойловские имена (doyle_players), то в свои (players) —
  // карта в VP_TABLES меняется при переезде. Песочнице всё равно: сводим оба
  // имени к одному хранилищу, иначе после переезда стаб молча опустеет.
  const canon = (t) => String(t).replace(/^doyle_/, "");

  const FK = {   // встроенные ресурсы PostgREST: registrations → players и т.д.
    registrations: { table: "players", local: "player_id", foreign: "id" },
    tournament_operators: { table: "profiles", local: "profile_id", foreign: "id" },
  };

  const NAMES = ["Андрей Кузнецов","Сергей Втюрин","Дмитрий Рычков","Павел Огородов",
    "Илья Метелёв","Максим Шабалин","Артём Вершинин","Роман Целищев","Никита Бакулев",
    "Евгений Помаскин","Олег Суслопаров","Данил Русских"];

  const today = new Date();

  // Прошедшие турниры для CRM: без них вкладки «Игроки» и «Отчёты» в песочнице
  // пусты и проверить на них нечего. Шесть вечеров за полтора месяца — хватает,
  // чтобы период («этот месяц», «прошлый месяц») отсекал часть списка.
  function seedResults(players) {
    const results = [], resultPlayers = [];
    const POINTS = [40, 25, 15];
    let prid = 5000;
    for (let t = 0; t < 6; t++) {
      const when = new Date(today);
      when.setDate(when.getDate() - (t * 7 + 2));
      when.setHours(19, 0, 0, 0);
      const id = 500 + t;
      const buyIn = t % 3 === 1 ? 1500 : 1000;
      const roster = players.slice(0, 8 + (t % 4));
      const head = {
        id, report_key: `DEV${id}__${when.toISOString()}`, room_id: `DEV${id}`,
        // Свежий вечер привязан к турниру №4 — на нём в приложении видно
        // «Как закончилось»; остальные лежат без привязки, как отчёты из комнат.
        tournament_id: t === 0 ? 4 : null, name: t % 3 === 1 ? "ПКО среда" : "Вечерний фриз-аут",
        played_at: when.toISOString(), buy_in: buyIn, pko: t % 3 === 1,
        players_count: roster.length, entries: 0, reentries: 0, addons: 0,
        expected: 0, paid: 0, debt: 0, transfer: 0, cash: 0, card: 0,
      };
      roster.forEach((p, i) => {
        // Порядок мест крутится от турнира к турниру — иначе один и тот же
        // игрок всегда первый, и сортировки CRM не на чем проверить.
        const place = ((i + t * 3) % roster.length) + 1;
        const reentries = (i + t) % 5 === 0 ? 1 : 0;
        const entries = 1 + reentries;
        const expected = entries * buyIn;
        // Последнему в списке долг — чтобы плашка долга была видна
        const paid = i === roster.length - 1 && t === 0 ? expected - 500 : expected;
        const method = ["transfer", "cash", "card"][(i + t) % 3];
        const row = {
          id: prid++, result_id: id, player_id: p.id, name: p.name, place,
          entries, reentries, addon: false, ko: (place <= 3 ? 4 - place : 0) + ((i + t) % 2),
          ko_pts: 0, points: place <= 3 ? POINTS[place - 1] : 0,
          buy_in: buyIn, expected, paid, debt: Math.max(0, expected - paid),
          transfer: 0, cash: 0, card: 0,
        };
        row[method] = paid;
        resultPlayers.push(row);
        head.entries += entries; head.reentries += reentries;
        head.expected += expected; head.paid += paid; head.debt += row.debt;
        head[method] += paid;
      });
      results.push(head);
    }
    return { results, resultPlayers };
  }

  // Игрок приложения. Первый в списке — «свой» телефон: его tg_id совпадает с
  // подменённым initData, поэтому app.html?dev=1 входит сразу и с историей.
  const DEV_TG = { id: 501234567, first_name: "Андрей", last_name: "Кузнецов", username: "vyatka_dev" };

  // Дата со временем, а не «день»: карточка турнира в приложении показывает час,
  // и на одной календарной дате она всегда писала бы «00:00».
  const at = (daysFromToday, hour) => {
    const d = new Date(today);
    d.setDate(d.getDate() + daysFromToday);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };

  function seed() {
    const players = NAMES.map((name, i) => ({ id: 100 + i, name, full_name: `${name}, Киров` }));
    players[0].tg_id = DEV_TG.id;
    players[0].tg_username = DEV_TG.username;
    // Латиницей — чтобы транслит-поиск было на чём проверить
    players.push({ id: 90, name: "Petr Shabalin", full_name: "Пётр Шабалин, Слободской" });
    const past = seedResults(players);
    return {
      tournament_results: past.results,
      tournament_result_players: past.resultPlayers,
      profiles: [
        { id: "dev-admin", email: "admin@vyatka.local", role: "admin" },
        { id: "dev-operator", email: "operator@vyatka.local", role: "operator" },
      ],
      players,
      player_sessions: [],
      tournaments: [
        { id: 1, name: "Вечерний фриз-аут", date: at(0, 19), status: "open", entry_fee: 1000, slots: 45,
          room_id: null, registered_count: 8, start_stack: 30000, level_minutes: 16, late_reg_level: 9,
          description: "Классика вечера: фриз-аут с одним реентри до конца поздней регистрации.",
          features: ["BB ante", "Один реентри", "Бонус за руку дня"] },
        { id: 2, name: "ПКО среда", date: at(1, 19), status: "open", entry_fee: 1500, slots: 36,
          room_id: null, registered_count: 0, start_stack: 25000, level_minutes: 15, late_reg_level: 8,
          description: "Половина взноса уходит за головы — выбиваешь и забираешь.",
          features: ["ПКО: 50% за голову", "Аддон 20 000 фишек"] },
        { id: 3, name: "Глубокий стек", date: at(4, 18), status: "draft", entry_fee: 2000, slots: 27,
          room_id: null, registered_count: 0, start_stack: 50000, level_minutes: 20, late_reg_level: 12,
          description: "", features: ["Уровни 20 минут"] },
        // Прошедший — чтобы в приложении была вкладка «Прошедшие», а не пустота
        { id: 4, name: "Вятский Дейли", date: at(-7, 19), status: "past", entry_fee: 1000, slots: 45,
          room_id: null, registered_count: 11, start_stack: 30000, level_minutes: 16, late_reg_level: 9,
          description: "", features: [] },
      ],
      // восьмеро уже записались на сегодняшний — есть что импортировать
      registrations: players.slice(0, 8).map((p, i) => ({
        id: 200 + i, tournament_id: 1, player_id: p.id, status: "registered",
        created_at: new Date(Date.now() - (8 - i) * 6e4).toISOString(),
      })),
      tournament_operators: [],
      rooms: [],
      // Макеты: те же «Классика» и «Турбо», что в migrations/014_blueprint_classic.sql
      // и 015_blueprint_turbo.sql, но короткой лестницей — песочнице важно, что
      // грузится из «базы», а не сама сетка.
      tournament_blueprints: [
        { id: 1, name: "Классика", start_stack: 40000, late_reg_until_level: 8, default_buy_in: 700, default_reentry: 500,
          default_addon_stack: 80000, default_addon_cost: 700, sort_order: 1,
          levels: [{min:20,sb:100,bb:200,anteMode:"BB"},{min:20,sb:200,bb:400,anteMode:"BB"},
                   {isBreak:true,min:12,label:"Перерыв"},{min:18,sb:500,bb:1000,anteMode:"BB"}] },
        { id: 2, name: "Турбо", start_stack: 30000, late_reg_until_level: 9, default_buy_in: 700, default_reentry: 500,
          default_addon_stack: 90000, default_addon_cost: 1000, sort_order: 2,
          levels: [{min:14,sb:100,bb:100,anteMode:"BB"},{min:14,sb:100,bb:200,anteMode:"BB"},
                   {isBreak:true,min:13,label:"Перерыв"},{min:12,sb:500,bb:1000,anteMode:"BB"}] },
      ],
    };
  }

  const readDb = () => {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    const fresh = seed();
    writeDb(fresh);
    return fresh;
  };
  function writeDb(db) {
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { console.warn("[dev] не сохранилось", e); }
  }

  // ── Realtime между вкладками ───────────────────────────────────────────────
  const bus = ("BroadcastChannel" in window) ? new BroadcastChannel("vp-dev-bus") : null;
  const channels = new Set();
  if (bus) bus.onmessage = (ev) => channels.forEach((ch) => ch._deliver(ev.data));

  // ── Триггеры вокруг регистраций ────────────────────────────────────────────
  // В базе за это отвечают sync_registered_count и sync_registration_to_room
  // (001_init.sql) плюс vp_unsync_registration (005). Без них в песочнице счётчик
  // записавшихся врёт, а запись из приложения не доезжает в открытую комнату —
  // то есть проверить как раз то, что связывает приложение с админкой, нельзя.
  const nkey = (s) => String(s ?? "").toLowerCase().replace(/[ёйЁЙ]/g, (c) => ({ "ё": "е", "Ё": "е", "й": "и", "Й": "и" }[c])).replace(/\s+/g, " ").trim();

  function devSyncRegistrations(db) {
    const regs = db.registrations || [];
    const players = db.players || [];
    (db.tournaments || []).forEach((t) => {
      t.registered_count = regs.filter((r) => String(r.tournament_id) === String(t.id) && r.status !== "cancelled").length;
      if (!t.room_id) return;
      const room = (db.rooms || []).find((r) => r.room_id === t.room_id);
      if (!room?.state) return;
      const list = Array.isArray(room.state.players) ? room.state.players : (room.state.players = []);
      regs.filter((r) => String(r.tournament_id) === String(t.id)).forEach((r) => {
        const p = players.find((x) => String(x.id) === String(r.player_id));
        if (!p) return;
        const k = nkey(p.name);
        const i = list.findIndex((pl) =>
          (pl.player_id != null && String(pl.player_id) === String(r.player_id)) || nkey(pl.name) === k);
        if (r.status === "cancelled") {
          // Тронутого за столом не убираем: статистика вечера уже на нём.
          if (i >= 0 && !list[i].present && !list[i].reentries && list[i].bustOrder == null) list.splice(i, 1);
        } else if (i < 0) {
          list.push({ name: p.name, player_id: p.id, present: false, reentries: 0, status: "registered", ko: 0, koPts: 0 });
        } else if (list[i].player_id == null) {
          list[i].player_id = p.id;
        }
      });
    });
  }

  const matchFilter = (filter, row) => {
    if (!filter) return true;
    const m = /^(\w+)=eq\.(.*)$/.exec(filter);
    return m ? String(row?.[m[1]]) === m[2] : true;
  };

  class DevChannel {
    constructor(name) { this.name = name; this.handlers = []; channels.add(this); }
    on(type, opts, cb) { this.handlers.push({ type, opts, cb }); return this; }
    subscribe(cb) { if (cb) setTimeout(() => cb("SUBSCRIBED"), 0); return this; }
    send(msg) {
      bus?.postMessage({ kind: "broadcast", channel: this.name, event: msg.event, payload: msg.payload });
      return Promise.resolve("ok");
    }
    _deliver(m) {
      for (const h of this.handlers) {
        if (m.kind === "broadcast" && h.type === "broadcast") {
          if (m.channel === this.name && m.event === h.opts?.event) h.cb({ payload: m.payload });
        } else if (m.kind === "pg" && h.type === "postgres_changes") {
          if (canon(h.opts?.table) === m.table && matchFilter(h.opts?.filter, m.new)) h.cb({ new: m.new });
        }
      }
    }
  }

  // ── Построитель запросов ───────────────────────────────────────────────────
  // Отвечает на тот кусок PostgREST, которым пользуется фронт: eq/in/is/gte,
  // order/limit, maybeSingle, встроенный ресурс в select и insert/update/delete.
  class Query {
    constructor(table) {
      this.table = canon(table);
      this.filters = [];
      this.embed = null;
      this.op = { kind: "select" };
      this._order = null;
      this._limit = null;
      this._single = false;
    }
    select(cols) {
      const m = /(\w+)\s*\(([^)]*)\)/.exec(cols || "");
      if (m) this.embed = { table: canon(m[1]), raw: m[1], cols: m[2].split(",").map((s) => s.trim()) };
      return this;
    }
    eq(f, v) { this.filters.push((r) => String(r[f]) === String(v)); return this; }
    lte(f, v) { this.filters.push((r) => String(r[f] ?? "") <= String(v)); return this; }
    lt(f, v) { this.filters.push((r) => String(r[f] ?? "") < String(v)); return this; }
    // «name.ilike.%пет%,full_name.ilike.%пет%» — форма PostgREST, которой ищут игроков
    or(cond) {
      const terms = String(cond || "").split(",").map((t) => {
        const m = /^(\w+)\.ilike\.%?(.*?)%?$/.exec(t.trim());
        return m ? { field: m[1], needle: m[2].toLowerCase() } : null;
      }).filter(Boolean);
      if (!terms.length) return this;
      this.filters.push((r) => terms.some((t) => String(r[t.field] ?? "").toLowerCase().includes(t.needle)));
      return this;
    }
    in(f, vs) { const s = new Set(vs.map(String)); this.filters.push((r) => s.has(String(r[f]))); return this; }
    is(f, v) { this.filters.push((r) => (v === null ? r[f] == null : r[f] === v)); return this; }
    gte(f, v) { this.filters.push((r) => String(r[f]) >= String(v)); return this; }
    order(f, o) { this._order = { f, asc: o?.ascending !== false }; return this; }
    limit(n) { this._limit = n; return this; }
    maybeSingle() { this._single = true; return this; }
    single() { this._single = true; return this; }
    insert(row) { this.op = { kind: "insert", row }; return this; }
    // Снимок турнира сохраняют по многу раз за вечер — CRM пишет шапку через
    // upsert по report_key, и без него песочница плодила бы отчёт на каждое нажатие.
    upsert(row, opts) { this.op = { kind: "upsert", row, onConflict: opts?.onConflict }; return this; }
    update(patch) { this.op = { kind: "update", patch }; return this; }
    delete() { this.op = { kind: "delete" }; return this; }

    // Запись в хранилище плюс то, что в базе делают триггеры. Комнаты
    // рассылаем соседним вкладкам: дисплей и админка слушают именно rooms.
    _save(db) {
      if (this.table === "registrations") devSyncRegistrations(db);
      writeDb(db);
      if (this.table === "registrations") {
        (db.rooms || []).forEach((r) => bus?.postMessage({ kind: "pg", table: "rooms", new: JSON.parse(JSON.stringify(r)) }));
      }
    }

    _run() {
      const db = readDb();
      const rows = (db[this.table] = db[this.table] || []);
      const hit = (r) => this.filters.every((f) => f(r));

      if (this.op.kind === "insert") {
        const list = Array.isArray(this.op.row) ? this.op.row : [this.op.row];
        for (const row of list) {
          const dup = this.table === "rooms" && rows.some((r) => r.room_id === row.room_id);
          if (dup) return { data: null, error: { message: "duplicate key value violates unique constraint" } };
          // Колонки со `default` в базе: без них новый турнир уезжает в
          // приложение с registered_count = undefined.
          const defaults = this.table === "tournaments" ? { registered_count: 0, features: [] } : {};
          rows.push({ id: row.id ?? Date.now() + Math.floor(Math.random() * 1000), created_at: new Date().toISOString(), ...defaults, ...row });
        }
        this._save(db);
        return { data: list, error: null };
      }
      if (this.op.kind === "upsert") {
        const list = Array.isArray(this.op.row) ? this.op.row : [this.op.row];
        // onConflict бывает составным: регистрация уникальна парой (турнир, игрок).
        const keys = String(this.op.onConflict || "id").split(",").map((s) => s.trim()).filter(Boolean);
        const saved = list.map((row) => {
          const old = rows.find((r) => keys.every((k) => String(r[k]) === String(row[k])));
          if (old) { Object.assign(old, row); return old; }
          const fresh = { id: Date.now() + Math.floor(Math.random() * 1000), created_at: new Date().toISOString(), ...row };
          rows.push(fresh);
          return fresh;
        });
        this._save(db);
        const copy = saved.map((r) => ({ ...r }));
        return this._single ? { data: copy[0] || null, error: null } : { data: copy, error: null };
      }
      if (this.op.kind === "update") {
        const touched = rows.filter(hit);
        touched.forEach((r) => Object.assign(r, this.op.patch));
        this._save(db);
        touched.forEach((r) => bus?.postMessage({ kind: "pg", table: this.table, new: JSON.parse(JSON.stringify(r)) }));
        // update().select().maybeSingle() на бою отдаёт строку или null — по нему
        // проверяют, что условие вроде `.is("room_id", null)` вообще кого-то нашло.
        if (this._single) return { data: touched[0] ? { ...touched[0] } : null, error: null };
        return { data: touched, error: null };
      }
      if (this.op.kind === "delete") {
        db[this.table] = rows.filter((r) => !hit(r));
        // Удаление комнаты отвязывает турнир: в базе это on delete set null.
        if (this.table === "rooms") {
          const alive = new Set((db.rooms || []).map((r) => String(r.room_id)));
          (db.tournaments || []).forEach((t) => { if (t.room_id && !alive.has(String(t.room_id))) t.room_id = null; });
        }
        // Удаление турнира уносит его регистрации: в базе это on delete cascade.
        if (this.table === "tournaments") {
          const alive = new Set((db.tournaments || []).map((t) => String(t.id)));
          db.registrations = (db.registrations || []).filter((r) => alive.has(String(r.tournament_id)));
        }
        this._save(db);
        return { data: null, error: null };
      }

      let out = rows.filter(hit).map((r) => ({ ...r }));
      if (this._order) {
        const { f, asc } = this._order;
        out.sort((a, b) => (String(a[f] ?? "") < String(b[f] ?? "") ? -1 : 1) * (asc ? 1 : -1));
      }
      if (this._limit != null) out = out.slice(0, this._limit);
      if (this.embed) {
        const fk = FK[this.table];
        const src = db[this.embed.table] || [];
        out = out.map((r) => {
          const parent = fk ? src.find((p) => String(p[fk.foreign]) === String(r[fk.local])) : null;
          // ключ — как во фронте: r[TBL.players], т.е. имя из запроса, не каноническое
          return { ...r, [this.embed.raw]: parent ? { ...parent } : null };
        });
      }
      if (this._single) return { data: out[0] || null, error: null };
      return { data: out, error: null };
    }
    then(res, rej) {
      // задержка — чтобы «Загрузка…» успевала мигнуть, как на живой базе
      return new Promise((ok) => setTimeout(() => ok(this._run()), 60)).then(res, rej);
    }
  }

  // ── Приложение игрока ──────────────────────────────────────────────────────
  // Подписи Telegram в песочнице нет: «initData» — это просто JSON пользователя,
  // и vp_app_login читает из него id, ничего не проверяя. На бою так нельзя
  // (см. 005_player_app.sql), и именно поэтому стаб живёт только на localhost.
  // Само приложение телеграмом больше не входит — в песочнице входим почтой
  // (любой адрес, код 000000).

  const playerJson = (p) => (p ? {
    id: p.id, name: p.name, full_name: p.full_name ?? null, phone: p.phone ?? null,
    tg_id: p.tg_id ?? null, tg_username: p.tg_username ?? null,
    vk_id: p.vk_id ?? null, vk_username: p.vk_username ?? null,
    email: p.email_verified ? p.email : null, auth_provider: p.auth_provider ?? null,
    photo_url: p.photo_url ?? null, games_played: p.games_played ?? 0,
    pd_consent_at: p.pd_consent_at ?? null, pd_consent_version: p.pd_consent_version ?? null,
    photo_consent: !!p.photo_consent, marketing_consent: !!p.marketing_consent,
  } : null);

  const fail = (code) => ({ data: null, error: { message: code } });

  function sessionPlayerId(db, token) {
    const s = (db.player_sessions || []).find((x) => x.token === token);
    return s ? s.player_id : null;
  }

  // Ответ vp_app_me целиком: профиль, свои записи и история из снимков CRM.
  // ── Опыт и уровни — копия vp_xp_games / vp_xp_ledger из 019_levels.sql ──────
  const mskMonth = (iso) => new Date(new Date(iso).getTime() + 3 * 3600000).toISOString().slice(0, 7);
  function devXpGames(db) {
    const now = new Date();
    const all = db.tournament_result_players || [];
    const out = new Map();
    (db.tournament_results || []).forEach((h) => {
      const rows = all.filter((r) => String(r.result_id) === String(h.id));
      const ok = new Date(h.played_at) <= now
        && (h.tournament_id == null || (db.tournaments || []).some((t) => String(t.id) === String(h.tournament_id) && t.status === "past"))
        && rows.length && rows.every((r) => r.place != null && r.place >= 1);
      if (!ok) return;
      rows.forEach((r) => {
        const p = r.player_id != null
          ? (db.players || []).find((x) => String(x.id) === String(r.player_id))
          : (db.players || []).find((x) => nkey(x.name) === nkey(r.name));
        if (!p) return;
        const key = `${p.id}:${h.id}`;
        if (out.has(key) && r.player_id == null) return;
        out.set(key, { player_id: p.id, result_id: h.id, tournament_id: h.tournament_id ?? null, title: h.name || "Турнир",
          played_at: h.played_at, place: r.place, ko: r.ko || 0, points: r.points || 0 });
      });
    });
    return [...out.values()].sort((a, b) => String(a.played_at).localeCompare(String(b.played_at)) || a.result_id - b.result_id);
  }
  function devXpLedger(db, pid) {
    const games = devXpGames(db).filter((g) => String(g.player_id) === String(pid));
    const rows = [], perMonth = {};
    games.forEach((g, i) => {
      const grp = "r" + g.result_id, at = g.played_at, title = g.title;
      const add = (kind, xp, n = 1) => rows.push({ grp, at, kind, title, xp, n });
      add("game", 100);
      if (i === 0) add("first", 150);
      const t = (db.tournaments || []).find((x) => g.tournament_id != null && String(x.id) === String(g.tournament_id));
      const reg = t && (db.registrations || []).find((r) => String(r.tournament_id) === String(t.id)
        && String(r.player_id) === String(pid) && r.status === "registered");
      if (reg && String(reg.created_at) < String(t.date || at)) add("prereg", 20);
      if (g.place >= 1 && g.place <= 3) add("place", [150, 100, 75][g.place - 1], g.place);
      else if (g.points > 0) add("place", 40, g.place);
      if (g.ko > 0) add("ko", 10 * g.ko, g.ko);
      const m = mskMonth(at);
      perMonth[m] = (perMonth[m] || 0) + 1;
      if (perMonth[m] === 4) rows.push({ grp: "m" + m, at, kind: "month", title: m, xp: 200, n: 4 });
    });
    const p = (db.players || []).find((x) => String(x.id) === String(pid));
    if (p && String(p.full_name || "").trim() && String(p.phone || "").trim())
      rows.push({ grp: "profile", at: p.created_at || new Date(0).toISOString(), kind: "profile", title: null, xp: 100, n: 1 });
    return rows;
  }
  function devLevel(db, pid, withEvents = false) {
    if (pid == null) return null;
    const rows = devXpLedger(db, pid);
    const lv = window.VP.levelFromXp(rows.reduce((a, r) => a + r.xp, 0));
    if (!withEvents) return lv;
    const groups = new Map();
    rows.forEach((r) => {
      const g = groups.get(r.grp) || { grp: r.grp, at: r.at, title: r.title, xp: 0, parts: [] };
      if (String(r.at) > String(g.at)) g.at = r.at;
      g.xp += r.xp; g.parts.push({ kind: r.kind, xp: r.xp, n: r.n });
      groups.set(r.grp, g);
    });
    lv.events = [...groups.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20);
    return lv;
  }
  // Списки (рейтинг, состав, итоги) получают level и rank_key, как в 019.
  const LEVELED_RPC = new Set(["vp_app_rating", "vp_tournament_roster", "vp_tournament_results"]);
  function withLevels(db, rows) {
    return (rows || []).map((r) => {
      const lv = devLevel(db, r.player_id);
      return { ...r, level: lv?.level ?? null, rank_key: lv?.rank_key ?? null };
    });
  }

  function appMe(db, pid) {
    const heads = {};
    (db.tournament_results || []).forEach((r) => { heads[r.id] = r; });
    const me = (db.players || []).find((p) => String(p.id) === String(pid));
    const key = nkey(me?.name);
    const history = (db.tournament_result_players || [])
      .filter((r) => String(r.player_id) === String(pid) || (r.player_id == null && nkey(r.name) === key))
      .map((r) => {
        const h = heads[r.result_id] || {};
        // Как left join в migrations/018: оформление берём у турнира итога.
        const t = (db.tournaments || []).find((x) => h.tournament_id != null && String(x.id) === String(h.tournament_id));
        return { name: h.name || "Турнир", played_at: h.played_at || null, place: r.place ?? null, ko: r.ko || 0, points: r.points || 0, entries: r.entries || 1,
          tournament_id: h.tournament_id ?? null, card_art: t?.card_art ?? null };
      })
      .sort((a, b) => String(b.played_at || "").localeCompare(String(a.played_at || "")));
    return {
      player: playerJson(me),
      registrations: (db.registrations || [])
        .filter((r) => String(r.player_id) === String(pid) && r.status !== "cancelled")
        .map((r) => Number(r.tournament_id)),
      history,
      level: devLevel(db, pid, true),
    };
  }

  // Три способа входа сходятся здесь же, где и на сервере (006): найти по
  // тому, чем вошли, иначе приклеиться к «бумажному» игроку, иначе завести.
  // Ошибка возвращается строкой-кодом — её ловит вызывающий.
  function devFindOrCreate(db, id, name) {
    let p = null;
    if (id.tg_id != null)  p = (db.players || []).find((x) => String(x.tg_id) === String(id.tg_id));
    if (!p && id.vk_id != null) p = (db.players || []).find((x) => String(x.vk_id) === String(id.vk_id));
    if (!p && id.email) p = (db.players || []).find((x) => x.email_verified && String(x.email).toLowerCase() === id.email);
    if (p) {
      if (p.tg_id == null && id.tg_id != null) p.tg_id = id.tg_id;
      if (p.vk_id == null && id.vk_id != null) p.vk_id = id.vk_id;
      if (!p.email && id.email) { p.email = id.email; p.email_verified = true; }
      if (id.tg_username) p.tg_username = id.tg_username;
      if (id.vk_username) p.vk_username = id.vk_username;
      return p;
    }
    const nm = String(name || "").trim();
    if (nm.length < 2 || nm.length > 60) throw new Error("invalid_name");
    p = (db.players || []).find((x) => nkey(x.name) === nkey(nm) && x.tg_id == null && x.vk_id == null && !x.email);
    if (p) { Object.assign(p, id); if (id.email) p.email_verified = true; return p; }
    if ((db.players || []).some((x) => nkey(x.name) === nkey(nm))) throw new Error("name_taken");
    p = {
      id: Date.now(), name: nm, games_played: 0, email_verified: !!id.email,
      auth_provider: id.tg_id != null ? "telegram" : id.vk_id != null ? "vk" : "email",
      ...id,
    };
    db.players.push(p);
    return p;
  }

  function devIssueSession(db, p) {
    const token = ("dev" + Math.random().toString(36).slice(2)).padEnd(40, "0");
    db.player_sessions = (db.player_sessions || []).filter((s) => String(s.player_id) !== String(p.id));
    db.player_sessions.push({ token, player_id: p.id });
    return { data: { token, player: playerJson(p) }, error: null };
  }

  // Доказательства в песочнице ненастоящие: «dev-vk:<id>» и «dev-mail:<адрес>».
  // На бою их проверяет сервер (у VK спрашивает владельца токена, у JWT
  // сверяет подпись), и подменить их из браузера нельзя — см. 006.
  const devVkUser = (t) => {
    const m = /^dev-vk:(\d+)$/.exec(String(t || ""));
    if (!m) throw new Error("auth_token_invalid");
    return { user_id: Number(m[1]), screen_name: "dev_vk" + m[1] };
  };
  const devMail = (t) => {
    const m = /^dev-mail:(.+)$/.exec(String(t || ""));
    if (!m) throw new Error("auth_token_invalid");
    return m[1].toLowerCase();
  };

  // Склейка: донор отдаёт входы, записи и сыгранное и исчезает.
  function devMerge(db, keepId, donor) {
    if (!donor) return fail("player_not_found");
    if (String(donor.id) === String(keepId)) return fail("same_player");
    const keep = db.players.find((x) => String(x.id) === String(keepId));
    keep.tg_id = keep.tg_id ?? donor.tg_id ?? null;
    keep.vk_id = keep.vk_id ?? donor.vk_id ?? null;
    if (!keep.email && donor.email) { keep.email = donor.email; keep.email_verified = donor.email_verified; }
    keep.tg_username = keep.tg_username || donor.tg_username || null;
    keep.vk_username = keep.vk_username || donor.vk_username || null;
    keep.games_played = (keep.games_played || 0) + (donor.games_played || 0);
    (db.registrations || []).forEach((r) => {
      if (String(r.player_id) !== String(donor.id)) return;
      const dup = (db.registrations || []).some((x) => String(x.tournament_id) === String(r.tournament_id) && String(x.player_id) === String(keepId));
      r.player_id = dup ? null : keepId;
    });
    db.registrations = (db.registrations || []).filter((r) => r.player_id != null);
    (db.tournament_result_players || []).forEach((r) => {
      if (String(r.player_id) === String(donor.id)) r.player_id = keepId;
    });
    db.players = db.players.filter((x) => String(x.id) !== String(donor.id));
    db.player_sessions = (db.player_sessions || []).filter((s) => String(s.player_id) !== String(donor.id));
    return { data: playerJson(keep), error: null };
  }

  const APP_RPC = {
    vp_app_login(db, args) {
      const raw = String(args?.p_init_data || "");
      if (!raw.startsWith("dev:")) return fail("init_data_invalid");
      const user = JSON.parse(raw.slice(4));
      const p = devFindOrCreate(db,
        { tg_id: user.id, tg_username: user.username || null },
        args?.p_name || [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username);
      return devIssueSession(db, p);
    },
    vp_app_login_vk(db, args) {
      const u = devVkUser(args?.p_access_token);
      const p = devFindOrCreate(db, { vk_id: u.user_id, vk_username: u.screen_name }, args?.p_name);
      return devIssueSession(db, p);
    },
    vp_app_login_email(db, args) {
      const email = devMail(args?.p_jwt);
      const p = devFindOrCreate(db, { email }, args?.p_name);
      return devIssueSession(db, p);
    },
    vp_app_link_vk(db, args) {
      const pid = sessionPlayerId(db, args?.p_token);
      if (!pid) return fail("not_authorized");
      const u = devVkUser(args?.p_access_token);
      if ((db.players || []).some((x) => String(x.vk_id) === String(u.user_id) && String(x.id) !== String(pid))) return fail("vk_id_taken");
      const p = db.players.find((x) => String(x.id) === String(pid));
      p.vk_id = u.user_id; p.vk_username = u.screen_name;
      return { data: playerJson(p), error: null };
    },
    vp_app_link_email(db, args) {
      const pid = sessionPlayerId(db, args?.p_token);
      if (!pid) return fail("not_authorized");
      const email = devMail(args?.p_jwt);
      if ((db.players || []).some((x) => x.email_verified && String(x.email).toLowerCase() === email && String(x.id) !== String(pid))) return fail("email_taken");
      const p = db.players.find((x) => String(x.id) === String(pid));
      p.email = email; p.email_verified = true;
      return { data: playerJson(p), error: null };
    },
    vp_app_merge_vk(db, args) {
      const pid = sessionPlayerId(db, args?.p_token);
      if (!pid) return fail("not_authorized");
      const u = devVkUser(args?.p_access_token);
      const donor = (db.players || []).find((x) => String(x.vk_id) === String(u.user_id));
      return devMerge(db, pid, donor);
    },
    vp_app_merge_email(db, args) {
      const pid = sessionPlayerId(db, args?.p_token);
      if (!pid) return fail("not_authorized");
      const email = devMail(args?.p_jwt);
      const donor = (db.players || []).find((x) => x.email_verified && String(x.email).toLowerCase() === email);
      return devMerge(db, pid, donor);
    },
    vp_app_logout(db, args) {
      db.player_sessions = (db.player_sessions || []).filter((s) => s.token !== args?.p_token);
      return { data: null, error: null };
    },
    vp_app_player_public(db, args) {
      const p = (db.players || []).find((x) => String(x.id) === String(args?.p_player_id));
      if (!p) return fail("player_not_found");
      const history = appMe(db, p.id).history;
      return { data: {
        player: { id: p.id, name: p.name, photo_url: p.photo_url ?? null },
        stats: {
          games: history.length,
          wins: history.filter((h) => h.place === 1).length,
          top3: history.filter((h) => h.place >= 1 && h.place <= 3).length,
          ko: history.reduce((a, h) => a + (h.ko || 0), 0),
        },
        history: history.slice(0, 30),
        level: devLevel(db, p.id),
      }, error: null };
    },
    vp_app_me(db, args) {
      const pid = sessionPlayerId(db, args?.p_token);
      if (!pid) return fail("not_authorized");
      return { data: appMe(db, pid), error: null };
    },
    vp_app_update_profile(db, args) {
      const pid = sessionPlayerId(db, args?.p_token);
      if (!pid) return fail("not_authorized");
      const p = db.players.find((x) => String(x.id) === String(pid));
      const name = String(args?.p_name || "").trim();
      if (name) {
        if (name.length < 2) return fail("invalid_name");
        if (db.players.some((x) => String(x.id) !== String(pid) && nkey(x.name) === nkey(name))) return fail("name_taken");
        p.name = name;
      }
      if (args?.p_full_name) p.full_name = String(args.p_full_name).trim();
      if (args?.p_phone) p.phone = String(args.p_phone).trim();
      return { data: playerJson(p), error: null };
    },
    // Журнал согласий из 008_player_consent.sql: без него экран согласия в
    // песочнице падал бы на первом же «Продолжить», то есть проверить главное —
    // что без согласия дальше не пускают — было бы нечем.
    vp_app_log_consent(db, args) {
      const pid = sessionPlayerId(db, args?.p_token);
      if (!pid) return fail("no_session");
      const ver = String(args?.p_consent_version || "").trim();
      if (!ver) return fail("no_version");
      if (!["tg", "vk", "email"].includes(String(args?.p_source))) return fail("invalid_source");
      const p = db.players.find((x) => String(x.id) === String(pid));
      if (!p) return fail("no_session");
      db.consent_log = db.consent_log || [];
      const row = (type) => ({
        id: Date.now() + Math.floor(Math.random() * 1000), player_id: p.id, consent_type: type,
        agreed: true, consent_version: ver, agreed_at: new Date().toISOString(),
        source: String(args.p_source), user_agent: String(args?.p_user_agent || "").slice(0, 400) || null,
      });
      db.consent_log.push(row("pd"));
      if (args?.p_photo_consent) db.consent_log.push(row("photo"));
      if (args?.p_marketing_consent) db.consent_log.push(row("marketing"));
      p.pd_consent_version = ver;
      p.pd_consent_at = new Date().toISOString();
      p.photo_consent = !!args?.p_photo_consent;
      p.marketing_consent = !!args?.p_marketing_consent;
      return { data: playerJson(p), error: null };
    },
    vp_app_register(db, args) {
      const pid = sessionPlayerId(db, args?.p_token);
      if (!pid) return fail("not_authorized");
      const t = (db.tournaments || []).find((x) => String(x.id) === String(args?.p_tournament_id));
      if (!t) return fail("tournament_not_found");
      if (!["open", "running"].includes(t.status)) return fail("registration_closed");
      const mine = (db.registrations || []).find((r) => String(r.tournament_id) === String(t.id) && String(r.player_id) === String(pid));
      const taken = (db.registrations || []).filter((r) => String(r.tournament_id) === String(t.id) && r.status !== "cancelled").length;
      if (t.slots != null && taken >= t.slots && (!mine || mine.status === "cancelled")) return fail("tournament_full");
      if (mine) { mine.status = "registered"; mine.created_at = new Date().toISOString(); }
      else db.registrations.push({ id: Date.now(), tournament_id: t.id, player_id: pid, status: "registered", created_at: new Date().toISOString() });
      devSyncRegistrations(db);
      return { data: { registered: true, registered_count: t.registered_count }, error: null };
    },
    vp_app_cancel(db, args) {
      const pid = sessionPlayerId(db, args?.p_token);
      if (!pid) return fail("not_authorized");
      const t = (db.tournaments || []).find((x) => String(x.id) === String(args?.p_tournament_id));
      (db.registrations || []).forEach((r) => {
        if (String(r.tournament_id) === String(args?.p_tournament_id) && String(r.player_id) === String(pid)) r.status = "cancelled";
      });
      devSyncRegistrations(db);
      return { data: { registered: false, registered_count: t?.registered_count ?? 0 }, error: null };
    },
    vp_tournament_roster(db, args) {
      const rows = (db.registrations || [])
        .filter((r) => String(r.tournament_id) === String(args?.p_tournament_id) && r.status !== "cancelled")
        .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
        .map((r) => {
          const p = (db.players || []).find((x) => String(x.id) === String(r.player_id));
          return p ? { player_id: p.id, name: p.name, registered_at: r.created_at, photo_url: p.photo_url ?? null } : null;
        }).filter(Boolean);
      return { data: rows, error: null };
    },
    vp_app_rating(db, args) {
      const period = args?.p_period || "month";
      const archive = /^([0-9]{4})-(0[1-9]|1[0-2])$/.exec(period);
      if (!["month", "year", "all"].includes(period) && (!archive || Number(archive[1]) === 0)) return { data: [], error: null };
      const now = new Date();
      const local = new Date(now.getTime() + 3 * 3600000);
      const year = archive ? Number(archive[1]) : local.getUTCFullYear();
      const month = archive ? Number(archive[2]) - 1 : period === "year" ? 0 : local.getUTCMonth();
      const boundary = offset => {
        const d = new Date(0);
        d.setUTCFullYear(year, month + offset, 1); d.setUTCHours(0, 0, 0, 0);
        return d.getTime() - 3 * 3600000;
      };
      const start = period === "all" ? -Infinity : boundary(0);
      const end = period === "all" ? Infinity : boundary(period === "year" ? 12 : 1);
      const all = db.tournament_result_players || [];
      const ids = new Set((db.tournament_results || []).filter(h => {
        const rows = all.filter(r => String(r.result_id) === String(h.id));
        return new Date(h.played_at).getTime() >= start && new Date(h.played_at).getTime() < end && new Date(h.played_at) <= now
          && (h.tournament_id == null || db.tournaments.some(t => String(t.id) === String(h.tournament_id) && t.status === "past"))
          && rows.length && rows.every(r => r.place != null && r.place >= 1);
      }).map(h => String(h.id)));
      const totals = new Map();
      all.filter(r => ids.has(String(r.result_id))).forEach(r => {
        const p = db.players.find(p => r.player_id != null ? String(p.id) === String(r.player_id) : nkey(p.name) === nkey(r.name));
        const key = p ? `id:${p.id}` : `name:${nkey(r.name)}`;
        if (!totals.has(key)) totals.set(key, { player_id: p?.id ?? null, name: p?.name || r.name, points: 0, games: 0, wins: 0, results: new Set() });
        const item = totals.get(key);
        item.points += Number(r.points) || 0;
        item.results.add(String(r.result_id)); item.games = item.results.size;
        item.wins += Number(r.place) === 1 ? 1 : 0;
      });
      const rows = [...totals.values()].sort((a,b) => b.points - a.points || a.name.localeCompare(b.name, "ru"));
      let rank = 0;
      rows.forEach((r,i) => { if (!i || r.points !== rows[i-1].points) rank = i + 1; r.rank = rank; delete r.results; });
      return { data: rows, error: null };
    },
    vp_tournament_results(db, args) {
      const t = (db.tournaments || []).find((x) => String(x.id) === String(args?.p_tournament_id));
      if (!t || t.status !== "past") return { data: [], error: null };
      const ids = (db.tournament_results || [])
        .filter((r) => String(r.tournament_id) === String(t.id)).map((r) => String(r.id));
      const rows = (db.tournament_result_players || [])
        .filter((r) => ids.includes(String(r.result_id)))
        .map((r) => {
          const p = (db.players || []).find((x) => String(x.id) === String(r.player_id))
            || (r.player_id == null ? (db.players || []).find((x) => nkey(x.name) === nkey(r.name)) : null);
          return { place: r.place ?? null, name: r.name, ko: r.ko || 0, points: r.points || 0,
            player_id: p?.id ?? null, photo_url: p?.photo_url ?? null };
        })
        .sort((a, b) => (a.place == null) - (b.place == null) || (a.place || 0) - (b.place || 0));
      return { data: rows, error: null };
    },
    vp_levels_for(db, args) {
      const ids = (args?.p_ids || []).map(String);
      const rows = (db.players || []).filter((p) => ids.includes(String(p.id))).map((p) => {
        const lv = devLevel(db, p.id);
        const games = devXpLedger(db, p.id).filter((r) => r.kind === "game").length;
        return { player_id: p.id, xp: lv.xp, games, level: lv.level, rank_key: lv.rank_key };
      });
      return { data: rows, error: null };
    },
    vp_unsync_registration(db, args) {
      (db.registrations || []).forEach((r) => {
        if (String(r.tournament_id) === String(args?.p_tournament_id) && String(r.player_id) === String(args?.p_player_id)) {
          r.status = "cancelled";
        }
      });
      devSyncRegistrations(db);
      return { data: null, error: null };
    },
  };

  // ── Клиент ─────────────────────────────────────────────────────────────────
  const getProfileId = () => { try { return localStorage.getItem(ME_KEY) || "dev-admin"; } catch (_) { return "dev-admin"; } };
  let signedOut = false;

  const client = {
    from: (t) => new Query(t),
    rpc: async (name, args) => {
      if (name === "try_acquire_room_lock") {
        // В песочнице ведущий один — блокировку отдаём всегда.
        return { data: [{ lock_owner: args?.p_owner, lock_until: new Date(Date.now() + 6000).toISOString() }], error: null };
      }
      if (name === "server_time_ms") return { data: Date.now(), error: null };
      if (APP_RPC[name]) {
        const db = readDb();
        let res;
        try {
          res = APP_RPC[name](db, args) || { data: null, error: null };
          if (LEVELED_RPC.has(name) && !res.error) res = { ...res, data: withLevels(db, res.data) };
        }
        catch (e) { return { data: null, error: { message: String(e?.message || e) } }; }
        if (!res.error) {
          writeDb(db);
          (db.rooms || []).forEach((r) => bus?.postMessage({ kind: "pg", table: "rooms", new: JSON.parse(JSON.stringify(r)) }));
        }
        return res;
      }
      return { data: null, error: { message: `dev: rpc ${name} не реализован` } };
    },
    channel: (name) => new DevChannel(name),
    removeChannel: (ch) => { channels.delete(ch); return Promise.resolve("ok"); },
    auth: {
      getSession: async () => {
        if (signedOut) return { data: { session: null }, error: null };
        return { data: { session: { access_token: "dev-token", user: { id: getProfileId() } } }, error: null };
      },
      getUser: async () => ({ data: { user: { id: getProfileId() } }, error: null }),
      // Логин принимает что угодно; «operator» открывает вторую роль — так
      // проверяются ограничения оператора, не заводя второй аккаунт.
      signInWithPassword: async ({ email }) => {
        const id = /operator|оператор/i.test(email || "") ? "dev-operator" : "dev-admin";
        try { localStorage.setItem(ME_KEY, id); } catch (_) {}
        signedOut = false;
        return { data: { session: { access_token: "dev-token", user: { id } } }, error: null };
      },
      signOut: async () => { signedOut = true; return { error: null }; },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      // Почтовый вход игрока. Письма из песочницы не уходят — код всегда
      // 000000, и он печатается в консоль, чтобы это было видно, а не
      // угадывалось. На бою и письмо, и код — работа GoTrue.
      signInWithOtp: async ({ email }) => {
        console.info("[vyatka dev] код для " + email + ": 000000");
        return { data: {}, error: null };
      },
      verifyOtp: async ({ email, token }) => {
        if (String(token) !== "000000") return { data: null, error: { message: "invalid otp" } };
        return { data: { session: { access_token: "dev-mail:" + String(email).toLowerCase() } }, error: null };
      },
    },
  };

  window.supabase = { createClient: () => client };

  // ── Кнопка VK ──────────────────────────────────────────────────────────────
  // Настоящий SDK ходит в id.vk.com и требует заведённого приложения, то есть
  // в песочнице бесполезен. Подменяем его кнопкой с тем же интерфейсом: она
  // отдаёт ненастоящий access_token, и весь путь после кнопки — вход, выбор
  // имени, привязка, склейка — проверяется локально, как есть.
  const DEV_VK_ID = 777001;
  window.VKIDSDK = {
    ConfigResponseMode: { Callback: "callback" },
    ConfigSource: { LOWCODE: "lowcode" },
    WidgetEvents: { ERROR: "error" },
    OneTapInternalEvents: { LOGIN_SUCCESS: "login_success" },
    Config: { init() {} },
    Auth: { exchangeCode: async (code) => ({ access_token: "dev-vk:" + code }) },
    OneTap: class {
      render({ container }) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = "Войти через VK (песочница)";
        b.style.cssText = "width:100%;background:#07f;color:#fff";
        b.onclick = () => this._on?.(DEV_VK_ID);
        container.appendChild(b);
        return this;
      }
      on(evt, fn) {
        // Порядок как у настоящего SDK: сначала ERROR, потом LOGIN_SUCCESS.
        if (evt === "login_success") this._on = (id) => fn({ code: String(id), device_id: "dev" });
        return this;
      }
    },
  };
  // VP_BLUEPRINTS намеренно не трогаем: песочница должна идти тем же путём,
  // что и боевая админка, — теперь через таблицу `tournament_blueprints`,
  // она в стабе засеяна (см. выше). Путь через служебную строку в rooms
  // остался только в истории общей с Дойлом базы.

  // Наружу из песочницы ничего не уходит: любой запрос — явная ошибка, чтобы
  // забытый вызов не постучался в боевую базу. Отчёт теперь ложится в
  // localStorage вместе с остальными таблицами, edge-функций не осталось.
  window.sbFetchFailover = async (input) => {
    const url = typeof input === "string" ? input : input?.url || "";
    throw new Error(`dev: запрос наружу заблокирован (${url})`);
  };
  window.syncServerClock = async () => { window.__serverClockOffsetMs = 0; return true; };

  // ── Плашка ─────────────────────────────────────────────────────────────────
  const banner = () => {
    const el = document.createElement("div");
    el.textContent = "DEV — локальная песочница, боевая база не подключена";
    el.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#b3261e;color:#fff;" +
      "font:600 12px/1.6 system-ui,sans-serif;letter-spacing:.06em;text-align:center;padding:4px 8px;text-transform:uppercase";
    el.title = "Выключить: ?dev=0 · сбросить данные: localStorage.removeItem('vp_dev_db')";
    document.body.appendChild(el);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", banner);
  else banner();

  readDb();
  console.info("[dev] песочница активна. Выключить: ?dev=0 · сброс данных: localStorage.removeItem('vp_dev_db')");
})();
