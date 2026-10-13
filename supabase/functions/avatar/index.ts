// Своя аватарка игрока (migrations/030_custom_avatars.sql).
//
// POST   — тело: JPEG как есть (приложение уже ужало и обрезало его в квадрат),
//          заголовок x-vp-token — токен сессии игрока. Ответ: { photo_url }.
// DELETE — убрать своё фото (photo_url = null), тот же заголовок.
//
// Через функцию, а не напрямую в Storage: у игроков нет JWT GoTrue, только наш
// токен сессии, и проверить его может только база.

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// SUPABASE_URL внутри контейнера — адрес шлюза в docker-сети, браузеру он не
// годится. Ссылка в photo_url должна открываться у всех.
const PUBLIC_URL = (Deno.env.get("SUPABASE_PUBLIC_URL") || "https://api.vyatkapoker.ru").replace(/\/+$/, "");

const BUCKET = "avatars";
const MAX_BYTES = 512 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-vp-token",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

const svc = { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` };

async function rpc(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { ...svc, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `rpc ${name}: ${res.status}`);
  return text ? JSON.parse(text) : null;
}

// Старый файл удаляем, только если он наш: ссылка VK/TG сюда тоже приходит.
async function dropOld(url: unknown) {
  const mark = `/storage/v1/object/public/${BUCKET}/`;
  if (typeof url !== "string" || !url.includes(mark)) return;
  const name = decodeURIComponent(url.split(mark)[1].split("?")[0]);
  if (!/^[\w.-]+$/.test(name)) return;
  await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${name}`, { method: "DELETE", headers: svc })
    .catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST" && req.method !== "DELETE") return json({ error: "method_not_allowed" }, 405);

  let playerId: number;
  try {
    playerId = Number(await rpc("vp_avatar_session", { p_token: req.headers.get("x-vp-token") || "" }));
    if (!playerId) throw new Error("not_authorized");
  } catch (_) {
    return json({ error: "not_authorized" }, 401);
  }

  try {
    if (req.method === "DELETE") {
      await dropOld(await rpc("vp_avatar_set", { p_player_id: playerId, p_url: null }));
      return json({ photo_url: null });
    }

    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.length < 512) return json({ error: "avatar_bad_image" }, 400);
    if (buf.length > MAX_BYTES) return json({ error: "avatar_too_big" }, 413);
    // Только JPEG: приложение всегда перекодирует через canvas, остальное — не от него.
    if (buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) return json({ error: "avatar_bad_image" }, 400);

    // Имя новое каждый раз: под старым его закешировали браузеры, а CDN-кеш
    // на год нам как раз и нужен.
    const name = `${playerId}-${Date.now().toString(36)}.jpg`;
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${name}`, {
      method: "POST",
      headers: { ...svc, "Content-Type": "image/jpeg", "Cache-Control": "max-age=31536000" },
      body: buf,
    });
    if (!up.ok) throw new Error(`storage: ${up.status} ${await up.text()}`);

    const url = `${PUBLIC_URL}/storage/v1/object/public/${BUCKET}/${name}`;
    await dropOld(await rpc("vp_avatar_set", { p_player_id: playerId, p_url: url }));
    return json({ photo_url: url });
  } catch (e) {
    console.error("[avatar]", e);
    return json({ error: "avatar_failed" }, 500);
  }
});
