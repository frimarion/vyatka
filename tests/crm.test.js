// CRM: снимок турнира, сведение показателей, отчёт за период и .xlsx.
// Запуск: node tests/crm.test.js
global.window = {};
global.crypto = require('crypto').webcrypto;
const path = require('path');
require(path.join(__dirname, '..', 'js', 'core.js'));
require(path.join(__dirname, '..', 'js', 'crm.js'));
require(path.join(__dirname, '..', 'js', 'xlsx.js'));
const VP = window.VP, CRM = window.VPCrm, X = window.VPXlsx;
const A = require('assert');

// ── Снимок турнира ───────────────────────────────────────────────────────────
function tournamentState() {
  const st = VP.normalizeState(VP.initialState());
  st.tournament.name = 'Вечерний фриз-аут';
  st.tournament.createdAt = '2026-03-10T16:00:00.000Z';
  st.tournament.defaultBuyIn = 1000;
  st.players = [
    { name: 'Андрей', present: true, player_id: 11, payments: [{ method: 'cash', amount: 1000 }] },
    { name: 'Борис', present: true, player_id: 12, reentries: 1, payments: [{ method: 'transfer', amount: 1500 }] },
    { name: 'Ваня', present: true, player_id: 13, buyIn: 0 },                 // Free-тариф
    { name: 'Гена', present: false, player_id: 14 },                          // записался, не дошёл
  ];
  VP.computeStatsFromPlayers(st);
  return st;
}

{
  const st = tournamentState();
  const p = (n) => st.players.find((x) => x.name === n);
  p('Андрей').status = 'busted'; p('Андрей').bustOrder = VP.nextBustOrder(st);
  p('Ваня').status = 'busted'; p('Ваня').bustOrder = VP.nextBustOrder(st);
  VP.computeStatsFromPlayers(st);

  const snap = CRM.snapshotFromState(st, { roomId: 'ABC123', tournamentId: 7 });

  // В историю едут только пришедшие: записавшийся без прихода — не сыгранный турнир
  A.equal(snap.players.length, 3, 'не пришедший в снимок не попал');
  A.equal(snap.result.players_count, 3);
  A.equal(snap.result.entries, 4, 'входы = пришедшие + реентри');
  A.equal(snap.result.reentries, 1);

  // Деньги совпадают с вкладкой оплаты
  const totals = VP.calcPayTotals(st);
  A.equal(snap.result.expected, totals.expected);
  A.equal(snap.result.paid, totals.paid);
  A.equal(snap.result.debt, totals.debt);
  A.equal(snap.result.cash, 1000);
  A.equal(snap.result.transfer, 1500);

  // Места приехали из bustOrder, оставшийся в игре — без места
  A.equal(snap.players.find((x) => x.name === 'Андрей').place, 3);
  A.equal(snap.players.find((x) => x.name === 'Ваня').place, 2);
  A.equal(snap.players.find((x) => x.name === 'Борис').place, 1, 'оставшийся один — победитель');

  // Ключ пересохранения не зависит от момента сохранения: вечер сохраняют
  // и посреди турнира, и после разбора поста — строка должна быть одна.
  const again = CRM.snapshotFromState(st, { roomId: 'ABC123', tournamentId: 7 });
  A.equal(snap.result.report_key, again.result.report_key);
  A.ok(snap.result.report_key.startsWith('ABC123__'));
}

// Победитель: его никто не выбивает, bustOrder у него нет — место проставляет снимок
{
  const st = tournamentState();
  const p = (n) => st.players.find((x) => x.name === n);
  st.rating = { isActive: true, payouts: [100, 60, 30] };

  // Пока в игре больше одного — чемпиона нет
  p('Андрей').status = 'busted'; p('Андрей').bustOrder = 1;
  VP.computeStatsFromPlayers(st);
  A.equal(CRM.finishedWinner(st), null, 'двое в игре — турнир не доигран');

  p('Ваня').status = 'busted'; p('Ваня').bustOrder = 2;
  VP.computeStatsFromPlayers(st);
  const snap = CRM.snapshotFromState(st, { roomId: 'R1' });
  const boris = snap.players.find((x) => x.name === 'Борис');
  A.equal(boris.place, 1, 'последний оставшийся — первое место');
  A.equal(boris.points, 100, 'и очки за первое место');
  // Остальным места не поехали
  A.equal(snap.players.find((x) => x.name === 'Ваня').place, 2);
  A.equal(snap.players.find((x) => x.name === 'Андрей').place, 3);
}
{
  // Ловушка правила «остался один»: первый пришедший в зал тоже один в игре,
  // но турнир ещё не начался — короновать его нельзя.
  const st = tournamentState();
  st.players.forEach((x) => { x.present = false; });
  st.players[0].present = true;
  VP.computeStatsFromPlayers(st);
  A.equal(st.stats.alive, 1, 'в игре один');
  A.equal(CRM.finishedWinner(st), null, 'но вылетевших нет — чемпиона тоже нет');
  A.equal(CRM.snapshotFromState(st, { roomId: 'R1' }).players[0].place, null);
}

