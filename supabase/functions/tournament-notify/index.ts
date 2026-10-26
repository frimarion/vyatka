// Уведомления в служебную Telegram-группу «Вятки» — по аналогии с эдж-функцией
// tournament-announcement у Дойла, под свою (более простую) схему: без city,
// без source регистрации, без поста в публичном канале — черновик уходит в
// группу текстом, публикует его руками админ.
//
// action=notify  — на каждую запись/отмену (дёргает trg_admin_notify_on_reg_change
//                  из migrations/012_tg_admin_notify.sql).
// action=prepare — раз в день по внешнему cron (см. deploy/README.md), утренний
//                  черновик поста с текущим списком записавшихся.
// action=publish — в день турнира в 15:00 МСК по внешнему cron: пост со списком
//                  участников в канал клуба (migrations/031_tg_channel_post.sql).
//                  Дальше notify правит этот пост при каждой записи/отмене.

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

// "Воскресенье" — с большой буквы, как в шапке гостевого списка.
function weekdayName(dateIso: string): string {
  const s = new Date(dateIso).toLocaleDateString("ru-RU", { weekday: "long", timeZone: TZ });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// "20 сентября" — родительный падеж месяца достаёт сам Intl.
function formatDayMonth(dateIso: string): string {
  return new Date(dateIso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: TZ });
}

async function dbWrite(method: string, path: string, body?: unknown, prefer = "return=representation") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json", "Prefer": prefer,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`DB error: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
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
    `registrations?tournament_id=eq.${tournamentId}&status=eq.registered&select=players(name)&order=created_at.asc,id.asc`
  );
  return (regs ?? []).map((r: any) => ({ name: r.players?.name ?? "—" }));
}

function fmtInt(n: number): string {
  return new Intl.NumberFormat("ru-RU").format(n);
}

// Стиль — гостевой список клуба, а не сухая карточка турнира: заголовок дня,
// особенности турнира буллетами, дальше список записавшихся цитатой
// (<blockquote>, Telegram отрисовывает её полосой сбоку — как у гостевых
// списков в других клубах) и ссылка на приложение вместо голого URL.
//
// Буллеты — из двух источников, оба правятся в tournaments.html: взнос
// (entry_fee — not null, всегда есть) и start_stack/late_reg_level/
// level_minutes — отдельные колонки карточки турнира, дальше свободный текст
// из features (поле "Особенности"). Реентри отдельной колонки не заводили —
// это описывается текстом в features или description, готовых данных для
// авто-строки про реентри нет. Пустое поле — это просто нет строки, а не
// "0" или прочерк.
//
// Возвращает готовый HTML: имена и название турнира экранированы по месту,
// поэтому весь результат уходит в sendMessage как есть, без escHtml() сверху —
// иначе <blockquote> и <a> превратились бы обратно в текст.
function buildDraftHtml(
  t: {
    name: string; date: string; entry_fee: number; slots: number | null;
    start_stack?: number | null; late_reg_level?: number | null; level_minutes?: number | null;
    features?: unknown;
  },
  players: { name: string }[],
): string {
  const details: string[] = [];
  details.push(`💰 Взнос — ${t.entry_fee ? `${fmtInt(t.entry_fee)} ₽` : "бесплатно"}`);
  if (t.start_stack) details.push(`♦️ Стартовый стек — ${escHtml(fmtInt(t.start_stack))} фишек`);
  if (t.late_reg_level) details.push(`♦️ Поздняя регистрация до ${t.late_reg_level} уровня`);
  if (t.level_minutes) details.push(`♦️ Уровни по ${t.level_minutes} мин`);
  if (Array.isArray(t.features)) {
    (t.features as string[]).forEach((f) => details.push(`♦️ ${escHtml(f)}`));
  }

  const lines = [
    "📋 Список записавшихся — клуб «Вятка»! ♠️",
    "",
    `${escHtml(weekdayName(t.date))}, ${escHtml(formatDayMonth(t.date))}, начало в ${escHtml(formatTime(t.date))}`,
    "Сбор — за полчаса до старта",
    "",
    `🏆 ${escHtml(t.name)} 🏆`,
    "",
    ...details,
    "",
    "Участники:",
  ];

  const playerLines = players.length
    ? players.map((p, i) => `${i + 1}. ${escHtml(p.name)}`).join("\n")
    : "(пока никто не записался)";
  lines.push(`<blockquote>${playerLines}</blockquote>`);

  if (t.slots && players.length >= t.slots) {
    lines.push("Мест больше нет — все заняты ✔️");
  } else if (t.slots) {
    lines.push(`Свободно мест: ${Math.max(0, t.slots - players.length)}`);
  }
  lines.push(
    "",
    'Записаться — в <a href="https://vyatkapoker.ru/">приложении «Вятка»</a>',
    "",
    "Ждём вас,",
    "Команда клуба «Вятка» ♠️",
  );
  return lines.join("\n");
}

