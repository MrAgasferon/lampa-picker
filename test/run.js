#!/usr/bin/env node
// Запуск: node run.js [--only S2,F1] [--strict] [--json]
//   --only    только перечисленные проверки
//   --strict  известные падения (known-failures.json) тоже считаются ошибкой
//   --json    результат одной строкой JSON (для CI/скриптов)
//   --prefix  только проверки с этим началом ID: --prefix S — базовые (для релизного picker.js)
// Переменная PICKER=/путь/к/picker.js — проверить другой файл (по умолчанию ../picker.js).
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i > -1 ? (args[i + 1] || '') : null; };
const only = (opt('--only') || '').split(',').map(s => s.trim()).filter(Boolean);
const prefix = opt('--prefix') || '';   // --prefix S — только базовые проверки (S1…S8, SM)
const strict = args.indexOf('--strict') > -1;
const asJson = args.indexOf('--json') > -1;

const CHECKS = require('./checks');
const { ERRORS } = require('./env');
let known = [];
try { known = JSON.parse(fs.readFileSync(path.join(__dirname, 'known-failures.json'), 'utf8')).known || []; } catch (e) {}

const LIMIT_MS = 30000; // реальное время на одну проверку

(async function () {
  const rows = [];
  for (const c of CHECKS) {
    if (only.length && only.indexOf(c.id) < 0) continue;
    if (prefix && c.id.indexOf(prefix) !== 0) continue;
    const t0 = Date.now();
    ERRORS.length = 0;
    let res;
    try {
      res = await Promise.race([
        c.fn(),
        new Promise(r => setTimeout(() => r({ ok: false, got: 'проверка не уложилась в ' + LIMIT_MS / 1000 + ' с реального времени' }), LIMIT_MS))
      ]);
    } catch (e) {
      res = { ok: false, got: 'исключение: ' + (e && e.message || e) };
    }
    // Исключение в таймере плагина — провал, даже если утверждение проверки выполнилось
    if (ERRORS.length && !c.allowErrors) res = { ok: false, got: 'исключение в коде плагина: ' + ERRORS[0] + (ERRORS.length > 1 ? ' (+' + (ERRORS.length - 1) + ')' : '') + '; проверка: ' + res.got };
    const isKnown = known.indexOf(c.id) > -1;
    let status;
    if (res.ok) status = isKnown ? 'FIXED?' : 'PASS';
    else status = isKnown && !strict ? 'KNOWN' : 'FAIL';
    rows.push({ id: c.id, status, title: c.title, got: res.got, ms: Date.now() - t0 });
    if (!asJson) console.log(status.padEnd(7) + c.id.padEnd(5) + c.title + '\n' + ' '.repeat(12) + '→ ' + res.got);
  }

  const count = s => rows.filter(r => r.status === s).length;
  const summary = { pass: count('PASS'), fail: count('FAIL'), known: count('KNOWN'), fixed: count('FIXED?') };
  if (asJson) console.log(JSON.stringify({ summary, rows }));
  else {
    console.log('\nИтог: PASS ' + summary.pass + ' · FAIL ' + summary.fail + ' · KNOWN ' + summary.known + ' · FIXED? ' + summary.fixed);
    const fixed = rows.filter(r => r.status === 'FIXED?').map(r => r.id);
    if (fixed.length) console.log('Проходят, хотя числятся в known-failures.json: ' + fixed.join(', ') + ' — уберите их из списка.');
  }
  process.exit(summary.fail ? 1 : 0);
})();