// Очки призовой зоны берутся посчитанными, а не пересчитываются заново
{
  const st = tournamentState();
  st.rating = { isActive: true, payouts: [120, 80, 40], entries: 3, r: 0.8, guarantee: 800 };
  st.players.find((x) => x.name === 'Андрей').status = 'busted';
  st.players.find((x) => x.name === 'Андрей').bustOrder = 1;
  VP.computeStatsFromPlayers(st);
  const snap = CRM.snapshotFromState(st, { roomId: 'R1' });
  A.equal(snap.players.find((x) => x.name === 'Андрей').points, 40, 'третье место — третья выплата');
  st.rating.isActive = false;
  A.equal(CRM.snapshotFromState(st, { roomId: 'R1' }).players.find((x) => x.name === 'Андрей').points, 0,
    'зона выключена — очков нет');
}

// ── Сведение показателей ─────────────────────────────────────────────────────
const results = [
  { id: 1, name: 'Мартовский', played_at: '2026-03-01T16:00:00.000Z', players_count: 2, entries: 3, reentries: 1, expected: 3000, paid: 3000, debt: 0, transfer: 3000, cash: 0, card: 0 },
  { id: 2, name: 'Апрельский', played_at: '2026-04-02T16:00:00.000Z', players_count: 2, entries: 2, reentries: 0, expected: 2000, paid: 1500, debt: 500, transfer: 0, cash: 1500, card: 0 },
];
const rows = [
  { result_id: 1, player_id: 11, name: 'Андрей', place: 1, entries: 2, reentries: 1, ko: 3, points: 40, buy_in: 1000, expected: 2000, paid: 2000, debt: 0, transfer: 2000, cash: 0, card: 0 },
  { result_id: 1, player_id: 12, name: 'Борис', place: 2, entries: 1, reentries: 0, ko: 0, points: 25, buy_in: 1000, expected: 1000, paid: 1000, debt: 0, transfer: 1000, cash: 0, card: 0 },
  { result_id: 2, player_id: 11, name: 'Андрей Кузнецов', place: 2, entries: 1, reentries: 0, ko: 1, points: 25, buy_in: 1000, expected: 1000, paid: 1000, debt: 0, transfer: 0, cash: 1000, card: 0 },
  // Незаведённый игрок: player_id нет, сшивается по имени
  { result_id: 2, player_id: null, name: 'Гость', place: 1, entries: 1, reentries: 0, ko: 2, points: 40, buy_in: 1000, expected: 1000, paid: 500, debt: 500, transfer: 0, cash: 500, card: 0 },
];

{
  const agg = CRM.aggregatePlayers(rows, results);
  const by = (n) => agg.find((p) => p.name.startsWith(n));
  A.equal(agg.length, 3, 'три человека: два своих и гость');

  const a = by('Андрей');
  A.equal(a.games, 2, 'один id — один игрок, даже если имя записано по-разному');
  A.equal(a.name, 'Андрей Кузнецов', 'показывается самое свежее написание');
  A.equal(a.entries, 3); A.equal(a.wins, 1); A.equal(a.top3, 2); A.equal(a.ko, 4);
  A.equal(a.points, 65); A.equal(a.avgPlace, 1.5); A.equal(a.bestPlace, 1);
  A.equal(a.paid, 3000); A.equal(a.debt, 0);
  A.equal(CRM.dateKey(a.lastPlayedAt), '2026-04-02', 'последняя игра — по самой свежей шапке');

  const g = by('Гость');
  A.equal(g.player_id, null);
  A.equal(g.debt, 500);
  A.equal(g.itm, 1, 'в призах считаем по очкам зоны');

  // Сортировки
  A.equal(CRM.sortPlayers(agg, 'games')[0].player_id, 11);
  A.equal(CRM.sortPlayers(agg, 'debt')[0].name, 'Гость');
  A.equal(CRM.sortPlayers(agg, 'name')[0].name, 'Андрей Кузнецов');
  // Игрок без единого вылета не должен всплывать наверх «лучшим средним местом»
  const noPlace = CRM.aggregatePlayers([{ result_id: 1, player_id: 99, name: 'Ещё в игре', place: null, entries: 1 }], results);
  A.equal(noPlace[0].avgPlace, null);
  A.equal(CRM.sortPlayers([...agg, ...noPlace], 'avgPlace').at(-1).player_id, 99);
}

