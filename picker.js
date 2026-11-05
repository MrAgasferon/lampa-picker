/*!
 * Lampa Picker — «Что посмотреть»
 * Подборщик фильмов и сериалов на вечер для Lampa / ByLampa.
 * Работает целиком на устройстве: без своего сервера, без LLM, без аккаунтов.
 * Код в ES5 — для старых ТВ-движков.
 */
(function () {
  'use strict';

  if (window.lampa_picker_loaded) return;
  window.lampa_picker_loaded = true;

  var VERSION = '0.13.1';
  // Тестовая сборка (picker-dev.js): видна в меню, чтобы не перепутать с рабочей
  var DEV = /-dev$/.test(VERSION);
  var TITLE = 'Что посмотреть' + (DEV ? ' (dev)' : '');

  // Адрес веб-приложения Google Apps Script для «Отправить автору». Пусто — кнопки нет.
  var FEEDBACK_URL = 'https://script.google.com/macros/s/AKfycbwfDLlJYpeW7Hnq6pD3-90wNWoTWjqJuRup7l2EHpMbB8qcGDJWKszei1Twyd1BhwB1/exec';
  var FEEDBACK_DAILY = 5;
  var NS = 'picker_';
  var DAY = 864e5;

  // =========================================================================
  // Утилиты
  // =========================================================================

  function now() { return new Date().getTime(); }

  function store(key, def) {
    try {
      var v = Lampa.Storage.get(NS + key, def);
      if (typeof v === 'string' && (v.charAt(0) === '{' || v.charAt(0) === '[')) {
        try { v = JSON.parse(v); } catch (e) { v = def; }
      }
      return v === undefined || v === null ? def : v;
    } catch (e) { return def; }
  }

  function save(key, val) {
    try { Lampa.Storage.set(NS + key, val); } catch (e) {}
  }

  function isDebug() { return !!store('debug', false); }

  function log() {
    if (!isDebug()) return;
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[Picker]');
      console.log.apply(console, args);
    } catch (e) {}
  }

  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function keyOf(type, id) { return type + ':' + id; }

  function each(obj, fn) {
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) fn(obj[k], k);
  }

  function uniq(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) if (out.indexOf(arr[i]) < 0) out.push(arr[i]);
    return out;
  }

  function typeOf(card) {
    if (!card) return 'movie';
    if (card.method === 'tv' || card.media_type === 'tv') return 'tv';
    if (card.method === 'movie' || card.media_type === 'movie') return 'movie';
    if (card.original_name || card.first_air_date || (card.name && !card.title)) return 'tv';
    return 'movie';
  }

  function noty(text) {
    try { Lampa.Noty.show(text); } catch (e) {}
  }

  // Детерминированный генератор случайных чисел (mulberry32)
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul ? Math.imul(t ^ (t >>> 15), t | 1) : (t ^ (t >>> 15)) * (t | 1);
      t ^= t + (Math.imul ? Math.imul(t ^ (t >>> 7), t | 61) : (t ^ (t >>> 7)) * (t | 61));
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function todaySeed() {
    var d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  // =========================================================================
  // Справочники
  // =========================================================================

  var GENRE_NAMES = {
    28: 'Боевик', 12: 'Приключения', 16: 'Мультфильм', 35: 'Комедия', 80: 'Криминал',
    99: 'Документальный', 18: 'Драма', 10751: 'Семейный', 14: 'Фэнтези', 36: 'История',
    27: 'Ужасы', 10402: 'Музыка', 9648: 'Детектив', 10749: 'Мелодрама', 878: 'Фантастика',
    10770: 'ТВ-фильм', 53: 'Триллер', 10752: 'Военный', 37: 'Вестерн', 10762: 'Детское'
  };

  // Сериальные жанры TMDB → жанры фильмов (вся логика живёт в пространстве жанров фильмов)
  var TV_TO_MOVIE = {
    10759: [28, 12], 10765: [878, 14], 10768: [10752], 10762: [10762],
    10763: [], 10764: [], 10766: [18], 10767: []
  };

  var MOVIE_TO_TV = { 28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768 };
  var TV_HAS_SAME = [16, 35, 80, 99, 18, 10751, 9648, 37, 10762];

  function normGenres(ids) {
    var out = [];
    for (var i = 0; i < (ids || []).length; i++) {
      var g = ids[i];
      var mapped = TV_TO_MOVIE[g] || [g];
      for (var j = 0; j < mapped.length; j++) if (out.indexOf(mapped[j]) < 0) out.push(mapped[j]);
    }
    return out;
  }

  function toTvGenre(g) {
    if (MOVIE_TO_TV[g]) return MOVIE_TO_TV[g];
    if (TV_HAS_SAME.indexOf(g) > -1) return g;
    return null;
  }

  // Вес жанра для настроения: >0 подходит, <0 мешает
  var MOODS = {
    relax: { title: 'Расслабиться', w: { 35: 1, 10749: 0.8, 10402: 0.6, 12: 0.4, 14: 0.3, 18: 0.1, 28: -0.3, 9648: -0.3, 80: -0.5, 53: -0.8, 10752: -0.8, 27: -1 } },
    laugh: { title: 'Посмеяться', w: { 35: 1, 10402: 0.2, 12: 0.1, 18: -0.2, 53: -0.4, 10752: -0.6, 27: -0.6 }, req: 35 },
    nerves: { title: 'Пощекотать нервы', w: { 53: 1, 27: 1, 9648: 0.8, 80: 0.7, 28: 0.5, 878: 0.3, 35: -0.3, 10749: -0.3, 16: -0.3, 10751: -0.8 } },
    // Драма в TMDB стоит у половины кино — сама по себе «думающим» фильм не делает
    think: { title: 'Подумать', w: { 878: 0.8, 9648: 0.8, 36: 0.8, 99: 0.6, 10752: 0.5, 18: 0.5, 80: 0.4, 35: -0.5, 16: -0.3, 27: -0.8, 10751: -0.8, 10749: -0.2, 10402: -0.3, 28: -0.5, 12: -0.3 } },
    surprise: { title: 'Удиви меня', w: {} }
  };

  function moodPlus(mood, n) {
    var arr = [];
    each(mood.w, function (v, g) { if (v > 0) arr.push({ g: parseInt(g, 10), v: v }); });
    arr.sort(function (a, b) { return b.v - a.v; });
    return arr.slice(0, n).map(function (x) { return x.g; });
  }

  var GROUP_PLUS = [35, 28, 12, 27];

  var WEIGHTS = {
    def: { q: 0.30, a: 0.35, m: 0.20, n: 0.05, s: 0.10 },
    think: { q: 0.40, a: 0.30, m: 0.15, n: 0.05, s: 0.10 },
    surprise: { q: 0.30, a: 0.20, m: 0.00, n: 0.40, s: 0.10 },
    group: { q: 0.40, a: 0.15, m: 0.30, n: 0.05, s: 0.10 },
    cold: { q: 0.55, a: 0.10, m: 0.30, n: 0.05, s: 0.00 },
    // С детьми вкус взрослого почти не важен — важно, что подходит детям
    kids: { q: 0.40, a: 0.15, m: 0.35, n: 0.05, s: 0.05 }
  };

  // «С детьми»: что тянет вверх и что вниз (поверх настроения)
  var KIDS_PLUS = [10751, 16, 12, 14];
  var KIDS_MINUS = [53, 80, 9648, 10752, 27];

  var AFFINITY_COEF = { genre: 0.30, keyword: 0.25, director: 0.15, cast: 0.15, decade: 0.08, lang: 0.07 };

  // Сигналы локальных списков Lampa
  var SIGNALS = {
    like: 1.0, viewed: 0.8,
    book: 0.4, wath: 0.4, look: 0.4, scheduled: 0.4,
    history: 0.3, continued: 0.3,
    thrown: -0.5
  };

  // Намерение посмотреть. «Смотрю» (look) сюда не входит: это уже начатое — его не предлагаем
  var INTENT_TYPES = ['wath', 'book', 'scheduled'];
  var INTENT_REASON = { wath: 'Из вашего списка «Позже»', book: 'Из ваших закладок', scheduled: 'Из запланированного' };
  var WATCHED_TYPES = ['like', 'viewed', 'thrown'];

  // =========================================================================
  // Очередь запросов (не больше 4 одновременно, один повтор при ошибке)
  // =========================================================================

  // 429 — пауза всей очереди с нарастающей задержкой; 4xx — без повтора; сеть/5xx — один повтор
  var Net = {
    queue: [],
    active: 0,
    max: 4,
    pauseUntil: 0,
    pauseTimer: null,
    oks: 0,          // счётчики для подбора: отличить «ничего не нашлось» от «нет связи»
    netFails: 0,

    get: function (url, ok, fail, opts) {
      this.queue.push({ url: url, ok: ok, fail: fail, opts: opts, tries: 0 });
      this.pump();
    },

    pump: function () {
      var self = this;
      var wait = self.pauseUntil - now();
      if (wait > 0) {
        if (!self.pauseTimer) self.pauseTimer = setTimeout(function () { self.pauseTimer = null; self.pump(); }, wait);
        return;
      }
      while (self.active < self.max && self.queue.length) {
        (function (job) {
          self.active++;
          var req = new Lampa.Reguest();
          req.timeout(15000);
          // Страховка: другой плагин может перехватить ответ Lampa.Reguest, и тогда колбэк не придёт никогда —
          // слот очереди занят навсегда. Через 17 с считаем запрос неудачным
          var settled = false;
          var guard = setTimeout(function () { failed({ status: 0 }); }, 17000);
          var done = function (json) {
            if (settled) return;
            settled = true;
            clearTimeout(guard);
            self.active--;
            self.oks++;
            try { job.ok(json); } catch (e) { log('callback error', e); }
            self.pump();
          };
          var failed = function (a) {
            if (settled) return;
            settled = true;
            clearTimeout(guard);
            self.active--;
            var status = (a && a.status) || 0;
            if (!status || status >= 500) self.netFails++;
            if (status === 429 && job.tries < 3) {
              job.tries++;
              self.pauseUntil = now() + Math.min(30000, 2000 * Math.pow(2, job.tries));
              self.queue.unshift(job);
              log('429, пауза', self.pauseUntil - now(), 'мс');
            } else if (status >= 400 && status < 500) {
              if (job.fail) { try { job.fail(status); } catch (e) {} }
            } else if (job.tries < 1) {
              job.tries++;
              setTimeout(function () { self.queue.push(job); self.pump(); }, 1500);
            } else if (job.fail) {
              try { job.fail(status); } catch (e) {}
            }
            self.pump();
          };
          if (job.opts) req.silent(job.url, done, failed, false, job.opts);
          else req.silent(job.url, done, failed);
        })(self.queue.shift());
      }
    }
  };

  // =========================================================================
  // Кеш: IndexedDB с запасным вариантом в памяти
  // =========================================================================

  var CACHE_GET_TIMEOUT = 8000;    // мс на чтение из IndexedDB: обычно — миллисекунды; 8 с — явно зависла
  var CACHE_MEM_MAX = 400;          // записей в памяти; источник правды — IndexedDB
  var CACHE_IDB_MAX_AGE = 35 * DAY;  // старше — удаляется при суточной чистке

  var Cache = {
    db: null,
    mem: {},
    order: [],
    opened: false,
    waiting: [],

    // Память ограничена: самые давние ключи вытесняются
    remember: function (key, rec) {
      if (!this.mem[key]) this.order.push(key);
      this.mem[key] = rec;
      while (this.order.length > CACHE_MEM_MAX) delete this.mem[this.order.shift()];
    },

    // Раз в сутки: удалить из IndexedDB просроченное и сырые детали старого формата (до 0.11)
    sweep: function () {
      var self = this;
      self.init(function () {
        if (!self.db) return;
        try {
          var lim = now() - CACHE_IDB_MAX_AGE, removed = 0;
          var cur = self.db.transaction('kv', 'readwrite').objectStore('kv').openCursor();
          cur.onsuccess = function (e) {
            var c = e.target.result;
            if (!c) { if (removed) log('cache sweep, removed', removed); return; }
            var k = String(c.key), v = c.value;
            var legacy = k.indexOf('tmdb:') === 0 && k.indexOf('append_to_response') > -1;
            if (k.indexOf('durable:') !== 0 && (legacy || !v || !(v.t > lim))) { c['delete'](); removed++; }
            c['continue']();
          };
        } catch (e) { log('cache sweep error', e); }
      });
    },

    init: function (cb) {
      var self = this;
      if (self.opened) return cb();
      self.waiting.push(cb);
      if (self.waiting.length > 1) return;

      var done = function () {
        if (self.opened) return;
        self.opened = true;
        var w = self.waiting;
        self.waiting = [];
        for (var i = 0; i < w.length; i++) w[i]();
      };

      try {
        if (!window.indexedDB) return done();
        var req = window.indexedDB.open('lampa_picker', 1);
        // Бывает, что open не отвечает вовсе (известная ошибка WebKit) — тогда работаем на памяти
        var guard = setTimeout(function () { log('idb open timeout'); done(); }, 3000);
        req.onupgradeneeded = function (e) { e.target.result.createObjectStore('kv'); };
        req.onsuccess = function (e) {
          clearTimeout(guard);
          if (self.opened) { try { e.target.result.close(); } catch (x) {} return; }   // опоздал — уже работаем без базы
          self.db = e.target.result;
          done();
        };
        req.onerror = function () { clearTimeout(guard); done(); };
        req.onblocked = function () { clearTimeout(guard); done(); };
      } catch (e) { done(); }
    },

    // cb(значение) или cb(null). Второй аргумент 'timeout' — база не ответила вовремя: значение неизвестно,
    // а не «пусто» (Durable по нему не перезаписывает данные на диске)
    get: function (key, ttl, cb) {
      var self = this;
      self.init(function () {
        var m = self.mem[key];
        if (m) return cb(now() - m.t < ttl ? m.v : null);
        if (!self.db) return cb(null);
        if (self.stalled) return cb(null, 'timeout');   // база уже не ответила — в этой сессии не ждём её снова
        var done = false;
        var reply = function (v, why) { if (done) return; done = true; clearTimeout(guard); cb(v, why); };
        // WebView иногда не вызывает ни onsuccess, ни onerror — подбор не должен ждать вечно
        var guard = setTimeout(function () { log('IndexedDB: нет ответа', key); self.stalled = true; reply(null, 'timeout'); }, CACHE_GET_TIMEOUT);
        try {
          var r = self.db.transaction('kv', 'readonly').objectStore('kv').get(key);
          r.onsuccess = function () {
            var x = r.result;
            if (x) self.remember(key, x);       // поздний ответ тоже идёт в память — пригодится следующему чтению
            if (x) reply(now() - x.t < ttl ? x.v : null); else reply(null);
          };
          r.onerror = function () { reply(null); };
        } catch (e) { reply(null); }
      });
    },

    set: function (key, val) {
      var rec = { t: now(), v: val };
      this.remember(key, rec);
      if (!this.db) return;
      try { this.db.transaction('kv', 'readwrite').objectStore('kv').put(rec, key); } catch (e) {}
    }
  };

  // =========================================================================
  // Durable: объёмные данные плагина (журнал, карта КП) — в IndexedDB, не в localStorage.
  // localStorage общий с Lampa и ограничен ~5 МБ, его не трогаем.
  // В памяти держится рабочая копия, на диск — с задержкой 2 с.
  // =========================================================================

  var Durable = {
    vals: {},
    loaded: {},
    waiting: {},
    timers: {},
    loading: {},    // чтение из IndexedDB в полёте
    readOnly: {},   // чтение не удалось (таймаут) — на диск не пишем до перезапуска
    touched: {},    // во время чтения записали: 'merge' — дописать к прочитанному, 'replace' — прочитанное не нужно

    // Однократный перенос старых данных из localStorage
    takeLegacy: function (key) {
      try {
        var raw = window.localStorage && window.localStorage.getItem(NS + key);
        if (!raw) return null;
        window.localStorage.removeItem(NS + key);
        return JSON.parse(raw);
      } catch (e) { return null; }
    },

    load: function (key, def, cb) {
      var self = this;
      if (self.loaded[key]) { if (cb) cb(self.vals[key]); return; }
      (self.waiting[key] = self.waiting[key] || []).push(cb);
      if (self.waiting[key].length > 1) return;
      self.loading[key] = true;

      Cache.get('durable:' + key, Infinity, function (v, why) {
        // Не дождались базы: на диске, возможно, лежит журнал — работаем в памяти и на диск не пишем,
        // иначе запишем поверх него пустой или частичный
        if (why === 'timeout') self.readOnly[key] = true;
        var legacy = why === 'timeout' ? null : self.takeLegacy(key);
        if ((v === null || v === undefined) && legacy !== null) v = legacy;
        var touched = self.touched[key], local = self.vals[key];
        self.loading[key] = false;
        self.touched[key] = null;
        // Пока грузились, могли что-то записать — не теряем
        if (touched === 'replace') {
          v = local;                                   // «Очистить» и т. п.: прочитанное устарело
        } else if (touched) {
          var isArr = function (x) { return Object.prototype.toString.call(x) === '[object Array]'; };
          if (v === null || v === undefined) v = local;
          else if (isArr(v) && isArr(local)) v = v.concat(local);
          else if (v && typeof v === 'object' && local && typeof local === 'object') v = extend(v, local);
          else v = local;
        }
        self.vals[key] = (v === null || v === undefined) ? def : v;
        self.loaded[key] = true;
        if (legacy !== null || touched) self.flush(key);
        var w = self.waiting[key] || [];
        self.waiting[key] = [];
        for (var i = 0; i < w.length; i++) if (w[i]) w[i](self.vals[key]);
      });
    },

    get: function (key, def) {
      var v = this.vals[key];
      return v === undefined || v === null ? def : v;
    },

    // replace = true: значение заменяет всё (очистка), а не дополняет то, что ещё читается с диска
    set: function (key, val, replace) {
      var self = this;
      self.vals[key] = val;
      if (self.loading[key]) self.touched[key] = replace ? 'replace' : (self.touched[key] || 'merge');
      else if (!self.loaded[key]) self.loaded[key] = true;
      if (self.timers[key]) return;
      self.timers[key] = setTimeout(function () { self.flush(key); }, 2000);
    },

    // force — явная очистка пользователем: пишем, даже если база в этой сессии не прочиталась
    flush: function (key, force) {
      if (this.timers[key]) { clearTimeout(this.timers[key]); this.timers[key] = null; }
      if (this.loading[key] && this.touched[key] !== 'replace') return;  // запишем после чтения, уже слитое
      if (this.readOnly[key] && !force) return;
      Cache.set('durable:' + key, this.vals[key]);
    },

    flushAll: function () {
      var self = this;
      each(self.timers, function (t, key) { if (t) self.flush(key); });
    },

    persistent: function () { return !!Cache.db; }
  };

  // =========================================================================
  // TMDB через механизм Lampa (наследуем прокси пользователя)
  // =========================================================================

  // Язык данных TMDB — отдельная настройка Lampa (tmdb_lang), не язык интерфейса
  function tmdbLang() {
    try {
      var l = (Lampa.Storage.field && Lampa.Storage.field('tmdb_lang')) || Lampa.Storage.get('tmdb_lang', '');
      return l || Lampa.Storage.get('language', 'ru') || 'ru';
    } catch (e) { return 'ru'; }
  }

  // В сборке нет Lampa.TMDB.api — повторяем логику самой Lampa: свой прокси из настроек →
  // прокси CUB → напрямую. Чужих адресов в коде нет: какой прокси, решает пользователь в настройках Lampa
  function tmdbFallback(rel) {
    var proto = 'https://';
    try { proto = Lampa.Utils.protocol(); } catch (e) {}
    var direct = proto + 'api.themoviedb.org/3/' + rel;
    var field = function (n) { try { return Lampa.Storage.field ? Lampa.Storage.field(n) : Lampa.Storage.get(n, ''); } catch (e) { return ''; } };
    if (!field('proxy_tmdb')) return direct;
    var own = String(field('tmdb_proxy_api') || '').replace(/\/+$/, '');
    if (own) return (/^https?:\/\//.test(own) ? own : proto + own) + '/' + direct;
    var cub = '';
    try { cub = Lampa.Manifest && Lampa.Manifest.cub_domain; } catch (e) {}
    return cub ? proto + 'apitmdb.' + cub + '/3/' + rel : direct;
  }

  function tmdbUrl(path, params) {
    var lang = tmdbLang();

    var q = [];
    each(params || {}, function (v, k) { q.push(k + '=' + encodeURIComponent(v)); });
    q.push('language=' + lang);
    try { if (Lampa.TMDB && Lampa.TMDB.key) q.push('api_key=' + Lampa.TMDB.key()); } catch (e) {}

    var rel = path + (path.indexOf('?') > -1 ? '&' : '?') + q.join('&');

    try {
      if (Lampa.TMDB && typeof Lampa.TMDB.api === 'function') return Lampa.TMDB.api(rel);
    } catch (e) {}

    return tmdbFallback(rel);
  }

  var LIST_TTL = 7 * DAY; // рекомендации и discover меняются медленно

  function tmdb(path, params, ttl, cb) {
    var ck = 'tmdb:' + tmdbLang() + ':' + path + '?' + JSON.stringify(params || {});
    Cache.get(ck, ttl, function (hit) {
      if (hit) return cb(hit);
      Net.get(tmdbUrl(path, params), function (json) {
        if (json && typeof json === 'object' && !json.status_message) {
          Cache.set(ck, json);
          cb(json);
        } else cb(null);
      }, function () { cb(null); });
    });
  }

  // =========================================================================
  // Детали фильма в сжатом виде
  // =========================================================================

  function certOf(type, d) {
    var list = type === 'movie'
      ? (d.release_dates && d.release_dates.results)
      : (d.content_ratings && d.content_ratings.results);
    if (!list) return null;

    function pick(cc) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].iso_3166_1 !== cc) continue;
        if (type === 'movie') {
          var rd = list[i].release_dates || [];
          for (var j = 0; j < rd.length; j++) if (rd[j].certification) return rd[j].certification;
        } else if (list[i].rating) return list[i].rating;
      }
      return null;
    }

    var ru = pick('RU');
    var us = pick('US');
    if (ru) return { c: 'RU', v: ru, ru: ru, us: us };
    if (us) return { c: 'US', v: us, ru: null, us: us };
    return null;
  }

  // Одна шкала возраста для российских и американских рейтингов. PG-13 = 12+, как обещает плитка «до 12+»
  var US_AGE = { 'G': 0, 'TV-Y': 0, 'TV-G': 0, 'TV-Y7': 7, 'TV-Y7-FV': 7, 'PG': 8, 'TV-PG': 10,
    'PG-13': 12, 'TV-14': 14, 'R': 17, 'TV-MA': 17, 'NC-17': 18 };
  var KIDS_MAX_AGE = 12;
  var KIDS_UNCONFIRMED_MAX = 8;    // без российского рейтинга и без КП — только до PG

  // Возраст по самому строгому из известных рейтингов; null — рейтинга нет
  function ageOf(cert) {
    if (!cert) return null;
    var a = null;
    var n = parseInt(cert.ru || '', 10);
    if (!isNaN(n)) a = n;
    if (cert.us && US_AGE[cert.us] !== undefined) a = Math.max(a === null ? 0 : a, US_AGE[cert.us]);
    return a;
  }

  function kidsOk(cert) {
    var a = ageOf(cert);
    return a !== null && a <= KIDS_MAX_AGE;
  }

  // Контент для детей: сериальный жанр «Детское» или возрастной рейтинг ниже 7 лет
  // Детское: жанр «Детское», детский ТВ-рейтинг, либо низкий возраст (RU ≤ 6 / US G) у анимации или семейного.
  // Один низкий возраст без такого жанра — не признак: 0+/G стоит и у старой классики.
  // Анимация не считается детской, если пользователь сам заметно её смотрит
  function kidsTargeted(c, profile) {
    var g = c.genres || [];
    if (g.indexOf(10762) > -1) return true;
    var ct = c.cert;
    if (!ct) return false;
    if (ct.us && ['TV-Y', 'TV-Y7', 'TV-Y7-FV'].indexOf(ct.us) > -1) return true;
    var n = parseInt(ct.ru || '', 10);
    var young = (!isNaN(n) && n <= 6) || ct.us === 'G';
    if (!young) return false;
    var anim = g.indexOf(16) > -1, family = g.indexOf(10751) > -1;
    if (!anim && !family) return false;
    if (anim && profile && typeof profile.animShare === 'number' && profile.animShare >= KIDS_ANIM_LOVER) return false;
    return true;
  }
  var KIDS_ANIM_LOVER = 0.3;

  // 18+: жёсткий контент. Американский рейтинг надёжнее: российский 18+ в TMDB часто стоит у безобидных фильмов
  var HARD_GENRES = [28, 53, 80, 27, 10752];

  // 18+ с «жёстким» жанром. R у комедии или мелодрамы — обычно лексика, для «расслабиться» это не помеха
  function harshAdult(c) {
    if (!adultRated(c)) return false;
    if (c.moods) return (mv(c, 'violence') || 0) >= 5 || (mv(c, 'fear') || 0) >= 5;
    for (var i = 0; i < HARD_GENRES.length; i++) if ((c.genres || []).indexOf(HARD_GENRES[i]) > -1) return true;
    return false;
  }

  function adultRated(c) {
    var ct = c.cert;
    if (!ct) return false;
    if (ct.us) return ['R', 'NC-17', 'TV-MA'].indexOf(ct.us) > -1;
    var n = parseInt(ct.ru || '', 10);
    return !isNaN(n) && n >= 18;
  }

  // =========================================================================
  // Шкалы настроения (метаданные CUB)
  // =========================================================================

  // Шкалы содержания из CUB: тот же источник, что показывает сама Lampa в карточке фильма
  // (блок «Метаданные» и теги настроения). Есть только для фильмов.
  var MoodsApi = { state: null, asked: 0, got: 0, statuses: {} };   // statuses — какие ответы CUB встречались (для отладки)
  var CUB_META_N = 20;              // запрашиваем только для финалистов
  var CUB_META_DEADLINE = 5000;     // подбор не ждёт CUB дольше
  var CUB_EMPTY_TTL = 7 * DAY;      // «данных нет» перепроверяем раз в неделю

  function cubMetaOff() {
    try { return !!(window.lampa_settings && window.lampa_settings.disable_features && window.lampa_settings.disable_features.metadata); }
    catch (e) { return false; }
  }

  function cubMetaUrl(id) {
    var proto = 'https://';
    try { if (Lampa.Utils && Lampa.Utils.protocol) proto = Lampa.Utils.protocol(); } catch (e) {}
    var dom = (Lampa.Manifest && Lampa.Manifest.cub_domain) || 'cub.best';
    return proto + dom + '/api/ai/video-view/' + id + '/metadata?type=movie';
  }

  // review: [{name, values[], avg 0–10}], moods: [{name, percent}]
  function parseCubMeta(j) {
    if (!j || j.status !== 'completed' || !j.review || !j.review.length) return null;
    var out = {}, n = 0;
    for (var i = 0; i < j.review.length; i++) {
      var m = j.review[i];
      if (m && m.name && typeof m.avg === 'number') { out[String(m.name).toLowerCase()] = clamp(m.avg, 0, 10); n++; }
    }
    return n ? out : null;
  }

  // Отдельная маленькая очередь: CUB не должен занимать слоты TMDB и Кинопоиска
  var CubNet = {
    queue: [], active: 0, max: 2,
    get: function (url, ok, fail, ctx) { this.queue.push({ url: url, ok: ok, fail: fail, ctx: ctx }); this.pump(); },
    pump: function () {
      var self = this;
      while (self.active < self.max && self.queue.length) {
        (function (job) {
          self.active++;
          var settled = false;
          var end = function (fn, arg) {
            if (settled) return; settled = true;
            self.active--;
            try { fn && fn(arg); } catch (e) { log('cub callback error', e); }
            self.pump();
          };
          var req = new Lampa.Reguest();
          req.timeout(5000);
          req.silent(job.url, function (j) { end(job.ok, j); }, function (a) { end(job.fail, (a && a.status) || 0); });
          setTimeout(function () { end(job.fail, 0); }, 6000); // страховка, если таймаут Reguest не сработал
        })(self.queue.shift());
      }
    },
    // Убрать задания одного подбора; без контекста — все
    drop: function (ctx) {
      if (!ctx) { this.queue = []; return; }
      this.queue = this.queue.filter(function (j) { return j.ctx !== ctx; });
    }
  };

  function cubMeta(id, cb, ctx) {
    var ck = 'cub:' + id;
    Cache.get(ck, 30 * DAY, function (hit) {
      if (hit && (hit.s || now() - (hit.at || 0) < CUB_EMPTY_TTL)) return cb(hit.s || null, true);
      CubNet.get(cubMetaUrl(id), function (j) {
        if (j && typeof j === 'object' && j.status) {
          MoodsApi.statuses[j.status] = (MoodsApi.statuses[j.status] || 0) + 1;
          var sc = parseCubMeta(j);
          // Кешируем только понятные ответы. Прочие статусы (например, «ещё считается») — спросим в следующий раз
          if (j.status === 'completed' || j.status === 'empty') Cache.set(ck, { s: sc, at: now() });
          else log('CUB: статус', j.status, 'для', id);
          cb(sc, false);
        } else cb(null, false);
      }, function () { cb(null, false); }, ctx);
    });
  }

  // Подтягивает шкалы для лучших фильмов списка; не ждёт дольше CUB_META_DEADLINE
  // Счётчики свои у каждого подбора: поздние ответы отменённого подбора не сбивают статистику нового
  function attachCubMeta(list, cb) {
    var fired = false, ctx = {};
    var st = { got: 0, asked: 0 };
    var finish = function () {
      if (fired) return;
      fired = true;
      MoodsApi.state = st.got > 0; MoodsApi.got = st.got; MoodsApi.asked = st.asked;
      cb(st);
    };
    if (cubMetaOff()) { MoodsApi.state = false; fired = true; return cb(st); }
    var todo = list.filter(function (it) { return it.c && it.c.type === 'movie' && !it.c.moods; })
      .sort(function (a, b) { return b.score - a.score; }).slice(0, CUB_META_N);
    st.asked = todo.length;
    for (var k = 0; k < list.length; k++) if (list[k].c && list[k].c.moods) st.got++;
    if (!todo.length) return finish();
    var left = todo.length;
    setTimeout(function () { if (!fired) { log('cub meta deadline, left', left); CubNet.drop(ctx); } finish(); }, CUB_META_DEADLINE);
    for (var i = 0; i < todo.length; i++) {
      (function (it) {
        cubMeta(it.id, function (sc) {
          if (sc && !fired) { it.c.moods = sc; st.got++; }
          if (--left === 0) finish();
        }, ctx);
      })(todo[i]);
    }
  }

  // Совместимость: раньше здесь была суточная проба прокси, теперь проверка не нужна
  function probeMoods(cb) {
    MoodsApi.state = cubMetaOff() ? false : null;
    cb(!cubMetaOff());
  }

  function mv(c, key) {
    return c.moods && typeof c.moods[key] === 'number' ? c.moods[key] : null;
  }

  // Оценка соответствия настроению по шкалам; null — данных нет
  function moodFromScales(c, ans) {
    if (!c.moods) return null;
    var f = mv(c, 'fear'), h = mv(c, 'humor'), sd = mv(c, 'sadness'), v = mv(c, 'violence'),
      a = mv(c, 'action'), t = mv(c, 'tension'), r = mv(c, 'romance'), pr = mv(c, 'profanity');
    var z = function (x) { return x === null ? 0 : x; };
    var m = null;
    // Без главных для настроения шкал оценка по шкалам ненадёжна (нет шкалы ≠ ноль) — пусть решают жанры
    if (ans.mood === 'relax' && (f === null || v === null)) return null;
    if (ans.mood === 'laugh' && h === null) return null;
    if (ans.mood === 'nerves' && f === null && t === null && v === null) return null;
    if (ans.mood === 'think' && (a === null || h === null)) return null;

    if (ans.mood === 'relax') m = 1 - 0.09 * z(f) - 0.07 * z(v) - 0.05 * z(t) - 0.04 * z(sd) + 0.04 * z(h) + 0.03 * z(r);
    else if (ans.mood === 'laugh') m = h / 10 * 1.2 - 0.04 * z(f) - 0.03 * z(sd);
    // Напряжение есть не у всех фильмов, а страх у триллеров без хоррора низкий: берём максимум из страха,
    // напряжения и насилия плюс половину темпа
    else if (ans.mood === 'nerves') m = clamp((Math.max(z(f), z(t), z(v)) + 0.5 * z(mv(c, 'pace'))) / 8, 0, 1) * 0.85 + z(a) / 10 * 0.25;
    else if (ans.mood === 'think') m = 0.75 - 0.05 * z(a) - 0.04 * z(h) + 0.03 * z(sd);
    else return null;

    if ((ans.company === 'couple' || ans.company === 'group') && (ans.mood === 'relax' || ans.mood === 'laugh')) {
      m -= 0.02 * z(pr) + 0.02 * z(v);
    }
    return clamp(m, 0, 1);
  }

  function isAnimated(c) { return (c.genres || []).indexOf(16) > -1; }

  function compact(type, d) {
    var kwRaw = (d.keywords && (d.keywords.keywords || d.keywords.results)) || [];
    var cast = ((d.credits && d.credits.cast) || []).slice(0, 5);
    var dirs = [];

    if (type === 'movie') {
      var crew = (d.credits && d.credits.crew) || [];
      for (var i = 0; i < crew.length; i++) if (crew[i].job === 'Director') dirs.push(crew[i]);
    } else {
      dirs = d.created_by || [];
    }

    var runtime = null;
    if (type === 'movie') runtime = d.runtime || null;
    else if (d.episode_run_time && d.episode_run_time.length) runtime = Math.min.apply(Math, d.episode_run_time);
    else if (d.last_episode_to_air && d.last_episode_to_air.runtime) runtime = d.last_episode_to_air.runtime;

    var date = d.release_date || d.first_air_date || '';
    var names = {};
    for (var c = 0; c < cast.length; c++) names['p' + cast[c].id] = cast[c].name;
    for (var r = 0; r < dirs.length; r++) names['p' + dirs[r].id] = dirs[r].name;

    return {
      id: d.id,
      type: type,
      title: d.title || d.name || '',
      original: d.original_title || d.original_name || '',
      year: date.slice(0, 4),
      date: date,
      runtime: runtime,
      genres: normGenres((d.genres || []).map(function (g) { return g.id; })),
      kw: kwRaw.slice(0, 10).map(function (k) { return k.id; }),
      cast: cast.map(function (p) { return p.id; }),
      dir: dirs.map(function (p) { return p.id; }),
      names: names,
      lang: d.original_language || '',
      cert: certOf(type, d),
      moods: null,
      coll: d.belongs_to_collection ? d.belongs_to_collection.id : null,
      imdb: (d.external_ids && d.external_ids.imdb_id) || d.imdb_id || null,
      va: d.vote_average || 0,
      vc: d.vote_count || 0,
      card: {
        id: d.id,
        title: d.title,
        name: d.name,
        original_title: d.original_title,
        original_name: d.original_name,
        poster_path: d.poster_path,
        backdrop_path: d.backdrop_path,
        release_date: d.release_date,
        first_air_date: d.first_air_date,
        vote_average: d.vote_average,
        overview: d.overview
      }
    };
  }

  // В кеш кладём уже сжатую карточку (~1–2 КБ), а не сырой ответ с полными credits и рейтингами всех стран
  // (десятки–сотни КБ): на ТВ это лишняя память и растущая IndexedDB
  function details(type, id, cb) {
    var ck = 'det2:' + tmdbLang() + ':' + type + ':' + id;
    Cache.get(ck, 30 * DAY, function (hit) {
      if (hit) return cb(hit);
      var append = type === 'movie'
        ? 'keywords,credits,release_dates,external_ids'
        : 'keywords,credits,content_ratings,external_ids';
      Net.get(tmdbUrl(type + '/' + id, { append_to_response: append }), function (d) {
        var c = d && typeof d === 'object' && d.id ? compact(type, d) : null;
        if (c) Cache.set(ck, c);
        cb(c);
      }, function () { cb(null); });
    });
  }

  function detailsMany(items, cb) {
    var left = items.length;
    if (!left) return cb();
    for (var i = 0; i < items.length; i++) {
      (function (it) {
        details(it.type, it.id, function (c) {
          it.c = c;
          if (--left === 0) cb();
        });
      })(items[i]);
    }
  }

  // Признаки из карточки списка (без запроса деталей)
  function cardCompact(card) {
    var date = card.release_date || card.first_air_date || '';
    return {
      id: card.id,
      type: typeOf(card),
      title: card.title || card.name || '',
      year: date.slice(0, 4),
      date: date,
      genres: normGenres(card.genre_ids || (card.genres || []).map(function (g) { return g.id || g; })),
      kw: [], cast: [], dir: [], names: {},
      lang: card.original_language || '',
      va: card.vote_average || 0,
      vc: card.vote_count || 0,
      runtime: null, cert: null, coll: null
    };
  }

  // =========================================================================
  // Обратная связь (только локально)
  // =========================================================================

  // Причины «Не то»: что показываем и как это влияет на профиль
  var REJECT_REASONS = [
    { r: 'mood', title: 'Не под настроение', subtitle: 'Фильм может и хороший, но не сейчас' },
    { r: 'genre', title: 'Не мой жанр', subtitle: 'Такое вообще не смотрю' },
    { r: 'old', title: 'Слишком старое' },
    { r: 'company', title: 'Не для этой компании' },
    { r: 'meh', title: 'Не интересно' },
    { r: '', title: 'Пропустить' }
  ];
  var REJECT_SIGNAL = { mood: 0, company: 0, old: 0, genre: -0.3, meh: -0.2 };
  var REJECT_GENRE_MIN = 2;      // жанр штрафуется со второго отказа «не мой жанр»
  var REJECT_GENRE_STEP = 0.3;   // за каждый отказ сверх первого
  var REJECT_OLD_MIN = 2;        // порог по годам — со второго «слишком старое»

  function feedback() {
    var fb = store('feedback', {});
    fb.rejected = fb.rejected || {};
    fb.seen = fb.seen || {};
    fb.opened = fb.opened || {};
    return fb;
  }

  // Обратная связь остаётся в localStorage (нужна синхронно), но с ограничением размера
  function trimMap(map, max, keepIf) {
    var keys = Object.keys(map);
    if (keepIf) for (var i = 0; i < keys.length; i++) if (!keepIf(map[keys[i]])) delete map[keys[i]];
    keys = Object.keys(map);
    if (keys.length <= max) return;
    keys.sort(function (a, b) { return ((map[a] && map[a].t) || 0) - ((map[b] && map[b].t) || 0); });
    for (var j = 0; j < keys.length - max; j++) delete map[keys[j]];
  }

  function saveFeedback(fb) {
    var t = now();
    trimMap(fb.rejected, 500, function (v) { return v && t - v.t < 90 * DAY; });
    trimMap(fb.opened, 300);
    trimMap(fb.seen, 1000);
    save('feedback', fb);
  }

  function miniCard(c) {
    return {
      id: c.id, title: c.title, original_language: c.lang,
      genre_ids: c.genres, release_date: c.type === 'movie' ? c.date : undefined,
      first_air_date: c.type === 'tv' ? c.date : undefined,
      method: c.type
    };
  }

  // =========================================================================
  // Сборщик сигналов из локальных данных Lampa
  // =========================================================================

  function favList(type) {
    try {
      var r = Lampa.Favorite.get({ type: type });
      if (r && r.length) return r;
    } catch (e) {}
    return [];
  }

  // ---- «Настроить вкус»: известные фильмы и сериалы для быстрой отметки «Нравится»
  var TASTE_PAGE = 24;
  var TASTE_MAX_PAGES = 5;   // страниц каждого источника (top_rated / popular) — дальше уже нишевое

  function tasteSources(page) {
    return [
      ['movie/top_rated', 'movie'], ['tv/top_rated', 'tv'], ['movie/popular', 'movie'], ['tv/popular', 'tv']
    ].map(function (x) { return { path: x[0], type: x[1], page: page }; });
  }

  // Порция кандидатов: чередуем источники, без дублей, без уже отмеченного и не слишком нишевое
  function tasteBatch(page, seen, cb) {
    var src = tasteSources(page), left = src.length, lists = [];
    var done = function () {
      var out = [], i = 0, more = true;
      while (more) {
        more = false;
        for (var s = 0; s < lists.length; s++) {
          var it = lists[s][i];
          if (!it) continue;
          more = true;
          var k = keyOf(it.__type, it.id);
          if (seen[k]) continue;
          seen[k] = true;
          if ((it.vote_count || 0) < 1500) continue;
          if (!it.poster_path) continue;
          out.push(it);
        }
        i++;
      }
      cb(out);
    };
    for (var j = 0; j < src.length; j++) {
      (function (sx, idx) {
        tmdb(sx.path, { page: sx.page }, LIST_TTL, function (json) {
          lists[idx] = ((json && json.results) || []).map(function (r) { r.__type = sx.type; return r; });
          if (--left === 0) done();
        });
      })(src[j], j);
    }
  }

  function isLiked(card) {
    try { var st = Lampa.Favorite.check(card); return !!(st && st.like); } catch (e) { return false; }
  }

  function setLiked(card, on) {
    try {
      if (on) Lampa.Favorite.add('like', card);
      else Lampa.Favorite.remove('like', card);
      return true;
    } catch (e) { log('favorite error', e); return false; }
  }

  // Карточка в формате Lampa из ответа TMDB
  function lampaCard(r) {
    var c = {
      id: r.id, poster_path: r.poster_path, backdrop_path: r.backdrop_path, overview: r.overview,
      vote_average: r.vote_average, vote_count: r.vote_count, genre_ids: r.genre_ids, original_language: r.original_language, source: 'tmdb'
    };
    if (r.__type === 'tv') { c.name = r.name; c.original_name = r.original_name; c.first_air_date = r.first_air_date; }
    else { c.title = r.title; c.original_title = r.original_title; c.release_date = r.release_date; }
    return c;
  }

  // Мало данных о вкусе — предлагаем экран сам (один раз)
  function needsTaste() {
    if (store('taste_offered', false)) return false;
    var n = 0;
    each(['like', 'history', 'book', 'wath', 'viewed'], function (t) { n += favList(t).length; });
    return n < 5;
  }

  var fileViewCache = null;

  function fileView() {
    if (fileViewCache) return fileViewCache;
    var fv = {};
    try {
      fv = Lampa.Storage.get('file_view', {}) || {};
      if (typeof fv === 'string') fv = JSON.parse(fv);
    } catch (e) { fv = {}; }
    fileViewCache = fv;
    setTimeout(function () { fileViewCache = null; }, 5000);
    return fv;
  }

  // Прогресс фильма. Хеш в разных сборках считается от разных полей — пробуем все.
  function progress(card) {
    if (!card || typeOf(card) !== 'movie') return null;
    var names = uniq([card.original_title, card.original_name, card.title, card.name].filter(Boolean));
    var fv = fileView();
    for (var i = 0; i < names.length; i++) {
      var h;
      try { h = Lampa.Utils.hash(names[i]); } catch (e) { continue; }
      try {
        var v = Lampa.Timeline.view(h);
        if (v && v.duration > 0) return v;   // updated — если сборка его пишет
      } catch (e) {}
      var raw = fv[h];
      if (raw && raw.duration > 0) {
        return { time: raw.time || 0, duration: raw.duration, percent: raw.percent || Math.round((raw.time || 0) / raw.duration * 100), updated: raw.updated || 0 };
      }
    }
    return null;
  }

  // Начат ли сериал: последняя серия онлайн-просмотра или прогресс первых серий первого сезона
  function seriesStarted(card) {
    if (!card) return false;
    var names = uniq([card.original_name, card.original_title, card.name, card.title].filter(Boolean));
    var last = {};
    try {
      last = Lampa.Storage.get('online_watched_last', '{}') || {};
      if (typeof last === 'string') last = JSON.parse(last);
    } catch (e) { last = {}; }
    var fv = fileView();
    for (var i = 0; i < names.length; i++) {
      try {
        var lw = last[Lampa.Utils.hash(names[i])];
        if (lw && (lw.episode || lw.season)) return true;
        for (var ep = 1; ep <= 3; ep++) {
          var h = Lampa.Utils.hash([1, '', ep, names[i]].join(''));
          var v = null;
          try { v = Lampa.Timeline.view(h); } catch (e) {}
          if ((v && v.percent > 0) || (fv[h] && (fv[h].percent > 0 || fv[h].time > 0))) return true;
        }
      } catch (e) {}
    }
    return false;
  }

  // Начат ли просмотр карточки любого типа
  function startedAny(r, type) {
    if (type === 'tv') return seriesStarted(r);
    var p = progress(extend(r, { method: 'movie' }));
    return !!(p && (p.percent > 0 || p.time > 0));
  }

  var OPENED_HIDE = 3 * DAY;  // открытое из подборки, но не начатое — не повторяем 3 дня

  function finished(v) {
    return v.percent >= 85 || (v.duration - v.time) <= 600;
  }

  var SHORT_MIN = 15;            // фильмы короче, минут, не предлагаем
  var STARTED_FRESH = 14 * DAY;  // начатое на 1–20 % свежее этого — ещё не «брошено»
  var SEEN_STALE_MAX = 200;      // столько «лишних» дат в picker_seen терпим без чистки
  var SEEN_MIN_LISTED = 20;      // ...и чистим, только если списки Lampa явно загрузились

  var CLASSIC_RATING = 8.0;     // такие старые фильмы не опускают границу по годам
  var LIKE_BATCH_WEIGHT = 0.6;  // вес отметки из пачки вместо 1,0
  var LIKE_BATCH = 6;            // столько «Нравится» за день — уже пачка
  var LIKE_BATCH_HISTORY = 30;   // ...и сглаживаем её, только если остальной истории не меньше
  var SEED_BATCH_SHARE = 0.4;    // доля опорных фильмов, которую может занять такая пачка

  function collect() {
    var map = {};
    var flags = {};
    var seen = store('seen', {});
    var t = now();
    var dirty = false;

    // Момент первичного импорта истории. В этот момент все карточки получают одну дату,
    // и это не «пачка» с экрана «Настроить вкус». Для старых установок — самая ранняя дата в seen
    var initT = store('seen_init', 0);
    if (!initT) {
      var minT = 0;
      each(seen, function (v) { if (v && (!minT || v < minT)) minT = v; });
      initT = minT || t;
      save('seen_init', initT);
    }

    function put(card, s, from) {
      if (!card || !card.id) return;
      var type = typeOf(card);
      var k = keyOf(type, card.id);
      flags[k] = flags[k] || {};
      flags[k][from] = true;

      var cur = map[k];
      if (!cur || Math.abs(s) > Math.abs(cur.s)) map[k] = { k: k, id: card.id, type: type, card: card, s: s };
      if (!seen[k]) { seen[k] = t; dirty = true; }
    }

    each(SIGNALS, function (sig, ft) {
      var list = favList(ft);
      for (var i = 0; i < list.length; i++) {
        var card = list[i];
        var s = sig;
        if (ft === 'history') {
          var p = progress(card);
          if (p) {
            var fk = keyOf('movie', card.id);
            flags[fk] = flags[fk] || {};
            if (finished(p)) { s = 0.8; flags[fk].viewed = true; }
            else if (p.percent > 20) { s = 0.3; flags[fk].started = true; }
            else if (p.percent > 0) {
              // Чуть начато: «брошено» только если давно. Дата — из таймлайна, иначе — дата знакомства
              // (кроме первичного импорта: там дата ничего не говорит о времени просмотра)
              var pt = p.updated > 0 ? p.updated : (seen[fk] || t);
              var fresh = (p.updated > 0 || pt !== initT) && t - pt < STARTED_FRESH;
              s = fresh ? 0 : -0.5;
            }
          }
        }
        put(card, s, ft);
      }
    });

    var fb = feedback();
    // Открыл из подборки = «удачная рекомендация»: заметный плюс, может стать опорным фильмом
    each(fb.opened, function (rec, k) {
      if (!rec || !rec.card) return;
      // Открыл, а потом отклонил — отказ отменяет «удачную рекомендацию»
      var rj = fb.rejected[k];
      if (rj && rj.t >= rec.t) return;
      put(rec.card, 0.5, 'opened');
    });
    // Сила минуса зависит от причины: «не под настроение» и «не для компании» о вкусе ничего не говорят
    each(fb.rejected, function (rec) {
      if (!rec || !rec.card) return;
      var rs = REJECT_SIGNAL[rec.r];
      put(rec.card, typeof rs === 'number' ? rs : -0.2, 'rejected');
    });
    each(fb.seen, function (rec) { if (rec && rec.card) put(rec.card, 0, 'seen'); });

    // Даты карточек, которых больше нет ни в списках Lampa, ни в обратной связи, не нужны.
    // Чистим, только когда лишнего много и списки явно загружены (иначе потеряем даты из-за пустой синхронизации)
    var stale = [], mapN = Object.keys(map).length;
    each(seen, function (v, k) { if (!map[k]) stale.push(k); });
    if (stale.length > SEEN_STALE_MAX && mapN >= SEEN_MIN_LISTED) {
      for (var si = 0; si < stale.length; si++) delete seen[stale[si]];
      dirty = true;
    }

    if (dirty) save('seen', seen);

    var events = [];
    each(map, function (e, k) {
      e.date = seen[k] || t;
      e.flags = flags[k] || {};
      events.push(e);
    });

    // Пачка «Нравится» за один день (экран «Настроить вкус» или ручная разметка) при большой истории —
    // это рассказ о вкусе в целом, а не свежий интерес: даём ей «среднюю» дату истории,
    // иначе десяток отметок перевешивает сотни событий
    var byDay = {};
    for (var bi = 0; bi < events.length; bi++) {
      var be = events[bi];
      if (!be.flags.like || be.date === initT) continue;   // первичный импорт — не пачка
      var dk = Math.floor(be.date / DAY);
      (byDay[dk] = byDay[dk] || []).push(be);
    }
    var batch = [];
    each(byDay, function (list) { if (list.length >= LIKE_BATCH) batch = batch.concat(list); });
    if (batch.length && events.length - batch.length >= LIKE_BATCH_HISTORY) {
      var dates = [];
      for (var di = 0; di < events.length; di++) if (batch.indexOf(events[di]) < 0) dates.push(events[di].date);
      dates.sort(function (a, b) { return a - b; });
      var mid = dates[Math.floor(dates.length / 2)];
      for (var bj = 0; bj < batch.length; bj++) {
        batch[bj].date = Math.min(batch[bj].date, mid);
        batch[bj].batch = true;
        // и вес меньше обычного «Нравится»: пачка не должна перекрывать то, что человек реально смотрит
        if (batch[bj].s > LIKE_BATCH_WEIGHT) batch[bj].s = LIKE_BATCH_WEIGHT;
      }
    }

    return events;
  }

  // =========================================================================
  // Профиль вкуса
  // =========================================================================

  function decay(date) {
    return Math.pow(0.5, ((now() - date) / DAY) / 180);
  }

  function featuresOf(c) {
    var dec = c.year ? [String(Math.floor(parseInt(c.year, 10) / 10) * 10)] : [];
    return {
      genre: c.genres || [],
      keyword: c.kw || [],
      cast: c.cast || [],
      director: c.dir || [],
      decade: dec,
      lang: c.lang ? [c.lang] : []
    };
  }

  // Детали для самых значимых событий (ключевые слова, режиссёр, актёры)
  function enrichEvents(events, cb) {
    events.sort(function (a, b) {
      return Math.abs(b.s) * decay(b.date) - Math.abs(a.s) * decay(a.date);
    });

    var top = [];
    for (var i = 0; i < events.length; i++) {
      events[i].c = cardCompact(events[i].card);
      if (events[i].s !== 0 && top.length < 25) top.push(events[i]);
    }

    var left = top.length;
    if (!left) return cb();

    for (var j = 0; j < top.length; j++) {
      (function (e) {
        details(e.type, e.id, function (c) {
          if (c) e.c = c;
          if (--left === 0) cb();
        });
      })(top[j]);
    }
  }

  function buildProfile(events) {
    var acc = {}, cnt = {}, names = {};
    each(AFFINITY_COEF, function (v, t) { acc[t] = {}; cnt[t] = {}; });

    var n = 0, pos = 0;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (!e.s || !e.c) continue;
      n++;
      if (e.s > 0) pos++;
      var w = e.s * decay(e.date);
      var f = featuresOf(e.c);
      each(f, function (vals, t) {
        for (var j = 0; j < vals.length; j++) {
          var x = vals[j];
          acc[t][x] = (acc[t][x] || 0) + w;
          cnt[t][x] = (cnt[t][x] || 0) + 1;
        }
      });
      each(e.c.names || {}, function (nm, pid) { names[pid] = nm; });
    }

    // pos — положительные события: по ним решаем, «знаем ли мы вкус» (одни отказы вкус не описывают)
    var profile = { n: n, pos: pos, f: {}, names: names };
    for (var lb = 0; lb < events.length; lb++) if (events[lb].batch) profile.likeBatch = (profile.likeBatch || 0) + 1;

    each(acc, function (vals, t) {
      var out = {}, max = 0;
      each(vals, function (v, x) {
        var c = cnt[t][x];
        var val = v / Math.sqrt(c);
        if (c === 1) val *= 0.5;
        out[x] = val;
        if (Math.abs(val) > max) max = Math.abs(val);
      });
      if (max > 0) each(out, function (v, x) { out[x] = v / max; });

      // Жанры центрируем: важно, какие жанры выше среднего у пользователя, а не что «нравится всё»
      if (t === 'genre') {
        var keys = Object.keys(out);
        if (keys.length > 3) {
          var mean = 0;
          for (var i = 0; i < keys.length; i++) mean += out[keys[i]];
          mean /= keys.length;
          var m2 = 0;
          for (var j = 0; j < keys.length; j++) {
            out[keys[j]] -= mean;
            if (Math.abs(out[keys[j]]) > m2) m2 = Math.abs(out[keys[j]]);
          }
          if (m2 > 0) for (var q = 0; q < keys.length; q++) out[keys[q]] /= m2;
        }
      }
      profile.f[t] = out;
    });

    // Доля анимации среди того, что нравится: анимация — формат, а не жанр
    var posW = 0, animW = 0;
    for (var ai = 0; ai < events.length; ai++) {
      var ae = events[ai];
      if (!(ae.s > 0) || !ae.c) continue;
      var aw = ae.s * decay(ae.date);
      posW += aw;
      if (isAnimated(ae.c)) animW += aw;
    }
    profile.animShare = posW > 0 ? animW / posW : 0.2;

    // Нижняя граница годов из данных пользователя: десятилетия, которые вместе дают 90% веса того, что нравится.
    // Мало истории — границы нет.
    var decW = {}, decTotal = 0, decN = 0;
    for (var di = 0; di < events.length; di++) {
      var de = events[di];
      if (!(de.s > 0) || !de.c || !de.c.year) continue;
      // Классика с очень высоким рейтингом: «понравился шедевр» ≠ «смотрю старое»
      if ((de.c.va || 0) >= CLASSIC_RATING && parseInt(de.c.year, 10) < new Date().getFullYear() - 25) continue;
      var dy = parseInt(de.c.year, 10);
      if (isNaN(dy)) continue;
      var dk = Math.floor(dy / 10) * 10;
      var dw = de.s * decay(de.date);
      decW[dk] = (decW[dk] || 0) + dw;
      decTotal += dw;
      decN++;
    }
    profile.yearFloor = null;
    if (decN >= 10 && decTotal > 0) {
      var decs = Object.keys(decW).map(Number).sort(function (x, y) { return y - x; });
      var acc90 = 0;
      for (var dd = 0; dd < decs.length; dd++) {
        acc90 += decW[decs[dd]];
        profile.yearFloor = decs[dd];
        if (acc90 >= decTotal * 0.9) break;
      }
    }

    // Явные причины отказов: «не мой жанр» и «слишком старое» — только при повторе
    // «Не мой жанр» засчитывается одному жанру фильма — самому нетипичному для пользователя
    // (драме — только если других жанров нет: она стоит у половины фильмов). Привязка «фильм → жанр»
    // хранится отдельно и не исчезает вместе с 90-дневными отказами — выученное не забывается
    var rej = feedback().rejected, gRej = {}, oldYears = [];
    var gMap = store('genre_rej', {}), gDirty = false;
    var baseG = profile.f.genre || {};
    each(rej, function (rec, k) {
      if (!rec || !rec.card || !rec.r) return;
      if (rec.r === 'genre') {
        if (gMap[k] === undefined) {
          var gs = normGenres(rec.card.genre_ids || []);
          var cand = gs.length > 1 ? gs.filter(function (g) { return g !== 18; }) : gs;
          var pick = null;
          for (var gi = 0; gi < cand.length; gi++) {
            var wv = typeof baseG[cand[gi]] === 'number' ? baseG[cand[gi]] : 0;
            if (pick === null || wv < pick.w) pick = { g: cand[gi], w: wv };
          }
          gMap[k] = pick ? pick.g : null;
          gDirty = true;
        }
      } else if (rec.r === 'old') {
        var oy = parseInt(String(rec.card.release_date || rec.card.first_air_date || '').slice(0, 4), 10);
        if (!isNaN(oy)) oldYears.push(oy);
      }
    });
    if (gDirty) {
      var gk = Object.keys(gMap);
      if (gk.length > 300) for (var gx = 0; gx < gk.length - 300; gx++) delete gMap[gk[gx]];
      save('genre_rej', gMap);
    }
    each(gMap, function (g) { if (g !== null && g !== undefined) gRej[g] = (gRej[g] || 0) + 1; });
    profile.rejGenres = {};
    profile.f.genre = profile.f.genre || {};
    each(gRej, function (cntG, g) {
      if (cntG < REJECT_GENRE_MIN) return;
      var pen = REJECT_GENRE_STEP * (cntG - 1);
      profile.f.genre[g] = clamp((profile.f.genre[g] || 0) - pen, -1, 1);
      profile.rejGenres[g] = cntG;
    });
    if (oldYears.length >= REJECT_OLD_MIN) {
      oldYears.sort(function (a, b) { return b - a; });
      // Второй по свежести отвергнутый год — граница; одиночный отказ её не двигает
      var oldFloor = Math.floor(oldYears[REJECT_OLD_MIN - 1] / 10) * 10 + 10;
      if (!profile.yearFloor || oldFloor > profile.yearFloor) { profile.yearFloor = oldFloor; profile.yearFloorBy = 'rejects'; }
    }

    // Опорные — только то, что вы видели и оценили: «Нравится» и просмотренное (список «Просмотрено» или досмотрено).
    // Открытое из подборки, закладки и «Позже» влияют на вкус, но «Похож на …» по ним не строим — фильм вы ещё не видели
    var seeds = events.filter(function (e) { return e.s > 0.25 && e.flags && (e.flags.like || e.flags.viewed); });
    seeds.sort(function (a, b) { return b.s * decay(b.date) - a.s * decay(a.date); });
    // Пачка отметок не занимает все опорные места
    var seedMax = 15, batchMax = Math.round(seedMax * SEED_BATCH_SHARE), nb = 0, picked = [];
    for (var sx = 0; sx < seeds.length && picked.length < seedMax; sx++) {
      if (seeds[sx].batch) { if (nb >= batchMax) continue; nb++; }
      picked.push(seeds[sx]);
    }
    profile.seeds = picked;

    var recent = events.filter(function (e) { return e.s > 0; })
      .sort(function (a, b) { return b.date - a.date; }).slice(0, 10);
    profile.recentGenres = [];
    profile.recentDecades = [];
    for (var r = 0; r < recent.length; r++) {
      var rf = featuresOf(recent[r].c);
      profile.recentGenres = uniq(profile.recentGenres.concat(rf.genre));
      profile.recentDecades = uniq(profile.recentDecades.concat(rf.decade));
    }

    return profile;
  }

  function topGenres(profile, count, positiveOnly) {
    var arr = [];
    each(profile.f.genre || {}, function (v, g) {
      if (!positiveOnly || v > 0) arr.push({ g: parseInt(g, 10), v: v });
    });
    arr.sort(function (a, b) { return b.v - a.v; });
    return arr.slice(0, count).map(function (x) { return x.g; });
  }

  // =========================================================================
  // Кандидаты
  // =========================================================================

  function wantedTypes(ans) {
    if (ans.time === 'series') return ['tv'];
    if (ans.time === '90' || ans.time === '120') return ['movie'];
    return ['movie', 'tv'];
  }

  // Пары и одиночные жанры для discover: пересечение «подходит под настроение» × «нравится пользователю»
  function discoverPlan(profile, ans) {
    var mood = MOODS[ans.mood];
    var user = topGenres(profile, 4, true);
    var plan = [];
    var seen = {};
    var push = function (genres, kind, w) {
      var key = genres.slice().sort().join(',');
      if (seen[key]) return;
      seen[key] = true;
      plan.push({ g: genres, kind: kind, w: w });
    };

    var hasMood = false;
    if (mood) each(mood.w, function () { hasMood = true; });

    // С детьми — сначала семейное и мультфильмы, потом остальное
    if (ans.company === 'kids') { push([10751], 'kids', 1); push([16, 10751], 'kids', 1); push([12, 10751], 'kids', 1); }

    if (hasMood) {
      var mg = moodPlus(mood, 3);
      var pairs = [];
      for (var i = 0; i < mg.length; i++) {
        for (var j = 0; j < user.length; j++) {
          if (mg[i] === user[j]) continue;
          var uw = (profile.f.genre && profile.f.genre[user[j]]) || 0;
          var own = mood.w[user[j]];
          if (own !== undefined && own < 0) continue;         // жанр пользователя мешает настроению
          pairs.push({ g: [mg[i], user[j]], w: mood.w[mg[i]] * (0.5 + uw) });
        }
      }
      pairs.sort(function (a, b) { return b.w - a.w; });
      for (var p = 0; p < Math.min(4, pairs.length); p++) push(pairs[p].g, 'pair', pairs[p].w);
      for (var k = 0; k < Math.min(2, mg.length); k++) push([mg[k]], 'mood', mood.w[mg[k]]);
      // Жанры пользователя, которые сами подходят под настроение
      for (var u = 0; u < user.length; u++) {
        var uwm = mood.w[user[u]];
        if (uwm !== undefined && uwm > 0) push([user[u]], 'user', uwm);
      }
    } else {
      for (var z = 0; z < Math.min(3, user.length); z++) push([user[z]], 'user', 1);
      if (!plan.length) { push([35], 'user', 1); push([18], 'user', 1); push([878], 'user', 1); }
    }
    return plan.slice(0, 7);
  }

  function moodExclude(ans, type) {
    var mood = MOODS[ans.mood];
    var out = [];
    if (mood) each(mood.w, function (v, g) { if (v <= -0.5) out.push(parseInt(g, 10)); });
    if (ans.company === 'kids') out = out.concat([27, 10752]);
    if (type === 'tv') out = out.map(toTvGenre).filter(Boolean);
    return uniq(out);
  }

  var TASTE_KW = 6, TASTE_DIR = 3, TASTE_CAST = 4, PPL_MIN_RATING = 6.0;

  // Сильнейшие положительные признаки профиля (id), не меньше порога
  function topPositive(map, n, min) {
    var arr = [];
    each(map || {}, function (v, k) { if (v >= min) arr.push([k, v]); });
    arr.sort(function (a, b) { return b[1] - a[1]; });
    return arr.slice(0, n).map(function (x) { return x[0]; });
  }

  function gatherPool(profile, events, ans, cb) {
    var pool = {};
    var pending = 1; // защитная единица: снимается после постановки всех запросов
    var closed = false;
    var types = wantedTypes(ans);
    var srcCount = {};

    function add(list, type, seed, src) {
      for (var i = 0; i < (list || []).length; i++) {
        var r = list[i];
        var t = r.media_type || type;
        if (t !== 'movie' && t !== 'tv') continue;
        if (types.indexOf(t) < 0) continue;
        var k = keyOf(t, r.id);
        if (!pool[k]) {
          pool[k] = { k: k, id: r.id, type: t, r: r, seedHits: 0, seeds: [], wath: false, src: src, srcs: {} };
          srcCount[src] = (srcCount[src] || 0) + 1;
        }
        // Все источники, где встретился фильм; основной — по приоритету, а не по тому, кто ответил первым
        (pool[k].srcs = pool[k].srcs || {})[src] = true;   // у карточек из «Позже» и франшиз srcs может не быть
        if (srcRank(src) < srcRank(pool[k].src)) pool[k].src = src;
        if (seed) { pool[k].seedHits++; pool[k].seeds.push(seed); }
      }
    }

    function req(path, params, type, seed, src) {
      pending++;
      tmdb(path, params, LIST_TTL, function (json) {
        // Ошибка в разборе одного ответа не должна вешать весь подбор до таймера
        try { if (json && json.results) add(json.results, type, seed, src); } catch (e) { log('pool add error', e); }
        if (--pending === 0) finish();
      });
    }

    function finish() {
      if (closed) return;
      closed = true;
      pool.__src = srcCount;
      cb(pool);
    }

    var short = ans.time === '40';
    var limited = ans.time !== 'any';
    var surprise = ans.mood === 'surprise';
    var floor = profile.yearFloor ? profile.yearFloor - (surprise ? 10 : 0) : null;

    // 1. Рекомендации по seed-фильмам — только от тех, что сами подходят под настроение
    var fits = [], rest = [];
    for (var si = 0; si < profile.seeds.length; si++) {
      var sd = profile.seeds[si];
      if (types.length === 1 && sd.type !== types[0]) continue;
      if (!sd.c) continue;
      if (MOODS[ans.mood] && moodScore(sd.c, ans, profile) < 0.5) rest.push(sd);
      else fits.push(sd);
    }
    // При ограничении по времени рекомендации чаще мимо по длительности — берём меньше
    var seedCap = limited ? 5 : 8;
    var seeds = fits.slice(0, seedCap);
    if (seeds.length < 3) seeds = seeds.concat(rest.slice(0, 3 - seeds.length));
    for (var i = 0; i < seeds.length; i++) {
      var s0 = seeds[i];
      req(s0.type + '/' + s0.id + '/recommendations', { page: 1 }, s0.type, s0.c ? s0.c.title : '', 'rec');
    }

    // 2. Discover: пересечение настроения и вкуса, длительность и годы фильтрует сам TMDB
    var plan = discoverPlan(profile, ans);
    for (var t = 0; t < types.length; t++) {
      var type = types[t];
      var excl = moodExclude(ans, type);
      for (var g = 0; g < plan.length; g++) {
        var ids = [];
        for (var gi = 0; gi < plan[g].g.length; gi++) {
          var gid = type === 'tv' ? toTvGenre(plan[g].g[gi]) : plan[g].g[gi];
          if (gid && ids.indexOf(gid) < 0) ids.push(gid);
        }
        if (ids.length !== plan[g].g.length) continue;
        var p = {
          with_genres: ids.join(','),
          sort_by: 'popularity.desc',
          'vote_count.gte': type === 'tv' ? 100 : (short ? 150 : 200),
          'vote_average.gte': 6
        };
        if (floor) p[type === 'tv' ? 'first_air_date.gte' : 'primary_release_date.gte'] = floor + '-01-01';
        if (type === 'movie' && limited) {
          var lim = short ? 45 : parseInt(ans.time, 10) + 10;
          if (!isNaN(lim)) p['with_runtime.lte'] = lim;
        }
        if (type === 'tv' && short) p['with_runtime.lte'] = 35;
        if (type === 'tv' && ans.time === 'series') p['with_runtime.lte'] = 60;
        var ex = excl.filter(function (x) { return ids.indexOf(x) < 0; });
        if (ex.length) p.without_genres = ex.join(',');

        req('discover/' + type, extend(p, { page: 1 }), type, null, 'disc');
        if (plan[g].kind !== 'pair' && types.length === 1) req('discover/' + type, extend(p, { page: 2 }), type, null, 'disc');
      }
    }

    // 3. Исследование: жанр с небольшим положительным весом
    var all = topGenres(profile, 6, true);
    if (all.length > 3) {
      var exg = all[3 + Math.floor(rng(todaySeed())() * (all.length - 3))];
      var exType = types[0];
      var exId = exType === 'tv' ? toTvGenre(exg) : exg;
      if (exId) {
        var ep = { with_genres: exId, sort_by: 'vote_average.desc', 'vote_count.gte': 500, page: 1 };
        if (floor) ep[exType === 'tv' ? 'first_air_date.gte' : 'primary_release_date.gte'] = floor + '-01-01';
        req('discover/' + exType, ep, exType, null, 'explore');
      }
    }

    // 4. По вкусу, а не по жанру: ключевые слова любимых фильмов и любимые режиссёры/актёры.
    //    Даёт личные кандидаты в настроениях, где опорных фильмов почти нет.
    var tasteBase = function (type) {
      var tp = { sort_by: 'popularity.desc', 'vote_count.gte': type === 'tv' ? 100 : (short ? 150 : 200), 'vote_average.gte': 6, page: 1 };
      if (floor) tp[type === 'tv' ? 'first_air_date.gte' : 'primary_release_date.gte'] = floor + '-01-01';
      if (type === 'movie' && limited) {
        var tl = short ? 45 : parseInt(ans.time, 10) + 10;
        if (!isNaN(tl)) tp['with_runtime.lte'] = tl;
      }
      if (type === 'tv' && short) tp['with_runtime.lte'] = 35;
      if (type === 'tv' && ans.time === 'series') tp['with_runtime.lte'] = 60;
      var tex = moodExclude(ans, type);
      if (tex.length) tp.without_genres = tex.join(',');
      return tp;
    };
    var kws = topPositive(profile.f.keyword, TASTE_KW, 0.3);
    if (kws.length >= 2) {
      for (var tk = 0; tk < types.length; tk++) {
        req('discover/' + types[tk], extend(tasteBase(types[tk]), { with_keywords: kws.join('|') }), types[tk], null, 'kw');
      }
    }
    // with_people есть только у фильмов
    var ppl = uniq(topPositive(profile.f.director, TASTE_DIR, 0.3).concat(topPositive(profile.f.cast, TASTE_CAST, 0.3)));
    if (ppl.length && types.indexOf('movie') > -1) {
      // Порог рейтинга для фильмов любимых людей (настраивается отдельно от общего поиска)
      req('discover/movie', extend(tasteBase('movie'), { with_people: ppl.join('|'), 'vote_count.gte': short ? 100 : 150, 'vote_average.gte': PPL_MIN_RATING }), 'movie', null, 'ppl');
    }

    // 5. Закладки «Позже»
    for (var e = 0; e < events.length; e++) {
      var ev = events[e];
      var intent = null;
      for (var it = 0; it < INTENT_TYPES.length && !intent; it++) if (ev.flags[INTENT_TYPES[it]]) intent = INTENT_TYPES[it];
      if (!intent || types.indexOf(ev.type) < 0) continue;
      if (!pool[ev.k]) {
        pool[ev.k] = { k: ev.k, id: ev.id, type: ev.type, r: ev.card, seedHits: 0, seeds: [], wath: true, src: 'wath', srcs: { wath: true } };
        srcCount.wath = (srcCount.wath || 0) + 1;
      } else pool[ev.k].wath = true;
      pool[ev.k].list = intent;
    }

    if (--pending === 0) finish();
  }

  function extend(a, b) {
    var o = {};
    each(a, function (v, k) { o[k] = v; });
    each(b, function (v, k) { o[k] = v; });
    return o;
  }

  // =========================================================================
  // Фильтры
  // =========================================================================

  function excludedKeys(events) {
    var ex = {};
    var fb = feedback();
    var t = now();

    for (var i = 0; i < events.length; i++) {
      var f = events[i].flags || {};
      for (var j = 0; j < WATCHED_TYPES.length; j++) if (f[WATCHED_TYPES[j]]) ex[events[i].k] = 'watched';
      if (f.started || f.viewed) ex[events[i].k] = 'watched';
      else if (f.look) ex[events[i].k] = 'watching';      // «Смотрю» — в процессе
      // Уже открывали в Lampa: прогресс мог не распознаться, повторно не предлагаем
      else if (!ex[events[i].k] && (f.history || f.continued)) ex[events[i].k] = 'history';
    }
    each(fb.opened, function (v, k) { if (!ex[k] && v && t - v.t < OPENED_HIDE) ex[k] = 'opened'; });
    each(fb.seen, function (v, k) { ex[k] = 'seen'; });
    each(fb.rejected, function (v, k) { if (v && t - v.t < 90 * DAY) ex[k] = 'rejected'; });
    return ex;
  }

  // Проверки до загрузки деталей — общие для пула и для подставленных частей франшиз.
  // Пустая строка — подходит, иначе причина отсева
  function preReason(it, ex, ans) {
    if (ex[it.k]) return ex[it.k];
    var r = it.r || {};
    // Начатое (в том числе онлайн, мимо истории Lampa) не предлагаем никогда
    if (startedAny(r, it.type)) return 'started';
    if (!it.wath) {
      var date = r.release_date || r.first_air_date || '';
      if (date && date > new Date().toISOString().slice(0, 10)) return 'future';
      var minVotes = it.type === 'tv' ? 100 : (ans.time === '40' ? 150 : 200);
      if ((r.vote_count || 0) < minVotes) return 'votes';
    }
    return '';
  }

  function prefilter(pool, events, ans, stats) {
    var ex = excludedKeys(events);
    var out = [];
    stats = stats || {};

    each(pool, function (it, k) {
      if (k === '__src') return;
      var why = preReason(it, ex, ans);
      if (why) stats[why] = (stats[why] || 0) + 1;
      else out.push(it);
    });
    return out;
  }

  // Пустая строка — подходит, иначе причина отсева
  function postReason(it, ans, profile, final) {
    var c = it.c;
    if (!c) return 'no_details';

    if (ans.time === '40') {
      if (!c.runtime) return 'no_runtime';
      if (c.type === 'movie' && c.runtime > 40) return 'too_long';
      if (c.type === 'tv' && c.runtime > 35) return 'too_long';
    } else if (ans.time === '90' || ans.time === '120') {
      if (c.type !== 'movie') return 'not_movie';
      if (!c.runtime) return 'no_runtime';
      if (c.runtime > parseInt(ans.time, 10) + 10) return 'too_long';
    } else if (ans.time === 'series') {
      if (c.type !== 'tv') return 'not_tv';
      if (c.runtime && c.runtime > 60) return 'too_long';
    }

    // Короткометражки на 3–14 минут — не просмотр на вечер (сериалы не трогаем: у них длительность серии)
    if (c.type === 'movie' && c.runtime && c.runtime < SHORT_MIN) return 'too_short';
    if (c.type === 'movie' && c.runtime && c.runtime <= 45 && (c.vc || 0) < 150) return 'votes';

    if (ans.company !== 'kids' && kidsTargeted(c, profile)) return 'kids_content';

    // Смотрят не одни, а анимация пользователю почти не интересна — второму зрителю тем более
    if ((ans.company === 'couple' || ans.company === 'group') && isAnimated(c) && profile && profile.pos >= 5 &&
      typeof profile.animShare === 'number' && profile.animShare < 0.2) return 'anim_format';

    if (ans.company === 'kids') {
      if (c.moods && ((mv(c, 'fear') || 0) > 6 || (mv(c, 'violence') || 0) > 5 || (mv(c, 'profanity') || 0) > 3 || (mv(c, 'sex') || 0) > 2)) return 'kids_moods';
      // Возраст — самый строгий из TMDB (RU/US) и Кинопоиска
      var age = ageOf(c.cert);
      var kpKnown = typeof c.kpAge === 'number';
      if (kpKnown && c.kpAge >= 0) age = Math.max(age === null ? 0 : age, c.kpAge);
      if (age === null || age > KIDS_MAX_AGE) return kpKnown && c.kpAge > KIDS_MAX_AGE ? 'kids_kp_age' : 'kids_cert';
      // Подтверждения нет (КП не ответил, российского рейтинга нет) — по одному американскому рейтингу
      // пускаем только G/PG: PG-13 у TMDB бывает и у того, что на КП 18+
      var ruKnown = c.cert && !isNaN(parseInt(c.cert.ru || '', 10));
      // Решаем только на финальной проверке — до неё КП ещё не спрашивали
      if (final && !kpKnown && !ruKnown && age > KIDS_UNCONFIRMED_MAX) return 'kids_unconfirmed';
      if (c.genres.indexOf(27) > -1 || c.genres.indexOf(10752) > -1) return 'kids_genre';
    }

    return '';
  }

  // =========================================================================
  // Скоринг
  // =========================================================================

  function kpCache() {
    try { return Lampa.Storage.cache('kp_rating', 500, {}) || {}; } catch (e) { return {}; }
  }

  // ---- КП и IMDb в оценке качества: поправка к TMDB, а не замена.
  // Шкалы смещены, поэтому учитываем, насколько фильм на КП/IMDb лучше или хуже обычного при таком рейтинге TMDB.
  // Нет оценки — поправка 0, фильм идёт ровно по TMDB.
  var RATE_ALPHA_MIN = 0.15;   // вес поправки при большом числе голосов TMDB
  var RATE_ALPHA_MAX = 0.30;   // ... и при малом (TMDB ненадёжен)
  var RATE_FRESH_VOTES = 3000; // «свежий» — меньше стольких голосов на TMDB
  var RATE_FRESH_EXTRA = 0.3;   // добавка к весу поправки для свежих при расхождении ≥ 1,5 пункта
  var RATE_KP_SHARE = 2 / 3;   // КП : IMDb = 2 : 1
  var RATE_DEF_OFF = { kp: -0.2, imdb: 0.1 };  // смещение к TMDB по умолчанию, пока своих данных мало
  var RATE_OFF_PRIOR = 20;     // «вес» значения по умолчанию в числе наблюдений

  // Оценки из кеша: rating.js (kp_rating) и свой kpmap. Без сети.
  function cachedRatings(c, k) {
    // Кеш rating.js хранит по id TMDB без типа: у фильма и сериала id могут совпасть — для сериалов не берём
    var rec = c.type === 'tv' ? null : kpCache()[c.id];
    if (rec && (parseFloat(rec.kp) > 0 || parseFloat(rec.imdb) > 0)) return { kp: parseFloat(rec.kp) || 0, imdb: parseFloat(rec.imdb) || 0 };
    var m = Durable.get('kpmap', {})[k];
    if (m && now() - m.t < 14 * DAY && (m.kp || m.imdb)) return { kp: m.kp || 0, imdb: m.imdb || 0 };
    return null;
  }

  // Среднее смещение КП−TMDB и IMDb−TMDB по накопленным данным, сжатое к значению по умолчанию
  function ratingOffsets(items) {
    var acc = { kp: [0, 0], imdb: [0, 0] };
    var add = function (va, kp, im) {
      if (!(va > 0)) return;
      if (kp > 0) { acc.kp[0] += kp - va; acc.kp[1]++; }
      if (im > 0) { acc.imdb[0] += im - va; acc.imdb[1]++; }
    };
    var mp = Durable.get('kpmap', {});
    each(mp, function (m) { if (m) add(m.va, m.kp, m.imdb); });
    // Кандидаты из кеша — только те, что ещё не учтены через kpmap (например, из кеша rating.js),
    // иначе одно наблюдение считается дважды. Запись kpmap без оценок или без TMDB не считается учтённой
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var mm = mp[it.k];
      var counted = mm && mm.va > 0 && (mm.kp > 0 || mm.imdb > 0);
      if (it.rt && it.c && it.rt.src === 'cache' && !counted) add(it.c.va, it.rt.kp, it.rt.imdb);
    }
    var off = {};
    each(acc, function (a, k) { off[k] = (a[0] + RATE_DEF_OFF[k] * RATE_OFF_PRIOR) / (a[1] + RATE_OFF_PRIOR); });
    off.n = acc.kp[1];
    return off;
  }

  function quality(c, C, rt, off) {
    if (!(c.va > 0)) return { q: 0, r: 0, corr: 0, boost: 0 };
    var m = c.type === 'tv' ? 200 : 500;
    var v = c.vc || 0;
    var wr = (v / (v + m)) * c.va + (m / (v + m)) * C;

    // Поправка в пунктах рейтинга
    var corr = 0, kp = rt ? rt.kp || 0 : 0, im = rt ? rt.imdb || 0 : 0;
    var dk = kp > 0 ? kp - c.va - off.kp : null;
    var di = im > 0 ? im - c.va - off.imdb : null;
    if (dk !== null && di !== null) corr = RATE_KP_SHARE * dk + (1 - RATE_KP_SHARE) * di;
    else if (dk !== null) corr = dk;
    else if (di !== null) corr = di;
    corr = clamp(corr, -2.5, 2.5);
    // Чем меньше голосов на TMDB, тем больше доверяем КП/IMDb
    var alpha = RATE_ALPHA_MIN + (RATE_ALPHA_MAX - RATE_ALPHA_MIN) * (m / (v + m));
    // Свежий фильм (мало голосов) и сильное расхождение: TMDB обычно завышен первыми голосами — доверяем КП ещё больше
    var fresh = v < RATE_FRESH_VOTES ? (RATE_FRESH_VOTES - v) / RATE_FRESH_VOTES : 0;
    alpha += RATE_FRESH_EXTRA * fresh * clamp(Math.abs(corr) - 0.5, 0, 1);
    var boost = alpha * corr;

    return { q: clamp((wr + boost - 5.5) / 3.0, 0, 1), r: c.va, corr: corr, boost: boost, kp: kp, imdb: im };
  }

  function affinity(c, profile) {
    var f = featuresOf(c);
    var total = 0;
    var best = { type: null, id: null, v: 0 };

    each(AFFINITY_COEF, function (coef, t) {
      var vals = f[t];
      if (!vals.length) return;
      var sum = 0;
      for (var i = 0; i < vals.length; i++) {
        var w = (profile.f[t] && profile.f[t][vals[i]]) || 0;
        sum += w;
        if ((t === 'director' || t === 'cast' || t === 'genre') && w * coef > best.v) {
          best = { type: t, id: vals[i], v: w * coef };
        }
      }
      total += coef * (sum / vals.length);
    });

    return { a: clamp((total + 1) / 2, 0, 1), best: best };
  }

  // Вес жанра в настроении с поправкой на вкус: жанр подходит под настроение, но пользователю не близок —
  // засчитываем наполовину. Таблица настроений общая, подстраивается только итог.
  var MOOD_TASTE_LOW = 0, MOOD_TASTE_HIGH = 0.2, MOOD_TASTE_MIN = 0.5;
  function moodTaste(profile, g) {
    var pg = profile && profile.f && profile.f.genre;
    if (!pg || !(profile.pos >= 10) || typeof pg[g] !== 'number') return 1;
    var v = pg[g];
    if (v >= MOOD_TASTE_HIGH) return 1;
    if (v <= MOOD_TASTE_LOW) return MOOD_TASTE_MIN;
    return MOOD_TASTE_MIN + (1 - MOOD_TASTE_MIN) * (v - MOOD_TASTE_LOW) / (MOOD_TASTE_HIGH - MOOD_TASTE_LOW);
  }

  function moodScore(c, ans, profile) {
    var mood = MOODS[ans.mood];
    var m = 0.5;

    var hasW = false;
    if (mood) each(mood.w, function () { hasW = true; });
    if (hasW) {
      var maxPos = 0, neg = 0;
      for (var i = 0; i < c.genres.length; i++) {
        var gw = mood.w[c.genres[i]];
        if (gw === undefined) continue;
        if (gw > 0 && ans.company !== 'kids') gw *= moodTaste(profile, c.genres[i]);   // вкус взрослого детям не мерило
        if (gw > maxPos) maxPos = gw;
        if (gw < 0) neg += gw;
      }
      m = 0.3 + 0.7 * maxPos + neg;   // штрафы — полностью: комедия или ужасы портят «Подумать» целиком
      if (mood.req && c.genres.indexOf(mood.req) < 0) m = Math.min(m, 0.15);
    }

    if (ans.company === 'group') {
      var fun = false;
      for (var g = 0; g < GROUP_PLUS.length; g++) if (c.genres.indexOf(GROUP_PLUS[g]) > -1) fun = true;
      if (fun) m += 0.2;
      else if (c.genres.indexOf(18) > -1) m -= 0.2;
    }

    if (ans.company !== 'kids' && isAnimated(c) && c.genres.indexOf(10751) > -1) m -= 0.4;
    if (ans.company === 'kids') {
      var kp = 0, kn = 0;
      for (var kg = 0; kg < c.genres.length; kg++) {
        if (KIDS_PLUS.indexOf(c.genres[kg]) > -1) kp = 0.3;
        if (KIDS_MINUS.indexOf(c.genres[kg]) > -1) kn += 0.3;
      }
      m += kp - Math.min(kn, 0.6);
    }
    if ((ans.mood === 'relax' || ans.mood === 'laugh') && harshAdult(c)) m -= 0.25;
    if (ans.company === 'couple' && harshAdult(c) && ans.mood !== 'nerves' && ans.mood !== 'think') m -= 0.1;

    m = clamp(m, 0, 1);

    // Если есть шкалы настроения — они точнее жанров
    var scaled = moodFromScales(c, ans);
    if (scaled !== null) m = 0.65 * scaled + 0.35 * m;

    return clamp(m, 0, 1);
  }
  // Незнакомый жанр — главная новизна только в «Удиви меня»; в остальных настроениях она почти не тянет
  function novelty(c, profile, ans) {
    var gw = ans && ans.mood === 'surprise' ? 0.6 : 0.15;
    var n = 0;
    var f = featuresOf(c);
    for (var i = 0; i < f.genre.length; i++) {
      if (profile.recentGenres.indexOf(f.genre[i]) < 0) { n += gw; break; }
    }
    if (f.decade.length && profile.recentDecades.indexOf(f.decade[0]) < 0) n += 0.2;
    var y = parseInt(c.year, 10);
    if (!isNaN(y) && y >= new Date().getFullYear() - 3) n += 0.2;
    return clamp(n, 0, 1);
  }

  // Множитель за возраст: десятилетием старше границы — ×0,75, ещё старше — ×0,4
  function yearFactor(c, profile, ans) {
    var y = parseInt(c.year, 10);
    var floor = profile.yearFloor;
    if (!floor || isNaN(y) || y >= floor) return 1;
    var surprise = ans.mood === 'surprise';
    if (y >= floor - 10) return surprise ? 0.9 : 0.75;
    return surprise ? 0.7 : 0.4;
  }

  function pickWeights(ans, profile) {
    if (ans.company === 'kids') return { key: 'kids', w: WEIGHTS.kids };
    if (!(profile.pos >= 5)) return { key: 'cold', w: WEIGHTS.cold };
    if (ans.company === 'group') return { key: 'group', w: WEIGHTS.group };
    if (ans.mood === 'think') return { key: 'think', w: WEIGHTS.think };
    if (ans.mood === 'surprise') return { key: 'surprise', w: WEIGHTS.surprise };
    return { key: 'def', w: WEIGHTS.def };
  }

  function formatVotes(v) {
    if (v >= 1000) return Math.round(v / 1000) + ' тыс.';
    return String(v);
  }

  // 1 голос, 2 голоса, 5 голосов, 21 голос; «тыс.» — всегда «голосов»
  function votesText(v) {
    v = v || 0;
    if (v >= 1000) return formatVotes(v) + ' голосов';
    var n10 = v % 10, n100 = v % 100;
    var word = n10 === 1 && n100 !== 11 ? 'голос' : (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? 'голоса' : 'голосов');
    return v + ' ' + word;
  }

  function rating1(x) { return x.toFixed(1).replace('.', ','); }

  var HIGH_RATING = 7.0;   // ниже «Высокий рейтинг» звучит странно — ищем другое объяснение
  var HIGH_KP = 7.5;       // «Высоко на Кинопоиске» — как и в основной причине про КП
  var HIGH_VOTES = 1000;
  var NEW_GENRE_MAX = 0.1; // «Что-то новое» — жанр с весом в профиле по модулю меньше этого   // «Высокий рейтинг» без подтверждения КП — только от стольких голосов на TMDB

  var MOOD_REASON = {
    relax: 'под «Расслабиться»', laugh: 'чтобы посмеяться', nerves: 'чтобы пощекотать нервы',
    think: 'чтобы подумать', surprise: 'что-то непривычное'
  };
  var COMPANY_REASON = { couple: ' вдвоём', group: ' компанией', kids: ' с детьми' };

  function moodReason(c, ans) {
    var mood = MOODS[ans.mood];
    if (!mood || !MOOD_REASON[ans.mood]) return '';
    var gs = [];
    for (var i = 0; i < c.genres.length; i++) {
      var g = c.genres[i];
      if (mood.w[g] > 0 && GENRE_NAMES[g]) gs.push({ n: GENRE_NAMES[g].toLowerCase(), v: mood.w[g] });
    }
    if (!gs.length) return '';
    gs.sort(function (a, b) { return b.v - a.v; });
    var what = gs.length > 1 ? gs[0].n + ' и ' + gs[1].n : gs[0].n;
    what = what.charAt(0).toUpperCase() + what.slice(1);
    return what + ' — ' + MOOD_REASON[ans.mood] + (COMPANY_REASON[ans.company] || '');
  }

  // Приоритет источников для причины и журнала: чем конкретнее объяснение, тем выше
  var SRC_PRIORITY = ['wath', 'franchise', 'rec', 'ppl', 'kw', 'disc', 'explore'];
  function srcRank(src) { var i = SRC_PRIORITY.indexOf(src); return i < 0 ? SRC_PRIORITY.length : i; }
  function hasSrc(it, src) { return it.src === src || !!(it.srcs && it.srcs[src]); }

  function reasonOf(it, parts, w, profile, ans) {
    var c = it.c;
    if (it.wath) return INTENT_REASON[it.list] || INTENT_REASON.wath;
    if (it.src === 'franchise') return 'Первая непросмотренная часть серии';
    // Найден по любимому режиссёру или актёру — называем его
    if (hasSrc(it, 'ppl') && !(it.seedHits >= 1)) {
      var pd = (c.dir || []).filter(function (id) { return (profile.f.director || {})[id] > 0; });
      if (pd.length) { var pdn = profile.names['p' + pd[0]] || c.names['p' + pd[0]]; if (pdn) return (c.type === 'tv' ? 'Автор ' : 'Режиссёр ') + pdn; }
      var pc = (c.cast || []).filter(function (id) { return (profile.f.cast || {})[id] > 0; });
      if (pc.length) { var pcn = c.names['p' + pc[0]] || profile.names['p' + pc[0]]; if (pcn) return 'С ' + pcn; }
    }
    if (it.seedHits >= 1 && it.seeds.length && it.seeds[0]) {
      if (it.seeds.length > 1) return 'Похож на «' + it.seeds[0] + '» и «' + it.seeds[1] + '»';
      return 'Похож на «' + it.seeds[0] + '»';
    }
    // Найден по ключевым словам любимых фильмов (если сильнее нет режиссёра или актёра)
    if (hasSrc(it, 'kw') && !(parts.best && (parts.best.type === 'director' || parts.best.type === 'cast'))) return 'Темы, как в ваших любимых фильмах';
    // КП заметно поднял фильм
    if (parts.rb >= 0.15 && it.kp >= 7.5) return 'Высоко на Кинопоиске: ' + it.kp.toFixed(1).replace('.', ',');

    var contrib = [
      { k: 's', v: Math.max(w.s, 0.25) * parts.s }, // «Похож на» — самое понятное объяснение
      { k: 'a', v: w.a * (parts.a - 0.5) * 2 },
      { k: 'q', v: w.q * parts.q * 0.5 }, // рейтинг — объяснение последней очереди
      { k: 'n', v: w.n * parts.n }
    ];
    contrib.sort(function (a, b) { return b.v - a.v; });

    for (var i = 0; i < contrib.length; i++) {
      var k = contrib[i].k;
      if (k === 's' && it.seeds.length && it.seeds[0]) return 'Похож на «' + it.seeds[0] + '»';
      if (k === 'a' && parts.best && parts.best.type) {
        var b = parts.best;
        if (b.type === 'director') {
          var dn = profile.names['p' + b.id] || c.names['p' + b.id];
          if (dn) return (c.type === 'tv' ? 'Автор ' : 'Режиссёр ') + dn;
        }
        if (b.type === 'cast') {
          var an = c.names['p' + b.id] || profile.names['p' + b.id];
          if (an) return 'С ' + an;
        }
        // Жанр как причина — только если он реально выделяется в профиле
        // ...и подходит под настроение: «Ваш жанр: драма» у триллера в «нервах» звучит странно
        var mw = ans && MOODS[ans.mood] && MOODS[ans.mood].w;
        var fitsMood = !mw || !Object.keys(mw).length || (mw[b.id] || 0) >= 0.3;
        if (b.type === 'genre' && GENRE_NAMES[b.id] && profile.f.genre[b.id] >= 0.6 && fitsMood) return 'Ваш жанр: ' + GENRE_NAMES[b.id].toLowerCase();
      }
      if (k !== 'q' && ans && parts.m >= 0.8) {
        var mr = moodReason(c, ans);
        if (mr) return mr;
      }
      if (k === 'q' && parts.r) {
        // Рейтинг — объяснение, только если он и правда высокий (на TMDB или на Кинопоиске).
        // TMDB 8,8 при КП 6,5 — не «высокий»: свежие фильмы TMDB завышает
        var kpLow = it.kp > 0 && it.kp < HIGH_RATING;
        // Мало голосов на TMDB (239 — это ещё не «высокий») — нужен КП в подтверждение
        var trusted = (c.vc || 0) >= HIGH_VOTES || it.kp >= HIGH_RATING;
        if (parts.r >= HIGH_RATING && !kpLow && trusted) return 'Высокий рейтинг: ' + rating1(parts.r) + ', ' + votesText(c.vc);
        if (it.kp >= HIGH_KP) return 'Высоко на Кинопоиске: ' + rating1(it.kp);
      }
      if (k === 'n' && parts.n > 0) {
        // Называем жанр, который и правда новый для вас: не из недавних и без отношения в профиле.
        // Нелюбимый жанр «новым» не бывает
        var ng = null, recentG = profile.recentGenres || [], pgw = (profile.f && profile.f.genre) || {};
        for (var ni = 0; ni < c.genres.length && !ng; ni++) {
          var g0 = c.genres[ni], w0 = pgw[g0];
          if (recentG.indexOf(g0) < 0 && GENRE_NAMES[g0] && !(typeof w0 === 'number' && Math.abs(w0) >= NEW_GENRE_MAX)) ng = g0;
        }
        if (ng) return 'Что-то новое: ' + GENRE_NAMES[ng].toLowerCase();
      }
    }
    // Сильного объяснения нет: жанры под настроение, иначе самый близкий вкусу жанр
    var mr2 = moodReason(c, ans);
    if (mr2) return mr2;
    var gw = (profile.f && profile.f.genre) || {}, bestG = null;
    for (var gi = 0; gi < c.genres.length; gi++) {
      var gv = gw[c.genres[gi]];
      if (GENRE_NAMES[c.genres[gi]] && typeof gv === 'number' && gv > 0 && (!bestG || gv > gw[bestG])) bestG = c.genres[gi];
    }
    if (bestG) return 'Ваш жанр: ' + GENRE_NAMES[bestG].toLowerCase();
    return '';
  }

  // Нелюбимый жанр: штраф плавно от DISLIKE_FROM (×1) до DISLIKE_FULL (×DISLIKE_MULT), без ступеньки
  var DISLIKE_FROM = -0.45, DISLIKE_FULL = -0.9, DISLIKE_MULT = 0.6;

  function dislikeMult(genres, profile) {
    var gw = (profile.f && profile.f.genre) || {}, worst = 0;
    for (var i = 0; i < (genres || []).length; i++) {
      var v = gw[genres[i]];
      if (typeof v === 'number' && v < worst) worst = v;
    }
    var t = clamp((DISLIKE_FROM - worst) / (DISLIKE_FROM - DISLIKE_FULL), 0, 1);
    return 1 - (1 - DISLIKE_MULT) * t;
  }

  function scoreAll(items, profile, ans) {
    var pw = pickWeights(ans, profile);
    var w = pw.w;
    for (var i0 = 0; i0 < items.length; i0++) {
      var it0 = items[i0];
      if (!it0.rt && it0.c) { var cr = cachedRatings(it0.c, it0.k); if (cr) { cr.src = 'cache'; it0.rt = cr; } }
    }
    var off = ratingOffsets(items);

    var sumVa = 0, nVa = 0;
    for (var i = 0; i < items.length; i++) if (items[i].c && items[i].c.vc > 0) { sumVa += items[i].c.va; nVa++; }
    // Априорное среднее ниже среднего по пулу: фильм без голосов не должен выглядеть «средне-хорошим»
    var C = Math.min(nVa ? sumVa / nVa : 6.0, 6.0);

    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var c = it.c;
      var qq = quality(c, C, it.rt, off);
      var aa = affinity(c, profile);
      var parts = {
        q: qq.q, r: qq.r, rc: qq.corr, rb: qq.boost,
        a: aa.a, best: aa.best,
        m: moodScore(c, ans, profile),
        n: novelty(c, profile, ans),
        s: it.wath ? 1 : Math.min(it.seedHits / 3, 1)
      };
      it.parts = parts;
      if (qq.kp) it.kp = qq.kp;
      if (qq.imdb) it.imdbR = qq.imdb;
    }

    // Совпадение растягиваем на диапазон текущего списка: иначе все в 0,65–0,76 и вклад тонет
    var minA = 1, maxA = 0;
    for (var a1 = 0; a1 < items.length; a1++) {
      var av = items[a1].parts.a;
      if (av < minA) minA = av;
      if (av > maxA) maxA = av;
    }
    var spread = maxA - minA;

    // Формат: доля анимации у пользователя против формата кандидата
    var share = typeof profile.animShare === 'number' ? profile.animShare : 0.2;

    for (var k = 0; k < items.length; k++) {
      var x = items[k];
      var pt = x.parts;
      pt.an = spread > 0.04 ? 0.5 * pt.a + 0.5 * (pt.a - minA) / spread : pt.a;
      var anim = isAnimated(x.c);
      pt.f = clamp((anim ? share : 1 - share) * 2, 0.25, 1);
      if (ans.company === 'kids') pt.f = 1;          // смотрит ли взрослый мультфильмы — детям неважно
      // Смотрят не одни: доля анимации у пользователя ничего не говорит о вкусе второго зрителя
      if (anim && (ans.company === 'couple' || ans.company === 'group')) pt.f *= 0.6;
      // Настроение — множитель: «Позже» или высокий рейтинг не вытащат фильм, который не подходит под запрос
      var rest = 1 - w.m;
      var base = (w.q * pt.q + w.a * pt.an + w.n * pt.n + w.s * pt.s) / (rest > 0 ? rest : 1);
      var moodGate = w.m > 0 ? 0.15 + 0.85 * pt.m : 1;
      // Нелюбимый жанр (заметный минус в профиле) — отдельный множитель; «Позже» — явный выбор, не трогаем
      pt.d = !x.wath && ans.company !== 'kids' ? dislikeMult(x.c.genres, profile) : 1;
      pt.y = x.wath ? 1 : yearFactor(x.c, profile, ans); // «Позже» — явный выбор, годы не штрафуем
      x.score = base * moodGate * (0.3 + 0.7 * pt.f) * pt.y * pt.d;
      x.reason = reasonOf(x, pt, w, profile, ans);
    }

    log('weights', pw.key, 'C', C.toFixed(2));
    return pw.key;
  }

  // =========================================================================
  // Разнообразие (MMR) и выдача
  // =========================================================================

  function similarity(a, b) {
    if (a.c.coll && a.c.coll === b.c.coll) return 1;
    var sa = a.c.genres.concat(a.c.kw.map(function (k) { return 'k' + k; }));
    var sb = b.c.genres.concat(b.c.kw.map(function (k) { return 'k' + k; }));
    if (!sa.length || !sb.length) return 0;
    var inter = 0;
    for (var i = 0; i < sa.length; i++) if (sb.indexOf(sa[i]) > -1) inter++;
    var union = uniq(sa.concat(sb)).length;
    return union ? inter / union : 0;
  }

  // Числовой отпечаток строки — сид разброса для конкретного фильма
  function strSeed(str) {
    var h = 2166136261;
    str = String(str || '');
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul ? Math.imul(h, 16777619) : (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  // Показанное сегодня: ключ → сколько раз показан. Новый день — новый список
  var REPEAT_MULT = 0.85;   // за каждый показ сегодня без действий — ещё ×0,85…
  var REPEAT_MIN = 0.6;     // …но не ниже: сильный фильм может вернуться наверх, а завтра штраф снимается
  function shownToday() {
    var sd = store('shown_day', null);
    return sd && sd.d === todaySeed() && sd.k ? sd.k : {};
  }
  // Каждый подбор отмечает показанные карточки один раз (страница отмечается при первом показе, см. state.logged)
  function markShownToday(items) {
    var map = shownToday(), n = 0;
    for (var i = 0; i < items.length; i++) {
      var k = items[i] && items[i].k;
      if (!k) continue;
      map[k] = (typeof map[k] === 'number' ? map[k] : 0) + 1;
      n++;
    }
    if (n) save('shown_day', { d: todaySeed(), k: map });
  }
  function repeatMult(times) {
    if (!(times > 0)) return 1;
    return Math.max(REPEAT_MIN, Math.pow(REPEAT_MULT, times));
  }

  // Разброс ×0,92…1,08 привязан к фильму и дню: в течение дня у фильма тот же множитель, где бы он ни стоял.
  // Показанное сегодня (без «Открыть», «Не то», «Уже видел» — те и так скрыты) — ×0,85 за каждый показ, не ниже ×0,6
  function jitter(items) {
    var day = todaySeed(), seenToday = shownToday();
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      it.jmul = 0.92 + 0.16 * rng(day ^ strSeed(it.k))();
      it.rp = repeatMult(seenToday[it.k]);
      it.jscore = it.score * it.jmul * it.rp;
    }
    items.sort(function (a, b) { return b.jscore - a.jscore; });
  }

  // ---- Теневая формула (п. 29): только в журнал, выдача не меняется.
  // Вкус весомее (a +0,10 за счёт q), совпадение растягивается по процентилям, а не от минимума до максимума
  var SHADOW_SHIFT = 0.10;
  function shadowPick(items, ans, wkey) {
    if (wkey === 'cold' || wkey === 'kids' || items.length < 6) return null;
    var w = WEIGHTS[wkey];
    if (!w || w.q < SHADOW_SHIFT) return null;
    var w2 = extend({}, w);
    w2.a = w.a + SHADOW_SHIFT; w2.q = w.q - SHADOW_SHIFT;
    var order = items.slice().sort(function (a, b) { return a.parts.a - b.parts.a; });
    var pct = {};
    for (var r = 0; r < order.length; r++) pct[order[r].k] = order.length > 1 ? r / (order.length - 1) : 0.5;
    var rest = 1 - w2.m;
    var copies = items.map(function (x) {
      var pt = x.parts;
      var an2 = 0.5 * pt.a + 0.5 * pct[x.k];
      var base = (w2.q * pt.q + w2.a * an2 + w2.n * pt.n + w2.s * pt.s) / (rest > 0 ? rest : 1);
      var gate = w2.m > 0 ? 0.15 + 0.85 * pt.m : 1;
      var sc = base * gate * (0.3 + 0.7 * pt.f) * pt.y * pt.d;
      return extend(extend({}, x), { score: sc, jscore: sc * (x.jmul || 1) * (x.rp || 1) });
    });
    copies.sort(function (a, b) { return b.jscore - a.jscore; });
    var shadowTop = nextPage({ rest: copies, shown: [] }, 5);
    var mainTop = nextPage({ rest: items.slice(), shown: [] }, 5);
    var mainKeys = mainTop.map(function (x) { return x.k; });
    var same = 0;
    for (var i = 0; i < shadowTop.length; i++) if (mainKeys.indexOf(shadowTop[i].k) > -1) same++;
    return {
      same: same,
      top: shadowTop.map(function (x) { return { k: x.k, title: x.c.title, score: round3(x.score), an: round3(0.5 * x.parts.a + 0.5 * pct[x.k]) }; })
    };
  }

  function nextPage(state, n) {
    var lambda = 0.7;
    var out = [];
    while (out.length < n && state.rest.length) {
      var bestI = -1, bestV = -Infinity;
      for (var i = 0; i < state.rest.length; i++) {
        var it = state.rest[i];
        var maxSim = 0;
        for (var j = 0; j < state.shown.length; j++) {
          var s = similarity(it, state.shown[j]);
          if (s > maxSim) maxSim = s;
        }
        var v = lambda * it.jscore - (1 - lambda) * maxSim;
        if (v > bestV) { bestV = v; bestI = i; }
      }
      var picked = state.rest.splice(bestI, 1)[0];
      state.shown.push(picked);
      out.push(picked);
    }
    return out;
  }

  // =========================================================================
  // Франшизы: одна карточка на коллекцию — первая непросмотренная часть
  // =========================================================================

  function franchiseFilter(list, events, ans, stats, profileRef, cb) {
    var byColl = {};
    for (var i = 0; i < list.length; i++) {
      var c = list[i].c;
      if (c && c.type === 'movie' && c.coll) (byColl[c.coll] = byColl[c.coll] || []).push(list[i]);
    }
    var colls = Object.keys(byColl);
    if (!colls.length) return cb(list, []);

    var ex = excludedKeys(events);
    var today = new Date().toISOString().slice(0, 10);
    var kids = ans.company === 'kids';
    var drop = {};
    var additions = [];
    var left = colls.length;
    var frLog = [];   // решения по франшизам — для журнала
    var note = function (collId, items, next, res) {
      frLog.push({ coll: +collId || collId, found: items.slice(0, 3).map(function (x) { return x.c && x.c.title; }), next: next ? next.title || next.name || next.id : null, res: res });
    };

    // Начало серии не подошло: взрослым поздняя часть не нужна — франшиза в этом подборе пропускается.
    // С детьми — остаётся лучшая часть, прошедшая все проверки пула (первая могла не подойти по возрасту)
    var rejectStart = function (kept, ad, why) {
      stats[why] = (stats[why] || 0) + 1;
      // Запасная часть — только когда начало не подошло детям по возрасту или содержанию (kids_*)
      if (ad.fallback && /^kids_/.test(why)) { kept.push(ad.fallback); ad.log.res = 'fallback:' + why; }
      else ad.log.res = 'skip:' + why;
    };

    var done = function () {
      if (--left > 0) return;
      var kept = list.filter(function (it) { return !drop[it.k]; });
      // Подставленная часть проходит те же проверки, что и пул: не начата, не исключена, достаточно голосов
      additions = additions.filter(function (ad) {
        var why = preReason(ad, ex, ans);
        if (!why) return true;
        rejectStart(kept, ad, why);
        return false;
      });
      if (!additions.length) return cb(kept, frLog);
      detailsMany(additions, function () {
        for (var a = 0; a < additions.length; a++) {
          // С детьми у добавленной части нет шкал CUB и возраста КП — проверяем по строгому правилу
          var r = postReason(additions[a], ans, profileRef, kids);
          if (r) rejectStart(kept, additions[a], r);
          else kept.push(additions[a]);
        }
        cb(kept, frLog);
      });
    };

    each(byColl, function (items, collId) {
      tmdb('collection/' + collId, {}, 30 * DAY, function (col) {
        var parts = ((col && col.parts) || []).filter(function (pt) {
          return pt.release_date && pt.release_date <= today;
        });
        parts.sort(function (a, b) { return a.release_date < b.release_date ? -1 : 1; });

        // Следующая часть: первая, которую не смотрели. Просмотренное (досмотрено, история, «Уже видел») пропускаем.
        // Отклонённая, «Смотрю» или недавно открытая из подборки — франшиза в этом подборе пропускается целиком:
        // предлагать следующую часть рано, а ту же — не нужно
        var next = null, blocked = '';
        for (var p = 0; p < parts.length; p++) {
          var k = keyOf('movie', parts[p].id);
          var exk = ex[k];
          if (exk === 'rejected' || exk === 'watching' || exk === 'opened') { blocked = exk; break; }
          if (!exk) { next = parts[p]; break; }
        }

        var best = items[0];
        for (var b = 1; b < items.length; b++) if ((items[b].score || 0) > (best.score || 0)) best = items[b];

        var inList = false;
        if (next) for (var q = 0; q < items.length; q++) if (items[q].id === next.id) inList = true;

        for (var j = 0; j < items.length; j++) {
          var it = items[j];
          // Состав коллекции неизвестен (TMDB не ответил) — остаётся лучшая из найденных частей
          var keep = !blocked && (next ? it.id === next.id : (parts.length === 0 && it === best));
          if (!keep) { drop[it.k] = true; stats.franchise = (stats.franchise || 0) + 1; }
        }

        if (blocked) note(collId, items, null, 'blocked:' + blocked);
        else if (!parts.length) note(collId, items, null, 'no_parts');
        else if (!next) note(collId, items, null, 'all_watched');
        else if (inList) note(collId, items, next, 'next_in_list');
        else {
          // Нужная часть не в списке — подставляем её вместо найденных частей франшизы
          var ad = {
            k: keyOf('movie', next.id), id: next.id, type: 'movie', r: next,
            // «Похож на …» относилось к другой части — не переносим
            seedHits: 0, seeds: [], wath: false, src: 'franchise',
            fallback: kids ? best : null                     // запасная часть — только с детьми
          };
          note(collId, items, next, 'added');
          ad.log = frLog[frLog.length - 1];
          additions.push(ad);
        }
        done();
      });
    });
  }

  // =========================================================================
  // Конвейер
  // =========================================================================

  var runToken = 0;

  function cancelRun() { runToken++; }

  // h: { stage(text), done(state) }
  // Сторож подбора: на медленной сети ждём, пока данные идут, но не вечно
  var RUN_SILENCE = 20000;     // ни одного ответа TMDB и ни одного нового этапа столько — сдаёмся
  var RUN_HARD_LIMIT = 90000;  // общий предел подбора
  var DETAILS_SOFT = 25000;    // после этого детали больше не догружаем, если кандидатов уже хватает…
  var DETAILS_MIN_OK = 10;     // …столько прошедших фильтры

  function run(ans, h) {
    h = h || {};
    var token = ++runToken;
    var alive = function () { return token === runToken; };
    var started = now();
    var lastProgress = started, lastOks = Net.oks;
    var poke = function () { lastProgress = now(); };
    var stage = function (t) { poke(); if (h.stage && alive()) h.stage(t); };
    var tm = {};                                     // время этапов, мс — для журнала
    var mark = function (k) { poke(); tm[k] = now() - started; };
    var net0 = { ok: Net.oks, fail: Net.netFails };

    // Сторож: подбор не может висеть бесконечно
    var finished = false;
    var fail = function (kind) {
      if (finished || !alive()) return;
      finished = true;
      cancelRun();
      log('run failed', kind);
      if (h.error) h.error(kind);
    };
    // Каждую секунду: пришёл ли ответ TMDB или начался новый этап. Тишина 20 с или 90 с всего — ошибка
    var watchdog = setInterval(function () {
      if (finished || !alive()) { clearInterval(watchdog); return; }
      if (Net.oks !== lastOks) { lastOks = Net.oks; poke(); }
      var t = now();
      if (t - lastProgress > RUN_SILENCE || t - started > RUN_HARD_LIMIT) {
        clearInterval(watchdog);
        // Запросы только падали и ни один не прошёл — это связь, а не «долго»
        fail(Net.netFails > net0.fail && Net.oks === net0.ok ? 'net' : 'timeout');
      }
    }, 1000);

    save('last_answers', ans);
    stage('Изучаю вашу историю');

    var events = collect();

    Durable.load('journal', []);
    Durable.load('kpmap', {});
    Durable.load('journal', [], function () {
    probeMoods(function () {
    enrichEvents(events, function () {
      if (!alive()) return;
      var profile = buildProfile(events);
      mark('profile');
      stage('Ищу кандидатов');

      gatherPool(profile, events, ans, function (pool) {
        if (!alive()) return;
        mark('pool');
        var stats = {};
        var list = prefilter(pool, events, ans, stats);

        // Предоценка по полям списка, затем детали партиями, пока не наберётся достаточно подходящих
        for (var i = 0; i < list.length; i++) list[i].c = cardCompact(list[i].r || {});
        scoreAll(list, profile, ans);
        list.sort(function (a, b) { return b.score - a.score; });

        // Строгие режимы отсеивают ~70% кандидатов — там нужен больший запас загрузок
        var strict = ans.time === '40' || ans.company === 'kids';
        var BATCH = 30, WANT = 30, MAX_DETAILED = strict ? 150 : 90;
        var passed = [];
        var offset = 0;
        var detailsCut = false;   // медленная сеть: остановились раньше, кандидатов хватало

        var nextBatch = function () {
          if (!alive()) return;
          var batch = list.slice(offset, offset + BATCH);
          offset += batch.length;
          stage('Сравниваю ' + offset + ' вариантов');
          detailsMany(batch, function () {
            if (!alive()) return;
            for (var b = 0; b < batch.length; b++) {
              var r = postReason(batch[b], ans, profile);
              if (r) stats[r] = (stats[r] || 0) + 1;
              else passed.push(batch[b]);
            }
            var more = passed.length < WANT && offset < list.length && offset < MAX_DETAILED;
            // Сеть медленная, а кандидатов уже достаточно — подбираем из того, что есть
            if (more && now() - started > DETAILS_SOFT && passed.length >= DETAILS_MIN_OK) { more = false; detailsCut = true; }
            if (more) nextBatch();
            else afterDetails();
          });
        };

        var kpBefore = 0;
        var cubStat = { got: 0, asked: 0 };
        var afterDetails = function () {
          if (!alive()) return;                       // отменённый подбор не тратит квоту КП и слоты CUB
          mark('details');
          scoreAll(passed, profile, ans);
          stage('Уточняю настроение и рейтинги');
          // Шкалы CUB и оценки КП — одновременно: ждём не дольше самого долгого из двух (~5 с)
          kpBefore = kpQuota().n;
          var pending = 2;
          var both = function () { if (--pending === 0) afterExtras(); };
          attachCubMeta(passed, function (x) { if (x) cubStat = x; both(); });
          attachRatings(passed, both);
        };

        var afterExtras = function () {
            if (!alive()) return;
            mark('extras');
            if (ans.company !== 'kids') return finishPick();
            // Шкалы CUB пришли после фильтров, плюс возраст с Кинопоиска — для детей проверяем ещё раз
            scoreAll(passed, profile, ans);
            attachKidsAge(passed, function () {
              if (!alive()) return;
              passed = passed.filter(function (it) {
                var r = postReason(it, ans, profile, true);
                if (r) { stats[r] = (stats[r] || 0) + 1; return false; }
                return true;
              });
              finishPick();
            });
        };

        var finishPick = function () {
          scoreAll(passed, profile, ans);
          franchiseFilter(passed, events, ans, stats, profile, function (finalList, frLog) {
          if (!alive()) return;
          var top = list.slice(0, offset);
          var wkey = scoreAll(finalList, profile, ans);
          jitter(finalList);
          var shadow = null;
          try { shadow = shadowPick(finalList, ans, wkey); } catch (eS) { log('shadow error', eS); }
          var kpReq = Math.max(0, kpQuota().n - kpBefore);

          log('events', events.length, 'profile.n', profile.n, 'pool', Object.keys(pool).length - 1,
            'prefiltered', list.length, 'final', finalList.length, 'ms', now() - started);

          // Пусто, а запросы к TMDB в основном падали — это не «ничего не нашлось», а нет связи
          var dOk = Net.oks - net0.ok, dFail = Net.netFails - net0.fail;
          if (!finalList.length && dFail > 0 && dFail >= dOk) return fail('net');
          if (finished) return;
          finished = true;

          var st = {
            ans: ans, rest: finalList, shown: [], page: [],
            profile: profile, wkey: wkey, cold: !(profile.pos >= 5)
          };
          st.journal = Journal.begin(ans, {
            wkey: wkey, ms: now() - started, tm: tm, moods: cubStat.got > 0, cub: [cubStat.got, cubStat.asked],
            kp: { req: kpReq, off: kpOffline(), rated: finalList.filter(function (x) { return x.rt; }).length },
            counts: { events: events.length, profile: profile.n, pool: Object.keys(pool).length - 1, prefiltered: list.length, detailed: top.length, final: finalList.length },
            sources: pool.__src,
            dropped: stats,
            profile: profileSummary(profile),
            top: finalList.slice().sort(function (a, b) { return b.score - a.score; }).slice(0, 12).map(journalItem),
            shadow: shadow,
            repeats: finalList.filter(function (x) { return x.rp < 1; }).length,
            franchises: frLog && frLog.length ? frLog.slice(0, 30) : undefined,
            detailsCut: detailsCut || undefined
          });
          if (h.done) h.done(st);
          });
        };

        nextBatch();
      });
    });
    });
    });
  }

  // =========================================================================
  // Журнал подборов (только локально, для анализа и настройки выборки)
  // =========================================================================

  var JOURNAL_MAX = 20;

  function round3(x) { return Math.round((x || 0) * 1000) / 1000; }

  function journalItem(it) {
    var c = it.c || {};
    var p = it.parts || {};
    return {
      k: it.k,
      title: c.title,
      year: c.year,
      runtime: c.runtime || null,
      genres: (c.genres || []).map(function (g) { return GENRE_NAMES[g] || g; }),
      tmdb: c.va ? Math.round(c.va * 10) / 10 : null,
      votes: c.vc || 0,
      kp: it.kp || null,
      imdb: it.imdbR || null,
      rsrc: it.rt ? it.rt.src : null,
      kpProbe: it.kp || it.imdbR ? undefined : (it.kpProbe || undefined),
      // Почему нет оценки КП/IMDb: not_found, no_rating, cached_miss, cached_no_rating, deadline, run_budget, daily_limit, blocked,
      // paused, offline, no_key, net, http_NNN; not_requested — не среди финалистов, спрашивали только кеш
      kpMiss: it.kp || it.imdbR ? undefined : (it.kpMiss || 'not_requested'),
      rc: round3(p.rc), rb: round3(p.rb), d: p.d === 1 || p.d === undefined ? undefined : round3(p.d),
      rp: it.rp && it.rp < 1 ? round3(it.rp) : undefined,
      score: round3(it.score),
      q: round3(p.q), a: round3(p.a), an: round3(p.an), m: round3(p.m), n: round3(p.n), s: round3(p.s), f: round3(p.f), y: round3(p.y),
      src: it.src || null,
      coll: c.coll || null,
      anim: isAnimated(c),
      cert: (c.cert || typeof c.kpAge === 'number') ? [c.cert && c.cert.ru ? 'RU:' + c.cert.ru : '', c.cert && c.cert.us ? 'US:' + c.cert.us : '',
        typeof c.kpAge === 'number' ? 'KP:' + (c.kpAge < 0 ? '—' : c.kpAge + '+') : ''].filter(Boolean).join(' ') : null,
      moods: c.moods || null,
      wath: !!it.wath,
      seeds: (it.seeds || []).slice(0, 3),
      reason: it.reason || ''
    };
  }

  function topOf(map, n, names) {
    var arr = [];
    each(map || {}, function (v, k) { arr.push([k, v]); });
    arr.sort(function (a, b) { return b[1] - a[1]; });
    return arr.slice(0, n).map(function (x) {
      var label = names ? (names(x[0]) || x[0]) : x[0];
      return label + ' ' + (Math.round(x[1] * 100) / 100);
    });
  }

  // Карточки без оценки КП для сжатых форматов: [название, причина, IMDb (e — пусто), вариантов в поиске, первые два «тип год»]
  function kpMissRows(shown, short) {
    var rows = [];
    (shown || []).forEach(function (it) {
      if (it.kp || it.imdb || !it.kpMiss || it.kpMiss === 'not_requested') return;
      var p = it.kpProbe;
      var im = p ? (p.imdb === 'empty' ? 'e' : p.imdb) : null;
      if (p && p.found) rows.push([short(it.title, 16), it.kpMiss, im, 'id' + p.found, (p.type || '?') + ' ' + (p.year || '?') + ' ' + short(p.name, 14)]);
      else rows.push([short(it.title, 16), it.kpMiss].concat(p ? [im, p.total,
        (p.top || []).slice(0, 2).map(function (x) { return (x[0] || '?').replace('TV_SERIES', 'TVS').replace('MINI_SERIES', 'MS') + ' ' + (x[1] || '?'); }).join('|')] : []));
    });
    return rows.length ? rows.slice(0, 8) : undefined;
  }

  function profileSummary(profile) {
    return {
      events: profile.n,
      positive: profile.pos,
      animShare: round3(profile.animShare),
      yearFloor: profile.yearFloor,
      yearFloorBy: profile.yearFloorBy || null,
      likeBatch: profile.likeBatch || 0,
      rejGenres: profile.rejGenres && Object.keys(profile.rejGenres).length ? profile.rejGenres : null,
      genres: topOf(profile.f.genre, 6, function (g) { return GENRE_NAMES[g]; }),
      dislikedGenres: topOf((function () {
        var neg = {};
        each(profile.f.genre || {}, function (v, k) { if (v < 0) neg[k] = -v; });
        return neg;
      })(), 3, function (g) { return GENRE_NAMES[g]; }),
      directors: topOf(profile.f.director, 4, function (id) { return profile.names['p' + id]; }),
      cast: topOf(profile.f.cast, 4, function (id) { return profile.names['p' + id]; }),
      decades: topOf(profile.f.decade, 3),
      langs: topOf(profile.f.lang, 3),
      seeds: (profile.seeds || []).slice(0, 8).map(function (e) { return (e.c && e.c.title) || e.k; })
    };
  }

  var Journal = {
    list: function () {
      var a = Durable.get('journal', null);
      if (Object.prototype.toString.call(a) !== '[object Array]') { a = []; Durable.vals.journal = a; }
      return a;
    },

    saveEntry: function (entry) {
      var a = this.list();
      var i = -1;
      for (var k = 0; k < a.length; k++) if (a[k].id === entry.id) i = k;
      if (i >= 0) a[i] = entry; else a.push(entry);
      while (a.length > JOURNAL_MAX) a.shift();
      Durable.set('journal', a);
    },

    begin: function (ans, data) {
      var entry = extend(data, {
        id: now(),
        at: new Date().toISOString(),
        v: VERSION,
        answers: describeList(ans).join(' · '),
        shown: [],
        actions: []
      });
      this.saveEntry(entry);
      return entry;
    },

    shown: function (entry, items, page) {
      if (!entry) return;
      for (var i = 0; i < items.length; i++) {
        var ji = journalItem(items[i]);
        ji.page = page;
        ji.pos = i + 1;
        entry.shown.push(ji);
      }
      this.saveEntry(entry);
    },

    rating: function (entry, it) {
      if (!entry) return;
      for (var i = 0; i < entry.shown.length; i++) {
        if (entry.shown[i].k === it.k) {
          entry.shown[i].kp = it.kp || null; entry.shown[i].imdb = it.imdbR || null;
          entry.shown[i].kpMiss = it.kp || it.imdbR ? undefined : (it.kpMiss || entry.shown[i].kpMiss);
          entry.shown[i].kpProbe = it.kp || it.imdbR ? undefined : (it.kpProbe || entry.shown[i].kpProbe);
        }
      }
      this.saveEntry(entry);
    },

    action: function (entry, type, it, extra) {
      if (!entry) return;
      var a = { sec: Math.round((now() - entry.id) / 1000), act: type };
      if (it) { a.k = it.k; a.title = it.c.title; }
      if (extra) each(extra, function (v, k) { a[k] = v; });
      entry.actions.push(a);
      this.saveEntry(entry);
    },

    clear: function () { Durable.set('journal', [], true); Durable.flush('journal', true); },

    // Последний подбор в компактном виде — помещается в одно сообщение мессенджера
    exportLast: function () {
      var a = this.list();
      var e = a[a.length - 1];
      if (!e) return '';
      var r2 = function (x) { return typeof x === 'number' ? Math.round(x * 100) / 100 : x; };
      var short = function (t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
      var flags = function (it) {
        var f = '';
        if (it.anim) f += 'A';
        if (it.wath) f += 'W';
        if (it.coll) f += 'C';
        if (it.rp) f += 'R' + Math.round(it.rp * 100);
        if (it.d) f += 'D' + Math.round(it.d * 100);
        return f;
      };
      var c = e.counts || {};
      var p = e.profile || {};
      var out = {
        f: 'LPJ-last',
        v: e.v,
        at: e.at,
        ans: e.answers,
        wk: e.wkey,
        ms: e.ms,
        mood: e.moods ? 1 : 0,
        kpq: kpQuota().n,
        cnt: [c.events, c.pool, c.prefiltered, c.detailed, c.final],
        src: e.sources,
        dr: e.dropped,
        pr: {
          an: p.animShare, yf: p.yearFloor,
          g: (p.genres || []).slice(0, 6),
          dg: (p.dislikedGenres || []).slice(0, 3),
          s: (p.seeds || []).slice(0, 5).map(function (x) { return short(x, 22); })
        },
        // t, год, тип, источник, флаги, score, q, an, m, n, s, f, y, tmdb, голоса, kp, imdb, cert, стр/поз, причина
        sh: (e.shown || []).map(function (it) {
          return [short(it.title, 28), it.year, it.k ? it.k.charAt(0) : '', it.src || '', flags(it),
            r2(it.score), r2(it.q), r2(it.an), r2(it.m), r2(it.n), r2(it.s), r2(it.f), r2(it.y),
            it.tmdb, it.votes, it.kp ? r2(it.kp) : 0, it.imdb ? r2(it.imdb) : 0,
            it.cert || '', it.page + '/' + it.pos, short(it.reason, 34)];
        }),
        shd: e.shadow ? [e.shadow.same, e.shadow.top.map(function (x) { return short(x.title, 22); })] : undefined,
        fr: e.franchises ? e.franchises.map(function (f) { return [short(f.next || (f.found || [])[0], 22), f.res]; }) : undefined,
        km: kpMissRows(e.shown, short),
        act: (e.actions || []).map(function (x) {
          var row = [x.sec, x.act];
          if (x.title) row.push(short(x.title, 22));
          if (x.act === 'more') row.push(x.opened ? 1 : 0);
          if (x.why) row.push(x.why);
          return row;
        })
      };
      // Лимит сообщения Telegram — 4096 символов: сначала убираем причины, потом самые ранние показы
      var txt = JSON.stringify(out);
      if (txt.length > 3900) {
        for (var i = 0; i < out.sh.length; i++) out.sh[i][19] = '';
        txt = JSON.stringify(out);
      }
      while (txt.length > 3900 && out.sh.length > 5) {
        out.sh.shift();
        out.cut = (out.cut || 0) + 1;
        txt = JSON.stringify(out);
      }
      return txt;
    },

    // Весь журнал, сжатый gzip + base64 (для консоли). Promise со строкой или null
    exportPacked: function () {
      return gzipB64(this.exportText()).then(function (b) { return b ? 'LPJ1:' + b : null; });
    },

    // Одна сессия в плотном виде: числа ×100 целыми, причины — только у свежей, профиль — если изменился
    compactEntry: function (e, withReasons, prevProfile) {
      var i100 = function (x) { return typeof x === 'number' ? Math.round(x * 100) : 0; };
      var short = function (t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
      var p = e.profile || {};
      var pr = {
        an: p.animShare, yf: p.yearFloor,
        g: (p.genres || []).slice(0, 6), dg: (p.dislikedGenres || []).slice(0, 3),
        s: (p.seeds || []).slice(0, 5).map(function (x) { return short(x, 22); })
      };
      var c = e.counts || {};
      var o = {
        at: String(e.at || '').slice(0, 16), v: e.v, ans: e.answers, wk: e.wkey,
        cnt: [c.events, c.pool, c.prefiltered, c.detailed, c.final],
        src: e.sources, dr: e.dropped,
        // название, год, тип+источник, флаги, score, q, an, m, n, s, f, y (×100), tmdb/kp/imdb (×10), голоса, cert, стр/поз[, причина]
        sh: (e.shown || []).map(function (it) {
          var row = [short(it.title, 24), it.year, (it.k || '').charAt(0) + String(it.src || '').charAt(0),
            (it.anim ? 'A' : '') + (it.wath ? 'W' : '') + (it.coll ? 'C' : '') + (it.rp ? 'R' + Math.round(it.rp * 100) : '') + (it.d ? 'D' + Math.round(it.d * 100) : ''),
            i100(it.score), i100(it.q), i100(it.an), i100(it.m), i100(it.n), i100(it.s), i100(it.f), i100(it.y),
            i100((it.tmdb || 0) / 10), i100((it.kp || 0) / 10), i100((it.imdb || 0) / 10), it.votes || 0,
            it.cert || '', it.page + '/' + it.pos];
          if (withReasons) row.push(short(it.reason, 30));
          return row;
        }),
        // тень: сколько из её пятёрки совпало с показанной первой страницей, и сама пятёрка
        shd: e.shadow ? [e.shadow.same, e.shadow.top.map(function (x) { return short(x.title, 16); })] : undefined,
        // франшизы: [часть, решение]
        fr: e.franchises ? e.franchises.map(function (f) { return [short(f.next || (f.found || [])[0], 16), f.res]; }) : undefined,
        // без оценки КП: см. kpMissRows
        km: kpMissRows(e.shown, short),
        act: (e.actions || []).map(function (x) {
          var row = [x.sec, x.act];
          if (x.title) row.push(short(x.title, 18));
          if (x.act === 'more') row.push(x.opened ? 1 : 0);
          if (x.why) row.push(x.why);
          return row;
        })
      };
      var key = JSON.stringify(pr);
      if (key !== prevProfile) o.pr = pr;
      return { o: o, prof: key };
    },

    // Вариант А: свежие подборы, сколько влезет в одно сообщение (≤ 3900 символов).
    // Promise → { text, sessions, total, packed }
    exportFit: function () {
      var self = this;
      var all = self.list();
      var total = all.length;
      var plain = function () {
        return { text: self.exportLast(), sessions: total ? 1 : 0, total: total, packed: false };
      };
      if (!total) return Promise.resolve({ text: '', sessions: 0, total: 0, packed: false });

      var build = function (n) {
        var out = [], prev = null;
        for (var i = 0; i < n; i++) {
          var r = self.compactEntry(all[total - 1 - i], i === 0, prev);
          out.push(r.o);
          prev = r.prof;
        }
        return JSON.stringify({ f: 'LPJ2', v: VERSION, kpq: kpQuota().n, mood: MoodsApi.state ? 1 : 0, s: out });
      };

      var best = null;
      var step = function (n) {
        if (n > total) return Promise.resolve(best);
        return gzipB64(build(n)).then(function (b) {
          if (b === null) return null;
          var text = 'LPJ2:' + b;
          if (text.length > 3900) return best;
          best = { text: text, sessions: n, total: total, packed: true };
          return step(n + 1);
        });
      };

      return step(1).then(function (res) { return res || plain(); }, function () { return plain(); });
    },

    exportText: function () {
      var a = this.list();
      var head = {
        plugin: 'lampa_picker',
        v: VERSION,
        exported: new Date().toISOString(),
        sessions: a.length,
        ua: (navigator.userAgent || '').slice(0, 120),
        kpQuotaToday: kpQuota().n,
        cubMeta: { off: cubMetaOff(), got: MoodsApi.got, asked: MoodsApi.asked, statuses: MoodsApi.statuses }
      };
      var lines = [JSON.stringify(head)];
      for (var i = 0; i < a.length; i++) lines.push(JSON.stringify(a[i]));
      return lines.join('\n');
    }
  };

  // gzip + base64 через CompressionStream. Promise со строкой или null, если сжатие недоступно
  function gzipB64(text) {
    if (typeof CompressionStream === 'undefined' || typeof Blob === 'undefined' || typeof Response === 'undefined') {
      return Promise.resolve(null);
    }
    try {
      var stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
      return new Response(stream).arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf);
        var bin = '';
        for (var i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(bin);
      })['catch'](function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  function copyText(text, ok, fail) {
    var legacy = function () {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-2000px';
        document.body.appendChild(ta);
        ta.select();
        var r = document.execCommand('copy');
        document.body.removeChild(ta);
        if (r) ok(); else fail();
      } catch (e) { fail(); }
    };
    try {
      if (Lampa.Utils && typeof Lampa.Utils.copyTextToClipboard === 'function') {
        Lampa.Utils.copyTextToClipboard(text, ok, legacy);
        return;
      }
    } catch (e) {}
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(ok, legacy);
        return;
      }
    } catch (e) {}
    legacy();
  }

  function canShare() { return !!(navigator.share); }

  // =========================================================================
  // Отправка журнала автору (Apps Script). Только по кнопке, с необязательным комментарием.
  // =========================================================================

  function feedbackLeft() {
    var q = store('fb_sent', {});
    if (q.day !== todaySeed()) q = { day: todaySeed(), n: 0 };
    return Math.max(0, FEEDBACK_DAILY - q.n);
  }

  var FEEDBACK_TIMEOUT = 30000;

  function postText(url, body) {
    if (window.fetch) {
      // У fetch нет таймаута: при зависшей сети пользователь иначе видит «Отправляю…» без итога
      return new Promise(function (resolve, reject) {
        var done = false;
        var t = setTimeout(function () { if (!done) { done = true; reject(new Error('timeout')); } }, FEEDBACK_TIMEOUT);
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body, redirect: 'follow' })
          .then(function (r) { return r.text(); })
          .then(function (txt) { if (!done) { done = true; clearTimeout(t); resolve(txt); } },
            function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } });
      });
    }
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open('POST', url, true);
      x.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
      x.timeout = 30000;
      x.onload = function () { resolve(x.responseText); };
      x.onerror = x.ontimeout = function () { reject(new Error('net')); };
      x.send(body);
    });
  }

  function sendFeedback(comment) {
    var text = Journal.exportText();
    var n = Journal.list().length;
    return gzipB64(text).then(function (b64) {
      var body = JSON.stringify({
        f: b64 ? 'LPJ1' : 'LPJ0',
        v: VERSION,
        n: n,
        c: String(comment || '').slice(0, 1000),
        j: b64 ? 'LPJ1:' + b64 : text.slice(0, 300000)
      });
      return postText(FEEDBACK_URL, body);
    }).then(function (resp) {
      var r = null;
      try { r = JSON.parse(resp); } catch (e) {}
      if (!r || !r.ok) throw new Error((r && r.error) || 'bad response');
      var q = store('fb_sent', {});
      if (q.day !== todaySeed()) q = { day: todaySeed(), n: 0 };
      q.n++;
      save('fb_sent', q);
      return r;
    });
  }

  // =========================================================================
  // Рейтинги КП и IMDb для видимых карточек
  // Схема как у rating.js: поиск на kinopoiskapiunofficial по imdb_id, запасной — по названию.
  // Результат пишется в кеш rating.js (kp_rating) — он не будет запрашивать повторно.
  // =========================================================================

  var KP_API = 'https://kinopoiskapiunofficial.tech/';
  var KP_DAILY_LIMIT = 500;         // личный ключ: суточный лимит бесплатного тарифа kinopoiskapiunofficial
  var KP_BUILTIN_DAILY_LIMIT = 40;  // встроенный ключ общий для всех — на устройство даём немного

  var KP_B = [91,87,2,85,72,104,63,110,118,53,22,13,0,23,59,43,41,108,35,212,142,203,158,254,247,252,190,174,151,215,192,212,176,237,178,225];

  function kpBuiltin() {
    var m = 'lampa-picker', out = '';
    for (var i = 0; i < KP_B.length; i++) out += String.fromCharCode(KP_B[i] ^ m.charCodeAt(i % m.length) ^ ((i * 7) & 0xff));
    return out;
  }

  function kpPersonal() {
    var k = store('kp_key', '');
    return typeof k === 'string' ? k.replace(/\s+/g, '') : '';
  }

  // Личный ключ из настроек важнее встроенного
  function kpKey() { return kpPersonal() || kpBuiltin(); }
  function kpUsingBuiltin() { return !kpPersonal(); }
  function kpLimit() { return kpUsingBuiltin() ? KP_BUILTIN_DAILY_LIMIT : KP_DAILY_LIMIT; }

  // Счётчик привязан к дню и к ключу: смена ключа — новый счёт
  function kpKeyTag() {
    var k = kpKey();
    return (kpUsingBuiltin() ? 'b' : 'p') + k.slice(-4);
  }

  function kpQuota() {
    var q = store('kp_quota', {});
    var day = todaySeed(), tag = kpKeyTag();
    if (q.day !== day || q.key !== tag) q = { day: day, key: tag, n: 0, blocked: false };
    return q;
  }

  // Отдельная очередь КП: не мешает TMDB, короткий таймаут, без повторов.
  // Два сетевых сбоя подряд (источник недоступен) — час только кеш.
  var KP_TIMEOUT = 4500, KP_OFF_FOR = 3600 * 1000;
  // Контекст подбора для КП: свой потолок квоты и флаг «закончен». Задания очереди помечены контекстом,
  // поэтому дедлайн одного подбора не трогает задания другого, а поздние шаги закончившегося не уходят в сеть
  function kpContext() {
    return { cap: kpQuota().n + (kpUsingBuiltin() ? KP_RUN_BUDGET_BUILTIN : KP_RUN_BUDGET_PERSONAL), done: false };
  }
  var kpNetFails = 0;
  var KpNet = {
    queue: [], active: 0, max: 3,
    get: function (url, ok, fail, opts, ctx) { this.queue.push({ url: url, ok: ok, fail: fail, opts: opts, ctx: ctx }); this.pump(); },
    // Убрать из очереди задания одного подбора (их колбэки получают отказ)
    dropCtx: function (ctx) {
      var keep = [], gone = [];
      for (var i = 0; i < this.queue.length; i++) (this.queue[i].ctx === ctx ? gone : keep).push(this.queue[i]);
      this.queue = keep;
      for (var j = 0; j < gone.length; j++) { try { gone[j].fail && gone[j].fail(-1); } catch (e) {} }
    },
    pump: function () {
      var self = this;
      while (self.active < self.max && self.queue.length) {
        (function (job) {
          self.active++;
          var settled = false;
          var end = function (fn, arg) {
            if (settled) return; settled = true;
            self.active--;
            try { fn && fn(arg); } catch (e) { log('kp callback error', e); }
            self.pump();
          };
          var onFail = function (status) {
            if (!status) { if (++kpNetFails >= 2) { save('kp_off', now() + KP_OFF_FOR); self.queue = []; log('kp offline for 1h'); } }
            else kpNetFails = 0;
            end(job.fail, status);
          };
          // Списываем квоту в момент отправки: отменённые из очереди запросы не считаются
          if (!kpSpend(job.ctx)) return end(job.fail, -1);
          var req = new Lampa.Reguest();
          req.timeout(KP_TIMEOUT);
          req.silent(job.url, function (j) { kpNetFails = 0; end(job.ok, j); }, function (a) { onFail((a && a.status) || 0); }, false, job.opts);
          setTimeout(function () { if (!settled) onFail(0); }, KP_TIMEOUT + 300);
        })(self.queue.shift());
      }
    }
  };

  function kpOffline() { return store('kp_off', 0) > now(); }

  var KP_PAUSE_429 = 60000;
  var kpPauseUntil = 0;           // в памяти: пауза короткая, переживать перезапуск ей незачем
  function kpPause() { kpPauseUntil = now() + KP_PAUSE_429; log('kp 429, pause', KP_PAUSE_429); }

  // Можно ли ещё запрашивать (без списания)
  function kpCan(ctx) {
    if (!kpKey() || kpOffline() || kpPauseUntil > now()) return false;
    if (ctx && ctx.done) return false;
    var q = kpQuota();
    return !q.blocked && q.n < kpLimit() && !(ctx && q.n >= ctx.cap);
  }

  // Почему сейчас нельзя спросить КП — для журнала (пусто — можно)
  function kpWhyNot(ctx) {
    if (!kpKey()) return 'no_key';
    if (kpOffline()) return 'offline';
    if (kpPauseUntil > now()) return 'paused';
    if (ctx && ctx.done) return 'deadline';
    var q = kpQuota();
    if (q.blocked) return 'blocked';
    if (q.n >= kpLimit()) return 'daily_limit';
    if (ctx && q.n >= ctx.cap) return 'run_budget';
    return '';
  }

  function kpSpend(ctx) {
    if (!kpCan(ctx)) return false;
    var q = kpQuota();
    q.n++;
    save('kp_quota', q);
    return true;
  }

  // Ключ отклонён или исчерпан — до конца дня не запрашиваем
  function kpBlock(status) {
    var q = kpQuota();
    if (q.blocked) return;
    q.blocked = status || true;
    save('kp_quota', q);
    if (kpUsingBuiltin()) return; // встроенный ключ исчерпан — молча уходим в кеш
    noty(status === 401 ? 'Ключ Кинопоиска не принят — проверьте его в настройках'
      : 'Лимит ключа Кинопоиска на сегодня исчерпан — рейтинги КП только из кеша');
  }

  function kpFail(cb) {
    return function (status) {
      // 429 — лимит запросов в секунду, а не суточная квота: короткая пауза, а не блок до конца дня
      if (status === 429) kpPause();
      else if (status === 401 || status === 402 || status === 403) kpBlock(status);
      cb(null, status > 0 ? 'http_' + status : 'net');
    };
  }

  function kpCheckKey(key, cb) {
    var req = new Lampa.Reguest();
    req.timeout(10000);
    req.silent(KP_API + 'api/v2.2/films/301', function (j) {
      cb(!!(j && (j.kinopoiskId || j.nameRu)), 200);
    }, function (a) { cb(false, (a && a.status) || 0); }, false, { headers: { 'X-API-KEY': key } });
  }

  function writeKpCache(tmdbId, rec) {
    try {
      var cache = Lampa.Storage.cache('kp_rating', 500, {}) || {};
      cache[tmdbId] = rec;
      Lampa.Storage.set('kp_rating', cache);
    } catch (e) {}
  }

  function kpHeaders() { return { headers: { 'X-API-KEY': kpKey() } }; }

  var KP_YEAR_SLACK = 3;   // ±лет при совпадении названия
  var KP_MATCH_V = 3;      // версия сопоставления: записи прежних версий без оценки переспрашиваем один раз

  // Название для сравнения: без регистра, знаков и «ё»
  function normTitle(t) {
    return String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '');
  }

  function fetchRatings(it, cb, ctx) {
    var c = it.c;
    var cached = c.type === 'tv' ? null : kpCache()[c.id];   // см. cachedRatings: ключ без типа
    if (cached && (parseFloat(cached.kp) > 0 || parseFloat(cached.imdb) > 0)) {
      return cb({ kp: parseFloat(cached.kp) || 0, imdb: parseFloat(cached.imdb) || 0, src: 'cache' });
    }

    var map = Durable.get('kpmap', {});
    var m = map[it.k];
    // Второй аргумент cb — почему оценки нет (для журнала)
    // «Не найден» из старых версий (без записи, что ответил КП) переспрашиваем один раз — ради диагностики
    var legacyMiss = m && !m.kp && !m.imdb && !m.id && (!m.probe || (m.probe.total > 0 && !(m.mv >= 2)));
    // Фильм на КП найден, но оценку ещё не спрашивали: запись от «С детьми» (возраст) или из старой версии
    // без отметки r — сразу за оценкой по id
    var ageOnly = m && !m.kp && !m.imdb && m.id && !m.r;
    // «Нашёлся без оценки» от прежней версии сопоставления: по названию мог найтись чужой фильм того же года
    // («Мультивселенная» → Entangled) — сопоставляем заново, один раз
    var staleNoRating = m && !m.kp && !m.imdb && m.id && m.r && !(m.mv >= KP_MATCH_V);
    if (m && now() - m.t < 14 * DAY && !legacyMiss && !ageOnly && !staleNoRating) {
      if (m.kp || m.imdb) return cb({ kp: m.kp, imdb: m.imdb, src: 'cache' });
      if (m.probe) it.kpProbe = m.probe;
      return cb(null, m.id ? 'cached_no_rating' : 'cached_miss');   // нашёлся без оценки / не нашёлся
    }


    var finish = function (kp, imdb, kpId, age) {
      kp = parseFloat(kp) || 0;
      imdb = parseFloat(imdb) || 0;
      var mp = Durable.get('kpmap', {});
      var prev = mp[it.k];
      mp[it.k] = { kp: kp, imdb: imdb, id: kpId || null, t: now(), va: c.va || 0, r: 1, mv: KP_MATCH_V };   // r — оценку спрашивали
      if (typeof age === 'number') mp[it.k].age = age;
      else if (prev && typeof prev.age === 'number' && prev.id === mp[it.k].id) mp[it.k].age = prev.age;
      if (!kp && !imdb && it.kpProbe) mp[it.k].probe = it.kpProbe;   // что ответил КП — до следующей проверки
      var keys = Object.keys(mp);
      if (keys.length > 1500) {
        keys.sort(function (a, b) { return mp[a].t - mp[b].t; });
        for (var i = 0; i < keys.length - 1500; i++) delete mp[keys[i]];
      }
      Durable.set('kpmap', mp);
      if (kp || imdb) {
        if (c.type !== 'tv') writeKpCache(c.id, { kp: kp, imdb: imdb, timestamp: now() });
        cb({ kp: kp, imdb: imdb, src: 'net' });
      } else cb(null, kpId ? 'no_rating' : 'not_found');
    };

    var imdbRes = '';   // что ответил поиск по IMDb-номеру — для журнала

    var byId = function (kpId) {
      if (!kpCan(ctx)) return cb(null, kpWhyNot(ctx));
      KpNet.get(KP_API + 'api/v2.2/films/' + kpId, function (j) {
        if (j && !(parseFloat(j.ratingKinopoisk) > 0 || parseFloat(j.ratingImdb) > 0)) {
          // Для журнала: какой фильм КП сопоставил — вдруг не тот (короткометражка, видео с тем же названием)
          it.kpProbe = { imdb: imdbRes || (c.imdb ? 'skip' : 'none'), found: kpId, type: String(j.type || ''), year: String(j.year || ''),
            name: String(j.nameRu || j.nameOriginal || j.nameEn || '').slice(0, 30), votes: j.ratingKinopoiskVoteCount || 0 };
        }
        finish(j && j.ratingKinopoisk, j && j.ratingImdb, kpId, kpAgeOf(j));
      }, kpFail(cb), kpHeaders(), ctx);
    };

    var byTitle = function () {
      if (!c.title) return cb(null, 'not_found');
      if (!kpCan(ctx)) return cb(null, kpWhyNot(ctx));
      KpNet.get(KP_API + 'api/v2.1/films/search-by-keyword?keyword=' + encodeURIComponent(c.original || c.title), function (j) {
        var films = (j && j.films) || [];
        var y = parseInt(c.year, 10);
        // Тип должен совпасть (фильм ≠ сериал)
        var typeOk = function (f) {
          var ft = String(f.type || '');
          if (!ft) return true;
          var isTv = /SERIES|TV_SHOW/.test(ft);
          return c.type === 'tv' ? isTv : !isTv;
        };
        // Год на КП бывает годом производства, а на TMDB — годом проката («Связь»: КП 2012, TMDB 2014).
        // Поэтому при совпадении названия допускаем разницу до 3 лет
        // Название сверяем всегда: поиск по слову отдаёт и чужие фильмы того же года
        // («Multiverse» → Entangled 2019 раньше нужной «Мультивселенной» 2018)
        var nameOk = function (f) {
          var o = normTitle(c.original), t = normTitle(c.title), en = normTitle(f.nameEn), ru = normTitle(f.nameRu);
          return !!((o && (en === o || ru === o)) || (t && (ru === t || en === t)));
        };
        var gap = function (f) {
          var fy = parseInt(f.year, 10);
          return !y ? 0 : isNaN(fy) ? 99 : Math.abs(fy - y);
        };
        var cands = films.filter(typeOk);
        var hit = null;
        // Совпало название — ближайший по году в пределах допуска
        cands.forEach(function (f) {
          if (nameOk(f) && gap(f) <= KP_YEAR_SLACK && (!hit || gap(f) < gap(hit))) hit = f;
        });
        // Названия не совпали (другой перевод, нет английского) — берём, только если вариант того же года один
        if (!hit) {
          var same = cands.filter(function (f) { return gap(f) === 0; });
          if (same.length === 1) hit = same[0];
        }
        if (hit) return byId(hit.filmId);
        // Для журнала: что вернул поиск (до 5 вариантов: тип, год, название) — чтобы понять, почему не совпало
        it.kpProbe = {
          imdb: c.imdb ? imdbRes : 'none', q: String(c.original || c.title).slice(0, 40), year: y || null, total: films.length,
          top: films.slice(0, 5).map(function (f) { return [String(f.type || ''), String(f.year || ''), String(f.nameRu || f.nameEn || '').slice(0, 30)]; })
        };
        finish(0, 0, null);
      }, kpFail(cb), kpHeaders(), ctx);
    };

    if (ageOnly) return byId(m.id);   // фильм на КП уже найден — сразу за оценкой
    if (c.imdb) {
      if (!kpCan(ctx)) return cb(null, kpWhyNot(ctx));
      KpNet.get(KP_API + 'api/v2.2/films?imdbId=' + encodeURIComponent(c.imdb), function (j) {
        var x = j && j.items && j.items[0];
        // Список по IMDb-номеру иногда отдаёт фильм без оценок, хотя у карточки КП они есть — переспрашиваем по id
        if (x && !(parseFloat(x.ratingKinopoisk) > 0 || parseFloat(x.ratingImdb) > 0) && x.kinopoiskId) { imdbRes = 'item_no_rating'; byId(x.kinopoiskId); }
        else if (x) finish(x.ratingKinopoisk, x.ratingImdb, x.kinopoiskId);
        else { imdbRes = 'empty'; byTitle(); }
      }, function (status) {
        if (status === 401 || status === 402 || status === 403 || status === 429 || status <= 0) return kpFail(cb)(status);
        imdbRes = 'http_' + status;
        byTitle();
      }, kpHeaders(), ctx);
    } else byTitle();
  }

  // Возрастное ограничение Кинопоиска: «age18» → 18; −1 — у КП ограничения нет; null — ответа нет
  function kpAgeOf(j) {
    if (!j || typeof j !== 'object') return null;
    var m = String(j.ratingAgeLimits || '').match(/(\d+)/);
    return m ? parseInt(m[1], 10) : -1;
  }

  // Возраст по КП для одного фильма: из kpmap, иначе запрос карточки КП (id берём из kpmap или ищем по imdb)
  function kpAge(it, cb, ctx) {
    var mp = Durable.get('kpmap', {});
    var m = mp[it.k];
    if (m && typeof m.age === 'number') return cb(m.age);
    var save = function (id, age) {
      var mm = Durable.get('kpmap', {});
      var rec = mm[it.k] || { kp: 0, imdb: 0, t: now(), va: (it.c && it.c.va) || 0 };
      rec.id = id; rec.age = age;
      mm[it.k] = rec;
      Durable.set('kpmap', mm);
      cb(age);
    };
    var byId = function (id) {
      if (!kpCan(ctx)) return cb(null);
      KpNet.get(KP_API + 'api/v2.2/films/' + id, function (j) {
        var age = kpAgeOf(j);
        if (age === null) return cb(null);
        save(id, age);
      }, function () { cb(null); }, kpHeaders(), ctx);
    };
    if (m && m.id) return byId(m.id);
    var c = it.c || {};
    if (!c.imdb || !kpCan(ctx)) return cb(null);          // поиск по названию ради возраста не тратим
    KpNet.get(KP_API + 'api/v2.2/films?imdbId=' + encodeURIComponent(c.imdb), function (j) {
      var x = j && j.items && j.items[0];
      if (x && x.kinopoiskId) byId(x.kinopoiskId);
      else cb(null);
    }, function () { cb(null); }, kpHeaders(), ctx);
  }

  // «С детьми»: возраст КП для лучших кандидатов. У TMDB часто есть только американский рейтинг,
  // а КП знает российское ограничение (пример: «10 причин моей ненависти» — PG-13 в TMDB, 18+ на КП)
  var KIDS_AGE_N = 20, KIDS_AGE_DEADLINE = 5000;

  function attachKidsAge(list, cb) {
    var fired = false;
    // Тот же бюджет на подбор, что и у оценок: встроенный ключ общий
    var ctx = kpContext();
    var finish = function () { if (!fired) { fired = true; ctx.done = true; KpNet.dropCtx(ctx); cb(); } };
    var todo = list.filter(function (it) { return it.c && it.c.type === 'movie' && it.c.kpAge === undefined; })
      .sort(function (a, b) { return b.score - a.score; }).slice(0, KIDS_AGE_N);
    if (!todo.length || !kpCan(ctx)) return finish();
    setTimeout(finish, KIDS_AGE_DEADLINE);
    var idx = 0, running = 0;
    var next = function () {
      if (fired) return;
      if (idx >= todo.length && !running) return finish();
      while (running < 3 && idx < todo.length) {
        (function (it) {
          running++;
          kpAge(it, function (age) {
            if (typeof age === 'number') it.c.kpAge = age;
            running--;
            next();
          }, ctx);
        })(todo[idx++]);
      }
    };
    next();
  }

  // Оценки для финалистов перед окончательным порядком: кеш, затем запросы. Подбор ждёт не дольше дедлайна.
  var KP_FINALISTS = 20, KP_DEADLINE = 5000;
  // Запросов на один подбор: встроенный ключ общий и маленький — не выжигаем его за раз
  var KP_RUN_BUDGET_BUILTIN = 12, KP_RUN_BUDGET_PERSONAL = 40;

  function attachRatings(list, cb) {
    var fired = false, timedOut = false;
    var ctx = kpContext();
    var todo = list.slice().sort(function (a, b) { return b.score - a.score; })
      .slice(0, KP_FINALISTS).filter(function (it) { return it.c && !it.rt && !it.kpTried; });
    var finish = function () {
      if (fired) return;
      fired = true;
      // Кого не успели или не смогли спросить — причина в журнал
      var why = timedOut ? 'deadline' : (kpWhyNot(ctx) || 'deadline');
      for (var t = 0; t < todo.length; t++) if (!todo[t].rt && !todo[t].kpMiss) todo[t].kpMiss = why;
      ctx.done = true;
      KpNet.dropCtx(ctx);        // не дождались — не тратим квоту на хвост; чужие задания не трогаем
      cb();
    };
    if (!todo.length || !kpCan(ctx)) return finish();
    setTimeout(function () { timedOut = true; finish(); }, KP_DEADLINE);
    // По очереди от лучшего к худшему, по 3 фильма одновременно: бюджет уходит на верх списка целиком
    var idx = 0, running = 0;
    var next = function () {
      if (fired) return;
      if ((idx >= todo.length || !kpCan(ctx)) && !running) return finish();
      while (running < 3 && idx < todo.length && kpCan(ctx)) {
        (function (it) {
          running++;
          it.kpTried = true;
          fetchRatings(it, function (r, why) {
            if (r) {
              it.rt = { kp: r.kp || 0, imdb: r.imdb || 0, src: r.src || 'net' };
              if (r.kp) it.kp = r.kp;
              if (r.imdb) it.imdbR = r.imdb;
              it.kpMiss = null;
            } else if (!fired) it.kpMiss = why || 'not_found';
            running--;
            next();
          }, ctx);
        })(todo[idx++]);
      }
    };
    next();
  }

  // =========================================================================
  // Интерфейс: справочники, иконки, стили
  // =========================================================================

  var TIME_ITEMS = [
    { title: 'До 40 минут', hint: 'Короткий метр или пара серий', value: '40', icon: 'stopwatch' },
    { title: 'До 1,5 часа', hint: 'Один фильм без спешки', value: '90', icon: 'film' },
    { title: 'До 2 часов', hint: 'Полный метр', value: '120', icon: 'hourglass' },
    { title: 'Сериал на вечер', hint: 'Несколько серий подряд', value: 'series', icon: 'tv' },
    { title: 'Неважно', hint: 'Без ограничений', value: 'any', icon: 'infinity' }
  ];

  var MOOD_ITEMS = [
    { title: 'Расслабиться', hint: 'Лёгкое и тёплое', value: 'relax', icon: 'sun' },
    { title: 'Посмеяться', hint: 'Комедии', value: 'laugh', icon: 'smile' },
    { title: 'Пощекотать нервы', hint: 'Триллеры и детективы', value: 'nerves', icon: 'bolt' },
    { title: 'Подумать', hint: 'Драмы и фантастика', value: 'think', icon: 'bulb' },
    { title: 'Удиви меня', hint: 'То, что вы обычно не смотрите', value: 'surprise', icon: 'sparkle' },
    { title: 'Неважно', hint: 'Только по вкусу', value: 'any', icon: 'dots' }
  ];

  var COMPANY_ITEMS = [
    { title: 'Один', hint: 'Только мой вкус', value: 'solo', icon: 'user' },
    { title: 'Вдвоём', hint: 'На двоих', value: 'couple', icon: 'couple' },
    { title: 'С детьми', hint: 'Рейтинг до 12+', value: 'kids', icon: 'kids' },
    { title: 'Компанией', hint: 'Чтобы зашло всем', value: 'group', icon: 'group' }
  ];

  var STEPS = [
    { key: 'time', q: 'Сколько есть времени?', items: TIME_ITEMS },
    { key: 'mood', q: 'Какое настроение?', items: MOOD_ITEMS },
    { key: 'company', q: 'С кем смотрите?', items: COMPANY_ITEMS }
  ];

  function titleOf(items, v) {
    for (var i = 0; i < items.length; i++) if (items[i].value === v) return items[i].title;
    return v;
  }

  function describeList(ans) {
    var out = [];
    if (ans.time) out.push(titleOf(TIME_ITEMS, ans.time));
    if (ans.mood) out.push(titleOf(MOOD_ITEMS, ans.mood));
    if (ans.company) out.push(titleOf(COMPANY_ITEMS, ans.company));
    return out;
  }

  var ICONS = {
    stopwatch: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5M9 2h6"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    hourglass: '<path d="M6 3h12M6 21h12M7 3v3a5 5 0 0 0 10 0V3M7 21v-3a5 5 0 0 1 10 0v3"/>',
    tv: '<rect x="3" y="7" width="18" height="12" rx="2"/><path d="M8 3l4 4 4-4"/>',
    infinity: '<path d="M7 9a3 3 0 1 0 0 6c2 0 3-1.5 5-3s3-3 5-3a3 3 0 1 1 0 6c-2 0-3-1.5-5-3S9 9 7 9z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9.5h.01M15 9.5h.01"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    bulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>',
    sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    dots: '<circle cx="12" cy="12" r="9"/><path d="M8 12h.01M12 12h.01M16 12h.01"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
    couple: '<circle cx="9" cy="8" r="3.5"/><circle cx="16.5" cy="9" r="3"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5M16.5 14.5c3 0 5.5 1.5 5.5 5"/>',
    kids: '<circle cx="8" cy="7" r="3.5"/><circle cx="17" cy="11" r="2.5"/><path d="M2 20c0-3.5 2.5-5.5 6-5.5s6 2 6 5.5M13.5 20c0-2.5 1.5-4 3.5-4s3.5 1.5 3.5 4"/>',
    group: '<circle cx="12" cy="7" r="3"/><circle cx="5" cy="10" r="2.5"/><circle cx="19" cy="10" r="2.5"/><path d="M6 20c0-3.5 2.7-5.5 6-5.5s6 2 6 5.5M1 19c0-2.5 1.8-4 4-4M23 19c0-2.5-1.8-4-4-4"/>',
    play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M4 12l5 5L20 6"/>',
    like: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
    send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    star: '<path d="M12 2l2.9 6.26L21.5 9l-5 4.73L17.8 21 12 17.27 6.2 21l1.3-7.27L2.5 9l6.6-.74L12 2z"/>'
  };

  function svg(name, cls) {
    return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  // Путь постера TMDB — «/abc123.jpg». Всё остальное (кавычки, скобки, пробелы) — не постер: в разметку не пускаем
  var POSTER_PATH = /^\/[A-Za-z0-9_\-]+\.(jpg|jpeg|png|webp)$/i;
  function cssUrl(u) {
    return String(u || '').replace(/["'()\\\s<>]/g, function (ch) { return '%' + ('0' + ch.charCodeAt(0).toString(16)).slice(-2); });
  }

  function img(path, size) {
    if (!path || !POSTER_PATH.test(String(path))) return '';
    try {
      if (Lampa.TMDB && typeof Lampa.TMDB.image === 'function') return cssUrl(Lampa.TMDB.image('t/p/' + size + path));
    } catch (e) {}
    return cssUrl('https://image.tmdb.org/t/p/' + size + path);
  }

  var CSS = [
    '.pkr-root{position:relative;height:100%;overflow:hidden}',
    '.pkr-scroller{position:relative;height:100%;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch}',
    '.pkr-scroller::-webkit-scrollbar{width:0;height:0}',
    '.pkr{position:relative;padding:1.5em 2em 4em;color:#fff;min-height:100%}',
    '.pkr *{box-sizing:border-box}',
    '.pkr svg{display:inline-block}',

    /* Мастер */
    '.pkr-step{font-size:.8em;letter-spacing:.18em;text-transform:uppercase;opacity:.5}',
    '.pkr-ver{margin-left:.6em;letter-spacing:.05em;text-transform:none;opacity:.7}',
    '.pkr-dots{margin-top:.7em;line-height:0}',
    '.pkr-dots span{display:inline-block;width:2.4em;height:.25em;border-radius:.2em;background:rgba(255,255,255,.18);margin-right:.4em;transition:background-color .3s}',
    '.pkr-dots span.on{background:#fff}',
    '.pkr-q{font-size:2.4em;font-weight:700;line-height:1.15;margin:.55em 0 .25em}',
    '.pkr-sub{opacity:.5;margin-bottom:1.6em;min-height:1.3em}',
    '.pkr-tiles{margin:0 -.5em}',
    '.pkr-tile{display:inline-block;vertical-align:top;width:12em;min-height:10em;margin:0 .5em 1em;padding:1.3em 1.2em 1.25em;border-radius:1em;',
    'background:rgba(255,255,255,.07);border:.15em solid rgba(255,255,255,.05);transition:transform .15s ease,background-color .15s ease,color .15s ease}',
    '.pkr-tile svg{width:2.3em;height:2.3em;margin-bottom:.9em;opacity:.9}',
    '.pkr-tile__title{font-size:1.2em;font-weight:600;line-height:1.2}',
    '.pkr-tile__hint{font-size:.82em;opacity:.55;margin-top:.4em;line-height:1.3}',
    '.pkr-tile.is-chosen{border-color:rgba(255,255,255,.45)}',
    '.pkr-tile.focus{background:#fff;color:#111;transform:scale(1.05)}',
    '.pkr-tile.focus .pkr-tile__hint{opacity:.65}',
    '.pkr-last{display:inline-block;margin:0 0 1.8em;padding:.65em 1.3em .65em 1em;border-radius:2em;background:rgba(255,255,255,.09);transition:background-color .15s,color .15s}',
    '.pkr-last svg{width:1.25em;height:1.25em;vertical-align:middle;margin-right:.6em}',
    '.pkr-last span{vertical-align:middle}',
    '.pkr-last b{font-weight:600;margin-right:.6em}',
    '.pkr-last i{font-style:normal;opacity:.6}',
    '.pkr-last.focus{background:#fff;color:#111}',

    /* Чипы ответов */
    '.pkr-chips{line-height:1}',
    '.pkr-chip{display:inline-block;padding:.4em .85em;border-radius:2em;background:rgba(255,255,255,.12);font-size:.82em;margin:0 .4em .4em 0}',

    /* Загрузка */
    '.pkr-load__title{font-size:2.2em;font-weight:700;margin-top:.4em}',
    '.pkr-load__stage{opacity:.55;margin:.5em 0 2.2em;min-height:1.4em}',
    '.pkr-skel{background:rgba(255,255,255,.06);background-image:linear-gradient(90deg,rgba(255,255,255,0) 0%,rgba(255,255,255,.09) 50%,rgba(255,255,255,0) 100%);',
    'background-size:200% 100%;background-repeat:no-repeat;-webkit-animation:pkrShimmer 1.3s infinite linear;animation:pkrShimmer 1.3s infinite linear}',
    '.pkr-skel-line{height:.8em;border-radius:.3em;margin-top:.8em;width:75%}',
    '.pkr-skel-line.short{width:45%;margin-top:.45em}',
    '@-webkit-keyframes pkrShimmer{0%{background-position:150% 0}100%{background-position:-50% 0}}',
    '@keyframes pkrShimmer{0%{background-position:150% 0}100%{background-position:-50% 0}}',

    /* Результаты */
    '.pkr-res{position:relative}',
    '.pkr-bg{position:absolute;left:-2em;right:-2em;top:-1.5em;height:32em;z-index:0;overflow:hidden;',
    '-webkit-mask-image:linear-gradient(to bottom,#000 40%,transparent 100%);mask-image:linear-gradient(to bottom,#000 40%,transparent 100%)}',
    '.pkr-bg__img{position:absolute;left:0;top:0;right:0;bottom:0;background-size:cover;background-position:center 25%;opacity:0;transition:opacity .45s ease}',
    '.pkr-bg__img.on{opacity:.5}',
    '.pkr-bg__shade{position:absolute;left:0;top:0;right:0;bottom:0;background:linear-gradient(90deg,rgba(0,0,0,.88) 0%,rgba(0,0,0,.55) 45%,rgba(0,0,0,.15) 100%)}',
    '.pkr-content{position:relative;z-index:1}',
    '.pkr-hero{min-height:13.5em;padding:1em 0 0;max-width:44em}',
    '.pkr-hero__title{font-size:2.6em;font-weight:700;line-height:1.1;text-shadow:0 .1em .5em rgba(0,0,0,.5);overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}',
    '.pkr-hero__orig{opacity:.55;margin-top:.35em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.pkr-hero__meta{margin-top:.9em;line-height:1}',
    '.pkr-b{display:inline-block;padding:.32em .6em;border-radius:.4em;background:rgba(255,255,255,.15);font-size:.85em;font-weight:600;margin:0 .45em .45em 0;vertical-align:middle;white-space:nowrap}',
    '.pkr-b--match{background:#21c063;color:#062a12}',
    '.pkr-b--kp{background:#ff6a00;color:#fff}',
    '.pkr-b--imdb{background:#f5c518;color:#111}',
    '.pkr-b--text{background:none;padding-left:0;padding-right:.2em;font-weight:400;opacity:.75}',
    '.pkr-moods{margin-top:.5em;line-height:1}',
    '.pkr-mood{display:inline-block;margin:0 1.1em .4em 0;font-size:.82em;vertical-align:middle}',
    '.pkr-mood i{font-style:normal;opacity:.7;margin-right:.45em;vertical-align:middle}',
    '.pkr-mood b{display:inline-block;width:3.6em;height:.35em;border-radius:.2em;background:rgba(255,255,255,.15);vertical-align:middle;overflow:hidden}',
    '.pkr-mood b span{display:block;height:100%;background:#ffd166;border-radius:.2em}',
    '.pkr-hero__reason{margin-top:.55em;font-size:1.08em;color:#ffd166;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}',
    '.pkr-hero__reason svg{width:1.05em;height:1.05em;vertical-align:-.12em;margin-right:.45em}',
    '.pkr-hero__descr{margin-top:.6em;border-radius:.5em;transition:background-color .15s}',
    '.pkr-hero__text{opacity:.75;line-height:1.45;min-height:2.9em;max-height:2.9em;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}',
    '.pkr-hero__more{display:inline-block;visibility:hidden;font-size:.85em;font-weight:600;color:#ffd166;margin-top:.35em;padding:.5em .9em;border-radius:2em;background:rgba(255,209,102,.12)}',
    '.pkr-hero__descr.is-long .pkr-hero__more{visibility:visible}',
    '.pkr-hero__descr{margin-left:-.5em;margin-right:-.5em;padding:.3em .5em}',
    '.pkr-hero__descr.is-long{cursor:pointer}',
    '.pkr-hero__descr.is-open .pkr-hero__text{max-height:none;min-height:0;display:block;-webkit-line-clamp:unset;opacity:.9}',
    '.pkr-hero__descr.focus{background:rgba(255,255,255,.1)}',
    '.pkr-debug{margin-top:.6em;font-family:monospace;font-size:.78em;opacity:.55}',
    '.pkr-note{font-size:.82em;opacity:.5;margin:.2em 0 .8em}',

    '.pkr-row{margin:0 -.55em;padding-top:.6em;white-space:nowrap;font-size:1em}',
    '.pkr-card{display:inline-block;vertical-align:top;width:14.2%;padding:0 .55em;white-space:normal}',
    '.pkr-card__img{position:relative;padding-bottom:150%;border-radius:.7em;background-color:rgba(255,255,255,.06);background-size:cover;background-position:center;',
    'box-shadow:0 .4em 1.2em rgba(0,0,0,.45);transition:transform .18s ease,opacity .25s ease}',
    '.pkr-card__img:after{content:"";position:absolute;left:0;top:0;right:0;bottom:0;border-radius:.7em;border:.2em solid transparent;transition:border-color .15s}',
    '.pkr-card.is-active .pkr-card__img:after{border-color:rgba(255,255,255,.4)}',
    '.pkr-card.focus .pkr-card__img{transform:scale(1.06)}',
    '.pkr-card.focus .pkr-card__img:after{border-color:#fff}',
    '.pkr-card.is-gone .pkr-card__img{opacity:0;transform:scale(.9)}',
    '.pkr-card__num{position:absolute;left:.45em;top:.45em;width:1.7em;height:1.7em;line-height:1.7em;text-align:center;border-radius:50%;background:rgba(0,0,0,.7);font-weight:700;font-size:.8em}',
    '.pkr-card__rate{position:absolute;right:.45em;top:.45em;padding:.2em .45em;border-radius:.35em;background:rgba(0,0,0,.72);font-size:.78em;font-weight:700}',
    '.pkr-card__rate.is-kp{background:#ff6a00;color:#fff}',
    '.pkr-card__type{position:absolute;left:.45em;bottom:.45em;padding:.2em .5em;border-radius:.35em;background:rgba(0,0,0,.72);font-size:.68em;text-transform:uppercase;letter-spacing:.06em}',
    '.pkr-card__noimg{position:absolute;left:0;top:0;right:0;bottom:0;padding:1em;display:-webkit-box;display:flex;-webkit-box-align:center;align-items:center;-webkit-box-pack:center;justify-content:center;text-align:center;font-weight:600;opacity:.6}',
    '.pkr-card__name{margin-top:.65em;font-size:.95em;font-weight:600;line-height:1.25;max-height:2.5em;overflow:hidden}',
    '.pkr-card__year{font-size:.8em;opacity:.5;margin-top:.2em}',

    '.pkr-actions{margin:1.2em 0 1.4em}','.pkr-actions--footer{margin:1.4em 0 0}','.pkr-btn--ghost{background:none;opacity:.75}','.pkr-btn--ghost.focus{opacity:1}',
    '.pkr-btn{display:inline-block;padding:.75em 1.3em;border-radius:.6em;background:rgba(255,255,255,.14);margin:0 .6em .6em 0;font-weight:600;transition:transform .15s,background-color .15s,color .15s}',
    '.pkr-btn svg{width:1.15em;height:1.15em;vertical-align:-.2em;margin-right:.55em}',
    '.pkr-btn--primary{background:rgba(255,255,255,.92);color:#111}',
    '.pkr-btn.focus{background:#fff;color:#111;transform:scale(1.04)}',
    '.pkr-btn--primary.focus{background:#ffd166}',

    /* Журнал */
    '.pkr-wizard__foot{margin-top:1.2em}',
    '.pkr-j__title{font-size:2.2em;font-weight:700;margin-top:.2em}',
    '.pkr-j__sub{opacity:.55;margin:.5em 0 1.4em;line-height:1.4;max-width:40em}',
    '.pkr-j__list{margin:1.2em 0 0;max-width:52em}',
    '.pkr-j__row{padding:.75em 1em;border-radius:.6em;background:rgba(255,255,255,.05);margin-bottom:.5em;line-height:1.35}',
    '.pkr-j__row b{font-weight:600}',
    '.pkr-j__meta{opacity:.55;font-size:.85em;margin-top:.2em}',

    /* Пусто */
    '.pkr-empty{padding:4em 0 2em;text-align:center}',
    '.pkr-empty svg{width:4em;height:4em;opacity:.35;margin-bottom:1em}',
    '.pkr-empty__title{font-size:1.7em;font-weight:700}',
    '.pkr-empty__text{opacity:.55;margin:.6em auto 1.8em;max-width:30em;line-height:1.4}',

    /* Телефон */
    // Низкий экран (ТВ-приставки часто отдают 960×540): компактнее, чтобы описание и постеры помещались вместе
    '.pkr-res.is-compact .pkr-hero{padding-top:.3em}',
    '.pkr-res.is-compact .pkr-hero__title{font-size:2em}',
    '.pkr-res.is-compact .pkr-hero__meta{margin-top:.5em}',
    '.pkr-res.is-compact .pkr-hero__reason{margin-top:.35em;-webkit-line-clamp:1}',
    '.pkr-res.is-compact .pkr-hero__descr{margin-top:.35em}',
    '.pkr-res.is-compact .pkr-hero__more{margin-top:.15em;padding:.3em .8em}',
    '.pkr-res.is-compact .pkr-actions{margin:.6em 0 .7em}',
    '.pkr-res.is-compact .pkr-row{padding-top:.3em}',
    '.pkr-res.is-compact .pkr-hero{min-height:0}',
    '.pkr-taste__sub{opacity:.7;margin:.4em 0 1em;line-height:1.4;max-width:44em}',
    '.pkr-tgrid{margin:0 -.4em}',
    '.pkr-tcard{display:inline-block;vertical-align:top;width:9.5em;margin:0 .4em .9em;position:relative}',
    '.pkr-tcard__img{position:relative;padding-bottom:150%;border-radius:.6em;background:rgba(255,255,255,.06) center/cover no-repeat;transition:transform .15s,opacity .15s;opacity:.8}',
    '.pkr-tcard__img:after{content:"";position:absolute;left:0;top:0;right:0;bottom:0;border-radius:.6em;border:.2em solid transparent}',
    '.pkr-tcard.focus .pkr-tcard__img{transform:scale(1.05);opacity:1}',
    '.pkr-tcard.focus .pkr-tcard__img:after{border-color:#fff}',
    '.pkr-tcard.is-on .pkr-tcard__img{opacity:1}',
    '.pkr-tcard.is-on .pkr-tcard__img:after{border-color:#21c063}',
    '.pkr-tcard__mark{position:absolute;right:.4em;top:.4em;width:1.8em;height:1.8em;border-radius:50%;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center}',
    '.pkr-tcard__mark svg{width:1.1em;height:1.1em}',
    '.pkr-tcard.is-on .pkr-tcard__mark{display:-webkit-box;display:flex;background:#21c063}',
    '.pkr-tcard__name{margin-top:.45em;font-size:.85em;font-weight:600;line-height:1.2;max-height:2.4em;overflow:hidden}',
    '.pkr-tcard__year{font-size:.75em;opacity:.5}',
    '.pkr-taste__count{display:inline-block;margin-left:.6em;opacity:.7;vertical-align:middle}',
    '@media (max-width: 767px){',
    '.pkr{padding:1em 1em 4em}',
    '.pkr-q{font-size:1.7em}',
    '.pkr-tiles{margin:0 -.35em}',
    '.pkr-tile{width:-webkit-calc(50% - .7em);width:calc(50% - .7em);margin:0 .35em .7em;padding:1em .9em}',
    '.pkr-tile svg{width:1.9em;height:1.9em;margin-bottom:.6em}',
    '.pkr-tile__title{font-size:1.05em}',
    '.pkr-bg{left:-1em;right:-1em;top:-1em;height:24em}',
    '.pkr-hero{min-height:0;padding-top:.6em}',
    '.pkr-hero__title{font-size:1.75em}',
    '.pkr-hero__text{min-height:4.35em;max-height:4.35em;-webkit-line-clamp:3}',
    '.pkr-hero__more{min-height:44px;line-height:28px;padding:8px 18px;margin-top:.5em;box-sizing:border-box}',
    '.pkr-row{margin:0 -1em;padding:.7em .65em .4em;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch}',
    '.pkr-card{width:38%;padding:0 .35em}',
    '.pkr-tcard{width:-webkit-calc(33.33% - .8em);width:calc(33.33% - .8em)}',
    '.pkr-btn{padding:.65em .9em;margin:0 .4em .5em 0;font-size:.92em}','.pkr-actions{margin:1em 0 1.2em}',
    '}'
  ].join('');

  function injectCss() {
    if (document.getElementById('pkr-style')) return;
    var st = document.createElement('style');
    st.id = 'pkr-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // =========================================================================
  // Экран подборщика (компонент Lampa)
  // =========================================================================

  function runtimeText(c) {
    if (!c.runtime) return '';
    if (c.type === 'tv') return 'серия ~' + c.runtime + ' мин';
    var h = Math.floor(c.runtime / 60), m = c.runtime % 60;
    return h ? (h + ' ч' + (m ? ' ' + m + ' мин' : '')) : m + ' мин';
  }

  function genresText(c) {
    var out = [];
    for (var i = 0; i < c.genres.length && out.length < 3; i++) {
      if (GENRE_NAMES[c.genres[i]]) out.push(GENRE_NAMES[c.genres[i]]);
    }
    return out.join(', ');
  }

  function shortRating(it) {
    if (it.kp) return it.kp.toFixed(1);
    if (it.c.va) return it.c.va.toFixed(1);
    return '';
  }

  function PickerComponent(object) {
    var self = this;
    var html = $('<div class="pkr-root"><div class="pkr-scroller"></div></div>');
    var scroller = html.find('.pkr-scroller');
    var body = $('<div class="pkr"></div>');
    var prevView = null;
    var last = null;          // последний элемент в фокусе
    var view = 'wizard';      // wizard | loading | results | empty
    var step = 0;
    var ans = {};
    var state = null;
    var current = null;       // карточка, показанная в блоке описания
    var heroEl, bgA, bgB, bgFront = 0, cardEls = [];
    var heroMinH = 0, lastWidth = 0;
    var stageEl = null;

    // ---- служебное

    function focusable() { return html; }

    // Экран выдачи — строгие уровни: описание → кнопки → постеры → нижний ряд.
    // Влево/вправо только внутри уровня, вверх/вниз — на соседний уровень. Элементы Lampa не задействуем,
    // кроме выхода в меню (влево с первого элемента) и в шапку (вверх с верхнего уровня).
    var lineMemo = {};

    function navLines() {
      if (view !== 'results' || !html) return null;
      var groups = [
        ['descr', html.find('.pkr-hero__descr.selector')],
        ['actions', html.find('.pkr-actions').not('.pkr-actions--footer').find('.selector')],
        ['cards', html.find('.pkr-row .pkr-card.selector')],
        ['footer', html.find('.pkr-actions--footer .selector')]
      ];
      var out = [];
      for (var i = 0; i < groups.length; i++) if (groups[i][1].length) out.push({ key: groups[i][0], els: groups[i][1].toArray() });
      return out;
    }

    function navFocus(el) { Lampa.Controller.collectionFocus(el, focusable()); }

    // Остальные экраны (мастер, журнал, «Настроить вкус»): ряды по положению на экране.
    // Влево/вправо — внутри ряда, вверх/вниз — в соседний ряд, на ближайший по горизонтали элемент.
    function gridMove(dir) {
      if (!html || !last || !$(last).closest(html).length) return false;
      var els = html.find('.selector').toArray().filter(function (e) { return e.offsetParent !== null; });
      if (!els.length) return false;
      var info = els.map(function (e) { var r = e.getBoundingClientRect(); return { e: e, top: r.top, cx: r.left + r.width / 2, left: r.left }; });
      info.sort(function (a, b) { return a.top - b.top || a.left - b.left; });
      var rows = [];
      for (var i = 0; i < info.length; i++) {
        var row = rows[rows.length - 1];
        if (row && Math.abs(info[i].top - row[0].top) < 12) row.push(info[i]);
        else rows.push([info[i]]);
      }
      for (var r = 0; r < rows.length; r++) rows[r].sort(function (a, b) { return a.left - b.left; });
      var ri = -1, ci = -1;
      for (var a = 0; a < rows.length && ri < 0; a++) for (var b = 0; b < rows[a].length; b++) if (rows[a][b].e === last) { ri = a; ci = b; break; }
      if (ri < 0) return false;

      if (dir === 'left' || dir === 'right') {
        var n = rows[ri][ci + (dir === 'left' ? -1 : 1)];
        if (n) navFocus(n.e);
        else if (dir === 'left') Lampa.Controller.toggle('menu');
        return true;
      }
      var tr = rows[ri + (dir === 'up' ? -1 : 1)];
      if (!tr) {
        if (dir === 'up') Lampa.Controller.toggle('head');
        return true;
      }
      // Вернулись туда, откуда пришли (сетка → кнопки → обратно) — на тот же элемент
      var back = gridHop && gridHop.to === last && gridHop.dir !== dir && $(gridHop.from).closest(html).length ? gridHop.from : null;
      var cx = rows[ri][ci].cx, best = tr[0];
      for (var k = 1; k < tr.length; k++) if (Math.abs(tr[k].cx - cx) < Math.abs(best.cx - cx)) best = tr[k];
      var target = back && tr.some(function (x) { return x.e === back; }) ? back : best.e;
      gridHop = { from: last, to: target, dir: dir };
      navFocus(target);
      return true;
    }
    var gridHop = null;

    function lineMove(dir) {
      if (view !== 'results') return gridMove(dir);
      var lines = navLines();
      if (!lines || !last) return false;
      var li = -1, pi = -1;
      for (var i = 0; i < lines.length && li < 0; i++) {
        var p = lines[i].els.indexOf(last);
        if (p > -1) { li = i; pi = p; }
      }
      if (li < 0) return false;
      var line = lines[li];

      if (dir === 'left' || dir === 'right') {
        var next = line.els[pi + (dir === 'left' ? -1 : 1)];
        if (next) { lineMemo[line.key] = pi + (dir === 'left' ? -1 : 1); navFocus(next); }
        else if (dir === 'left') Lampa.Controller.toggle('menu');
        return true;                                      // правый край — остаёмся
      }

      lineMemo[line.key] = pi;
      var tl = lines[li + (dir === 'up' ? -1 : 1)];
      if (!tl) {
        if (dir === 'up') Lampa.Controller.toggle('head');
        return true;                                      // нижний уровень — остаёмся
      }
      var target = null;
      if (tl.key === 'cards') {
        // В ряд постеров — на тот фильм, что сейчас в описании
        for (var c = 0; c < tl.els.length; c++) if ($(tl.els[c]).hasClass('is-active')) target = tl.els[c];
      }
      if (!target) target = tl.els[Math.min(lineMemo[tl.key] || 0, tl.els.length - 1)];
      navFocus(target);
      return true;
    }

    // На телефоне у Lampa поверх контента нижняя панель (в альбомной ориентации — справа).
    // Даём под неё отступ, иначе нижние кнопки уходят под неё
    function avoidNavBar() {
      try {
        var bar = $('.navigation-bar').filter(function () { return this.offsetParent !== null || $(this).css('display') !== 'none'; })[0];
        var pb = '', pr = '';
        if (bar && $(bar).css('display') !== 'none' && $(bar).css('visibility') !== 'hidden') {
          var r = bar.getBoundingClientRect();
          var vw = window.innerWidth || 0;
          if (r.width && r.height) {
            if (r.width < vw * 0.5) pr = Math.ceil(r.width) + 'px';          // сбоку
            else pb = Math.ceil(r.height + 16) + 'px';                        // снизу
          }
        }
        body.css({ 'padding-bottom': pb, 'padding-right': pr });
      } catch (e) {}
    }

    // Высота экрана: от верха компонента до низа окна
    function fit() {
      avoidNavBar();
      try {
        var top = html.offset() ? html.offset().top : 0;
        var h = (window.innerHeight || document.documentElement.clientHeight) - Math.max(0, top);
        if (h > 100) html.css('height', h + 'px');
      } catch (e) {}
      // Изменилась ширина — переносы строк другие, высоту блока описания пересчитываем.
      // Высоту не трогаем: в мобильных браузерах resize приходит и при скрытии адресной строки
      var w = window.innerWidth || 0;
      if (w !== lastWidth) {
        lastWidth = w;
        heroMinH = 0;
        if (heroEl) heroEl.css('min-height', '');
        if (view === 'results') { measurePage(); if (current) setCurrent(current); sizeCards(); }
      }
    }

    // Заранее меряем блок описания для всех карточек страницы — с запасом под плашки КП и IMDb,
    // которые приходят позже. Тогда сетка не сдвигается ни при переходе, ни при загрузке рейтингов
    function measurePage() {
      if (!heroEl || !state) return;
      for (var i = 0; i < state.page.length; i++) {
        var it = state.page[i];
        var kp = it.kp, im = it.imdbR;
        if (!kp) it.kp = 9.9;
        if (!im) it.imdbR = 9.9;
        heroEl.html(heroHtml(it));
        it.kp = kp; it.imdbR = im;
        var t = heroEl.find('.pkr-hero__text')[0];
        if (t && t.scrollHeight > t.clientHeight + 2) heroEl.find('.pkr-hero__descr').addClass('is-long');
        var hh = heroEl[0].offsetHeight;
        if (hh > heroMinH) heroMinH = hh;
      }
      heroEl.css('min-height', heroMinH + 'px');
    }

    function isCompact() {
      try {
        if ((window.innerWidth || 0) < 768) return false;
        var fs = parseFloat(window.getComputedStyle(html[0]).fontSize) || 16;
        return scroller[0].clientHeight / fs < 42;
      } catch (e) { return false; }
    }

    // Широкий экран (ТВ): постеры такого размера, чтобы блок описания и ряд карточек помещались вместе
    function sizeCards() {
      try {
        if (!cardEls.length || !heroEl) return;
        for (var i = 0; i < cardEls.length; i++) cardEls[i].css('width', '');
        if ((window.innerWidth || 0) < 768) return;     // телефон: свой макет со свайпом
        var vh = scroller[0].clientHeight;
        if (!vh) return;
        var card = cardEls[0], im = card.find('.pkr-card__img');
        var imgH = im.outerHeight();
        var below = card.outerHeight() - imgH;          // название и год под постером
        var gap = card.offset().top - heroEl.offset().top;
        var avail = vh - gap - below - Math.round(vh * 0.08);
        if (imgH <= avail) return;
        var minW = Math.round(vh * 0.26 / 1.5);          // постер не ниже четверти экрана — иначе не разглядеть
        var w = Math.max(minW, Math.floor(Math.max(avail, 0) / 1.5));
        w += im.outerWidth() ? card.outerWidth() - im.outerWidth() : 0;   // поля карточки: ширина задаётся вместе с ними
        for (var j = 0; j < cardEls.length; j++) cardEls[j].css('width', w + 'px');
      } catch (e) {}
    }

    function holdHeroHeight() {
      if (!heroEl || heroEl.find('.pkr-hero__descr.is-open').length) return;
      var hh = heroEl[0].offsetHeight;
      if (hh > heroMinH) heroMinH = hh;
      heroEl.css('min-height', heroMinH + 'px');
    }

    // Прокрутка к элементу в фокусе (для пульта)
    function ensureVisible(el) {
      try {
        var sc = scroller[0];
        var vh = sc.clientHeight;
        if (!vh) return;
        var top = el.offset().top - scroller.offset().top + sc.scrollTop;
        var h = el.outerHeight();
        var pad = Math.round(vh * 0.12);
        var target = null;

        if (el.hasClass('pkr-card') && heroEl && heroEl.closest('html').length) {
          // Постеры: показываем ряд целиком, но блок описания с рейтингами не уводим за верх экрана
          var base = scroller.offset().top - sc.scrollTop;
          var heroTop = heroEl.offset().top - base;
          var meta = heroEl.find('.pkr-hero__meta');
          var metaTop = meta.length ? meta.offset().top - base : heroTop;
          var small = Math.round(vh * 0.04);
          var need = top + h - vh + small;
          // Сначала пытаемся сохранить всё описание; если не влезает — жертвуем заголовком, но не рейтингами
          target = Math.max(0, Math.min(need, need <= heroTop - small ? heroTop - small : metaTop - small));
        }
        else if (el.closest('.pkr-hero, .pkr-actions:not(.pkr-actions--footer), .pkr-tiles, .pkr-last').length && top < vh * 0.6) target = 0;
        else if (top < sc.scrollTop + pad) target = top - pad;
        else if (top + h > sc.scrollTop + vh - pad) target = top + h - vh + pad;

        if (target === null) return;
        target = Math.max(0, Math.min(target, sc.scrollHeight - vh));
        if (Math.abs(target - sc.scrollTop) < 2) return;
        scroller.stop(true).animate({ scrollTop: target }, 180);
      } catch (e) {}
    }

    function refresh(target) {
      if (target) last = target.jquery ? target[0] : target;
      try {
        var en = Lampa.Controller.enabled();
        if (en && en.name === 'content') {
          Lampa.Controller.collectionSet(focusable());
          Lampa.Controller.collectionFocus(last || false, focusable());
        }
      } catch (e) {}
    }

    function bindFocus(el, onFocus) {
      el.on('hover:focus', function () {
        last = el[0];
        ensureVisible(el);
        if (onFocus) onFocus();
      });
    }

    function setBody(node) {
      body.empty().append(node);
      try { scroller.stop(true); scroller[0].scrollTop = 0; } catch (e) {}
    }

    // ---- мастер

    function renderWizard(n) {
      view = 'wizard';
      step = n;
      var def = STEPS[n];
      var wrap = $('<div class="pkr-wizard"></div>');

      var dots = '';
      for (var i = 0; i < STEPS.length; i++) dots += '<span class="' + (i <= n ? 'on' : '') + '"></span>';

      wrap.append('<div class="pkr-step">Что посмотреть · шаг ' + (n + 1) + ' из ' + STEPS.length +
        (n === 0 ? '<span class="pkr-ver">v' + VERSION + '</span>' : '') + '</div>');
      wrap.append('<div class="pkr-dots">' + dots + '</div>');
      wrap.append('<div class="pkr-q">' + esc(def.q) + '</div>');

      var chosen = describeList(ans).slice(0, n);
      var sub = $('<div class="pkr-sub"></div>');
      if (chosen.length) {
        var chips = $('<div class="pkr-chips"></div>');
        for (var c = 0; c < chosen.length; c++) chips.append('<span class="pkr-chip">' + esc(chosen[c]) + '</span>');
        sub.append(chips);
      }
      wrap.append(sub);

      var focusEl = null;

      if (n === 0) {
        var prev = store('last_answers', null);
        if (prev && prev.time && prev.mood && prev.company) {
          var lastBtn = $('<div class="pkr-last selector">' + svg('refresh') +
            '<span><b>Как в прошлый раз</b><i>' + esc(describeList(prev).join(' · ')) + '</i></span></div>');
          lastBtn.on('hover:enter', function () { ans = extend(prev, {}); startRun(); });
          bindFocus(lastBtn);
          wrap.append(lastBtn);
        }
      }

      var tiles = $('<div class="pkr-tiles"></div>');
      for (var t = 0; t < def.items.length; t++) {
        (function (item) {
          var tile = $('<div class="pkr-tile selector">' + svg(item.icon) +
            '<div class="pkr-tile__title">' + esc(item.title) + '</div>' +
            (item.hint ? '<div class="pkr-tile__hint">' + esc(item.hint) + '</div>' : '') + '</div>');
          if (ans[def.key] === item.value) { tile.addClass('is-chosen'); focusEl = tile; }
          tile.on('hover:enter', function () {
            ans[def.key] = item.value;
            if (n < STEPS.length - 1) renderWizard(n + 1);
            else startRun();
          });
          bindFocus(tile);
          tiles.append(tile);
          if (!focusEl && t === 0) focusEl = tile;
        })(def.items[t]);
      }
      wrap.append(tiles);

      if (n === 0) {
        var foot = $('<div class="pkr-wizard__foot"></div>');
        foot.append(button('like', 'Настроить вкус', 'pkr-btn--ghost', function () { renderTaste(); }));
        if (Journal.list().length) foot.append(button('list', 'Журнал подборов', 'pkr-btn--ghost', function () { renderJournal(); }));
        wrap.append(foot);
      }

      setBody(wrap);
      refresh(focusEl);
    }

    // ---- «Настроить вкус»

    function renderTaste() {
      view = 'taste';
      save('taste_offered', true);
      var seen = {}, nextP = 1, picked = 0, items = [];
      var wrap = $('<div class="pkr-taste"></div>');
      wrap.append('<div class="pkr-step">Что посмотреть</div>');
      wrap.append('<div class="pkr-q">Что вам понравилось?</div>');
      wrap.append('<div class="pkr-taste__sub">Отметьте фильмы и сериалы, которые вам зашли — по ним подбор поймёт ваш вкус. ' +
        'Отмеченное попадёт в ваш список «Нравится» в Lampa, убрать можно повторным нажатием.</div>');
      var grid = $('<div class="pkr-tgrid"></div>');
      // Кнопки сверху: до «Готово» не нужно листать всю сетку пультом
      var foot = $('<div class="pkr-actions"></div>');
      var count = $('<span class="pkr-taste__count"></span>');
      var upd = function () { html.find('.pkr-taste__count').text(picked ? 'Отмечено: ' + picked : ''); };
      var finishTaste = function () {
        if (picked) noty('Добавлено в «Нравится»: ' + picked);
        renderWizard(0);
      };
      foot.append(button('check', 'Готово', 'pkr-btn--primary', function () { finishTaste(); }));
      var moreBtn = button('refresh', 'Ещё фильмы', '', function () { load(); });
      foot.append(moreBtn);
      foot.append(count);
      wrap.append(foot);
      wrap.append(grid);
      // Снизу — те же кнопки, чтобы не возвращаться наверх
      var count2 = $('<span class="pkr-taste__count"></span>');
      var foot2 = $('<div class="pkr-actions pkr-actions--footer"></div>');
      foot2.append(button('check', 'Готово', 'pkr-btn--primary', function () { finishTaste(); }));
      var moreBtn2 = button('refresh', 'Ещё фильмы', '', function () { load(); });
      foot2.append(moreBtn2);
      foot2.append(count2);
      wrap.append(foot2);

      var tcard = function (r) {
        var card = lampaCard(r);
        var on = isLiked(card);
        var t = r.__type === 'tv' ? r.name : r.title;
        var y = String(r.release_date || r.first_air_date || '').slice(0, 4);
        var el = $('<div class="pkr-tcard selector' + (on ? ' is-on' : '') + '">' +
          '<div class="pkr-tcard__img" style="background-image:url(\'' + img(r.poster_path, 'w342') + '\')">' +
          '<div class="pkr-tcard__mark">' + svg('check') + '</div></div>' +
          '<div class="pkr-tcard__name">' + esc(t) + '</div><div class="pkr-tcard__year">' + esc(y + (r.__type === 'tv' ? ' · сериал' : '')) + '</div></div>');
        var lastT = 0;
        var tog = function () {
          if (now() - lastT < 400) return;          // тап может прийти и как hover:enter, и как click
          lastT = now();
          var next = !el.hasClass('is-on');
          if (!setLiked(card, next)) return noty('Не удалось изменить «Нравится»');
          el.toggleClass('is-on', next);
          picked += next ? 1 : -1;
          upd();
        };
        el.on('hover:enter', tog);
        el.on('click', tog);
        bindFocus(el);
        return el;
      };

      // Страницы источников идут по порядку: 1, 2, 3… Следующую подгружаем заранее, пока человек отмечает
      var loading = false, prefetching = false, wantShow = false;
      var fetchMore = function (cb) {
        if (nextP > TASTE_MAX_PAGES) return cb(false);
        var p = nextP++;
        tasteBatch(p, seen, function (list) { items = items.concat(list); cb(true); });
      };
      var exhausted = function () { return nextP > TASTE_MAX_PAGES && !prefetching && !items.length; };
      var show = function () {
        var chunk = items.splice(0, TASTE_PAGE);
        var first = null;
        for (var i = 0; i < chunk.length; i++) { var e = tcard(chunk[i]); if (!first) first = e; grid.append(e); }
        loading = false;
        if (items.length < TASTE_PAGE && nextP <= TASTE_MAX_PAGES && !prefetching) {
          prefetching = true;
          fetchMore(function () { prefetching = false; if (wantShow) { wantShow = false; load(); } });
        }
        if (!first && !grid.children().length) {
          grid.append('<div class="pkr-j__row">Не удалось загрузить список — проверьте связь с TMDB</div>');
        } else if (exhausted()) {
          // Всё показано — кнопку «Ещё фильмы» убираем, чтобы не жать впустую
          moreBtn.remove(); moreBtn2.remove();
          if (!first) noty('Больше нет — это все популярные фильмы и сериалы');
        }
        try { Lampa.Controller.collectionSet(focusable()); } catch (e2) {}
        if (first) refresh(first);
        else if (!grid.children('.pkr-tcard').length || exhausted()) refresh(foot.find('.selector').eq(0));
      };
      var load = function () {
        if (loading) return;
        if (items.length >= TASTE_PAGE || (nextP > TASTE_MAX_PAGES && !prefetching)) { loading = true; return show(); }
        if (prefetching) { wantShow = true; return; }   // следующая страница уже в пути
        loading = true;
        var step = function () { fetchMore(function (ok) { if (ok && items.length < TASTE_PAGE) return step(); show(); }); };
        step();
      };

      setBody(wrap);
      refresh(foot.find('.selector').eq(0));
      load();
    }

    // ---- загрузка

    function renderLoading() {
      view = 'loading';
      var wrap = $('<div class="pkr-loading"></div>');
      var chips = $('<div class="pkr-chips"></div>');
      var d = describeList(ans);
      for (var i = 0; i < d.length; i++) chips.append('<span class="pkr-chip">' + esc(d[i]) + '</span>');
      wrap.append(chips);
      wrap.append('<div class="pkr-load__title">Подбираю для вас</div>');
      stageEl = $('<div class="pkr-load__stage"></div>');
      wrap.append(stageEl);

      var row = $('<div class="pkr-row"></div>');
      for (var k = 0; k < 5; k++) {
        row.append('<div class="pkr-card"><div class="pkr-card__img pkr-skel"></div>' +
          '<div class="pkr-skel pkr-skel-line"></div><div class="pkr-skel pkr-skel-line short"></div></div>');
      }
      wrap.append(row);
      setBody(wrap);
      last = null;
      refresh();
    }

    function startRun() {
      renderLoading();
      run(ans, {
        stage: function (t) { if (stageEl) stageEl.text(t + '…'); },
        done: function (st) {
          state = st;
          if (!state.rest.length) return renderEmpty();
          state.page = nextPage(state, 5);
          current = state.page[0];
          renderResults(0);
        },
        error: function (kind) { renderError(kind); }
      });
    }

    // Подбор не удался: нет связи с TMDB или что-то зависло
    function renderError(kind) {
      view = 'error';
      var net = kind === 'net';
      var wrap = $('<div class="pkr-empty">' + svg('search') +
        '<div class="pkr-empty__title">' + (net ? 'Нет связи с TMDB' : 'Не получилось подобрать') + '</div>' +
        '<div class="pkr-empty__text">' + (net
          ? 'Подборщик берёт фильмы из TMDB, а он сейчас не отвечает. Проверьте интернет и прокси TMDB в настройках Lampa.'
          : 'Подбор занял слишком много времени — скорее всего, медленно отвечает сеть. Попробуйте ещё раз.') + '</div></div>');
      var actions = $('<div class="pkr-actions"></div>');
      actions.append(button('refresh', 'Повторить', 'pkr-btn--primary', function () { startRun(); }));
      actions.append(button('sliders', 'Изменить ответы', '', function () { renderWizard(0); }));
      wrap.append(actions);
      setBody(wrap);
      refresh(actions.find('.selector').eq(0));
    }

    // ---- результаты

    function heroHtml(it) {
      var c = it.c;
      var h = '<div class="pkr-hero__title">' + esc(c.title) + '</div>';
      var orig = [];
      if (c.original && c.original !== c.title) orig.push(esc(c.original));
      if (c.year) orig.push(c.year);
      if (orig.length) h += '<div class="pkr-hero__orig">' + orig.join(' · ') + '</div>';

      var meta = '';
      if (!state.cold && it.parts) meta += '<span class="pkr-b pkr-b--match">Совпадение ' + Math.round(it.parts.a * 100) + '%</span>';
      if (c.va) meta += '<span class="pkr-b">TMDB ' + c.va.toFixed(1) + '</span>';
      if (it.kp) meta += '<span class="pkr-b pkr-b--kp">КП ' + it.kp.toFixed(1) + '</span>';
      if (it.imdbR) meta += '<span class="pkr-b pkr-b--imdb">IMDb ' + it.imdbR.toFixed(1) + '</span>';
      if (c.type === 'tv') meta += '<span class="pkr-b">Сериал</span>';
      var rt = runtimeText(c);
      if (rt) meta += '<span class="pkr-b pkr-b--text">' + rt + '</span>';
      var g = genresText(c);
      if (g) meta += '<span class="pkr-b pkr-b--text">' + esc(g) + '</span>';
      h += '<div class="pkr-hero__meta">' + meta + '</div>';

      if (c.moods) {
        var labels = { humor: 'Юмор', romance: 'Романтика', fear: 'Страх', tension: 'Напряжение', violence: 'Насилие', sadness: 'Грусть', action: 'Экшн', pace: 'Темп', profanity: 'Лексика', sex: 'Откровенность' };
        var sc = [];
        each(labels, function (lbl, key) { if (typeof c.moods[key] === 'number') sc.push({ l: lbl, v: c.moods[key] }); });
        sc.sort(function (a, b) { return b.v - a.v; });
        if (sc.length) {
          var bars = '';
          for (var si = 0; si < Math.min(4, sc.length); si++) {
            bars += '<span class="pkr-mood"><i>' + esc(sc[si].l) + '</i><b><span style="width:' + Math.round(sc[si].v * 10) + '%"></span></b></span>';
          }
          h += '<div class="pkr-moods">' + bars + '</div>';
        }
      }
      if (it.reason) h += '<div class="pkr-hero__reason">' + svg('sparkle') + esc(it.reason) + '</div>';
      var descr = c.card && c.card.overview;
      h += '<div class="pkr-hero__descr"><div class="pkr-hero__text">' + esc(descr || '') + '</div><div class="pkr-hero__more"><span>Читать полностью</span> ▾</div></div>';

      if (isDebug() && it.parts) {
        var p = it.parts;
        h += '<div class="pkr-debug">Q ' + p.q.toFixed(2) + ' · A ' + p.a.toFixed(2) + ' · M ' + p.m.toFixed(2) +
          ' · N ' + p.n.toFixed(2) + ' · S ' + p.s.toFixed(2) + ' · An ' + (p.an || 0).toFixed(2) + ' · F ' + (p.f || 0).toFixed(2) + ' = ' + it.score.toFixed(3) + ' [' + state.wkey + ']</div>';
      }
      return h;
    }

    function setBackdrop(it) {
      var path = it && it.c.card && (it.c.card.backdrop_path || it.c.card.poster_path);
      var url = img(path, 'w1280');
      var next = bgFront ? bgA : bgB;
      var prevEl = bgFront ? bgB : bgA;
      if (!url) { bgA.removeClass('on'); bgB.removeClass('on'); return; }

      var im = new Image();
      im.onload = function () {
        if (current !== it) return;
        next.css('background-image', 'url("' + url + '")').addClass('on');
        prevEl.removeClass('on');
        bgFront = bgFront ? 0 : 1;
      };
      im.src = url;
    }

    // Длинное описание — фокусируемый блок, OK/тап разворачивает
    function bindDescr() {
      var d = heroEl.find('.pkr-hero__descr');
      if (!d.length) return;
      var t = d.find('.pkr-hero__text')[0];
      if (!t || t.scrollHeight <= t.clientHeight + 2) return;
      d.addClass('is-long selector');
      var lastToggle = 0;
      var toggle = function () {
        // Lampa на сенсорных экранах может прислать и hover:enter, и click — второй игнорируем
        if (now() - lastToggle < 400) return;
        lastToggle = now();
        var open = !d.hasClass('is-open');
        d.toggleClass('is-open', open);
        heroEl.css('min-height', open ? '' : heroMinH + 'px');
        d.find('.pkr-hero__more').html('<span>' + (open ? 'Свернуть' : 'Читать полностью') + '</span> ' + (open ? '▴' : '▾'));
        if (state) Journal.action(state.journal, open ? 'descr_open' : 'descr_close', current);
      };
      d.on('hover:enter', toggle);
      d.on('click', toggle);
      bindFocus(d);
      try {
        var en = Lampa.Controller.enabled();
        if (en && en.name === 'content') Lampa.Controller.collectionSet(focusable());
      } catch (e) {}
    }

    function setCurrent(it) {
      if (!it) return;
      current = it;
      heroEl.html(heroHtml(it));
      bindDescr();
      holdHeroHeight();
      for (var i = 0; i < cardEls.length; i++) cardEls[i].toggleClass('is-active', state.page[i] === it);
      setBackdrop(it);
    }

    function cardEl(it, idx) {
      var c = it.c;
      var poster = img(c.card && c.card.poster_path, 'w342');
      var rate = shortRating(it);
      var el = $('<div class="pkr-card selector">' +
        '<div class="pkr-card__img"' + (poster ? ' style="background-image:url(\'' + poster + '\')"' : '') + '>' +
        (poster ? '' : '<div class="pkr-card__noimg">' + esc(c.title) + '</div>') +
        '<div class="pkr-card__num">' + (idx + 1) + '</div>' +
        (rate ? '<div class="pkr-card__rate' + (it.kp ? ' is-kp' : '') + '">' + rate + '</div>' : '') +
        (c.type === 'tv' ? '<div class="pkr-card__type">Сериал</div>' : '') +
        '</div>' +
        '<div class="pkr-card__name">' + esc(c.title) + '</div>' +
        '<div class="pkr-card__year">' + esc([c.year, runtimeText(c)].filter(Boolean).join(' · ')) + '</div>' +
        '</div>');

      bindFocus(el, function () { if (current !== it) setCurrent(it); });
      el.on('hover:enter', function () {
        // ТВ: фокус уже выбрал карточку — открываем. Телефон: первый тап выбирает, второй открывает.
        if (current === it) openIt(it);
        else setCurrent(it);
      });
      return el;
    }

    function button(icon, text, cls, fn) {
      var b = $('<div class="pkr-btn selector ' + (cls || '') + '">' + svg(icon) + '<span>' + esc(text) + '</span></div>');
      b.on('hover:enter', fn);
      bindFocus(b);
      return b;
    }

    function renderResults(focusIdx) {
      view = 'results';
      if (!state.page.length) return renderEmpty();
      if (state.page.indexOf(current) < 0) current = state.page[0];

      lineMemo = {};
      var wrap = $('<div class="pkr-res"></div>');
      var bg = $('<div class="pkr-bg"><div class="pkr-bg__img"></div><div class="pkr-bg__img"></div><div class="pkr-bg__shade"></div></div>');
      bgA = bg.find('.pkr-bg__img').eq(0);
      bgB = bg.find('.pkr-bg__img').eq(1);
      bgFront = 0;
      wrap.append(bg);

      var actions = $('<div class="pkr-actions"></div>');
      actions.append(button('play', 'Открыть', 'pkr-btn--primary', function () { if (current) openIt(current); }));
      actions.append(button('close', 'Не то', '', function () { askReject(); }));
      actions.append(button('check', 'Уже видел', '', function () { dismiss('seen'); }));

      var footer = $('<div class="pkr-actions pkr-actions--footer"></div>');
      if (state.rest.length) footer.append(button('refresh', 'Ещё варианты', 'pkr-btn--ghost', function () {
        Journal.action(state.journal, 'more', null, { opened: !!state.pageOpened });
        state.pageOpened = false;
        state.page = nextPage(state, 5);
        state.pageNo = (state.pageNo || 1) + 1;
        state.logged = false;
        current = state.page[0];
        renderResults(0);
      }));
      footer.append(button('sliders', 'Изменить ответы', 'pkr-btn--ghost', function () {
        Journal.action(state.journal, 'restart');
        ans = extend(state.ans, {});
        renderWizard(0);
      }));
      footer.append(button('list', 'Журнал', 'pkr-btn--ghost', function () { renderJournal(); }));

      var content = $('<div class="pkr-content"></div>');
      var chips = $('<div class="pkr-chips"></div>');
      var d = describeList(state.ans);
      for (var i = 0; i < d.length; i++) chips.append('<span class="pkr-chip">' + esc(d[i]) + '</span>');
      content.append(chips);

      heroEl = $('<div class="pkr-hero"></div>');
      content.append(heroEl);
      content.append(actions);

      if (state.cold) content.append('<div class="pkr-note">Истории просмотров пока мало — подбор в основном по рейтингу и настроению</div>');
      // Встроенный ключ КП общий и маленький — когда он на сегодня кончился, подсказываем про личный (раз в день)
      try {
        var kq = kpQuota();
        if (kpUsingBuiltin() && (kq.blocked || kq.n >= kpLimit()) && store('kp_hint_day', 0) !== todaySeed()) {
          save('kp_hint_day', todaySeed());
          content.append('<div class="pkr-note">Рейтинги Кинопоиска на сегодня закончились. Свой бесплатный ключ снимает ограничение: Настройки → ' + esc(TITLE) + ' → Ключ Кинопоиска</div>');
        }
      } catch (e) {}

      var row = $('<div class="pkr-row"></div>');
      cardEls = [];
      for (var k = 0; k < state.page.length; k++) {
        var ce = cardEl(state.page[k], k);
        cardEls.push(ce);
        row.append(ce);
      }
      content.append(row);
      content.append(footer);

      wrap.append(content);
      setBody(wrap);
      wrap.toggleClass('is-compact', isCompact());
      measurePage();
      setCurrent(current);
      sizeCards();

      if (!state.logged) {
        Journal.shown(state.journal, state.page, state.pageNo || 1);
        markShownToday(state.page);
        state.logged = true;
      }
      loadRatings();

      var fi = typeof focusIdx === 'number' ? Math.min(focusIdx, cardEls.length - 1) : state.page.indexOf(current);
      refresh(cardEls[fi < 0 ? 0 : fi]);
    }

    function openIt(it) {
      if (state) { Journal.action(state.journal, 'open', it); state.pageOpened = true; }
      openCard(it);
    }

    // Рейтинги КП/IMDb подгружаются только для видимых карточек
    function loadRatings() {
      var page = state.page.slice();
      for (var i = 0; i < page.length; i++) {
        (function (it) {
          if (it.ratingsTried) return;
          it.ratingsTried = true;
          // Встроенный ключ маленький: плагин тратит его на финалистов, плашки дальше — только из кеша
          var getR = kpUsingBuiltin() ? function (x, cb) {
            var cr = x.c ? cachedRatings(x.c, x.k) : null;
            cb(cr ? { kp: cr.kp, imdb: cr.imdb, src: 'cache' } : null);
          } : fetchRatings;
          getR(it, function (r, why) {
            if (!r) {
              // «не найден» из кеша — следствие того же поиска: исходную причину подбора не затираем
              if (why && !it.kp && !it.imdbR && !(why === 'cached_miss' && it.kpMiss)) { it.kpMiss = why; Journal.rating(state.journal, it); }
              return;
            }
            it.kpMiss = null;
            it.kp = r.kp || it.kp || 0;
            it.imdbR = r.imdb || it.imdbR || 0;
            Journal.rating(state.journal, it);
            if (view !== 'results') return;
            var idx = state.page.indexOf(it);
            if (idx < 0 || !cardEls[idx]) return;
            var badge = cardEls[idx].find('.pkr-card__rate');
            var txt = shortRating(it);
            if (badge.length) badge.text(txt);
            else cardEls[idx].find('.pkr-card__img').append('<div class="pkr-card__rate">' + txt + '</div>');
            if (it.kp) cardEls[idx].find('.pkr-card__rate').addClass('is-kp');
            if (current === it && !heroEl.find(".pkr-hero__descr.is-open").length) { heroEl.html(heroHtml(it)); bindDescr(); holdHeroHeight(); }
          });
        })(page[i]);
      }
    }

    // «Не то» сначала спрашивает причину; «Назад» в меню — отмена
    function askReject() {
      if (!current) return;
      var it = current;
      if (!Lampa.Select || !Lampa.Select.show) return dismiss('reject', '');
      var back = function () { Lampa.Controller.toggle('content'); };
      Lampa.Select.show({
        title: 'Почему не то?',
        items: REJECT_REASONS.map(function (x) { return { title: x.title, subtitle: x.subtitle, r: x.r }; }),
        onSelect: function (a) { back(); current = it; dismiss('reject', a.r || ''); },
        onBack: back
      });
    }

    function dismiss(kind, reason) {
      if (!current) return;
      var it = current;
      var idx = state.page.indexOf(it);
      var fb = feedback();
      if (kind === 'reject') {
        var rec = { t: now(), card: miniCard(it.c) };
        if (reason) { rec.r = reason; rec.m = ans.mood; rec.co = ans.company; }
        fb.rejected[it.k] = rec;
      }
      else fb.seen[it.k] = { t: now(), card: miniCard(it.c) };
      saveFeedback(fb);
      Journal.action(state.journal, kind === 'reject' ? 'reject' : 'seen', it, kind === 'reject' && reason ? { why: reason } : null);
      state.logged = true;
      noty(kind === 'reject' ? 'Скрыто на 90 дней' : 'Отмечено как просмотренное');

      if (cardEls[idx]) cardEls[idx].addClass('is-gone');
      setTimeout(function () {
        replaceInPage(state, it);
        var fresh = state.page[idx];
        if (fresh && fresh !== it) { Journal.shown(state.journal, [fresh], (state.pageNo || 1) + '-repl'); markShownToday([fresh]); }
        current = state.page[Math.min(idx, state.page.length - 1)];
        renderResults(idx);
      }, 220);
    }

    function renderEmpty() {
      view = 'empty';
      var wrap = $('<div class="pkr-empty">' + svg('search') +
        '<div class="pkr-empty__title">Под эти условия ничего не нашлось</div>' +
        '<div class="pkr-empty__text">Чаще всего мешает ограничение по времени или режим «С детьми» — у многих фильмов нет возрастного рейтинга.</div></div>');
      var actions = $('<div class="pkr-actions"></div>');
      if (ans.time && ans.time !== 'any') {
        actions.append(button('infinity', 'Без ограничения по времени', 'pkr-btn--primary', function () {
          ans.time = 'any';
          startRun();
        }));
      }
      actions.append(button('sliders', 'Изменить ответы', '', function () { renderWizard(0); }));
      actions.append(button('list', 'Журнал', 'pkr-btn--ghost', function () { renderJournal(); }));
      wrap.append(actions);
      setBody(wrap);
      refresh(actions.find('.selector').eq(0));
    }

    // ---- журнал

    function sessionLine(e) {
      var d = new Date(e.id);
      var pad = function (x) { return (x < 10 ? '0' : '') + x; };
      var when = pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      var acts = {};
      for (var i = 0; i < (e.actions || []).length; i++) acts[e.actions[i].act] = (acts[e.actions[i].act] || 0) + 1;
      var actText = [];
      if (acts.open) actText.push('открыто ' + acts.open);
      if (acts.reject) actText.push('«не то» ' + acts.reject);
      if (acts.seen) actText.push('«видел» ' + acts.seen);
      if (acts.more) actText.push('ещё ×' + acts.more);
      var c = e.counts || {};
      return '<div class="pkr-j__row"><b>' + esc(when) + '</b> · ' + esc(e.answers || '') +
        '<div class="pkr-j__meta">кандидатов ' + (c.pool || 0) + ' → ' + (c.final || 0) +
        ' · показано ' + (e.shown || []).length + (actText.length ? ' · ' + esc(actText.join(', ')) : '') + '</div></div>';
    }

    function renderJournal() {
      if (view !== 'journal') prevView = view;
      view = 'journal';
      var list = Journal.list();
      var text = Journal.exportText();
      
      var wrap = $('<div class="pkr-journal"></div>');
      wrap.append('<div class="pkr-step">Что посмотреть<span class="pkr-ver">v' + VERSION + '</span></div>');
      wrap.append('<div class="pkr-j__title">Журнал подборов</div>');
      wrap.append('<div class="pkr-j__sub">Сессий: ' + list.length + '. ' +
        '«Скопировать журнал» берёт последние подборы — сколько поместится в одно сообщение мессенджера (обычно 3–4), в сжатом виде. ' +
        '«Последний подбор текстом» — читаемый вариант одной сессии. ' +
        (FEEDBACK_URL ? '«Отправить автору» передаёт весь журнал и ваш комментарий: ответы, показанные фильмы, ваши действия и названия любимых фильмов из профиля. Имени, аккаунта и IP плагин не передаёт. ' : '') +
        (Durable.persistent() ? 'Хранится только на этом устройстве.' : 'IndexedDB недоступен — журнал живёт до перезапуска.') + '</div>');

      var actions = $('<div class="pkr-actions"></div>');
      if (list.length) {
        actions.append(button('copy', 'Скопировать журнал', 'pkr-btn--primary', function () {
          Journal.exportFit().then(function (r) {
            copyText(r.text, function () {
              noty(r.packed
                ? 'Скопировано: ' + r.sessions + ' из ' + r.total + ' подборов, ' + r.text.length + ' симв.'
                : 'Сжатие недоступно — скопирован последний подбор текстом');
            }, function () { noty('Не удалось скопировать в буфер'); });
          });
        }));
        actions.append(button('copy', 'Последний подбор текстом', '', function () {
          copyText(Journal.exportLast(), function () { noty('Скопировано: последний подбор'); },
            function () { noty('Не удалось скопировать в буфер'); });
        }));
        if (FEEDBACK_URL) actions.append(button('send', 'Отправить автору', '', function () { askFeedback(); }));
        if (canShare()) actions.append(button('share', 'Поделиться', '', function () {
          try {
            Journal.exportFit().then(function (r) {
              navigator.share({ title: 'Журнал подборщика Lampa', text: r.text })['catch'](function () {});
            });
          } catch (e) { noty('Поделиться не получилось'); }
        }));
      }
      actions.append(button('trash', 'Очистить', 'pkr-btn--ghost', function () {
        Journal.clear();
        noty('Журнал очищен');
        renderJournal();
      }));
      wrap.append(actions);

      if (isDebug()) { try { console.log('[Picker] journal\n' + text); } catch (e) {} }

      var rows = $('<div class="pkr-j__list"></div>');
      for (var i = list.length - 1; i >= 0 && i >= list.length - 8; i--) rows.append(sessionLine(list[i]));
      if (!list.length) rows.append('<div class="pkr-j__row">Пока пусто — сделайте первый подбор</div>');
      wrap.append(rows);

      var foot = $('<div class="pkr-actions pkr-actions--footer"></div>');
      foot.append(button('back', 'Назад', 'pkr-btn--ghost', function () { leaveJournal(); }));
      wrap.append(foot);

      setBody(wrap);
      refresh(actions.find('.selector').eq(0));
    }

    // Комментарий через клавиатуру Lampa. Пустой ввод — отправка без комментария, «Назад» — отмена.
    var feedbackSending = false;

    function askFeedback() {
      if (feedbackSending) return noty('Журнал уже отправляется');
      if (!feedbackLeft()) return noty('На сегодня лимит отправок исчерпан');
      var restore = function () {
        if (view === 'journal') {
          try { if (Lampa.Controller.enabled().name !== 'content') Lampa.Controller.toggle('content'); } catch (e) {}
        }
      };
      var go = function (comment) {
        setTimeout(restore, 0);
        if (feedbackSending) return;
        feedbackSending = true;
        noty('Отправляю…');
        sendFeedback(comment).then(function () {
          feedbackSending = false;
          noty('Отправлено, спасибо!');
        }, function (e) {
          feedbackSending = false;
          log('feedback error', e);
          noty('Не получилось отправить — попробуйте позже');
        });
      };
      if (!Lampa.Input || !Lampa.Input.edit) return go('');
      Lampa.Input.edit({ title: 'Комментарий (необязательно)', value: '', free: true, nosave: true }, go);
      // «Назад» в клавиатуре колбэк не вызывает и отдаёт фокус настройкам — возвращаем его сами
      var poll = setInterval(function () {
        if (!$('.settings-input').length) { clearInterval(poll); restore(); }
      }, 300);
    }

    function leaveJournal() {
      if (prevView === 'results' && state && state.page.length) renderResults();
      else if (prevView === 'empty') renderEmpty();
      else renderWizard(0);
    }

    // ---- жизненный цикл компонента

    this.create = function () {
      injectCss();
      scroller.append(body);
      $(window).on('resize', fit);
      if (this.activity && this.activity.loader) this.activity.loader(false);

      var preset = object && object.answers;
      if (preset && preset.time && preset.mood && preset.company) { ans = extend(preset, {}); startRun(); }
      else if (needsTaste()) renderTaste();
      else renderWizard(0);

      return this.render();
    };

    this.start = function () {
      Lampa.Controller.add('content', {
        link: self,
        toggle: function () {
          Lampa.Controller.collectionSet(focusable());
          Lampa.Controller.collectionFocus(last || false, focusable());
        },
        left: function () {
          if (lineMove('left')) return;
          if (Navigator.canmove('left')) Navigator.move('left');
          else Lampa.Controller.toggle('menu');
        },
        right: function () { if (!lineMove('right')) Navigator.move('right'); },
        up: function () {
          if (lineMove('up')) return;
          if (Navigator.canmove('up')) Navigator.move('up');
          else Lampa.Controller.toggle('head');
        },
        down: function () { if (!lineMove('down') && Navigator.canmove('down')) Navigator.move('down'); },
        back: function () { self.back(); }
      });
      Lampa.Controller.toggle('content');
      fit();
      setTimeout(fit, 60);
    };

    this.back = function () {
      if (view === 'journal') return leaveJournal();
      if (view === 'taste' || view === 'error') return renderWizard(0);
      if (view === 'wizard' && step > 0) return renderWizard(step - 1);
      if (view === 'loading') { cancelRun(); return renderWizard(STEPS.length - 1); }
      Lampa.Activity.backward();
    };

    this.pause = function () {};
    this.stop = function () {};
    this.render = function () { return html; };

    this.destroy = function () {
      cancelRun();
      $(window).off('resize', fit);
      html.remove();
    };
  }

  function replaceInPage(state, it) {
    var i = state.page.indexOf(it);
    if (i < 0) return;
    var repl = nextPage(state, 1);
    if (repl.length) state.page[i] = repl[0];
    else state.page.splice(i, 1);
  }

  function openCard(it) {
    var fb = feedback();
    fb.opened[it.k] = { t: now(), card: miniCard(it.c) };
    saveFeedback(fb);

    Lampa.Activity.push({
      url: '',
      component: 'full',
      id: it.id,
      method: it.type,
      card: it.c.card || { id: it.id },
      source: 'tmdb'
    });
  }

  function openPicker(answers) {
    Lampa.Activity.push({
      url: '',
      title: TITLE,
      component: 'lampa_picker',
      answers: answers || null,
      page: 1
    });
  }

  // =========================================================================
  // Меню, фоновый прогрев, диагностика
  // =========================================================================

  var ICON = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12 2l2.9 6.26L21.5 9l-5 4.73L17.8 21 12 17.27 6.2 21l1.3-7.27L2.5 9l6.6-.74L12 2z" ' +
    'stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

  function addMenu() {
    try {
      if ($('.menu [data-action="picker"]').length) return;
      var item = $('<li class="menu__item selector" data-action="picker">' +
        '<div class="menu__ico">' + ICON + '</div>' +
        '<div class="menu__text">' + TITLE + '</div></li>');
      item.on('hover:enter', function () { openPicker(); });
      $('.menu .menu__list').eq(0).append(item);
    } catch (e) { log('menu error', e); }
  }

  function addSettings() {
    try {
      if (!Lampa.SettingsApi || !Lampa.SettingsApi.addComponent) return;
      Lampa.SettingsApi.addComponent({ component: 'lampa_picker', name: TITLE, icon: ICON });
      Lampa.SettingsApi.addParam({
        component: 'lampa_picker',
        param: { name: NS + 'about', type: 'static' },
        field: { name: 'Версия ' + VERSION, description: 'Подборщик фильмов и сериалов на вечер' }
      });
      Lampa.SettingsApi.addParam({
        component: 'lampa_picker',
        param: { name: NS + 'kp_key', type: 'input', values: '', placeholder: 'например, 0a1b2c3d-…', default: '' },
        field: {
          name: 'Ключ Кинопоиска',
          description: 'Необязательно. Личный ключ kinopoiskapiunofficial.tech (бесплатная регистрация) — для рейтингов КП и IMDb без общего лимита. Без него используется встроенный ключ с ограничением на устройство.'
        },
        onChange: function (value) {
          var key = String(value || '').replace(/\s+/g, '');
          var q = kpQuota();
          q.blocked = false;
          save('kp_quota', q);
          if (!key) return noty('Личный ключ удалён — используется встроенный');
          kpCheckKey(key, function (ok, status) {
            noty(ok ? 'Ключ Кинопоиска работает' : 'Ключ не прошёл проверку' + (status ? ' (' + status + ')' : ''));
          });
        }
      });
    } catch (e) { log('settings error', e); }
  }

  function warmup() {
    try {
      if (!Cache.db) return;                                // без IndexedDB прогрев бесполезен — кеш не переживёт перезапуск
      if (store('warmup_day', 0) === todaySeed()) return;   // не чаще раза в сутки
      save('warmup_day', todaySeed());
      Cache.sweep();
      var events = collect();
      enrichEvents(events, function () {
        var profile = buildProfile(events);
        var seeds = profile.seeds.slice(0, 8);
        for (var i = 0; i < seeds.length; i++) {
          tmdb(seeds[i].type + '/' + seeds[i].id + '/recommendations', { page: 1 }, LIST_TTL, function () {});
        }
        log('warmup done, events', events.length, 'profile.n', profile.n);
      });
    } catch (e) { log('warmup error', e); }
  }

  // Диагностика из консоли: LampaPicker.diag()
  // api_key=…, email=… в адресах для отчёта — маской
  function maskKeys(u) {
    return String(u || '').replace(/(api_key|key|email|token)=([^&]+)/gi, function (m, k) { return k + '=…'; });
  }

  function diag() {
    var report = { version: VERSION, favorites: {}, timelineSample: null, tmdbUrl: null, kpCache: 0, manifest: null };
    each(SIGNALS, function (v, ft) { report.favorites[ft] = favList(ft).length; });
    var hist = favList('history');
    for (var i = 0; i < hist.length && !report.timelineSample; i++) {
      var p = progress(hist[i]);
      if (p) report.timelineSample = { title: hist[i].title || hist[i].name, progress: p };
    }
    report.tmdbUrl = maskKeys(tmdbUrl('movie/27205', {}));
    try { report.kpCache = Object.keys(kpCache()).length; } catch (e) {}
    try { report.manifest = Lampa.Manifest && Lampa.Manifest.origin; } catch (e) {}
    report.hasTmdbKey = !!(Lampa.TMDB && Lampa.TMDB.key);
    report.hasIndexedDB = !!window.indexedDB;
    report.idbOpened = Durable.persistent();
    report.kp = { key: kpUsingBuiltin() ? 'встроенный' : 'личный', today: kpQuota().n, limit: kpLimit(), blocked: kpQuota().blocked || false, offlineUntil: kpOffline() ? new Date(store('kp_off', 0)).toISOString() : null };
    try {
      var mine = 0, total = 0;
      for (var li = 0; li < localStorage.length; li++) {
        var lk = localStorage.key(li), ln = (localStorage.getItem(lk) || '').length;
        total += ln;
        if (lk.indexOf(NS) === 0) mine += ln;
      }
      report.localStorage = { pluginChars: mine, totalChars: total, totalPctOf5M: Math.round(total / 50000) };
    } catch (e) {}
    if (cubMetaOff()) console.log('[Picker] CUB metadata: отключено в сборке');
    else CubNet.get(cubMetaUrl(603), function (j) {
      console.log('[Picker] CUB metadata:', j && j.status === 'completed' ? 'OK' : 'нет данных', parseCubMeta(j));
    }, function (st) { console.log('[Picker] CUB metadata: FAIL', st); });

    console.log('[Picker] diag', report);
    tmdb('movie/27205', {}, 0, function (d) {
      console.log('[Picker] TMDB test:', d && d.id ? 'OK — ' + (d.title || d.original_title) : 'FAIL');
    });
    return report;
  }

  window.LampaPicker = {
    version: VERSION,
    start: openPicker,
    run: run,
    diag: diag,
    collect: collect,
    debug: function (on) { save('debug', on !== false); return isDebug(); },
    journal: function () { var t = Journal.exportText(); console.log(t); return t; },
    journalLast: function () { return Journal.exportLast(); },
    journalPacked: function () { return Journal.exportPacked(); },
    journalFit: function () { return Journal.exportFit(); },
    setKpKey: function (k) { save('kp_key', String(k || '')); var q = kpQuota(); q.blocked = false; save('kp_quota', q); return kpPersonal() ? 'личный ключ сохранён' : 'личный ключ удалён, используется встроенный'; },
    // Даты первого знакомства (seen) не трогаем: это служебные данные, без них вся история снова «свежая»
    reset: function () { save('feedback', {}); save('last_answers', null); return 'reset'; }
  };

  function init() {
    injectCss();
    Durable.load('journal', []);
    Durable.load('kpmap', {});
    try {
      window.addEventListener('pagehide', function () { Durable.flushAll(); });
      document.addEventListener('visibilitychange', function () { if (document.hidden) Durable.flushAll(); });
    } catch (e) {}
    try { Lampa.Component.add('lampa_picker', PickerComponent); } catch (e) { log('component error', e); }
    addMenu();
    addSettings();
    // Случайная задержка 30–120 с, чтобы запуски у разных пользователей не совпадали
    setTimeout(function () { Cache.init(warmup); }, 30000 + Math.floor(Math.random() * 90000));
    log('ready', VERSION);
  }

  if (window.appready) init();
  else {
    Lampa.Listener.follow('app', function (e) {
      if (e.type === 'ready') init();
    });
  }
})();
