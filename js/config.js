// Пока путь один: собственный origin на своём VPS. У Дойла запасных хостов
// три, и появились они не от хорошей жизни — по одному на каждый случай, когда
// ТСПУ придушил очередной адрес. Вятке второй путь тоже понадобится, но
// заводить его имеет смысл, когда основной поработает и станет видно, где
// именно рвётся; список и failover ниже к этому уже готовы.
window.SUPABASE_HOSTS = [
  "https://api.vyatkapoker.ru"   // свой Supabase, nginx → Kong на 127.0.0.1:8000
];
window.SUPABASE_URL = (() => {
  try { const s = localStorage.getItem('vp_sb_host'); if (window.SUPABASE_HOSTS.includes(s)) return s; } catch(_){}
  return window.SUPABASE_HOSTS[0];
})();
// ANON_KEY из `node deploy/gen-keys.mjs` — тот же, что уехал в /opt/vyatka/.env.
// Ключ публичный по назначению: он уходит в браузер каждому игроку, и всё, что
// им можно, ограничено RLS. Секретный — SERVICE_ROLE_KEY, он живёт только на
// сервере и в репозиторий не попадает никогда.
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg5OTQ1MzM3LCJleHAiOjIxMDUzMDUzMzd9.oV8xwj1bBXYc6DwH_9GfmPRiIGd6BtNMoCy4dTS72uI";
if (window.SUPABASE_ANON_KEY.indexOf("PASTE_") === 0) {
  // Иначе первый же запрос падает с невнятным 401, и полчаса уходит на поиск
  // опечатки там, где ключ просто не вставили.
  console.error("[vyatka] SUPABASE_ANON_KEY не заполнен — см. deploy/README.md, шаг 2");
}

// ── Карта таблиц ──────────────────────────────────────────────────────────────
// Переезд состоялся: инсталляция своя, имена таблиц свои — те, что заводит
// migrations/001_init.sql. Префикс doyle_ остался в истории вместе с общей базой.
//
// branch отделял вятские комнаты от дойловских в общей таблице rooms. В своей
// базе чужих комнат нет, колонки branch тоже нет — null выключает фильтр.
window.VP_ROOMS_BRANCH = null;

window.VP_TABLES = {
  rooms: "rooms",
  profiles: "profiles",
  operators: "tournament_operators",
  tournaments: "tournaments",
  registrations: "registrations",
  players: "players",
  // Итоги турниров — хранилище CRM (migrations/004_results.sql).
  results: "tournament_results",
  resultPlayers: "tournament_result_players",
};

// ── Макеты турниров ──────────────────────────────────────────────────────────
// Своя таблица (migrations/003_blueprints.sql). Пока таблицы Вятки не было,
// макеты жили служебной строкой в общей rooms — этот путь в админке ещё
// поддержан, но включается только через VP_BLUEPRINTS_ROOM, и здесь он выключен.
window.VP_BLUEPRINTS = "tournament_blueprints";
window.VP_BLUEPRINTS_ROOM = null;

// Drop-in fetch for supabase-js: createClient(url, key, { global: { fetch: window.sbFetchFailover } }).
// Tries the current host, fails over to the other on a timeout / connection error, swapping the
// host in the request URL. The whole BODY is read under the timeout (the throttle slows the body,
// not the headers), then handed back as a buffered Response so the SDK never re-reads a slow stream.
// ── Server clock sync ─────────────────────────────────────────────────────────
// levelEndAt в rooms.state — абсолютный timestamp, записанный часами админского
// устройства; дисплей считает остаток своими часами. Сбитые на десятки секунд часы
// ТВ/мини-ПК напрямую искажают таймер уровня. Оцениваем offset (server − local)
// через RPC server_time_ms с поправкой на RTT/2 и отдаём скорректированное время.
window.__serverClockOffsetMs = 0;
window.serverNowMs = function(){ return Date.now() + window.__serverClockOffsetMs; };
window.syncServerClock = async function(){
  try{
    const t0 = Date.now();
    const resp = await window.sbFetchFailover(window.SUPABASE_URL + '/rest/v1/rpc/server_time_ms', {
      method: 'POST',
      headers: { 'apikey': window.SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + window.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: '{}'
    });
    const t1 = Date.now();
    if (!resp.ok) return false;
    const rtt = t1 - t0;
    if (rtt > 5000) return false;                 // слишком шумное измерение — не доверяем
    const serverMs = Number(await resp.text());
    if (!Number.isFinite(serverMs) || serverMs < 1000000000000) return false;
    window.__serverClockOffsetMs = serverMs - (t0 + rtt / 2);
    return true;
  }catch(_){ return false; }
};

window.sbFetchFailover = async function(input, init) {
  init = init || {};
  const urlStr = (typeof input === 'string') ? input : (input && input.url) || '';
  const curHost = window.SUPABASE_HOSTS.find(h => urlStr.indexOf(h) === 0);
  if (!curHost) return fetch(input, init);            // not one of our hosts — passthrough
  const path = urlStr.slice(curHost.length);
  const method = (init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
  const isWrite = method !== 'GET' && method !== 'HEAD';
  const timeoutMs = isWrite ? 15000 : 6000;
  const order = [window.SUPABASE_URL, ...window.SUPABASE_HOSTS.filter(h => h !== window.SUPABASE_URL)];
  let lastErr;
  for (let i = 0; i < order.length; i++) {
    const base = order[i];
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(base + path, { ...init, signal: ctrl.signal });
      const buf = await resp.arrayBuffer();           // read body under the same timeout
      clearTimeout(t);
      const h = new Headers(resp.headers);
      h.delete('content-encoding'); h.delete('content-length');  // body is already decoded
      if (base !== window.SUPABASE_URL) { window.SUPABASE_URL = base; try { localStorage.setItem('vp_sb_host', base); } catch(_){} }
      // Null-body statuses (204/205/304/101/103) forbid ANY body — even an empty buffer throws
      // "Response with null body status cannot have body". PostgREST returns 204 on writes.
      const nullBody = [101, 103, 204, 205, 304].includes(resp.status);
      return new Response(nullBody ? null : buf, { status: resp.status, statusText: resp.statusText, headers: h });
    } catch(e) {
      clearTimeout(t);
      lastErr = e;
      const isAbort = e && e.name === 'AbortError';   // our timeout fired (throttled/hung)
      const isNetwork = e instanceof TypeError;        // never connected (blocked / DNS)
      if (!isAbort && !isNetwork) throw e;             // real HTTP/business error — authoritative
      if (isWrite && isAbort) throw e;                 // never retry a write that timed out mid-flight
      // else: try the next host
    }
  }
  throw lastErr || new Error('all_endpoints_unreachable');
};
