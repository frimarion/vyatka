const A = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let now = 1800000000000;
const context = vm.createContext({ window: { serverNowMs: () => now }, crypto: require('node:crypto').webcrypto });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/core.js'), 'utf8'), context);
const VP = context.window.VP;
// Execute the actual app renderer and its VP imports, without network or login.
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const imports = html.match(/  const \{\s*escHtml,[\s\S]*?\} = window\.VP;/)[0];
const renderer = html.match(/  function liveBlock\(t\) \{[\s\S]*?\n  \}/)[0];
context.roomOf = () => context.state;
context.isRunning = t => context.state.timer.isRunning || t.status === 'running';
context.coarse = String;
vm.runInContext(imports + '\n' + renderer, context);
const render = () => vm.runInContext('liveBlock({ status: "running" })', context);
function reset() {
  context.state = VP.normalizeState(VP.initialState());
  context.state.structure.levels = [
    { min: 1, sb: 100, bb: 200 },
    { min: 1, isBreak: true },
    { min: 2, sb: 200, bb: 400 },
  ];
  Object.assign(context.state.timer, { isRunning: true, levelEndAt: now + 60000 });
}

reset();
A.match(render(), /01:00/);
now += 60000;
A.match(render(), /Перерыв/);
A.match(render(), /01:00/);
A.equal(context.state.timer.levelIndex, 1);
now += 65000;
A.match(render(), /Уровень 2/);
A.match(render(), /01:55/);
A.match(render(), /200 \/ 400/);

reset();
const stale = JSON.stringify(context.state);
now += 135000; // Resume after sleeping through two level boundaries.
A.match(render(), /01:45/);
context.state = JSON.parse(stale); // Poll returns the same stale room.
A.match(render(), /01:45/);

reset();
VP.T.pause(context.state);
now += 180000;
A.match(render(), /Пауза/);
A.match(render(), /01:00/);
A.equal(context.state.timer.levelIndex, 0);

reset();
VP.T.breakStart(context.state);
const breakSnapshot = JSON.stringify(context.state);
now = context.state.timer.breakUntil + 15000;
A.match(render(), /00:45/);
context.state = JSON.parse(breakSnapshot);
now += 5000;
A.match(render(), /00:40/, 'stale polling must not restart the resumed level');

reset();
now += 300000;
A.equal(render(), '', 'exhausted structure must not show a frozen 00:00');
A.equal(context.state.timer.isRunning, false);
console.log('Tournament detail timer checks passed');
