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

  var VERSION = '0.5.0';
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
    think: { title: 'Подумать', w: { 99: 1, 18: 0.8, 878: 0.8, 9648: 0.8, 36: 0.8, 10752: 0.5, 80: 0.4, 35: -0.2, 16: -0.2, 10751: -0.6 } },
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
    cold: { q: 0.55, a: 0.10, m: 0.30, n: 0.05, s: 0.00 }
  };

  var AFFINITY_COEF = { genre: 0.30, keyword: 0.25, director: 0.15, cast: 0.15, decade: 0.08, lang: 0.07 };

  // Сигналы локальных списков Lampa
  var SIGNALS = {
    like: 1.0, viewed: 0.8,
    book: 0.4, wath: 0.4, look: 0.4, scheduled: 0.4,
    history: 0.3, continued: 0.3,
    thrown: -0.5
  };

  var INTENT_TYPES = ['book', 'wath', 'look', 'scheduled'];
  var WATCHED_TYPES = ['like', 'viewed', 'thrown'];

  // =========================================================================
  // Очередь запросов (не больше 4 одновременно, один повтор при ошибке)
  // =========================================================================

  var Net = {
    queue: [],
    active: 0,
    max: 4,

    get: function (url, ok, fail, opts) {
      this.queue.push({ url: url, ok: ok, fail: fail, opts: opts, tries: 0 });
      this.pump();
    },

    pump: function () {
      var self = this;
      while (self.active < self.max && self.queue.length) {
        (function (job) {
          self.active++;
          var req = new Lampa.Reguest();
          req.timeout(15000);
          var done = function (json) {
            self.active--;
            try { job.ok(json); } catch (e) { log('callback error', e); }
            self.pump();
          };
          var failed = function () {
            self.active--;
            if (job.tries < 1) {
              job.tries++;
              setTimeout(function () { self.queue.push(job); self.pump(); }, 1500);
            } else if (job.fail) {
              try { job.fail(); } catch (e) {}
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

  var Cache = {
    db: null,
    mem: {},
    opened: false,
    waiting: [],

    init: function (cb) {
      var self = this;
      if (self.opened) return cb();
      self.waiting.push(cb);
      if (self.waiting.length > 1) return;

      var done = function () {
        self.opened = true;
        var w = self.waiting;
        self.waiting = [];
        for (var i = 0; i < w.length; i++) w[i]();
      };

      try {
        if (!window.indexedDB) return done();
        var req = window.indexedDB.open('lampa_picker', 1);
        req.onupgradeneeded = function (e) { e.target.result.createObjectStore('kv'); };
        req.onsuccess = function (e) { self.db = e.target.result; done(); };
        req.onerror = function () { done(); };
        req.onblocked = function () { done(); };
      } catch (e) { done(); }
    },

    get: function (key, ttl, cb) {
      var self = this;
      self.init(function () {
        var m = self.mem[key];
        if (m) return cb(now() - m.t < ttl ? m.v : null);
        if (!self.db) return cb(null);
        try {
          var r = self.db.transaction('kv', 'readonly').objectStore('kv').get(key);
          r.onsuccess = function () {
            var x = r.result;
            if (x) { self.mem[key] = x; cb(now() - x.t < ttl ? x.v : null); }
            else cb(null);
          };
          r.onerror = function () { cb(null); };
        } catch (e) { cb(null); }
      });
    },

    set: function (key, val) {
      var rec = { t: now(), v: val };
      this.mem[key] = rec;
      if (!this.db) return;
      try { this.db.transaction('kv', 'readwrite').objectStore('kv').put(rec, key); } catch (e) {}
    }
  };

  // =========================================================================
  // TMDB через механизм Lampa (наследуем прокси пользователя)
  // =========================================================================

  function tmdbUrl(path, params) {
    var lang = 'ru';
    try { lang = Lampa.Storage.get('language', 'ru') || 'ru'; } catch (e) {}

    var q = [];
    each(params || {}, function (v, k) { q.push(k + '=' + encodeURIComponent(v)); });
    q.push('language=' + lang);
    try { if (Lampa.TMDB && Lampa.TMDB.key) q.push('api_key=' + Lampa.TMDB.key()); } catch (e) {}

    var rel = path + (path.indexOf('?') > -1 ? '&' : '?') + q.join('&');

    try {
      if (Lampa.TMDB && typeof Lampa.TMDB.api === 'function') return Lampa.TMDB.api(rel);
    } catch (e) {}

    var proto = 'https://';
    try { proto = Lampa.Utils.protocol(); } catch (e) {}
    return proto + 'tmdbapi.bylampa.online/3/' + rel;
  }

  function tmdb(path, params, ttl, cb) {
    var ck = 'tmdb:' + path + '?' + JSON.stringify(params || {});
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

  function kidsOk(cert) {
    if (!cert) return false;
    if (cert.c === 'RU') {
      var n = parseInt(cert.v, 10);
      return !isNaN(n) && n <= 12;
    }
    return ['G', 'PG', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG'].indexOf(cert.v) > -1;
  }

  // Контент для детей: сериальный жанр «Детское» или возрастной рейтинг ниже 7 лет
  function kidsTargeted(c) {
    if ((c.genres || []).indexOf(10762) > -1) return true;
    var ct = c.cert;
    if (!ct) return false;
    if (ct.us && ['TV-Y', 'TV-Y7', 'TV-Y7-FV'].indexOf(ct.us) > -1) return true;
    var n = parseInt(ct.ru || '', 10);
    return !isNaN(n) && n <= 6;
  }

  // 18+: жёсткий контент. Американский рейтинг надёжнее: российский 18+ в TMDB часто стоит у безобидных фильмов
  function adultRated(c) {
    var ct = c.cert;
    if (!ct) return false;
    if (ct.us) return ['R', 'NC-17', 'TV-MA'].indexOf(ct.us) > -1;
    var n = parseInt(ct.ru || '', 10);
    return !isNaN(n) && n >= 18;
  }

  // =========================================================================
  // Шкалы настроения (amodb через прокси ByLampa, если доступно)
  // =========================================================================

  var MOOD_ALIASES = {
    fear: ['fear', 'scary', 'horror', 'страх', 'тревож'],
    humor: ['humor', 'humour', 'funny', 'comedy', 'юмор', 'смеш'],
    sadness: ['sad', 'грус', 'печал'],
    violence: ['violen', 'gore', 'blood', 'насили', 'жесто', 'агресс'],
    action: ['action', 'экшн', 'динами'],
    pace: ['pace', 'tempo', 'темп'],
    profanity: ['profan', 'swear', 'language', 'брань', 'лексик', 'мат'],
    tension: ['tension', 'suspense', 'tense', 'напряж'],
    romance: ['roman', 'love', 'романт', 'любов']
  };

  // Формат ответа не задокументирован — собираем все числовые шкалы 0–10 (или 0–100) на глубине до 3
  function parseMoods(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var flat = {};
    var walk = function (o, depth, prefix) {
      if (!o || depth > 3) return;
      if (Object.prototype.toString.call(o) === '[object Array]') {
        for (var i = 0; i < o.length; i++) {
          var e = o[i];
          if (e && typeof e === 'object') {
            var name = e.name || e.key || e.mood || e.title || e.id;
            var val = e.value !== undefined ? e.value : (e.score !== undefined ? e.score : e.rating);
            if (name && typeof val === 'number') flat[String(name).toLowerCase()] = val;
            else walk(e, depth + 1, prefix);
          }
        }
        return;
      }
      each(o, function (v, k) {
        if (typeof v === 'number') flat[(prefix + k).toLowerCase()] = v;
        else if (v && typeof v === 'object') walk(v, depth + 1, k + '.');
      });
    };
    walk(raw, 0, '');

    var out = {}, found = 0;
    var max = 0;
    each(flat, function (v) { if (v > max) max = v; });
    var scale = max > 10 ? 10 : 1; // проценты → 0–10
    each(MOOD_ALIASES, function (al, key) {
      each(flat, function (v, name) {
        if (out[key] !== undefined) return;
        for (var i = 0; i < al.length; i++) {
          if (name.indexOf(al[i]) > -1 && name.indexOf('id') !== 0) { out[key] = clamp(v / scale, 0, 10); found++; return; }
        }
      });
    });
    return found ? out : null;
  }

  var MoodsApi = { state: null };

  // Пробный запрос раз в сутки: отдаёт ли прокси пользователя эндпоинт /moods
  function probeMoods(cb) {
    var cached = store('moods_probe', {});
    if (cached.day === todaySeed() && typeof cached.ok === 'boolean') {
      MoodsApi.state = cached.ok;
      return cb(cached.ok);
    }
    tmdb('movie/550/moods', {}, DAY, function (raw) {
      var parsed = parseMoods(raw);
      var ok = !!parsed;
      MoodsApi.state = ok;
      save('moods_probe', { day: todaySeed(), ok: ok, sample: raw ? JSON.stringify(raw).slice(0, 600) : null });
      log('moods probe', ok, raw);
      cb(ok);
    });
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

    if (ans.mood === 'relax') m = 1 - 0.09 * z(f) - 0.07 * z(v) - 0.05 * z(t) - 0.04 * z(sd) + 0.04 * z(h) + 0.03 * z(r);
    else if (ans.mood === 'laugh') m = (h === null ? 0.5 : h / 10 * 1.2) - 0.04 * z(f) - 0.03 * z(sd);
    else if (ans.mood === 'nerves') m = Math.max(z(f), z(t)) / 10 * 0.85 + z(a) / 10 * 0.25;
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
      moods: d.moods ? parseMoods(d.moods) : null,
      moodsRaw: d.moods ? JSON.stringify(d.moods).slice(0, 400) : null,
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

  function details(type, id, cb) {
    var append = type === 'movie'
      ? 'keywords,credits,release_dates,external_ids'
      : 'keywords,credits,content_ratings,external_ids';
    if (MoodsApi.state === true) append += ',moods';
    tmdb(type + '/' + id, { append_to_response: append }, 30 * DAY, function (d) {
      cb(d && d.id ? compact(type, d) : null);
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

  function feedback() {
    var fb = store('feedback', {});
    fb.rejected = fb.rejected || {};
    fb.seen = fb.seen || {};
    fb.opened = fb.opened || {};
    return fb;
  }

  function saveFeedback(fb) { save('feedback', fb); }

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
        if (v && v.duration > 0) return v;
      } catch (e) {}
      var raw = fv[h];
      if (raw && raw.duration > 0) {
        return { time: raw.time || 0, duration: raw.duration, percent: raw.percent || Math.round((raw.time || 0) / raw.duration * 100) };
      }
    }
    return null;
  }

  function finished(v) {
    return v.percent >= 85 || (v.duration - v.time) <= 600;
  }

  function collect() {
    var map = {};
    var flags = {};
    var seen = store('seen', {});
    var t = now();
    var dirty = false;

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
            else if (p.percent > 0) s = -0.5;
          }
        }
        put(card, s, ft);
      }
    });

    var fb = feedback();
    each(fb.opened, function (rec) { if (rec && rec.card) put(rec.card, 0.2, 'opened'); });
    each(fb.rejected, function (rec) { if (rec && rec.card) put(rec.card, -0.2, 'rejected'); });
    each(fb.seen, function (rec) { if (rec && rec.card) put(rec.card, 0, 'seen'); });

    if (dirty) save('seen', seen);

    var events = [];
    each(map, function (e, k) {
      e.date = seen[k] || t;
      e.flags = flags[k] || {};
      events.push(e);
    });

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
      if (events[i].s !== 0 && top.length < 40) top.push(events[i]);
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

    var n = 0;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (!e.s || !e.c) continue;
      n++;
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

    var profile = { n: n, f: {}, names: names };

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

    // Нижняя граница годов: самое раннее десятилетие с заметной долей среди того, что нравится
    var decW = {}, decMax = 0;
    for (var di = 0; di < events.length; di++) {
      var de = events[di];
      if (!(de.s > 0) || !de.c || !de.c.year) continue;
      var dy = parseInt(de.c.year, 10);
      if (isNaN(dy)) continue;
      var dk = Math.floor(dy / 10) * 10;
      decW[dk] = (decW[dk] || 0) + de.s * decay(de.date);
      if (decW[dk] > decMax) decMax = decW[dk];
    }
    var floorDec = null;
    each(decW, function (v, d) {
      d = parseInt(d, 10);
      if (v >= decMax * 0.15 && (floorDec === null || d < floorDec)) floorDec = d;
    });
    // Холодный старт — 1990; не строже 2010, чтобы не обеднить пул
    if (n < 5 || floorDec === null) floorDec = 1990;
    profile.yearFloor = Math.min(floorDec, 2010);

    var seeds = events.filter(function (e) { return e.s > 0.25; });
    seeds.sort(function (a, b) { return b.s * decay(b.date) - a.s * decay(a.date); });
    profile.seeds = seeds.slice(0, 15);

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
          pool[k] = { k: k, id: r.id, type: t, r: r, seedHits: 0, seeds: [], wath: false, src: src };
          srcCount[src] = (srcCount[src] || 0) + 1;
        }
        if (seed) { pool[k].seedHits++; pool[k].seeds.push(seed); }
      }
    }

    function req(path, params, type, seed, src) {
      pending++;
      tmdb(path, params, 3 * DAY, function (json) {
        if (json && json.results) add(json.results, type, seed, src);
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
    var floor = (profile.yearFloor || 1990) - (surprise ? 10 : 0);

    // 1. Рекомендации по seed-фильмам — только от тех, что сами подходят под настроение
    var fits = [], rest = [];
    for (var si = 0; si < profile.seeds.length; si++) {
      var sd = profile.seeds[si];
      if (types.length === 1 && sd.type !== types[0]) continue;
      if (!sd.c) continue;
      if (MOODS[ans.mood] && moodScore(sd.c, ans) < 0.5) rest.push(sd);
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
          'vote_count.gte': type === 'tv' ? 100 : (short ? 30 : 200),
          'vote_average.gte': 6
        };
        p[type === 'tv' ? 'first_air_date.gte' : 'primary_release_date.gte'] = floor + '-01-01';
        if (type === 'movie' && limited) {
          var lim = short ? 45 : parseInt(ans.time, 10) + 10;
          if (!isNaN(lim)) p['with_runtime.lte'] = lim;
        }
        if (type === 'tv' && short) p['with_runtime.lte'] = 35;
        if (type === 'tv' && ans.time === 'series') p['with_runtime.lte'] = 60;
        var ex = excl.filter(function (x) { return ids.indexOf(x) < 0; });
        if (ex.length) p.without_genres = ex.join(',');

        req('discover/' + type, extend(p, { page: 1 }), type, null, 'disc');
        if (plan[g].kind !== 'pair') req('discover/' + type, extend(p, { page: 2 }), type, null, 'disc');
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
        ep[exType === 'tv' ? 'first_air_date.gte' : 'primary_release_date.gte'] = floor + '-01-01';
        req('discover/' + exType, ep, exType, null, 'explore');
      }
    }

    // 4. Закладки «Позже»
    for (var e = 0; e < events.length; e++) {
      var ev = events[e];
      var intent = false;
      for (var it = 0; it < INTENT_TYPES.length; it++) if (ev.flags[INTENT_TYPES[it]]) intent = true;
      if (!intent || types.indexOf(ev.type) < 0) continue;
      if (!pool[ev.k]) {
        pool[ev.k] = { k: ev.k, id: ev.id, type: ev.type, r: ev.card, seedHits: 0, seeds: [], wath: true, src: 'wath' };
        srcCount.wath = (srcCount.wath || 0) + 1;
      } else pool[ev.k].wath = true;
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
      // Уже открывали в Lampa: прогресс мог не распознаться, повторно не предлагаем
      else if (!ex[events[i].k] && (f.history || f.continued)) ex[events[i].k] = 'history';
    }
    each(fb.seen, function (v, k) { ex[k] = 'seen'; });
    each(fb.rejected, function (v, k) { if (v && t - v.t < 90 * DAY) ex[k] = 'rejected'; });
    return ex;
  }

  function prefilter(pool, events, ans, stats) {
    var ex = excludedKeys(events);
    var today = new Date().toISOString().slice(0, 10);
    var short = ans.time === '40';
    var out = [];
    stats = stats || {};
    var bump = function (k) { stats[k] = (stats[k] || 0) + 1; };

    each(pool, function (it, k) {
      if (k === '__src') return;
      if (ex[k]) return bump(ex[k]);
      var r = it.r || {};
      var date = r.release_date || r.first_air_date || '';
      if (!it.wath) {
        if (date && date > today) return bump('future');
        var minVotes = it.type === 'tv' ? 100 : (short ? 30 : 200);
        if ((r.vote_count || 0) < minVotes) return bump('votes');
      }
      out.push(it);
    });
    return out;
  }

  // Пустая строка — подходит, иначе причина отсева
  function postReason(it, ans) {
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

    if (ans.company !== 'kids' && kidsTargeted(c)) return 'kids_content';

    if (ans.company === 'kids') {
      if (c.moods && ((mv(c, 'fear') || 0) > 6 || (mv(c, 'violence') || 0) > 5 || (mv(c, 'profanity') || 0) > 3)) return 'kids_moods';
      if (!kidsOk(c.cert)) return 'kids_cert';
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

  function quality(c, C, kp) {
    var ratings = [];
    if (c.va > 0) ratings.push(c.va);
    var rec = kp[c.id];
    if (rec) {
      if (parseFloat(rec.kp) > 0) ratings.push(parseFloat(rec.kp));
      if (parseFloat(rec.imdb) > 0) ratings.push(parseFloat(rec.imdb));
    }
    if (!ratings.length) return { q: 0, r: 0 };
    var R = 0;
    for (var i = 0; i < ratings.length; i++) R += ratings[i];
    R /= ratings.length;

    var m = c.type === 'tv' ? 200 : 500;
    var v = c.vc || 0;
    var wr = (v / (v + m)) * R + (m / (v + m)) * C;
    return { q: clamp((wr - 5.5) / 3.0, 0, 1), r: R, kp: rec ? parseFloat(rec.kp) || 0 : 0, imdb: rec ? parseFloat(rec.imdb) || 0 : 0 };
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

  function moodScore(c, ans) {
    var mood = MOODS[ans.mood];
    var m = 0.5;

    var hasW = false;
    if (mood) each(mood.w, function () { hasW = true; });
    if (hasW) {
      var maxPos = 0, neg = 0;
      for (var i = 0; i < c.genres.length; i++) {
        var gw = mood.w[c.genres[i]];
        if (gw === undefined) continue;
        if (gw > maxPos) maxPos = gw;
        if (gw < 0) neg += gw;
      }
      m = 0.3 + 0.7 * maxPos + 0.5 * neg;
      if (mood.req && c.genres.indexOf(mood.req) < 0) m = Math.min(m, 0.15);
    }

    if (ans.company === 'group') {
      var fun = false;
      for (var g = 0; g < GROUP_PLUS.length; g++) if (c.genres.indexOf(GROUP_PLUS[g]) > -1) fun = true;
      if (fun) m += 0.2;
      else if (c.genres.indexOf(18) > -1) m -= 0.2;
    }

    if (ans.company !== 'kids' && isAnimated(c) && c.genres.indexOf(10751) > -1) m -= 0.4;
    if ((ans.mood === 'relax' || ans.mood === 'laugh') && adultRated(c)) m -= 0.25;
    if (ans.company === 'couple' && adultRated(c) && ans.mood !== 'nerves' && ans.mood !== 'think') m -= 0.1;

    m = clamp(m, 0, 1);

    // Если есть шкалы настроения — они точнее жанров
    var scaled = moodFromScales(c, ans);
    if (scaled !== null) m = 0.65 * scaled + 0.35 * m;

    return clamp(m, 0, 1);
  }
  function novelty(c, profile) {
    var n = 0;
    var f = featuresOf(c);
    for (var i = 0; i < f.genre.length; i++) {
      if (profile.recentGenres.indexOf(f.genre[i]) < 0) { n += 0.6; break; }
    }
    if (f.decade.length && profile.recentDecades.indexOf(f.decade[0]) < 0) n += 0.2;
    var y = parseInt(c.year, 10);
    if (!isNaN(y) && y >= new Date().getFullYear() - 3) n += 0.2;
    return clamp(n, 0, 1);
  }

  // Множитель за возраст: десятилетием старше границы — ×0,75, ещё старше — ×0,4
  function yearFactor(c, profile, ans) {
    var y = parseInt(c.year, 10);
    var floor = profile.yearFloor || 1990;
    if (isNaN(y) || y >= floor) return 1;
    var surprise = ans.mood === 'surprise';
    if (y >= floor - 10) return surprise ? 0.9 : 0.75;
    return surprise ? 0.7 : 0.4;
  }

  function pickWeights(ans, profile) {
    if (profile.n < 5) return { key: 'cold', w: WEIGHTS.cold };
    if (ans.company === 'group') return { key: 'group', w: WEIGHTS.group };
    if (ans.mood === 'think') return { key: 'think', w: WEIGHTS.think };
    if (ans.mood === 'surprise') return { key: 'surprise', w: WEIGHTS.surprise };
    return { key: 'def', w: WEIGHTS.def };
  }

  function formatVotes(v) {
    if (v >= 1000) return Math.round(v / 1000) + ' тыс.';
    return String(v);
  }

  function reasonOf(it, parts, w, profile) {
    var c = it.c;
    if (it.wath) return 'Из вашего списка «Позже»';
    if (it.seedHits >= 1 && it.seeds.length && it.seeds[0]) {
      if (it.seeds.length > 1) return 'Похож на «' + it.seeds[0] + '» и «' + it.seeds[1] + '»';
      return 'Похож на «' + it.seeds[0] + '»';
    }

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
        if (b.type === 'genre' && GENRE_NAMES[b.id]) return 'Ваш жанр: ' + GENRE_NAMES[b.id].toLowerCase();
      }
      if (k === 'q' && parts.r) return 'Высокий рейтинг: ' + parts.r.toFixed(1) + ', ' + formatVotes(c.vc) + ' голосов';
      if (k === 'n' && c.genres.length) return 'Что-то новое: ' + (GENRE_NAMES[c.genres[0]] || '').toLowerCase();
    }
    return '';
  }

  function scoreAll(items, profile, ans) {
    var pw = pickWeights(ans, profile);
    var w = pw.w;
    var kp = kpCache();

    var sumVa = 0, nVa = 0;
    for (var i = 0; i < items.length; i++) if (items[i].c && items[i].c.vc > 0) { sumVa += items[i].c.va; nVa++; }
    var C = nVa ? sumVa / nVa : 6.5;

    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var c = it.c;
      var qq = quality(c, C, kp);
      var aa = affinity(c, profile);
      var parts = {
        q: qq.q, r: qq.r,
        a: aa.a, best: aa.best,
        m: moodScore(c, ans),
        n: novelty(c, profile),
        s: it.wath ? 1 : Math.min(it.seedHits / 3, 1)
      };
      it.parts = parts;
      it.kp = qq.kp;
      it.imdbR = qq.imdb;
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
      // Смотрят не одни: доля анимации у пользователя ничего не говорит о вкусе второго зрителя
      if (anim && (ans.company === 'couple' || ans.company === 'group')) pt.f *= 0.6;
      // Настроение — множитель: «Позже» или высокий рейтинг не вытащат фильм, который не подходит под запрос
      var rest = 1 - w.m;
      var base = (w.q * pt.q + w.a * pt.an + w.n * pt.n + w.s * pt.s) / (rest > 0 ? rest : 1);
      var moodGate = w.m > 0 ? 0.35 + 0.65 * pt.m : 1;
      pt.y = x.wath ? 1 : yearFactor(x.c, profile, ans); // «Позже» — явный выбор, годы не штрафуем
      x.score = base * moodGate * (0.65 + 0.35 * pt.f) * pt.y;
      x.reason = reasonOf(x, pt, w, profile);
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

  function jitter(items) {
    items.sort(function (a, b) { return b.score - a.score; });
    var rand = rng(todaySeed());
    for (var i = 0; i < Math.min(15, items.length); i++) {
      items[i].jscore = items[i].score * (0.92 + 0.16 * rand());
    }
    for (var j = 15; j < items.length; j++) items[j].jscore = items[j].score;
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

  function franchiseFilter(list, events, ans, stats, cb) {
    var byColl = {};
    for (var i = 0; i < list.length; i++) {
      var c = list[i].c;
      if (c && c.type === 'movie' && c.coll) (byColl[c.coll] = byColl[c.coll] || []).push(list[i]);
    }
    var colls = Object.keys(byColl);
    if (!colls.length) return cb(list);

    var ex = excludedKeys(events);
    var today = new Date().toISOString().slice(0, 10);
    var drop = {};
    var additions = [];
    var left = colls.length;

    var done = function () {
      if (--left > 0) return;
      var kept = list.filter(function (it) { return !drop[it.k]; });
      if (!additions.length) return cb(kept);
      detailsMany(additions, function () {
        for (var a = 0; a < additions.length; a++) {
          var r = postReason(additions[a], ans);
          if (r) stats[r] = (stats[r] || 0) + 1;
          else kept.push(additions[a]);
        }
        cb(kept);
      });
    };

    each(byColl, function (items, collId) {
      tmdb('collection/' + collId, {}, 30 * DAY, function (col) {
        var parts = ((col && col.parts) || []).filter(function (pt) {
          return pt.release_date && pt.release_date <= today;
        });
        parts.sort(function (a, b) { return a.release_date < b.release_date ? -1 : 1; });

        // Следующая часть: первая, которую не смотрели (отклонённая — франшиза пропускается целиком)
        var next = null, blocked = false;
        for (var p = 0; p < parts.length; p++) {
          var k = keyOf('movie', parts[p].id);
          if (ex[k] === 'rejected') { blocked = true; break; }
          if (!ex[k]) { next = parts[p]; break; }
        }

        var best = items[0];
        for (var b = 1; b < items.length; b++) if ((items[b].score || 0) > (best.score || 0)) best = items[b];

        for (var j = 0; j < items.length; j++) {
          var it = items[j];
          var keep = !blocked && (next ? it.id === next.id : (parts.length === 0 && it === best));
          if (!keep) { drop[it.k] = true; stats.franchise = (stats.franchise || 0) + 1; }
        }

        // Нужная часть не в списке — подставляем её вместо лучшего представителя франшизы
        if (!blocked && next) {
          var inList = false;
          for (var q = 0; q < items.length; q++) if (items[q].id === next.id) inList = true;
          if (!inList) {
            additions.push({
              k: keyOf('movie', next.id), id: next.id, type: 'movie', r: next,
              seedHits: best.seedHits, seeds: best.seeds, wath: false, src: 'franchise'
            });
          }
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
  function run(ans, h) {
    h = h || {};
    var token = ++runToken;
    var alive = function () { return token === runToken; };
    var stage = function (t) { if (h.stage && alive()) h.stage(t); };
    var started = now();

    save('last_answers', ans);
    stage('Изучаю вашу историю');

    var events = collect();

    probeMoods(function () {
    enrichEvents(events, function () {
      if (!alive()) return;
      var profile = buildProfile(events);
      stage('Ищу кандидатов');

      gatherPool(profile, events, ans, function (pool) {
        if (!alive()) return;
        var stats = {};
        var list = prefilter(pool, events, ans, stats);

        // Предоценка по полям списка, затем детали партиями, пока не наберётся достаточно подходящих
        for (var i = 0; i < list.length; i++) list[i].c = cardCompact(list[i].r || {});
        scoreAll(list, profile, ans);
        list.sort(function (a, b) { return b.score - a.score; });

        var BATCH = 30, WANT = 30, MAX_DETAILED = 150;
        var passed = [];
        var offset = 0;

        var nextBatch = function () {
          if (!alive()) return;
          var batch = list.slice(offset, offset + BATCH);
          offset += batch.length;
          stage('Сравниваю ' + offset + ' вариантов');
          detailsMany(batch, function () {
            if (!alive()) return;
            for (var b = 0; b < batch.length; b++) {
              var r = postReason(batch[b], ans);
              if (r) stats[r] = (stats[r] || 0) + 1;
              else passed.push(batch[b]);
            }
            if (passed.length < WANT && offset < list.length && offset < MAX_DETAILED) nextBatch();
            else afterDetails();
          });
        };

        var afterDetails = function () {
          scoreAll(passed, profile, ans);
          franchiseFilter(passed, events, ans, stats, function (finalList) {
          if (!alive()) return;
          var top = list.slice(0, offset);
          var wkey = scoreAll(finalList, profile, ans);
          jitter(finalList);

          log('events', events.length, 'profile.n', profile.n, 'pool', Object.keys(pool).length - 1,
            'prefiltered', list.length, 'final', finalList.length, 'ms', now() - started);

          var st = {
            ans: ans, rest: finalList, shown: [], page: [],
            profile: profile, wkey: wkey, cold: profile.n < 5
          };
          st.journal = Journal.begin(ans, {
            wkey: wkey, ms: now() - started, moods: MoodsApi.state,
            counts: { events: events.length, profile: profile.n, pool: Object.keys(pool).length - 1, prefiltered: list.length, detailed: top.length, final: finalList.length },
            sources: pool.__src,
            dropped: stats,
            profile: profileSummary(profile),
            top: finalList.slice().sort(function (a, b) { return b.score - a.score; }).slice(0, 12).map(journalItem)
          });
          if (h.done) h.done(st);
          });
        };

        nextBatch();
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
      score: round3(it.score),
      q: round3(p.q), a: round3(p.a), an: round3(p.an), m: round3(p.m), n: round3(p.n), s: round3(p.s), f: round3(p.f), y: round3(p.y),
      src: it.src || null,
      coll: c.coll || null,
      anim: isAnimated(c),
      cert: c.cert ? [c.cert.ru ? 'RU:' + c.cert.ru : '', c.cert.us ? 'US:' + c.cert.us : ''].filter(Boolean).join(' ') : null,
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

  function profileSummary(profile) {
    return {
      events: profile.n,
      animShare: round3(profile.animShare),
      yearFloor: profile.yearFloor,
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
      var a = store('journal', []);
      return Object.prototype.toString.call(a) === '[object Array]' ? a : [];
    },

    saveEntry: function (entry) {
      var a = this.list();
      var i = -1;
      for (var k = 0; k < a.length; k++) if (a[k].id === entry.id) i = k;
      if (i >= 0) a[i] = entry; else a.push(entry);
      while (a.length > JOURNAL_MAX) a.shift();
      save('journal', a);
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
        if (entry.shown[i].k === it.k) { entry.shown[i].kp = it.kp || null; entry.shown[i].imdb = it.imdbR || null; }
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

    clear: function () { save('journal', []); },

    exportText: function () {
      var a = this.list();
      var head = {
        plugin: 'lampa_picker',
        v: VERSION,
        exported: new Date().toISOString(),
        sessions: a.length,
        ua: (navigator.userAgent || '').slice(0, 120),
        kpQuotaToday: kpQuota().n,
        moodsProbe: store('moods_probe', {})
      };
      var lines = [JSON.stringify(head)];
      for (var i = 0; i < a.length; i++) lines.push(JSON.stringify(a[i]));
      return lines.join('\n');
    }
  };

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

  function downloadText(name, text) {
    try {
      var blob = new Blob([text], { type: 'application/x-ndjson' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); document.body.removeChild(a); }, 1500);
      return true;
    } catch (e) { return false; }
  }

  function canShare() { return !!(navigator.share); }

  // =========================================================================
  // Рейтинги КП и IMDb для видимых карточек
  // Схема как у rating.js: поиск на kinopoiskapiunofficial по imdb_id, запасной — по названию.
  // Результат пишется в кеш rating.js (kp_rating) — он не будет запрашивать повторно.
  // =========================================================================

  var KP_API = 'https://kinopoiskapiunofficial.tech/';
  var KP_KEY = '14342b35-714b-449d-bf10-30d0d9ac22e6'; // публичный ключ из bylampa rating.js
  var KP_DAILY_LIMIT = 120;

  function kpQuota() {
    var q = store('kp_quota', {});
    var day = todaySeed();
    if (q.day !== day) q = { day: day, n: 0 };
    return q;
  }

  function kpSpend() {
    var q = kpQuota();
    if (q.n >= KP_DAILY_LIMIT) return false;
    q.n++;
    save('kp_quota', q);
    return true;
  }

  function writeKpCache(tmdbId, rec) {
    try {
      var cache = Lampa.Storage.cache('kp_rating', 500, {}) || {};
      cache[tmdbId] = rec;
      Lampa.Storage.set('kp_rating', cache);
    } catch (e) {}
  }

  function kpHeaders() { return { headers: { 'X-API-KEY': KP_KEY } }; }

  function fetchRatings(it, cb) {
    var c = it.c;
    var cached = kpCache()[c.id];
    if (cached && (parseFloat(cached.kp) > 0 || parseFloat(cached.imdb) > 0)) {
      return cb({ kp: parseFloat(cached.kp) || 0, imdb: parseFloat(cached.imdb) || 0 });
    }

    var map = store('kpmap', {});
    var m = map[it.k];
    if (m && now() - m.t < 14 * DAY) return cb(m.kp || m.imdb ? { kp: m.kp, imdb: m.imdb } : null);

    var finish = function (kp, imdb, kpId) {
      kp = parseFloat(kp) || 0;
      imdb = parseFloat(imdb) || 0;
      var mp = store('kpmap', {});
      mp[it.k] = { kp: kp, imdb: imdb, id: kpId || null, t: now() };
      var keys = Object.keys(mp);
      if (keys.length > 1500) {
        keys.sort(function (a, b) { return mp[a].t - mp[b].t; });
        for (var i = 0; i < keys.length - 1500; i++) delete mp[keys[i]];
      }
      save('kpmap', mp);
      if (kp || imdb) {
        writeKpCache(c.id, { kp: kp, imdb: imdb, timestamp: now() });
        cb({ kp: kp, imdb: imdb });
      } else cb(null);
    };

    var byId = function (kpId) {
      if (!kpSpend()) return cb(null);
      Net.get(KP_API + 'api/v2.2/films/' + kpId, function (j) {
        finish(j && j.ratingKinopoisk, j && j.ratingImdb, kpId);
      }, function () { cb(null); }, kpHeaders());
    };

    var byTitle = function () {
      if (!c.title || !kpSpend()) return cb(null);
      Net.get(KP_API + 'api/v2.1/films/search-by-keyword?keyword=' + encodeURIComponent(c.original || c.title), function (j) {
        var films = (j && j.films) || [];
        var y = parseInt(c.year, 10);
        for (var i = 0; i < films.length; i++) {
          var fy = parseInt(films[i].year, 10);
          if (!y || (!isNaN(fy) && Math.abs(fy - y) <= 1)) return byId(films[i].filmId);
        }
        finish(0, 0, null);
      }, function () { cb(null); }, kpHeaders());
    };

    if (c.imdb) {
      if (!kpSpend()) return cb(null);
      Net.get(KP_API + 'api/v2.2/films?imdbId=' + encodeURIComponent(c.imdb), function (j) {
        var x = j && j.items && j.items[0];
        if (x) finish(x.ratingKinopoisk, x.ratingImdb, x.kinopoiskId);
        else byTitle();
      }, byTitle, kpHeaders());
    } else byTitle();
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
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
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

  function img(path, size) {
    if (!path) return '';
    try {
      if (Lampa.TMDB && typeof Lampa.TMDB.image === 'function') return Lampa.TMDB.image('t/p/' + size + path);
    } catch (e) {}
    return 'https://image.tmdb.org/t/p/' + size + path;
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
    '.pkr-hero__title{font-size:2.6em;font-weight:700;line-height:1.1;text-shadow:0 .1em .5em rgba(0,0,0,.5)}',
    '.pkr-hero__orig{opacity:.55;margin-top:.35em}',
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
    '.pkr-hero__reason{margin-top:.55em;font-size:1.08em;color:#ffd166;line-height:1.35}',
    '.pkr-hero__reason svg{width:1.05em;height:1.05em;vertical-align:-.12em;margin-right:.45em}',
    '.pkr-hero__descr{margin-top:.6em;opacity:.75;line-height:1.45;max-height:2.9em;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}',
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
    '.pkr-hero__descr{max-height:4.35em;-webkit-line-clamp:3}',
    '.pkr-row{margin:0 -1em;padding:.7em .65em .4em;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch}',
    '.pkr-card{width:38%;padding:0 .35em}',
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
    var stageEl = null;

    // ---- служебное

    function focusable() { return html; }

    // Высота экрана: от верха компонента до низа окна
    function fit() {
      try {
        var top = html.offset() ? html.offset().top : 0;
        var h = (window.innerHeight || document.documentElement.clientHeight) - Math.max(0, top);
        if (h > 100) html.css('height', h + 'px');
      } catch (e) {}
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

        if (el.closest('.pkr-hero, .pkr-actions:not(.pkr-actions--footer), .pkr-tiles, .pkr-last').length && top < vh * 0.6) target = 0;
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

      wrap.append('<div class="pkr-step">Что посмотреть · шаг ' + (n + 1) + ' из ' + STEPS.length + '</div>');
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

      if (n === 0 && Journal.list().length) {
        var foot = $('<div class="pkr-wizard__foot"></div>');
        foot.append(button('list', 'Журнал подборов', 'pkr-btn--ghost', function () { renderJournal(); }));
        wrap.append(foot);
      }

      setBody(wrap);
      refresh(focusEl);
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
        }
      });
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
        var labels = { humor: 'Юмор', romance: 'Романтика', fear: 'Страх', tension: 'Напряжение', violence: 'Насилие', sadness: 'Грусть', action: 'Экшн', pace: 'Темп', profanity: 'Брань' };
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
      if (descr) h += '<div class="pkr-hero__descr">' + esc(descr) + '</div>';

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

    function setCurrent(it) {
      if (!it) return;
      current = it;
      heroEl.html(heroHtml(it));
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

      var wrap = $('<div class="pkr-res"></div>');
      var bg = $('<div class="pkr-bg"><div class="pkr-bg__img"></div><div class="pkr-bg__img"></div><div class="pkr-bg__shade"></div></div>');
      bgA = bg.find('.pkr-bg__img').eq(0);
      bgB = bg.find('.pkr-bg__img').eq(1);
      bgFront = 0;
      wrap.append(bg);

      var actions = $('<div class="pkr-actions"></div>');
      actions.append(button('play', 'Открыть', 'pkr-btn--primary', function () { if (current) openIt(current); }));
      actions.append(button('close', 'Не то', '', function () { dismiss('reject'); }));
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
      setCurrent(current);

      if (!state.logged) {
        Journal.shown(state.journal, state.page, state.pageNo || 1);
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
          fetchRatings(it, function (r) {
            if (!r) return;
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
            if (current === it) heroEl.html(heroHtml(it));
          });
        })(page[i]);
      }
    }

    function dismiss(kind) {
      if (!current) return;
      var it = current;
      var idx = state.page.indexOf(it);
      var fb = feedback();
      if (kind === 'reject') fb.rejected[it.k] = { t: now(), card: miniCard(it.c) };
      else fb.seen[it.k] = { t: now(), card: miniCard(it.c) };
      saveFeedback(fb);
      Journal.action(state.journal, kind === 'reject' ? 'reject' : 'seen', it);
      state.logged = true;
      noty(kind === 'reject' ? 'Скрыто на 90 дней' : 'Отмечено как просмотренное');

      if (cardEls[idx]) cardEls[idx].addClass('is-gone');
      setTimeout(function () {
        replaceInPage(state, it);
        var fresh = state.page[idx];
        if (fresh && fresh !== it) Journal.shown(state.journal, [fresh], (state.pageNo || 1) + '-repl');
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
      var kb = Math.max(1, Math.round(text.length / 1024));

      var wrap = $('<div class="pkr-journal"></div>');
      wrap.append('<div class="pkr-step">Что посмотреть</div>');
      wrap.append('<div class="pkr-j__title">Журнал подборов</div>');
      wrap.append('<div class="pkr-j__sub">Сессий: ' + list.length + ' · около ' + kb + ' КБ. ' +
        'Внутри ответы, профиль вкуса, причины отсева, показанные фильмы с разбивкой оценки и ваши действия. ' +
        'Хранится только на этом устройстве.</div>');

      var actions = $('<div class="pkr-actions"></div>');
      actions.append(button('copy', 'Скопировать', 'pkr-btn--primary', function () {
        copyText(Journal.exportText(), function () { noty('Журнал скопирован: ' + list.length + ' сессий'); },
          function () { noty('Не удалось скопировать — попробуйте «Скачать» или «Поделиться»'); });
      }));
      if (canShare()) actions.append(button('share', 'Поделиться', '', function () {
        try {
          navigator.share({ title: 'Журнал подборщика Lampa', text: Journal.exportText() })['catch'](function () {});
        } catch (e) { noty('Поделиться не получилось'); }
      }));
      actions.append(button('download', 'Скачать файл', '', function () {
        var ok = downloadText('lampa-picker-journal-' + todaySeed() + '.jsonl', Journal.exportText());
        noty(ok ? 'Файл сохранён' : 'Скачивание недоступно на этом устройстве');
      }));
      actions.append(button('trash', 'Очистить', 'pkr-btn--ghost', function () {
        Journal.clear();
        noty('Журнал очищен');
        renderJournal();
      }));
      wrap.append(actions);

      try { console.log('[Picker] journal\n' + text); } catch (e) {}

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
          if (Navigator.canmove('left')) Navigator.move('left');
          else Lampa.Controller.toggle('menu');
        },
        right: function () { Navigator.move('right'); },
        up: function () {
          if (Navigator.canmove('up')) Navigator.move('up');
          else Lampa.Controller.toggle('head');
        },
        down: function () { if (Navigator.canmove('down')) Navigator.move('down'); },
        back: function () { self.back(); }
      });
      Lampa.Controller.toggle('content');
      fit();
      setTimeout(fit, 60);
    };

    this.back = function () {
      if (view === 'journal') return leaveJournal();
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
      title: 'Что посмотреть',
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
        '<div class="menu__text">Что посмотреть</div></li>');
      item.on('hover:enter', function () { openPicker(); });
      $('.menu .menu__list').eq(0).append(item);
    } catch (e) { log('menu error', e); }
  }

  function warmup() {
    try {
      var events = collect();
      enrichEvents(events, function () {
        var profile = buildProfile(events);
        var seeds = profile.seeds.slice(0, 8);
        for (var i = 0; i < seeds.length; i++) {
          tmdb(seeds[i].type + '/' + seeds[i].id + '/recommendations', { page: 1 }, 3 * DAY, function () {});
        }
        log('warmup done, events', events.length, 'profile.n', profile.n);
      });
    } catch (e) { log('warmup error', e); }
  }

  // Диагностика из консоли: LampaPicker.diag()
  function diag() {
    var report = { version: VERSION, favorites: {}, timelineSample: null, tmdbUrl: null, kpCache: 0, manifest: null };
    each(SIGNALS, function (v, ft) { report.favorites[ft] = favList(ft).length; });
    var hist = favList('history');
    for (var i = 0; i < hist.length && !report.timelineSample; i++) {
      var p = progress(hist[i]);
      if (p) report.timelineSample = { title: hist[i].title || hist[i].name, progress: p };
    }
    report.tmdbUrl = tmdbUrl('movie/27205', {});
    try { report.kpCache = Object.keys(kpCache()).length; } catch (e) {}
    try { report.manifest = Lampa.Manifest && Lampa.Manifest.origin; } catch (e) {}
    report.hasTmdbKey = !!(Lampa.TMDB && Lampa.TMDB.key);
    report.hasIndexedDB = !!window.indexedDB;
    probeMoods(function (ok) { console.log('[Picker] moods endpoint:', ok ? 'доступен' : 'нет', store('moods_probe', {})); });

    console.log('[Picker] diag', report);
    tmdb('movie/27205', {}, 0, function (d) {
      console.log('[Picker] TMDB test:', d && d.id ? 'OK — ' + (d.title || d.original_title) : 'FAIL', d);
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
    reset: function () { save('feedback', {}); save('seen', {}); save('last_answers', null); return 'reset'; }
  };

  function init() {
    injectCss();
    try { Lampa.Component.add('lampa_picker', PickerComponent); } catch (e) { log('component error', e); }
    addMenu();
    setTimeout(warmup, 30000);
    log('ready', VERSION);
  }

  if (window.appready) init();
  else {
    Lampa.Listener.follow('app', function (e) {
      if (e.type === 'ready') init();
    });
  }
})();
