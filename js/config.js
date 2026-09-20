// RKN/TSPU throttles cloud IPs in a fluctuating way — sometimes the Timeweb origin,
// sometimes the Cloudflare edge. We keep TWO independent paths to the same backend and
// fail over to whichever responds right now. The last working host is remembered.
window.SUPABASE_HOSTS = [
  "https://r.doylepoker.ru",     // reg.ru relay on a clean (un-throttled) network — primary
  "https://api.doylepoker.ru",   // direct Timeweb origin — fallback
  "https://gw.doylepoker.ru"     // same backend, fronted by Cloudflare — fallback
];
window.SUPABASE_URL = (() => {
  try { const s = localStorage.getItem('doyle_sb_host2'); if (window.SUPABASE_HOSTS.includes(s)) return s; } catch(_){}
  return window.SUPABASE_HOSTS[0];
})();
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzEzMjI1NjAwLCJleHAiOjE4Njg5OTIwMDB9.JEHfDm5ghdB_UgORrAXZzjcT8TFdecTPs88C77sm5MA";

// ── Карта таблиц ──────────────────────────────────────────────────────────────
// Вятка переезжает на собственный Supabase-проект: пока часть таблиц ещё
// дойловская (общая инсталляция), после переезда здесь меняются только имена.
// Пока комнаты Вятки лежат в общей с Дойлом таблице, их отбирают по branch.
// В собственном проекте комнаты только свои — поставь null, и фильтр отключится.
window.VP_ROOMS_BRANCH = "VYATKA";

window.VP_TABLES = {
  rooms: "rooms",
  profiles: "profiles",
  operators: "tournament_operators",
  tournaments: "doyle_tournaments",
  registrations: "doyle_registrations",
  players: "doyle_players",
};

// ── Макеты турниров ──────────────────────────────────────────────────────────
// Два хранилища, одно на переходный период.
//
// Сейчас: служебная строка в общей таблице rooms под своим branch. Туда Вятка
// уже пишет и имеет права, дойловскую схему трогать не надо. Строка не комната:
// из списка комнат она отфильтрована по id.
window.VP_BLUEPRINTS_ROOM = "__BP__";

// После переезда: собственная таблица (migrations/003_blueprints.sql). Ставится
// вместе с остальными настройками ниже, и тогда служебная строка игнорируется.
// Именно null, а не "tournament_blueprints": в общей с Дойлом инсталляции такая
// таблица есть, но лежат в ней дойловские форматы, и Вятка показала бы чужие.
window.VP_BLUEPRINTS = null;

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
      if (base !== window.SUPABASE_URL) { window.SUPABASE_URL = base; try { localStorage.setItem('doyle_sb_host2', base); } catch(_){} }
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