// ── Период ───────────────────────────────────────────────────────────────────
{
  const today = new Date(2026, 2, 17);                      // 17 марта 2026
  A.deepEqual(CRM.periodPreset('month', today), { from: '2026-03-01', to: '2026-03-17' });
  A.deepEqual(CRM.periodPreset('prevMonth', today), { from: '2026-02-01', to: '2026-02-28' });
  A.deepEqual(CRM.periodPreset('week', today), { from: '2026-03-11', to: '2026-03-17' });
  A.deepEqual(CRM.periodPreset('all', today), { from: '', to: '' });
  // Турнир, начатый вечером последнего дня периода, обязан в него попасть
  A.ok(CRM.dayEnd('2026-03-31') > new Date('2026-03-31T19:00:00'));

  const t = CRM.periodTotals(results);
  A.equal(t.tournaments, 2); A.equal(t.entries, 5); A.equal(t.paid, 4500); A.equal(t.debt, 500);
  A.equal(t.avgEntries, 2.5);
}

// ── Книга Excel ──────────────────────────────────────────────────────────────
{
  const wb = CRM.buildWorkbook({ results, rows, from: '2026-03-01', to: '2026-04-30' });
  A.equal(wb.sheets.length, 3);
  A.deepEqual(wb.sheets.map((s) => s.name), ['Турниры', 'Игроки', 'Оплата']);
  A.equal(wb.fileName, 'Вятка — отчёт 01.03.2026—30.04.2026.xlsx');

  // Лист турниров: строка на вечер плюс ИТОГО
  const tours = wb.sheets[0];
  A.equal(tours.rows.length, results.length + 1);
  A.equal(tours.rows.at(-1)[1], 'ИТОГО');
  A.equal(tours.rows.at(-1)[8], 4500, 'итог оплачено сходится с периодом');
  A.equal(tours.rows[0][1], 'Мартовский', 'вечера идут по возрастанию даты');

  A.equal(wb.sheets[1].rows.length, 3);
  A.equal(wb.sheets[2].rows.length, rows.length);
}

// ── ZIP/xlsx ─────────────────────────────────────────────────────────────────
// Excel не откроет архив с битым CRC или сдвинутым смещением, а сообщение будет
// «unreadable content» — здесь это ловится дешевле, чем в зале.
{
  const wb = CRM.buildWorkbook({ results, rows, from: '', to: '' });
  const bytes = Buffer.concat(X.build(wb.sheets).map((c) => Buffer.from(c)));
  A.equal(bytes.readUInt32LE(0), 0x04034b50, 'архив начинается локальной записью');

  // Разбираем центральный каталог с конца и сверяем CRC каждого файла
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  A.ok(eocd > 0, 'нашёлся конец центрального каталога');
  const count = bytes.readUInt16LE(eocd + 10);
  let p = bytes.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    A.equal(bytes.readUInt32LE(p), 0x02014b50, 'запись каталога на месте');
    const crc = bytes.readUInt32LE(p + 16);
    const size = bytes.readUInt32LE(p + 24);
    const nameLen = bytes.readUInt16LE(p + 28);
    const offset = bytes.readUInt32LE(p + 42);
    const name = bytes.slice(p + 46, p + 46 + nameLen).toString('utf8');
    names.push(name);
    A.equal(bytes.readUInt32LE(offset), 0x04034b50, `локальная запись ${name} по смещению из каталога`);
    const localNameLen = bytes.readUInt16LE(offset + 26);
    const data = bytes.slice(offset + 30 + localNameLen, offset + 30 + localNameLen + size);
    A.equal(X.crc32(data), crc, `CRC ${name}`);
    p += 46 + nameLen + bytes.readUInt16LE(p + 30) + bytes.readUInt16LE(p + 32);
  }
  A.ok(names.includes('[Content_Types].xml') && names.includes('xl/workbook.xml')
    && names.includes('xl/worksheets/sheet3.xml'), 'все обязательные части на месте: ' + names.join(', '));

  // Кириллица в имени листа и в ячейках — инлайн-строками, без таблицы общих строк
  const sheet1 = bytes.toString('utf8');
  A.ok(sheet1.includes('Мартовский'), 'имя турнира попало в лист');
  A.ok(sheet1.includes('name="Игроки"'), 'русское имя листа');

  // Экранирование: имя с & и < не должно ломать XML
  const xml = Buffer.concat(X.build([{ name: 'Тест', columns: [{ title: 'Игрок' }], rows: [['Петя & <Вася>']] }]).map((c) => Buffer.from(c))).toString('utf8');
  A.ok(xml.includes('Петя &amp; &lt;Вася&gt;'), 'спецсимволы экранированы');
  A.ok(!xml.includes('<t xml:space="preserve">Петя & '), 'сырой амперсанд в XML не уехал');

  // Даты уходят числом Excel, а не текстом: иначе по ним не отсортировать
  A.equal(X.excelSerial(new Date(1900, 0, 1)), 2);
  A.equal(X.colName(0), 'A'); A.equal(X.colName(26), 'AA');
  A.equal(X.sheetName('Отчёт/2026:март'), 'Отчёт 2026 март');
}

console.log('CRM — проверки прошли');