// ── Пост в канале ───────────────────────────────────────────────────────────

const CHANNEL_PUBLISH_HOUR_MSK = 15;
const TOURNAMENT_COLS = "id,name,date,status,slots,late_reg_level,level_minutes,room_id,is_monthly_final";

function mskDayKey(iso: string | Date): string {
  return new Date(new Date(iso).getTime() + MSK_OFFSET).toISOString().slice(0, 10);
}
const isTodayMsk = (iso: string) => mskDayKey(iso) === mskDayKey(new Date());

// Конец поздней регистрации — конец уровня late_reg_level, как считает и
// приложение (VP.lateRegRemainingSec): перерывы до него входят во время. Если
// у турнира уже есть комната, берём её структуру уровней — там и перерывы, и
// правки админа; нет — уровень × длительность. Округляем вверх до 5 минут:
// «до 21:40» читается лучше, чем «до 21:39».
async function lateRegEnd(t: any): Promise<Date | null> {
  if (!t.date) return null;
  let lvl = Number(t.late_reg_level) || 0;
  let minutes = 0;
  if (t.room_id) {
    try {
      const rows = await dbFetch(`rooms?room_id=eq.${encodeURIComponent(t.room_id)}&select=state&limit=1`);
      const st = rows?.[0]?.state;
      const levels = Array.isArray(st?.structure?.levels) ? st.structure.levels : [];
      lvl = Number(st?.tournament?.lateRegUntilLevel) || lvl;
      if (lvl && levels.length) {
        let played = 0;
        for (const l of levels) {
          minutes += Number(l?.min) || 0;
          if (!l?.isBreak && ++played >= lvl) break;
        }
      }
    } catch (_) { minutes = 0; }
  }
  if (!minutes && lvl && t.level_minutes) minutes = lvl * Number(t.level_minutes);
  if (!minutes) return null;
  const step = 5 * 60 * 1000;
  return new Date(Math.ceil((new Date(t.date).getTime() + minutes * 60000) / step) * step);
}

async function buildChannelHtml(t: any, players: { name: string }[]): Promise<string> {
  const end = await lateRegEnd(t);
  const lines = [
    `<b>ТУРНИР СЕГОДНЯ ( ${escHtml(formatDayMonth(t.date))} )</b>`,
    `Начало ${formatTime(t.date)}` + (end ? ` поздняя регистрация ДО ${formatTime(end.toISOString())}` : ""),
    "",
    "Предварительный состав участников:",
    "",
    players.length
      ? players.map((p, i) => `${i + 1}. ${escHtml(p.name)}`).join("\n")
      : "Пока никого — будь первым!",
    "",
    "",
    t.slots && players.length >= t.slots
      ? "<b>МЕСТ БОЛЬШЕ НЕТ</b> ♠️♥️♣️♦️"
      : "<b>ПРИСОЕДИНЯЙТЕСЬ ЕСТЬ СВОБОДНЫЕ МЕСТА</b> ♠️♥️♣️♦️",
    "",
    "",
    "📱 Для записи пишите:",
    "• В сообщения @maks9228",
    "• В комментариях ставьте «+»",
  ];
  return lines.join("\n");
}

async function channelId(): Promise<string | null> {
  const rows = await dbFetch(`_app_config?key=eq.tg_channel_id&select=value&limit=1`);
  return rows?.[0]?.value || null;
}

