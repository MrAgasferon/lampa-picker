// Стенд для picker.js: jsdom + jQuery + мок Lampa + фейковая сеть + виртуальное время.
//
// picker.js не меняется. В копию в памяти перед концом IIFE добавляется одна строка,
// которая отдаёт внутренние функции в window.__pk. Имена, которых нет (переименовали,
// удалили), просто приходят как undefined — стенд от этого не падает.
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PICKER = process.env.PICKER || path.join(__dirname, '..', 'picker.js');
const RAW = fs.readFileSync(PICKER, 'utf8');
const JQ_SRC = fs.readFileSync(path.join(__dirname, 'node_modules', 'jquery', 'dist', 'jquery.js'), 'utf8');

const NAMES = ['certOf', 'kidsOk', 'kidsTargeted', 'adultRated', 'harshAdult', 'collect', 'enrichEvents', 'buildProfile',
  'pickWeights', 'moodScore', 'postReason', 'prefilter', 'scoreAll', 'ratingOffsets', 'cachedRatings', 'tmdb', 'tmdbUrl',
  'details', 'compact', 'cubMeta', 'Cache', 'Durable', 'Net', 'KpNet', 'CubNet', 'attachRatings', 'attachCubMeta', 'kpQuota',
  'fetchRatings', 'run', 'cancelRun', 'nextPage', 'PickerComponent', 'feedback', 'saveFeedback', 'Journal', 'progress',
  'startedAny', 'seriesStarted'];
const HOOK = '\n  window.__pk = {' + NAMES.map(n => n + ": (typeof " + n + " !== 'undefined' ? " + n + ' : undefined)').join(', ') +
  ", getKpRunCap: function () { return typeof kpRunCap !== 'undefined' ? kpRunCap : undefined; } };\n";
const END = RAW.lastIndexOf('})()');
if (END < 0) throw new Error('picker.js: не найден конец IIFE «})()»');
const SRC = RAW.slice(0, END) + HOOK + RAW.slice(END);

// ---------------------------------------------------------------- виртуальное время
const flush = () => new Promise(r => setImmediate(r));

function makeClock(start) {
  let now = start, seq = 0;
  const timers = new Map();
  const add = (fn, ms, args, every) => {
    const id = ++seq;
    timers.set(id, { at: now + Math.max(0, +ms || 0), fn, args, every, seq: id });
    return id;
  };
  const pick = () => {
    let best = null;
    for (const [id, t] of timers) if (!best || t.at < best.t.at || (t.at === best.t.at && t.seq < best.t.seq)) best = { id, t };
    return best;
  };
  const fire = (b) => {
    now = Math.max(now, b.t.at);
    if (b.t.every) { b.t.at = now + b.t.every; b.t.seq = ++seq; } else timers.delete(b.id);
    try { b.t.fn.apply(null, b.t.args || []); } catch (e) { console.error('[timer]', e && e.stack || e); }
  };
  return {
    get now() { return now; },
    setTimeout: (fn, ms, ...a) => add(fn, ms, a, 0),
    clearTimeout: id => { timers.delete(id); },
    setInterval: (fn, ms, ...a) => add(fn, Math.max(1, +ms || 0), a, Math.max(1, +ms || 0)),
    clearInterval: id => { timers.delete(id); },
    // Прокрутить время на ms, выполняя всё, что наступает
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        const b = pick();
        if (!b || b.t.at > end) break;
        fire(b);
      }
      now = end;
      await flush();
    },
    // Крутить время, пока pred() не станет true (или пока не пройдёт maxMs виртуальных мс)
    async until(pred, maxMs) {
      const end = now + (maxMs || 60000);
      for (;;) {
        await flush();
        if (pred()) return true;
        const b = pick();
        if (!b || b.t.at > end) { now = end; await flush(); return pred(); }
        fire(b);
      }
    }
  };
}

// ---------------------------------------------------------------- синтетический TMDB
function hash(s) { let h = 5381; s = String(s); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h >>> 0); }

function movie(id, extra) {
  return Object.assign({ id: id, title: 'Film ' + id, original_title: 'Film ' + id, release_date: '2015-05-01',
    genre_ids: [28, 878], vote_average: 7.0, vote_count: 5000, poster_path: '/p' + id + '.jpg', popularity: 10 }, extra || {});
}

