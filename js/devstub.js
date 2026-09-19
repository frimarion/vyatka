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

  function seed() {
    const players = NAMES.map((name, i) => ({ id: 100 + i, name }));
    const tomorrow = new Date(Date.now() + 864e5);
    return {
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
    in(f, vs) { const s = new Set(vs.map(String)); this.filters.push((r) => s.has(String(r[f]))); return this; }
    is(f, v) { this.filters.push((r) => (v === null ? r[f] == null : r[f] === v)); return this; }
    gte(f, v) { this.filters.push((r) => String(r[f]) >= String(v)); return this; }
    order(f, o) { this._order = { f, asc: o?.ascending !== false }; return this; }
    limit(n) { this._limit = n; return this; }
    maybeSingle() { this._single = true; return this; }
    single() { this._single = true; return this; }
    insert(row) { this.op = { kind: "insert", row }; return this; }
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

  // Наружу из песочницы ничего не уходит: отчёт в таблицу подтверждаем сами,
  // остальное — явная ошибка, чтобы забытый вызов не постучался в боевую базу.
  window.sbFetchFailover = async (input) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("/functions/v1/gsheets-proxy")) {
      console.info("[dev] отчёт в таблицу не отправлен — песочница");
      return new Response(JSON.stringify({ ok: true, dev: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
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
