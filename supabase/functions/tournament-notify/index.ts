// Уведомления в служебную Telegram-группу «Вятки» — по аналогии с эдж-функцией
// tournament-announcement у Дойла, под свою (более простую) схему: без city,
// без source регистрации, без поста в публичном канале — черновик уходит в
// группу текстом, публикует его руками админ.
//
// action=notify  — на каждую запись/отмену (дёргает trg_admin_notify_on_reg_change
//                  из migrations/012_tg_admin_notify.sql).
// action=prepare — раз в день по внешнему cron (см. deploy/README.md), утренний
//                  черновик поста с текущим списком записавшихся.

const BOT_TOKEN            = Deno.env.get("BOT_TOKEN")!;
const TG_ADMIN_CHAT_ID     = Deno.env.get("TG_ADMIN_CHAT_ID")!;
const CRON_SECRET          = Deno.env.get("CRON_SECRET")!;
const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TZ = "Europe/Moscow";
const MSK_OFFSET = 3 * 60 * 60 * 1000;

function nowInMsk(): Date { return new Date(Date.now() + MSK_OFFSET); }

function todayBoundsUTC() {
  const msk = nowInMsk();
  const y = msk.getUTCFullYear(), m = msk.getUTCMonth(), d = msk.getUTCDate();
  return {
    start: new Date(Date.UTC(y, m, d, 0,  0,  0,   0) - MSK_OFFSET).toISOString(),
    end:   new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - MSK_OFFSET).toISOString(),
  };
}

function formatTime(dateIso: string): string {
  return new Date(dateIso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
}

async function dbFetch(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`, "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`DB error: ${res.status} ${await res.text()}`);
  return res.json();
}

// Тот же прокси, что у Дойла — он просто зеркалит api.telegram.org по пути
// /bot<token>/<method>, токен ему не важен. Нужен потому, что api.telegram.org
// из России бьётся нестабильно.
const TG_API = "https://tg-proxy.fr34m1337.workers.dev";

async function tgRequest(method: string, body: Record<string, unknown>) {
  const res = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return res.json();
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function getPlayers(tournamentId: number) {
  const regs = await dbFetch(
    `registrations?tournament_id=eq.${tournamentId}&status=eq.registered&select=players(name)`
  );
  return (regs ?? []).map((r: any) => ({ name: r.players?.name ?? "—" }));
}

function buildDraft(t: { name: string; date: string; entry_fee: number; slots: number | null }, players: { name: string }[]): string {
  const lines = [
    `ТУРНИР СЕГОДНЯ, ${formatTime(t.date)}`,
    t.name,
    `Взнос: ${t.entry_fee} ₽`,
    "",
    "Предварительный состав участников:",
    "",
  ];
  players.forEach((p, i) => lines.push(`${i + 1}. ${p.name}`));
  if (players.length === 0) lines.push("(пока никто не записался)");
  if (t.slots) lines.push("", `Мест: ${t.slots}, свободно: ${Math.max(0, t.slots - players.length)}`);
  lines.push("", "Запись — в приложении «Вятка»: https://vyatkapoker.ru/");
  return lines.join("\n");
}

async function prepare() {
  const { start, end } = todayBoundsUTC();
  const tournaments = await dbFetch(
    `tournaments?status=neq.past&status=neq.cancelled&date=gte.${start}&date=lte.${end}&order=date.asc&limit=1`
  );
  if (!tournaments || tournaments.length === 0) return { ok: true, message: "No tournament today" };

  const t = tournaments[0];
  const players = await getPlayers(t.id);
  const draft = buildDraft(t, players);
  const notice =
    `📋 <b>Черновик поста — турнир #${t.id}</b>\n\n` +
    "Скопируйте текст, добавьте фото и опубликуйте — автопубликации здесь нет.\n\n" +
    escHtml(draft);

  const tgRes = await tgRequest("sendMessage", { chat_id: TG_ADMIN_CHAT_ID, text: notice, parse_mode: "HTML" });
  if (!tgRes.ok) throw new Error("Telegram error: " + JSON.stringify(tgRes));
  return { ok: true, tournament_id: t.id, players_count: players.length };
}

async function notify(tournamentId: number, playerId: number, opType: string) {
  const playersRes = await dbFetch(`players?id=eq.${playerId}&select=name&limit=1`);
  const playerName = playersRes?.[0]?.name ?? "Неизвестный";

  const tournamentsRes = await dbFetch(`tournaments?id=eq.${tournamentId}&select=name,date&limit=1`);
  if (!tournamentsRes || tournamentsRes.length === 0) throw new Error(`Tournament ${tournamentId} not found`);
  const t = tournamentsRes[0];

  const dateStr = t.date ? formatDate(t.date) : "";
  const verb = opType === "CANCEL" ? "отменил(а) регистрацию" : "зарегистрировался(лась)";
  const text = `<b>${escHtml(t.name)}</b> ${dateStr}\n${escHtml(playerName)} ${verb}`;

  const tgRes = await tgRequest("sendMessage", { chat_id: TG_ADMIN_CHAT_ID, text, parse_mode: "HTML" });
  if (!tgRes.ok) throw new Error("Telegram error: " + JSON.stringify(tgRes));
  return { ok: true };
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== "Bearer " + CRON_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  let body: { action: string; tournament_id?: number; player_id?: number; op_type?: string };
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } }); }

  try {
    let result;
    if (body.action === "prepare") result = await prepare();
    else if (body.action === "notify" && body.tournament_id && body.player_id) {
      result = await notify(body.tournament_id, body.player_id, body.op_type ?? "INSERT");
    }
    else return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    const err = e as Error;
    console.error("[tournament-notify]", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
