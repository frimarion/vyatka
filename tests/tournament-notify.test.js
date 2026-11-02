// Проверяет рабочую Edge Function без отправки сообщений в Telegram.
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const A = require('node:assert/strict');
const source = readFileSync(require('node:path').join(__dirname, '../supabase/functions/tournament-notify/index.ts'), 'utf8');
const ctx = vm.createContext({ console });
// Исполняем сам обработчик; убираем только аннотации двух аргументов для Node 20.
const start = source.indexOf('async function editChannelMessage(');
const end = source.indexOf('\n}\n', start) + 2;
A.ok(start >= 0 && end > start);
vm.runInContext(source.slice(start, end).replace('(post: any, text: string)', '(post, text)'), ctx);

async function check(replies, expectedMethods, shouldFail = false) {
  const calls = [];
  ctx.tgRequest = async (method, body) => {
    calls.push({ method, body });
    A.ok(replies.length, 'Unexpected Telegram request');
    return replies.shift();
  };
  ctx.post = { chat_id: '-100123', message_id: 1520 };
  const run = () => vm.runInContext('editChannelMessage(post, "<b>Участники</b>\\n1. Иван")', ctx);
  if (shouldFail) await A.rejects(run, /Telegram error/);
  else await run();
  A.deepEqual(calls.map(c => c.method), expectedMethods);
  for (const c of calls) {
    A.equal(c.body.chat_id, '-100123');
    A.equal(c.body.message_id, 1520);
    A.equal(c.body.parse_mode, 'HTML');
    A.equal(c.body[c.method === 'editMessageCaption' ? 'caption' : 'text'], '<b>Участники</b>\n1. Иван');
    if (c.method === 'editMessageCaption') A.equal(c.body.text, undefined);
  }
}

(async () => {
  const media = { ok: false, error_code: 400, description: 'Bad Request: there is no text in the message to edit' };
  const unchanged = { ok: false, error_code: 400, description: 'Bad Request: message is not modified: specified new message content is the same' };
  await check([{ ok: true }], ['editMessageText']);
  await check([media, { ok: true }], ['editMessageText', 'editMessageCaption']);
  await check([unchanged], ['editMessageText']);
  await check([media, unchanged], ['editMessageText', 'editMessageCaption']);
  await check([{ ok: false, error_code: 403, description: 'Forbidden' }], ['editMessageText'], true);
  await check([{ ok: false, error_code: 429, description: 'Too Many Requests' }], ['editMessageText'], true);
  await check([media, { ok: false, error_code: 400, description: 'Bad Request: message caption is too long' }], ['editMessageText', 'editMessageCaption'], true);
  console.log('tournament-notify: 7 scenarios passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