function detailsOf(m) {
  return Object.assign({}, m, {
    genres: (m.genre_ids || []).map(g => ({ id: g, name: 'g' + g })),
    runtime: m.runtime || 100,
    belongs_to_collection: m.coll ? { id: m.coll } : null,
    credits: m.credits || { cast: [{ id: 9000 + m.id % 7, name: 'Actor ' + m.id % 7 }], crew: [{ id: 8000 + m.id % 5, job: 'Director', name: 'Dir ' + m.id % 5 }] },
    keywords: { keywords: [{ id: 1 + m.id % 9 }] },
    release_dates: { results: m.cert || [
      { iso_3166_1: 'US', release_dates: [{ certification: 'PG-13' }] },
      { iso_3166_1: 'RU', release_dates: [{ certification: '12+' }] }] },
    external_ids: { imdb_id: 'tt' + m.id }
  });
}

// Карточка в том виде, в каком она лежит в «Избранном» Lampa
function card(id, extra) {
  return Object.assign({ id: id, title: 'Film ' + id, original_title: 'Film ' + id, release_date: '2015-05-01',
    genre_ids: [28, 878], vote_average: 7.0, vote_count: 5000, method: 'movie' }, extra || {});
}

// Простейший IndexedDB: open → onsuccess, get/put через store kv, всё асинхронно на виртуальных часах
function fakeIdb(clock, initial, delay) {
  const data = Object.assign({}, initial || {});
  const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    data,
    open() {
      const req = {};
      clock.setTimeout(() => {
        const store = {
          // снимок на момент запроса — как у readonly-транзакции, начатой раньше записи
          get(key) { const r = {}, snap = clone(data[key]); clock.setTimeout(() => { r.result = snap; r.onsuccess && r.onsuccess(); }, delay || 1); return r; },
          put(val, key) { data[key] = clone(val); }
        };
        const db = { transaction() { return { objectStore() { return store; } }; }, close() {} };
        req.onsuccess && req.onsuccess({ target: { result: db } });
      }, 1);
      return req;
    }
  };
}

