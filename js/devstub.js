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
  const dk = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

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
        tournament_id: null, name: t % 3 === 1 ? "ПКО среда" : "Вечерний фриз-аут",
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

  function seed() {
    const players = NAMES.map((name, i) => ({ id: 100 + i, name, full_name: `${name}, Киров` }));
    // Латиницей — чтобы транслит-поиск было на чём проверить
    players.push({ id: 90, name: "Petr Shabalin", full_name: "Пётр Шабалин, Слободской" });
    const tomorrow = new Date(Date.now() + 864e5);
    const past = seedResults(players);
    return {
      tournament_results: past.results,
      tournament_result_players: past.resultPlayers,
      profiles: [
        { id: "dev-admin", email: "admin@vyatka.local", role: "admin" },
        { id: "dev-operator", email: "operator@vyatka.local", role: "operator" },
      ],
      players,
      tournaments: [
        { id: 1, name: "Вечерний фриз-аут", date: dk(today), status: "open", entry_fee: 1000, room_id: null, registered_count: 8 },
        { id: 2, name: "ПКО среда", date: dk(tomorrow), status: "draft", entry_fee: 1500, room_id: null, registered_count: 0 },
      ],
      // восьмеро уже записались на сегодняшний — есть что импортировать
      registrations: players.slice(0, 8).map((p, i) => ({
        id: 200 + i, tournament_id: 1, player_id: p.id,
        created_at: new Date(Date.now() - (8 - i) * 6e4).toISOString(),
      })),
      tournament_operators: [],
      rooms: [],
      // Макеты: те же три, что в migrations/003_blueprints.sql, но короткими
      // лестницами — песочнице важно, что грузится из «базы», а не сама сетка.
      tournament_blueprints: [
        { id: 1, name: "Вятский Дейли", start_stack: 30000, late_reg_until_level: 9, default_buy_in: 1000, sort_order: 1,
          levels: [{min:16,sb:100,bb:100,anteMode:"BB"},{min:16,sb:100,bb:200,anteMode:"BB"},
                   {isBreak:true,min:15,label:"Перерыв"},{min:16,sb:200,bb:400,anteMode:"BB"}] },
        { id: 2, name: "Турбо", start_stack: 20000, late_reg_until_level: 6, default_buy_in: 1000, sort_order: 2,
          levels: [{min:10,sb:100,bb:100,anteMode:"BB"},{min:10,sb:100,bb:200,anteMode:"BB"},
                   {isBreak:true,min:10,label:"Перерыв"},{min:10,sb:200,bb:400,anteMode:"BB"}] },
        { id: 3, name: "Глубокий стек", start_stack: 50000, late_reg_until_level: 12, default_buy_in: 2000, sort_order: 3,
          levels: [{min:20,sb:100,bb:100,anteMode:"BB"},{min:20,sb:100,bb:200,anteMode:"BB"},
                   {isBreak:true,min:15,label:"Перерыв"},{min:20,sb:200,bb:400,anteMode:"BB"}] },
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

    _run() {
      const db = readDb();
      const rows = (db[this.table] = db[this.table] || []);
      const hit = (r) => this.filters.every((f) => f(r));

      if (this.op.kind === "insert") {
        const list = Array.isArray(this.op.row) ? this.op.row : [this.op.row];
        for (const row of list) {
          const dup = this.table === "rooms" && rows.some((r) => r.room_id === row.room_id);
          if (dup) return { data: null, error: { message: "duplicate key value violates unique constraint" } };
          rows.push({ id: row.id ?? Date.now() + Math.floor(Math.random() * 1000), ...row });
        }
        writeDb(db);
        return { data: list, error: null };
      }
      if (this.op.kind === "upsert") {
        const list = Array.isArray(this.op.row) ? this.op.row : [this.op.row];
        const key = this.op.onConflict || "id";
        const saved = list.map((row) => {
          const old = rows.find((r) => String(r[key]) === String(row[key]));
          if (old) { Object.assign(old, row); return old; }
          const fresh = { id: Date.now() + Math.floor(Math.random() * 1000), ...row };
          rows.push(fresh);
          return fresh;
        });
        writeDb(db);
        const copy = saved.map((r) => ({ ...r }));
        return this._single ? { data: copy[0] || null, error: null } : { data: copy, error: null };
      }
      if (this.op.kind === "update") {
        const touched = rows.filter(hit);
        touched.forEach((r) => Object.assign(r, this.op.patch));
        writeDb(db);
        touched.forEach((r) => bus?.postMessage({ kind: "pg", table: this.table, new: JSON.parse(JSON.stringify(r)) }));
        return { data: touched, error: null };
      }
      if (this.op.kind === "delete") {
        db[this.table] = rows.filter((r) => !hit(r));
        writeDb(db);
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
    },
  };

  window.supabase = { createClient: () => client };
  // VP_BLUEPRINTS намеренно не трогаем: песочница должна идти тем же путём,
  // что и боевая админка, — через служебную строку в rooms.

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
