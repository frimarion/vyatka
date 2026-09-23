global.window = {}; global.crypto = require('crypto').webcrypto;
const fs = require('node:fs');
const path = require('node:path');
require(path.join(__dirname, '..', 'js', 'core.js'));
const VP = window.VP; const A = require('node:assert/strict');

// Пороги в core.js — копия seed'а vp_levels из миграции: разъедутся — песочница
// и лист правил начнут врать.
const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '019_levels.sql'), 'utf8');
const seed = [...sql.matchAll(/\(\s*(\d+),\s*(\d+),\s*'(\w+)',\s*'([^']+)'\)/g)]
  .map(([, level, xp, rank, name]) => ({ level: +level, xp: +xp, rank, name }));
A.equal(seed.length, 25);
A.deepEqual(seed.map((r) => r.xp), VP.LEVEL_XP);
seed.forEach((r) => {
  const lv = VP.levelFromXp(r.xp);
  A.equal(lv.level, r.level);
  A.equal(lv.rank_key, r.rank);
  A.equal(VP.RANKS[r.rank].name, r.name);
});

// Границы
A.deepEqual(VP.levelFromXp(0), { xp: 0, level: 1, rank_key: 'novice', rank_name: 'Новичок', xp_from: 0, xp_next: 200 });
A.equal(VP.levelFromXp(-50).level, 1);
A.equal(VP.levelFromXp('abc').level, 1);
A.equal(VP.levelFromXp(199).level, 1);
A.equal(VP.levelFromXp(200).level, 2);
A.equal(VP.levelFromXp(1499).rank_key, 'novice');
A.equal(VP.levelFromXp(1500).rank_key, 'habitue');
const top = VP.levelFromXp(1e6);
A.equal(top.level, 25); A.equal(top.xp_next, null); A.equal(top.rank_key, 'legend');

// Прогресс
A.equal(VP.levelProgress(VP.levelFromXp(0)), 0);
A.equal(VP.levelProgress(VP.levelFromXp(100)), 0.5);
A.equal(VP.levelProgress(top), 1);
A.equal(VP.levelProgress(null), 1);

// Подпись
A.equal(VP.levelLine({ level: 12, rank_key: 'regular' }), 'Регуляр · 12 ур.');
A.equal(VP.levelLine({ level: 17 }), 'Акула · 17 ур.');
A.equal(VP.levelLine(null), '');

// Аватарка: без уровня — прежняя разметка, с уровнем — рамка и бейдж
A.equal(VP.avatarHtml('Иван Петров', null), '<span class="avatar">ИП</span>');
A.equal(VP.avatarHtml('Иван Петров', null, 'avatar', { level: null }), '<span class="avatar">ИП</span>');
const withLv = VP.avatarHtml('Иван Петров', null, 'avatar', { level: 16, rank_key: 'shark' });
A.match(withLv, /^<span class="lvWrap rk-shark" title="Акула · 16 уровень"><span class="avatar">ИП<\/span><b class="lvBadge">16<\/b><\/span>$/);
A.doesNotMatch(VP.avatarHtml('Иван', null, 'avatar', { level: 3, rank_key: 'novice' }, false), /lvBadge/);
// Неизвестный rank_key — ранг выводится из номера уровня, а не ломает класс
A.match(VP.avatarHtml('Иван', null, 'avatar', { level: 22, rank_key: '"><x' }), /rk-legend/);

console.log('Levels — checks passed');
