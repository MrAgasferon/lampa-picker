'use strict';
// Сторож релиза: релизный picker.js не должен оказаться dev-сборкой, а picker-dev.js и picker.js
// с одной версией не должны расходиться в коде.
//
//   node release-check.js                      проверяет ../picker.js и ../picker-dev.js
//   node release-check.js путь/к/picker.js путь/к/picker-dev.js
//
// Ошибка (код выхода 1): в picker.js нет VERSION или версия с «-dev».
// Предупреждения (сборку не валят): в picker-dev.js версия без «-dev»; версии совпадают, а код разный;
// dev отстаёт от релиза.

const fs = require('fs');
const path = require('path');

const relPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'picker.js'));
const devPath = path.resolve(process.argv[3] || path.join(__dirname, '..', 'picker-dev.js'));
const GH = !!process.env.GITHUB_ACTIONS;

let errors = 0;
const say = (kind, file, msg) => {
  if (kind === 'error') errors++;
  const label = { error: 'ОШИБКА', warning: 'ВНИМАНИЕ', notice: 'OK' }[kind];
  console.log(GH ? `::${kind} file=${path.basename(file)}::${msg}` : `${label.padEnd(8)} ${path.basename(file)}: ${msg}`);
};

const RE = /var VERSION = '([^']+)'/;
const read = p => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const verOf = src => { const m = src && src.match(RE); return m ? m[1] : null; };
const base = v => String(v).replace(/-dev$/, '');
const cmp = (a, b) => {
  const x = base(a).split('.').map(Number), y = base(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
};

const rel = read(relPath), dev = read(devPath);
const vRel = verOf(rel), vDev = verOf(dev);

if (rel === null) say('warning', relPath, 'файла нет');
else if (!vRel) say('error', relPath, "не найдена строка var VERSION = '…'");
else if (/dev/i.test(vRel)) say('error', relPath, `версия ${vRel} — в релизный файл попала dev-сборка`);
else say('notice', relPath, `версия ${vRel}`);

if (dev !== null) {
  if (!vDev) say('warning', devPath, "не найдена строка var VERSION = '…'");
  else if (!/-dev$/.test(vDev)) say('warning', devPath, `версия ${vDev} без «-dev» — так её легко спутать с релизом`);
  else say('notice', devPath, `версия ${vDev}`);

  if (vRel && vDev) {
    const a = rel.split('\n'), b = dev.split('\n');
    const diff = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] === b[i]) continue;
      if (RE.test(a[i] || '') && RE.test(b[i] || '')) continue;      // строка версии — различие ожидаемое
      diff.push(i + 1);
    }
    const same = base(vRel) === base(vDev);
    if (cmp(vDev, vRel) < 0) say('warning', devPath, `dev (${vDev}) старше релиза (${vRel})`);
    else if (same && diff.length) {
      const where = a.length === b.length ? `строки ${diff.slice(0, 5).join(', ')}${diff.length > 5 ? '…' : ''}` : `разная длина: ${a.length} и ${b.length} строк`;
      say('warning', devPath, `версия одна (${base(vRel)}), а код отличается: ${where}. Поднимите версию в dev или скопируйте dev в релиз`);
    } else if (same) say('notice', devPath, 'код совпадает с релизом, кроме строки версии');
    else say('notice', devPath, `dev впереди релиза: ${vRel} → ${vDev}`);
  }
}

process.exit(errors ? 1 : 0);