// ---------------------------------------------------------------- окружение
// o: { fav, timeline, timelineFn, world, router, storage, cub, kp, idb: 'fake' | object, idbData, noTmdbApi }
function makeEnv(o) {
  o = o || {};
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://lampa.test/', runScripts: 'outside-only' });
  const w = dom.window;
  const clock = makeClock(Date.now());
  const RealDate = Date;
  function FakeDate() { return arguments.length ? new (Function.prototype.bind.apply(RealDate, [null].concat([].slice.call(arguments))))() : new RealDate(clock.now); }
  FakeDate.now = () => clock.now;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.prototype = RealDate.prototype;
  w.Date = FakeDate;
  w.setTimeout = clock.setTimeout; w.clearTimeout = clock.clearTimeout;
  w.setInterval = clock.setInterval; w.clearInterval = clock.clearInterval;

  const log = { urls: [], noty: [], console: [] };
  w.console = {
    log: function () { log.console.push([].slice.call(arguments).map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); },
    warn() {}, error() {}, info() {}, debug() {}
  };
  w.eval(JQ_SRC);
  const $ = w.jQuery;

  const storage = Object.assign({}, o.storage || {});
  const fav = Object.assign({ like: [], wath: [], book: [], history: [], look: [], viewed: [], scheduled: [], continued: [], thrown: [] }, o.fav || {});
  const timeline = o.timeline || {};
  const world = Object.assign({ movies: {}, discover: [], recs: [], collections: {} }, o.world || {});
  const getMovie = id => world.movies[id] || movie(id);

  const defaultRouter = function (url) {
    const m = url.match(/^https:\/\/api\.tmdb\.test\/3\/([^?]+)\??(.*)$/);
    if (!m) return null;
    const p = m[1];
    let r;
    if (p === 'discover/movie') return { body: { results: world.discover.map(getMovie) } };
    if (p.indexOf('discover/tv') === 0 || p.indexOf('tv/') === 0) return { body: { results: [] } };
    if ((r = p.match(/^movie\/(\d+)\/recommendations$/))) return { body: { results: world.recs.map(getMovie) } };
    if ((r = p.match(/^movie\/(\d+)$/))) return { body: detailsOf(getMovie(+r[1])) };
    if ((r = p.match(/^collection\/(\d+)$/))) return { body: { id: +r[1], parts: (world.collections[r[1]] || []).map(getMovie) } };
    return { body: { results: [] } };
  };
  const router = o.router || defaultRouter;

  function Reguest() { this._t = 30000; }
  Reguest.prototype.timeout = function (t) { this._t = t; };
  Reguest.prototype.silent = function (url, ok, fail, post, params) {
    log.urls.push(url);
    const r = router(url, params, defaultRouter) || { status: 404 };
    if (r.hang) return;                                   // никогда не отвечает ни успехом, ни ошибкой
    const delay = r.delay || 3;
    if (delay > this._t) { clock.setTimeout(function () { fail({ status: 0 }); }, this._t); return; }
    clock.setTimeout(function () {
      if ('status' in r && r.status !== 200) fail({ status: r.status });
      else ok(JSON.parse(JSON.stringify(r.body)));
    }, delay);
  };

  w.Lampa = {
    Storage: {
      get: (k, d) => (k in storage ? storage[k] : (typeof d === 'string' && (d[0] === '{' || d[0] === '[') ? JSON.parse(d) : d)),
      set: (k, v) => { storage[k] = v === undefined ? v : JSON.parse(JSON.stringify(v)); },
      cache: (k, max, d) => (k in storage ? storage[k] : d),
      field: k => storage[k]
    },
    Favorite: {
      get: p => (fav[p.type] || []).slice(),
      check: c => ({ like: fav.like.some(x => x.id === c.id) }),
      add: (t, c) => { fav[t].push(c); },
      remove: (t, c) => { fav[t] = fav[t].filter(x => x.id !== c.id); }
    },
    Timeline: {
      view: (h, meta) => (o.timelineFn ? o.timelineFn(h, meta) : null) || timeline[h] || { percent: 0, time: 0, duration: 0 },
      // как в Lampa (src/interaction/timeline.js): привязка прогресса к карточке
      link: (c, season, episode) => {
        if (!c || !c.id) return null;
        const r = { card: (c.original_name ? 'tv' : 'movie') + '_' + c.id };
        if (season !== undefined) { r.season = season; r.episode = episode; }
        return r;
      },
      watched: function (c) {
        const T = w.Lampa.Timeline;
        if (c.original_name) {
          let n = 0;
          for (let i = 1; i <= 24; i++) if (T.view(hash([1, i, c.original_name].join('')), T.link(c, 1, i)).percent) n++;
          return n;
        }
        return T.view(hash(c.original_title), T.link(c)).percent;
      }
    },
    Utils: { hash: hash, protocol: () => 'https://' },
    TMDB: { api: rel => 'https://api.tmdb.test/3/' + rel, key: () => 'PUBLICKEY', image: u => 'https://img.test/' + u },
    Reguest: Reguest,
    Manifest: { cub_domain: 'cub.test' },
    Listener: { follow() {}, send() {} },
    Component: { add() {} },
    Noty: { show: t => log.noty.push(t) },
    Activity: { push() {}, backward() {} },
    Controller: { add() {}, toggle() {}, enabled: () => ({ name: 'content' }), collectionSet() {}, collectionFocus() {} }
  };
  if (o.noTmdbApi) { delete w.Lampa.TMDB.api; delete w.Lampa.TMDB.image; }
  w.lampa_settings = { disable_features: { metadata: !o.cub } };
  let idb;
  if (o.idb === 'fake') idb = fakeIdb(clock, o.idbData, o.idbDelay);
  else if (o.idb) idb = o.idb;
  w.indexedDB = idb;
  if (!o.kp) storage.picker_kp_off = clock.now + 3600e3;   // КП выключен, если проверка не про него

  w.eval(SRC);
  const pk = w.__pk;

  const env = { w, $, pk, log, storage, fav, timeline, world, clock, idb };

  // Вызвать функцию с колбэком и крутить время, пока колбэк не придёт. Возвращает аргументы колбэка или undefined.
  env.cb = async function (starter, maxMs) {
    let res, done = false;
    starter(function () { res = [].slice.call(arguments); done = true; });
    await clock.until(() => done, maxMs || 60000);
    return done ? res : undefined;
  };
  // Полный подбор. done(st) или error(...) — что наступит раньше.
  env.run = async function (ans, maxMs) {
    let out = null;
    const stages = [];
    pk.run(ans, {
      stage: s => stages.push(s),
      done: st => { out = { st }; },
      error: e => { out = { error: e || true }; }
    });
    await clock.until(() => !!out, maxMs || 120000);
    return Object.assign({ stages, timedOut: !out }, out || {});
  };
  // Профиль по текущим данным (collect → enrichEvents → buildProfile)
  env.profile = async function () {
    const ev = pk.collect();
    await env.cb(cb => pk.enrichEvents(ev, cb));
    return { events: ev, profile: pk.buildProfile(ev) };
  };
  return env;
}

module.exports = { makeEnv, makeClock, movie, detailsOf, card, hash, fakeIdb, PICKER, RAW };