// Публикует пост (create) или приводит уже опубликованный к текущему списку.
// Запись и отмена могут прийти почти одновременно, и правка по старому списку
// может доехать до Telegram позже свежей. Поэтому после правки список читаем
// ещё раз и, если он успел измениться, правим снова — последний вызов всегда
// оставляет в канале актуальный состав.
async function syncChannelPost(t: any, create: boolean) {
  const chatId = await channelId();
  if (!chatId || !t?.date || !isTodayMsk(t.date)) return { skipped: true };

  let post = (await dbFetch(`tg_channel_posts?tournament_id=eq.${t.id}&select=*&limit=1`))?.[0];
  if (!post) {
    if (!create) return { skipped: true };
    // Сначала «занимаем» строку: unique по tournament_id не даст второму
    // одновременному вызову опубликовать дубль.
    const claimed = await dbWrite(
      "POST", "tg_channel_posts?on_conflict=tournament_id",
      { tournament_id: t.id, chat_id: chatId },
      "resolution=ignore-duplicates,return=representation",
    );
    if (!claimed?.length) return { skipped: "claimed" };
    const text = await buildChannelHtml(t, await getPlayers(t.id));
    const res = await tgRequest("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
    if (!res.ok) {
      await dbWrite("DELETE", `tg_channel_posts?tournament_id=eq.${t.id}`, undefined, "return=minimal");
      throw new Error("Telegram error: " + JSON.stringify(res));
    }
    await dbWrite("PATCH", `tg_channel_posts?tournament_id=eq.${t.id}`,
      { message_id: res.result.message_id, text, updated_at: new Date().toISOString() }, "return=minimal");
    post = { message_id: res.result.message_id, chat_id: chatId, text };
  }
  // Пост ещё публикуется соседним вызовом — он же и подхватит наш список.
  if (!post.message_id) return { skipped: "publishing" };

  let last = post.text;
  for (let i = 0; i < 3; i++) {
    const text = await buildChannelHtml(t, await getPlayers(t.id));
    if (text === last) break;
    const res = await tgRequest("editMessageText", {
      chat_id: post.chat_id, message_id: post.message_id, text, parse_mode: "HTML",
    });
    if (!res.ok && !/not modified/i.test(res.description || "")) {
      throw new Error("Telegram error: " + JSON.stringify(res));
    }
    await dbWrite("PATCH", `tg_channel_posts?tournament_id=eq.${t.id}`,
      { text, updated_at: new Date().toISOString() }, "return=minimal");
    last = text;
  }
  return { ok: true, message_id: post.message_id };
}

async function publish() {
  const { start, end } = todayBoundsUTC();
  const tournaments = await dbFetch(
    `tournaments?status=neq.past&status=neq.cancelled&date=gte.${start}&date=lte.${end}&order=date.asc&select=${TOURNAMENT_COLS}`
  );
  const results = [];
  for (const t of tournaments ?? []) results.push({ tournament_id: t.id, ...(await syncChannelPost(t, true)) });
  return { ok: true, results };
}

async function prepare() {
  const { start, end } = todayBoundsUTC();
  const tournaments = await dbFetch(
    `tournaments?status=neq.past&status=neq.cancelled&date=gte.${start}&date=lte.${end}&order=date.asc&limit=1`
  );
  if (!tournaments || tournaments.length === 0) return { ok: true, message: "No tournament today" };

  const t = tournaments[0];
  const players = await getPlayers(t.id);
  const draft = buildDraftHtml(t, players);
  const notice =
    `📋 <b>Черновик поста — турнир #${t.id}</b>\n\n` +
    "Скопируйте текст, добавьте фото и опубликуйте — автопубликации здесь нет.\n\n" +
    draft;

  const tgRes = await tgRequest("sendMessage", { chat_id: TG_ADMIN_CHAT_ID, text: notice, parse_mode: "HTML" });
  if (!tgRes.ok) throw new Error("Telegram error: " + JSON.stringify(tgRes));
  return { ok: true, tournament_id: t.id, players_count: players.length };
}

async function notify(tournamentId: number, playerId: number, opType: string) {
  const playersRes = await dbFetch(`players?id=eq.${playerId}&select=name&limit=1`);
  const playerName = playersRes?.[0]?.name ?? "Неизвестный";

  const tournamentsRes = await dbFetch(`tournaments?id=eq.${tournamentId}&select=${TOURNAMENT_COLS}&limit=1`);
  if (!tournamentsRes || tournamentsRes.length === 0) throw new Error(`Tournament ${tournamentId} not found`);
  const t = tournamentsRes[0];

  // Пост в канале правим независимо от сообщения в служебную группу: сбой
  // одного не должен оставлять устаревшим другое. Если пост ещё не вышел, а
  // 15:00 уже было (cron не сработал или турнир завели днём) — публикуем сразу.
  let channel: unknown = null;
  try {
    const lateEnough = nowInMsk().getUTCHours() >= CHANNEL_PUBLISH_HOUR_MSK;
    if (t.status !== "cancelled") channel = await syncChannelPost(t, lateEnough);
  } catch (e) {
    console.error("[tournament-notify] channel:", (e as Error).message);
    channel = { error: (e as Error).message };
  }

  // SILENT — запись финала поменял сам админ: пост в канале поправили,
  // писать в группу о его же действии незачем.
  if (opType === "SILENT") return { ok: true, channel, silent: true };

  const dateStr = t.date ? formatDate(t.date) : "";
  // У финала месяца запись — это подтверждение участия (migrations/033).
  const verb = opType === "DECLINE"
    ? "отказался(лась) от участия в финале.\nПримите отказ или верните игрока: «Расписание» → «Записались»."
    : t.is_monthly_final
      ? (opType === "CANCEL" ? "снял(а) подтверждение участия в финале" : "подтвердил(а) участие в финале")
      : (opType === "CANCEL" ? "отменил(а) регистрацию" : "зарегистрировался(лась)");
  const text = `${opType === "DECLINE" ? "⚠️ " : ""}<b>${escHtml(t.name)}</b> ${dateStr}\n${escHtml(playerName)} ${verb}`;

  const tgRes = await tgRequest("sendMessage", { chat_id: TG_ADMIN_CHAT_ID, text, parse_mode: "HTML" });
  if (!tgRes.ok) throw new Error("Telegram error: " + JSON.stringify(tgRes));
  return { ok: true, channel };
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
    else if (body.action === "publish") result = await publish();
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
