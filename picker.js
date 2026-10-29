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

  var VERSION = '0.1.0';
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
    10770: 'ТВ-фильм', 53: 'Триллер', 10752: 'Военный', 37: 'Вестерн'
  };

  // Сериальные жанры TMDB → жанры фильмов (вся логика живёт в пространстве жанров фильмов)
  var TV_TO_MOVIE = {
    10759: [28, 12], 10765: [878, 14], 10768: [10752], 10762: [10751],
    10763: [], 10764: [], 10766: [18], 10767: []
  };

  var MOVIE_TO_TV = { 28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768 };
  var TV_HAS_SAME = [16, 35, 80, 99, 18, 10751, 9648, 37];

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

  var MOODS = {
    relax: { title: 'Расслабиться', plus: [35, 10751, 16, 10749, 12], minus: [27, 10752, 53] },
    laugh: { title: 'Посмеяться', plus: [35], minus: [27, 10752], req: 35 },
    nerves: { title: 'Пощекотать нервы', plus: [53, 27, 9648, 80], minus: [10751, 16] },
    think: { title: 'Подумать', plus: [18, 878, 9648, 36, 99], minus: [10751] },
    surprise: { title: 'Удиви меня', plus: [], minus: [] }
  };

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

    get: function (url, ok, fail) {
      this.queue.push({ url: url, ok: ok, fail: fail, tries: 0 });
      this.pump();
    },

    pump: function () {
      var self = this;
      while (self.active < self.max && self.queue.length) {
        (function (job) {
          self.active++;
          var req = new Lampa.Reguest();
          req.timeout(15000);
          req.silent(job.url, function (json) {
            self.active--;
            try { job.ok(json); } catch (e) { log('callback error', e); }
            self.pump();
          }, function () {
            self.active--;
            if (job.tries < 1) {
              job.tries++;
              setTimeout(function () { self.queue.push(job); self.pump(); }, 1500);
            } else if (job.fail) {
              try { job.fail(); } catch (e) {}
            }
            self.pump();
          });
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
    if (ru) return { c: 'RU', v: ru };
    var us = pick('US');
    if (us) return { c: 'US', v: us };
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

  function progress(card) {
    if (typeOf(card) !== 'movie') return null;
    try {
      var h = Lampa.Utils.hash(card.original_title || card.title || '');
      var v = Lampa.Timeline.view(h);
      if (v && v.duration > 0) return v;
    } catch (e) {}
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
      profile.f[t] = out;
    });

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

  function gatherPool(profile, events, ans, cb) {
    var pool = {};
    var pending = 1; // защитная единица: снимается после постановки всех запросов
    var closed = false;
    var types = wantedTypes(ans);

    function add(list, type, seed) {
      for (var i = 0; i < (list || []).length; i++) {
        var r = list[i];
        var t = r.media_type || type;
        if (t !== 'movie' && t !== 'tv') continue;
        if (types.indexOf(t) < 0) continue;
        var k = keyOf(t, r.id);
        if (!pool[k]) pool[k] = { k: k, id: r.id, type: t, r: r, seedHits: 0, seeds: [], wath: false };
        if (seed) { pool[k].seedHits++; pool[k].seeds.push(seed); }
      }
    }

    function req(path, params, type, seed) {
      pending++;
      tmdb(path, params, 3 * DAY, function (json) {
        if (json && json.results) add(json.results, type, seed);
        if (--pending === 0) finish();
      });
    }

    function finish() {
      if (closed) return;
      closed = true;
      cb(pool);
    }

    // 1. Рекомендации по seed-фильмам
    var seeds = profile.seeds.slice(0, 8);
    for (var i = 0; i < seeds.length; i++) {
      var s = seeds[i];
      req(s.type + '/' + s.id + '/recommendations', { page: 1 }, s.type, s.c ? s.c.title : '');
    }

    // 2. Discover по жанрам профиля (холодный старт — по жанрам настроения)
    var genres = topGenres(profile, 3, true);
    var mood = MOODS[ans.mood];
    if (genres.length < 2 && mood && mood.plus.length) genres = uniq(genres.concat(mood.plus.slice(0, 3)));
    if (!genres.length) genres = [35, 18, 878];

    var short = ans.time === '40';

    for (var t = 0; t < types.length; t++) {
      var type = types[t];
      for (var g = 0; g < genres.length; g++) {
        var gid = type === 'tv' ? toTvGenre(genres[g]) : genres[g];
        if (!gid) continue;
        var p = {
          with_genres: gid,
          sort_by: 'popularity.desc',
          'vote_count.gte': type === 'tv' ? 100 : (short ? 30 : 300)
        };
        if (type === 'movie' && ans.time !== 'any') {
          var limit = short ? 45 : parseInt(ans.time, 10) + 10;
          if (!isNaN(limit)) p['with_runtime.lte'] = limit;
        }
        if (ans.company === 'kids') p['without_genres'] = type === 'tv' ? '' : '27,10752';
        if (!p['without_genres']) delete p['without_genres'];

        req('discover/' + type, extend(p, { page: 1 }), type, null);
        req('discover/' + type, extend(p, { page: 2 }), type, null);
      }
    }

    // 3. Исследование: жанр с небольшим положительным весом
    var all = topGenres(profile, 6, true);
    if (all.length > 3) {
      var ex = all[3 + Math.floor(rng(todaySeed())() * (all.length - 3))];
      var exType = types[0];
      var exId = exType === 'tv' ? toTvGenre(ex) : ex;
      if (exId) req('discover/' + exType, {
        with_genres: exId, sort_by: 'vote_average.desc', 'vote_count.gte': 500, page: 1
      }, exType, null);
    }

    // 4. Закладки «Позже»
    for (var e = 0; e < events.length; e++) {
      var ev = events[e];
      var intent = false;
      for (var it = 0; it < INTENT_TYPES.length; it++) if (ev.flags[INTENT_TYPES[it]]) intent = true;
      if (!intent || types.indexOf(ev.type) < 0) continue;
      if (!pool[ev.k]) pool[ev.k] = { k: ev.k, id: ev.id, type: ev.type, r: ev.card, seedHits: 0, seeds: [], wath: true };
      else pool[ev.k].wath = true;
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
      if (f.started || f.seen) ex[events[i].k] = 'watched';
    }
    each(fb.seen, function (v, k) { ex[k] = 'seen'; });
    each(fb.rejected, function (v, k) { if (v && t - v.t < 90 * DAY) ex[k] = 'rejected'; });
    return ex;
  }

  function prefilter(pool, events, ans) {
    var ex = excludedKeys(events);
    var today = new Date().toISOString().slice(0, 10);
    var short = ans.time === '40';
    var out = [];

    each(pool, function (it, k) {
      if (ex[k]) return;
      var r = it.r || {};
      var date = r.release_date || r.first_air_date || '';
      if (!it.wath) {
        if (date && date > today) return;
        var minVotes = it.type === 'tv' ? 100 : (short ? 30 : 200);
        if ((r.vote_count || 0) < minVotes) return;
      }
      out.push(it);
    });
    return out;
  }

  function postfilter(it, ans) {
    var c = it.c;
    if (!c) return false;

    if (ans.time === '40') {
      if (!c.runtime) return false;
      if (c.type === 'movie' && c.runtime > 40) return false;
      if (c.type === 'tv' && c.runtime > 35) return false;
    } else if (ans.time === '90' || ans.time === '120') {
      if (c.type !== 'movie' || !c.runtime) return false;
      if (c.runtime > parseInt(ans.time, 10) + 10) return false;
    } else if (ans.time === 'series') {
      if (c.type !== 'tv') return false;
      if (c.runtime && c.runtime > 60) return false;
    }

    if (ans.company === 'kids') {
      if (!kidsOk(c.cert)) return false;
      if (c.genres.indexOf(27) > -1 || c.genres.indexOf(10752) > -1) return false;
    }

    return true;
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

    if (mood && (mood.plus.length || mood.minus.length)) {
      var has = false;
      for (var i = 0; i < mood.plus.length; i++) if (c.genres.indexOf(mood.plus[i]) > -1) has = true;
      m = has ? 1 : 0.2;
      if (mood.req && c.genres.indexOf(mood.req) < 0) m = 0;
      for (var j = 0; j < mood.minus.length; j++) if (c.genres.indexOf(mood.minus[j]) > -1) m -= 0.5;
    }

    if (ans.company === 'group') {
      var fun = false;
      for (var g = 0; g < GROUP_PLUS.length; g++) if (c.genres.indexOf(GROUP_PLUS[g]) > -1) fun = true;
      if (fun) m += 0.3;
      else if (c.genres.indexOf(18) > -1) m -= 0.3;
    }

    if (ans.company === 'couple' && c.genres.indexOf(27) > -1 && ans.mood !== 'nerves') m -= 0.1;

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
    if (parts.s >= 0.67 && it.seeds.length && it.seeds[0]) return 'Похож на «' + it.seeds[0] + '»';

    var contrib = [
      { k: 's', v: Math.max(w.s, 0.25) * parts.s }, // «Похож на» — самое понятное объяснение
      { k: 'a', v: w.a * (parts.a - 0.5) * 2 },
      { k: 'q', v: w.q * parts.q },
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
      it.score = w.q * parts.q + w.a * parts.a + w.m * parts.m + w.n * parts.n + w.s * parts.s;
      it.reason = reasonOf(it, parts, w, profile);
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
  // Конвейер
  // =========================================================================

  var running = false;

  function loading(on) {
    try {
      if (on && Lampa.Loading) Lampa.Loading.start(function () { running = false; Lampa.Loading.stop(); });
      else if (Lampa.Loading) Lampa.Loading.stop();
    } catch (e) {}
    if (on && !(window.Lampa && Lampa.Loading)) noty('Подбираю…');
  }

  function run(ans) {
    if (running) return;
    running = true;
    save('last_answers', ans);
    loading(true);

    var started = now();
    var events = collect();

    enrichEvents(events, function () {
      if (!running) return;
      var profile = buildProfile(events);

      gatherPool(profile, events, ans, function (pool) {
        if (!running) return;
        var list = prefilter(pool, events, ans);

        // Предоценка по полям списка, детали — только для топ-60
        var tmp = list.map(function (it) {
          return { it: it, c: cardCompact(it.r || {}) };
        });
        var light = tmp.map(function (x) {
          x.it.c = x.c;
          return x.it;
        });
        scoreAll(light, profile, ans);
        light.sort(function (a, b) { return b.score - a.score; });
        var top = light.slice(0, 60);

        detailsMany(top, function () {
          if (!running) return;
          var finalList = top.filter(function (it) { return postfilter(it, ans); });
          var wkey = scoreAll(finalList, profile, ans);
          jitter(finalList);

          running = false;
          loading(false);

          log('events', events.length, 'profile.n', profile.n, 'pool', Object.keys(pool).length,
            'prefiltered', list.length, 'final', finalList.length, 'ms', now() - started);

          if (!finalList.length) {
            noty('Ничего не нашлось под эти условия. Попробуйте «Неважно» по времени.');
            return;
          }
          if (profile.n < 5) noty('Истории пока мало — подбор в основном по рейтингу и настроению');

          showResults({ ans: ans, rest: finalList, shown: [], profile: profile, wkey: wkey, page: [] });
        });
      });
    });
  }

  // =========================================================================
  // Интерфейс
  // =========================================================================

  function toContent() {
    try { Lampa.Controller.toggle('content'); } catch (e) {}
  }

  function select(title, items, onSelect, onBack) {
    Lampa.Select.show({
      title: title,
      items: items,
      onSelect: function (a) {
        try { Lampa.Select.close(); } catch (e) {}
        setTimeout(function () { onSelect(a); }, 30);
      },
      onBack: function () {
        if (onBack) onBack(); else toContent();
      }
    });
  }

  var TIME_ITEMS = [
    { title: 'До 40 минут', value: '40' },
    { title: 'До 1,5 часа', value: '90' },
    { title: 'До 2 часов', value: '120' },
    { title: 'Сериал на вечер', value: 'series' },
    { title: 'Неважно', value: 'any' }
  ];

  var MOOD_ITEMS = [
    { title: 'Расслабиться', value: 'relax' },
    { title: 'Посмеяться', value: 'laugh' },
    { title: 'Пощекотать нервы', value: 'nerves' },
    { title: 'Подумать', value: 'think' },
    { title: 'Удиви меня', value: 'surprise' },
    { title: 'Неважно', value: 'any' }
  ];

  var COMPANY_ITEMS = [
    { title: 'Один', value: 'solo' },
    { title: 'Вдвоём', value: 'couple' },
    { title: 'С детьми', value: 'kids' },
    { title: 'Компанией', value: 'group' }
  ];

  function titleOf(items, v) {
    for (var i = 0; i < items.length; i++) if (items[i].value === v) return items[i].title;
    return v;
  }

  function describe(ans) {
    return [titleOf(TIME_ITEMS, ans.time), titleOf(MOOD_ITEMS, ans.mood), titleOf(COMPANY_ITEMS, ans.company)].join(' · ');
  }

  function wizard() {
    var ans = {};
    select('Сколько есть времени?', TIME_ITEMS, function (a) {
      ans.time = a.value;
      select('Какое настроение?', MOOD_ITEMS, function (b) {
        ans.mood = b.value;
        select('С кем смотрите?', COMPANY_ITEMS, function (c) {
          ans.company = c.value;
          run(ans);
        });
      });
    });
  }

  function start() {
    var last = store('last_answers', null);
    if (last && last.time) {
      select('Что посмотреть', [
        { title: 'Как в прошлый раз', subtitle: describe(last), value: 'last' },
        { title: 'Новый подбор', value: 'new' }
      ], function (a) {
        if (a.value === 'last') run(last); else wizard();
      });
    } else wizard();
  }

  function runtimeText(c) {
    if (!c.runtime) return '';
    if (c.type === 'tv') return 'серия ' + c.runtime + ' мин';
    var h = Math.floor(c.runtime / 60), m = c.runtime % 60;
    return h ? (h + ' ч ' + (m ? m + ' мин' : '')).trim() : m + ' мин';
  }

  function itemTitle(it) {
    var c = it.c;
    var rating = it.kp ? 'КП ' + it.kp.toFixed(1) : (c.va ? '★ ' + c.va.toFixed(1) : '');
    return c.title + (c.year ? ' (' + c.year + ')' : '') + (rating ? ' · ' + rating : '');
  }

  function itemSubtitle(it, debug) {
    var parts = [];
    if (it.c.type === 'tv') parts.push('Сериал');
    var rt = runtimeText(it.c);
    if (rt) parts.push(rt);
    if (it.reason) parts.push(it.reason);
    if (debug && it.parts) {
      var p = it.parts;
      parts.push('[Q' + p.q.toFixed(2) + ' A' + p.a.toFixed(2) + ' M' + p.m.toFixed(2) +
        ' N' + p.n.toFixed(2) + ' S' + p.s.toFixed(2) + ' = ' + it.score.toFixed(3) + ']');
    }
    return parts.join(' · ');
  }

  function showResults(state) {
    if (!state.page.length) state.page = nextPage(state, 5);
    var debug = isDebug();

    var items = state.page.map(function (it, i) {
      return { title: itemTitle(it), subtitle: itemSubtitle(it, debug), value: 'item', index: i };
    });

    if (state.rest.length) items.push({ title: 'Ещё варианты', value: 'more' });
    items.push({ title: 'Изменить ответы', value: 'restart' });

    select('Подборка: ' + describe(state.ans), items, function (a) {
      if (a.value === 'more') { state.page = nextPage(state, 5); showResults(state); }
      else if (a.value === 'restart') wizard();
      else itemActions(state, state.page[a.index]);
    });
  }

  function itemActions(state, it) {
    select(itemTitle(it), [
      { title: 'Открыть', value: 'open' },
      { title: 'Не то', subtitle: 'Не показывать 90 дней', value: 'reject' },
      { title: 'Уже видел', value: 'seen' },
      { title: 'Назад к подборке', value: 'back' }
    ], function (a) {
      var fb = feedback();
      if (a.value === 'open') {
        fb.opened[it.k] = { t: now(), card: miniCard(it.c) };
        saveFeedback(fb);
        openCard(it);
      } else if (a.value === 'reject' || a.value === 'seen') {
        if (a.value === 'reject') fb.rejected[it.k] = { t: now(), card: miniCard(it.c) };
        else fb.seen[it.k] = { t: now(), card: miniCard(it.c) };
        saveFeedback(fb);
        replaceInPage(state, it);
        showResults(state);
      } else showResults(state);
    }, function () { showResults(state); });
  }

  function replaceInPage(state, it) {
    var i = state.page.indexOf(it);
    if (i < 0) return;
    var repl = nextPage(state, 1);
    if (repl.length) state.page[i] = repl[0];
    else state.page.splice(i, 1);
  }

  function openCard(it) {
    var card = it.c.card || { id: it.id };
    Lampa.Activity.push({
      url: '',
      component: 'full',
      id: it.id,
      method: it.type,
      card: card,
      source: 'tmdb'
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
      item.on('hover:enter', start);
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

    console.log('[Picker] diag', report);
    tmdb('movie/27205', {}, 0, function (d) {
      console.log('[Picker] TMDB test:', d && d.id ? 'OK — ' + (d.title || d.original_title) : 'FAIL', d);
    });
    return report;
  }

  window.LampaPicker = {
    version: VERSION,
    start: start,
    run: run,
    diag: diag,
    collect: collect,
    debug: function (on) { save('debug', on !== false); return isDebug(); },
    reset: function () { save('feedback', {}); save('seen', {}); save('last_answers', null); return 'reset'; }
  };

  function init() {
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
