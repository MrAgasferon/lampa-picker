// Проверки. Каждая утверждает, как ДОЛЖНО быть, и возвращает { ok, got }.
// S* — базовое поведение (сейчас проходит, защищает от регрессий).
// F* — находки аудита (ID как в AUDIT_lampa-picker_0.10.3.md); пока не исправлены — падают
//      и перечислены в known-failures.json.
'use strict';
const fs = require('fs');
const { makeEnv, movie, card, hash, RAW } = require('./env');

const ANY = { time: 'any', mood: 'any', company: 'solo' };
const ids = list => list.map(it => it.id);
const r2 = x => Math.round(x * 100) / 100;

// Обычный мир: 8 «Нравится», 3 в истории, 40 фильмов в discover, 20 в рекомендациях
function baseWorld(extra) {
  const likes = []; for (let i = 0; i < 8; i++) likes.push(card(100 + i));
  const hist = []; for (let i = 0; i < 3; i++) hist.push(card(150 + i));
  const world = { movies: {}, discover: [], recs: [], collections: {} };
  for (let i = 0; i < 40; i++) world.discover.push(300 + i);
  for (let i = 0; i < 20; i++) world.recs.push(340 + i);
  [100, 101, 150].forEach(id => world.discover.push(id));           // уже виденное попадёт в пул
  // уже виденное и отклонённое — с высоким рейтингом, чтобы без фильтров оно точно дошло до финала
  [100, 101, 150, 300, 301].forEach(id => { world.movies[id] = movie(id, { vote_average: 9.0, vote_count: 20000 }); });
  return Object.assign({ fav: { like: likes, history: hist }, world }, extra || {});
}

// Возрастной рейтинг для синтетики
const cert = (us, ru) => {
  const out = [];
  if (us) out.push({ iso_3166_1: 'US', release_dates: [{ certification: us }] });
  if (ru) out.push({ iso_3166_1: 'RU', release_dates: [{ certification: ru }] });
  return out;
};
const certObj = (pk, us, ru) => pk.certOf('movie', { release_dates: { results: cert(us, ru) } });
const certTv = (pk, us, ru) => {
  const r = [];
  if (us) r.push({ iso_3166_1: 'US', rating: us });
  if (ru) r.push({ iso_3166_1: 'RU', rating: ru });
  return pk.certOf('tv', { content_ratings: { results: r } });
};
const item = (c) => ({ c: Object.assign({ type: 'movie', runtime: 100, vc: 5000, va: 7, genres: [18], kw: [], cast: [], dir: [], names: {}, moods: null }, c) });
const why = (pk, it, ans, profile) => pk.postReason(it, Object.assign({}, ANY, ans), profile || { n: 10, animShare: 0.2, f: {} }, true) || 'проходит';

// Мир с франшизой: часть 1 начата (не в истории), часть с 40 голосами, «Смотрю»
function franchiseEnv() {
  const likes = []; for (let i = 0; i < 6; i++) likes.push(card(100 + i));
  const world = { movies: {}, discover: [201, 202, 203], recs: [], collections: { 900: [201, 202, 203], 950: [777, 778] } };
  [201, 202, 203].forEach((id, i) => { world.movies[id] = movie(id, { coll: 900, release_date: (2001 + 2 * i) + '-01-01', vote_average: 8.2 }); });
  world.movies[777] = movie(777, { vote_count: 40, coll: 950, release_date: '1999-01-01' });
  world.movies[778] = movie(778, { coll: 950, release_date: '2004-01-01', vote_average: 8.2 });
  world.discover.push(778);
  for (let i = 0; i < 20; i++) { world.discover.push(301 + i); world.recs.push(331 + i); }
  const env = makeEnv({ fav: { like: likes, look: [card(401, { title: 'Watching now', original_title: 'Watching now', vote_average: 8.2 })] }, world });
  env.timeline[hash('Film 201')] = { percent: 30, time: 1800, duration: 6000 };
  return env;
}

// Экран «Настроить вкус» (открывается сам, когда истории нет)
async function tasteEnv(posterPath) {
  const router = function (url) {
    const m = url.match(/3\/(movie|tv)\/(top_rated|popular)\?page=(\d+)/);
    if (m) {
      const base = ({ 'movie/top_rated': 1, 'tv/top_rated': 2, 'movie/popular': 3, 'tv/popular': 4 })[m[1] + '/' + m[2]] * 100000 + (+m[3]) * 1000;
      return { body: { results: Array.from({ length: 20 }, (_, i) => ({ id: base + i, title: 'T' + (base + i), name: 'T' + (base + i),
        poster_path: posterPath || '/x.jpg', vote_count: 3000, release_date: '2010-01-01' })) } };
    }
    return { body: { results: [] } };
  };
  const env = makeEnv({ router });
  const comp = new env.pk.PickerComponent({});
  env.w.document.body.appendChild(comp.create()[0]);
  await env.clock.advance(200);
  env.pages = () => Array.from(new Set(env.log.urls.map(u => +(u.match(/page=(\d+)/) || [])[1]).filter(Boolean))).sort((a, b) => a - b);
  env.more = async () => {
    env.$('.pkr-btn').filter(function () { return env.$(this).text().indexOf('Ещё фильмы') > -1; }).eq(0).trigger('hover:enter');
    await env.clock.advance(200);
  };
  return env;
}

const CHECKS = [
  // ------------------------------------------------------------------ базовое поведение
  { id: 'S1', title: 'Синтаксис — чистый ES5 (acorn)', fn: async () => {
    try { require('acorn').parse(RAW, { ecmaVersion: 5 }); return { ok: true, got: 'ES5' }; }
    catch (e) { return { ok: false, got: e.message }; }
  } },
  { id: 'S2', title: 'Полный подбор: есть финалисты, первая страница из 5, без «Нравится» и истории', fn: async () => {
    const env = makeEnv(baseWorld());
    const r = await env.run(ANY);
    if (!r.st) return { ok: false, got: r.timedOut ? 'подбор не завершился' : 'ошибка: ' + r.error };
    const fin = ids(r.st.rest);
    const page = env.pk.nextPage(r.st, 5);
    const leaked = fin.filter(id => [100, 101, 150].indexOf(id) > -1);
    return { ok: fin.length >= 5 && page.length === 5 && !leaked.length, got: 'финал ' + fin.length + ', страница ' + page.length + ', виденное в финале: ' + (leaked.join(',') || 'нет') };
  } },
  { id: 'S3', title: '«Не то» и «Уже видел» не возвращаются в выдачу', fn: async () => {
    const env = makeEnv(baseWorld());
    const t = env.clock.now;
    env.storage.picker_feedback = { rejected: { 'movie:300': { t, r: 'meh', card: { id: 300, genre_ids: [28], method: 'movie' } } },
      seen: { 'movie:301': { t, card: { id: 301, method: 'movie' } } }, opened: {} };
    const r = await env.run(ANY);
    const fin = ids(r.st ? r.st.rest : []);
    return { ok: !!r.st && fin.indexOf(300) < 0 && fin.indexOf(301) < 0, got: '300 в финале: ' + (fin.indexOf(300) > -1) + ', 301: ' + (fin.indexOf(301) > -1) };
  } },
  { id: 'S4', title: '«С детьми»: нет ужасов и 18+', fn: async () => {
    const o = baseWorld();
    for (let i = 0; i < 6; i++) { o.world.discover.push(360 + i); o.world.movies[360 + i] = movie(360 + i, { genre_ids: [27, 28, 878], vote_average: 9.0, vote_count: 20000, cert: cert('R', '18+') }); }
    // 18+ без «ужасов» и во вкусе пользователя (дойдут до деталей): отсечь должен именно возрастной фильтр
    for (let i = 0; i < 6; i++) { o.world.discover.push(370 + i); o.world.movies[370 + i] = movie(370 + i, { genre_ids: [28, 878], vote_average: 9.0, vote_count: 20000, cert: cert('R', '18+') }); }
    const env = makeEnv(o);
    const r = await env.run({ time: 'any', mood: 'any', company: 'kids' });
    const fin = r.st ? r.st.rest : [];
    const bad = fin.filter(it => it.c.genres.indexOf(27) > -1 || env.pk.adultRated(it.c));
    const d = (r.st && r.st.journal && r.st.journal.dropped) || {};
    const cut = (d.kids_cert || 0) + (d.kids_genre || 0);
    return { ok: !!r.st && fin.length > 0 && !bad.length && cut > 0, got: 'финал ' + fin.length + ', неподходящих: ' + bad.length + ', отсеяно по возрасту/жанру: ' + cut };
  } },
  { id: 'S5', title: '«До 1,5 часа»: только фильмы не длиннее 100 мин', fn: async () => {
    const o = baseWorld();
    for (let i = 0; i < 6; i++) o.world.movies[320 + i] = movie(320 + i, { runtime: 150, vote_average: 9.0, vote_count: 20000 });
    const env = makeEnv(o);
    const r = await env.run({ time: '90', mood: 'any', company: 'solo' });
    const bad = (r.st ? r.st.rest : []).filter(it => it.c.type !== 'movie' || !(it.c.runtime <= 100));
    const cut = ((r.st && r.st.journal && r.st.journal.dropped) || {}).too_long || 0;
    return { ok: !!r.st && r.st.rest.length > 0 && !bad.length && cut > 0, got: 'финал ' + (r.st ? r.st.rest.length : 0) + ', не по времени: ' + bad.length + ', отсеяно too_long: ' + cut };
  } },
  { id: 'S6', title: 'Одна франшиза — одна карточка', fn: async () => {
    const o = baseWorld();
    o.world.collections[950] = [380, 381, 382];
    [380, 381, 382].forEach((id, i) => { o.world.movies[id] = movie(id, { coll: 950, release_date: (2001 + i) + '-01-01', vote_average: 8.6 }); o.world.discover.push(id); });
    const env = makeEnv(o);
    const r = await env.run(ANY);
    const n = (r.st ? r.st.rest : []).filter(it => it.c.coll === 950).length;
    return { ok: !!r.st && n <= 1, got: 'карточек из коллекции: ' + n };
  } },
  { id: 'S7', title: 'Журнал: сессия записана, «Последний подбор» — JSON до 3900 символов', fn: async () => {
    const env = makeEnv(baseWorld());
    await env.run(ANY);
    const J = env.pk.Journal;
    if (!J) return { ok: false, got: 'Journal не найден' };
    const txt = J.exportLast();
    let parsed = false; try { JSON.parse(txt); parsed = true; } catch (e) {}
    return { ok: J.list().length >= 1 && parsed && txt.length <= 3900, got: 'сессий ' + J.list().length + ', длина ' + txt.length + ', JSON ' + parsed };
  } },
  { id: 'S8', title: 'Холодный старт без истории: подбор работает, флаг cold', fn: async () => {
    const o = baseWorld(); o.fav = {};
    const env = makeEnv(o);
    const r = await env.run(ANY);
    return { ok: !!r.st && r.st.cold === true && r.st.rest.length > 0, got: r.st ? 'cold ' + r.st.cold + ', финал ' + r.st.rest.length : 'нет результата' };
  } },

  // ------------------------------------------------------------------ находки аудита
  { id: 'F1', title: 'Первый запуск: старые «Нравится» не считаются «пачкой»', fn: async () => {
    const likes = []; for (let i = 0; i < 12; i++) likes.push(card(100 + i));
    const hist = []; for (let i = 0; i < 40; i++) hist.push(card(500 + i, { genre_ids: [18] }));
    const env = makeEnv({ fav: { like: likes, history: hist } });
    const { events } = await env.profile();
    const l = events.filter(e => e.flags.like);
    const batch = l.filter(e => e.batch).length;
    return { ok: batch === 0 && l.every(e => e.s === 1), got: 'пачкой помечено ' + batch + ' из ' + l.length + ', вес лайка ' + l[0].s };
  } },
  { id: 'F2', title: 'Кеш деталей одного фильма меньше 10 КБ', fn: async () => {
    const cast = Array.from({ length: 60 }, (_, i) => ({ adult: false, gender: 2, id: 10000 + i, known_for_department: 'Acting', name: 'Actor Name ' + i, original_name: 'Actor Name ' + i, popularity: 12.3, profile_path: '/abcdefghijklmnopqrstuvwx' + i + '.jpg', cast_id: i, character: 'Character ' + i, credit_id: '52fe4250c3a36847f80149f' + i, order: i }));
    const crew = Array.from({ length: 300 }, (_, i) => ({ adult: false, gender: 1, id: 20000 + i, known_for_department: 'Production', name: 'Crew Person ' + i, original_name: 'Crew Person ' + i, popularity: 1.2, profile_path: null, credit_id: '52fe4250c3a36847f8014a' + i, department: 'Production', job: i === 0 ? 'Director' : 'Producer' }));
    const env = makeEnv({ world: { movies: { 42: movie(42, { credits: { cast, crew } }) } } });
    await env.cb(cb => env.pk.details('movie', 42, cb));
    let bytes = 0;
    Object.keys(env.pk.Cache.mem).forEach(k => { bytes += JSON.stringify(env.pk.Cache.mem[k]).length; });
    return { ok: bytes < 10000, got: 'в кеше ' + bytes + ' байт' };
  } },
  { id: 'F3a', title: 'indexedDB.open без ответа: подбор всё равно завершается', fn: async () => {
    const o = baseWorld(); o.idb = { open() { return {}; } };
    const env = makeEnv(o);
    const r = await env.run(ANY, 120000);
    return { ok: !r.timedOut, got: r.timedOut ? 'висит на «' + r.stages.slice(-1)[0] + '», запросов ' + env.log.urls.length : (r.error ? 'ошибка показана' : 'финал ' + r.st.rest.length) };
  } },
  { id: 'F3b', title: 'Зависшие запросы TMDB не блокируют очередь навсегда', fn: async () => {
    const env = makeEnv({ router: (url, p, def) => (url.indexOf('/hang') > -1 ? { hang: true } : def(url)) });
    for (let i = 0; i < 4; i++) env.pk.tmdb('movie/hang' + i, {}, 1000, () => {});
    const res = await env.cb(cb => env.pk.tmdb('movie/5', {}, 1000, cb), 120000);
    return { ok: !!res, got: res ? 'пятый запрос выполнен' : 'пятый запрос не выполнен за 120 с (занято слотов ' + env.pk.Net.active + ')' };
  } },
  { id: 'F4a', title: '«С детьми»: RU 12+ / US R отсекается', fn: async () => {
    const { pk } = makeEnv();
    const got = why(pk, item({ cert: certObj(pk, 'R', '12+') }), { company: 'kids' });
    return { ok: got !== 'проходит', got };
  } },
  { id: 'F4b', title: '«С детьми»: US PG-13 без RU — проходит с подтверждением КП ≤ 12, без него — нет', fn: async () => {
    const { pk } = makeEnv();
    const confirmed = why(pk, item({ cert: certObj(pk, 'PG-13', null), kpAge: 12 }), { company: 'kids' });
    const unconfirmed = why(pk, item({ cert: certObj(pk, 'PG-13', null) }), { company: 'kids' });
    const pg = why(pk, item({ cert: certObj(pk, 'PG', null) }), { company: 'kids' });
    return { ok: confirmed === 'проходит' && unconfirmed !== 'проходит' && pg === 'проходит',
      got: 'КП 12+: ' + confirmed + '; без КП: ' + unconfirmed + '; PG без КП: ' + pg };
  } },
  { id: 'F4c', title: '«С детьми»: сериал TV-Y7-FV допускается', fn: async () => {
    const { pk } = makeEnv();
    const got = why(pk, item({ type: 'tv', runtime: 22, genres: [16], cert: certTv(pk, 'TV-Y7-FV', null) }), { company: 'kids' });
    return { ok: got === 'проходит', got };
  } },
  { id: 'F4d', title: '«С детьми»: семейное выше триллера 12+ даже у любителя триллеров', fn: async () => {
    const likes = []; const movies = {};
    for (let i = 0; i < 10; i++) { likes.push(card(100 + i, { genre_ids: [53, 80, 9648] })); movies[100 + i] = movie(100 + i, { genre_ids: [53, 80, 9648] }); }
    const env = makeEnv({ fav: { like: likes }, world: { movies } });
    const { profile } = await env.profile();
    const mk = (id, genres, c) => ({ k: 'movie:' + id, id, type: 'movie', seedHits: 0, seeds: [], wath: false, src: 'disc',
      c: { id, type: 'movie', title: 'X' + id, year: '2016', genres, kw: [], cast: [], dir: [], names: {}, lang: 'en', va: 7.5, vc: 8000, runtime: 100, cert: c, moods: null, coll: null, card: {} } });
    const ans = { time: 'any', mood: 'any', company: 'kids' };
    const items = [mk(1, [53, 9648, 80], certObj(env.pk, 'PG-13', '12+')), mk(2, [16, 10751, 12], certObj(env.pk, 'PG', '6+')), mk(3, [10751, 35, 12], certObj(env.pk, 'G', '0+'))];
    env.pk.scoreAll(items, profile, ans);
    const thr = items[0].score, fam = Math.max(items[1].score, items[2].score);
    return { ok: fam > thr, got: 'триллер ' + r2(thr) + ', лучшее семейное ' + r2(fam) };
  } },
  { id: 'F4e', title: '«С детьми»: PG-13 в TMDB, но 18+ на Кинопоиске — отсекается', fn: async () => {
    const o = baseWorld();
    o.world.movies[300] = movie(300, { genre_ids: [35, 10749], vote_average: 9.5, vote_count: 30000, cert: cert('PG-13', null) });
    const router = (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) {
        const im = url.match(/imdbId=tt(\d+)/);
        if (im) return { body: { items: [{ kinopoiskId: 5000000 + +im[1], ratingKinopoisk: 7.5, ratingImdb: 7.2 }] } };
        const byId = url.match(/films\/(\d+)$/);
        if (byId) return { body: { kinopoiskId: +byId[1], ratingKinopoisk: 7.5, ratingImdb: 7.2, ratingAgeLimits: +byId[1] === 5000300 ? 'age18' : 'age6' } };
      }
      return def(url);
    };
    const env = makeEnv(Object.assign(o, { kp: true, router }));
    const r = await env.run({ time: 'any', mood: 'any', company: 'kids' });
    const fin = r.st ? r.st.rest : [];
    const x = fin.find(it => it.id === 300);
    const d = (r.st && r.st.journal && r.st.journal.dropped) || {};
    return { ok: !!r.st && fin.length > 0 && !x, got: x ? 'в финале (KP возраст ' + x.c.kpAge + ')' : 'отсеян, kids_kp_age ' + (d.kids_kp_age || 0) + ', финал ' + fin.length };
  } },
  { id: 'F4f', title: '«С детьми»: PG-13 без RU — с КП 12+ остаётся, без КП отсекается', fn: async () => {
    const mk = (kp, ageStr) => {
      const o = baseWorld();
      o.world.movies[300] = movie(300, { genre_ids: [35, 10749], vote_average: 9.5, vote_count: 30000, cert: cert('PG-13', null) });
      const router = (url, p, def) => {
        if (url.indexOf('kinopoiskapiunofficial') > -1) {
          const im = url.match(/imdbId=tt(\d+)/);
          if (im) return { body: { items: [{ kinopoiskId: 5000000 + +im[1], ratingKinopoisk: 7.5, ratingImdb: 7.2 }] } };
          const byId = url.match(/films\/(\d+)$/);
          if (byId) return { body: { kinopoiskId: +byId[1], ratingKinopoisk: 7.5, ratingImdb: 7.2, ratingAgeLimits: ageStr } };
        }
        return def(url);
      };
      return makeEnv(Object.assign(o, { kp, router }));
    };
    const ans = { time: 'any', mood: 'any', company: 'kids' };
    const r1 = await mk(true, 'age12').run(ans);
    const r2 = await mk(false, 'age12').run(ans);
    const in1 = !!(r1.st && r1.st.rest.find(it => it.id === 300));
    const in2 = !!(r2.st && r2.st.rest.find(it => it.id === 300));
    return { ok: in1 && !in2, got: 'КП 12+: ' + (in1 ? 'в финале' : 'нет') + '; КП недоступен: ' + (in2 ? 'в финале' : 'нет') };
  } },
  { id: 'F4g', title: '«С детьми»: франшиза начинается с первой части, если она подходит детям; иначе — лучшая проверенная', fn: async () => {
    const mk = (firstCert) => {
      const o = baseWorld();
      o.world.collections[960] = [390, 391, 392];
      o.world.movies[390] = movie(390, { coll: 960, release_date: '1995-01-01', genre_ids: [16, 10751, 35], vote_average: 8.3, vote_count: 20000, cert: firstCert });
      o.world.movies[391] = movie(391, { coll: 960, release_date: '2010-01-01', genre_ids: [16, 10751, 35], vote_average: 7.9, vote_count: 20000, cert: cert('G', '0+') });
      o.world.movies[392] = movie(392, { coll: 960, release_date: '2019-01-01', genre_ids: [16, 10751, 35], vote_average: 9.5, vote_count: 20000, cert: cert('G', '6+') });
      o.world.discover.push(392);
      return makeEnv(o);
    };
    const ans = { time: 'any', mood: 'any', company: 'kids' };
    const pick = r => ((r.st ? r.st.rest : []).filter(it => it.c.coll === 960).map(it => it.id)).join(',') || 'нет';
    const ok1 = pick(await mk(cert('G', '0+')).run(ans));
    const ok2 = pick(await mk(cert('PG-13', null)).run(ans));   // первая часть без подтверждения — не детям
    return { ok: ok1 === '390' && ok2 === '392', got: 'первая подходит: ' + ok1 + '; первая не подтверждена: ' + ok2 };
  } },
  { id: 'F5', title: '«Смотрю» не предлагается (тем более как «Позже»)', fn: async () => {
    const env = franchiseEnv();
    const r = await env.run(ANY);
    const x = (r.st ? r.st.rest : []).find(it => it.id === 401);
    return { ok: !!r.st && !x, got: x ? 'в финале, причина «' + x.reason + '»' : 'не предлагается' };
  } },
  { id: 'F6a', title: 'Франшиза не возвращает начатую часть', fn: async () => {
    const env = franchiseEnv();
    const r = await env.run(ANY);
    const x = (r.st ? r.st.rest : []).find(it => it.id === 201);
    return { ok: !!r.st && !x, got: x ? 'начатая часть в финале (src ' + x.src + ')' : 'нет' };
  } },
  { id: 'F6b', title: 'Франшиза не добавляет фильм ниже порога голосов', fn: async () => {
    const env = franchiseEnv();
    const r = await env.run(ANY);
    const x = (r.st ? r.st.rest : []).find(it => it.id === 777);
    return { ok: !!r.st && !x, got: x ? 'фильм с 40 голосами в финале (src ' + x.src + ')' : 'нет' };
  } },
  { id: 'F7a', title: '«Один»: семейный мультфильм 6+ не отсекается у любителя анимации', fn: async () => {
    const { pk } = makeEnv();
    const got = why(pk, item({ genres: [16, 10751], cert: certObj(pk, 'PG', '6+') }), { company: 'solo' }, { n: 20, animShare: 0.6, f: {} });
    return { ok: got === 'проходит', got };
  } },
  { id: 'F7b', title: '«Один»: комедия RU 0+ (не детская) не отсекается', fn: async () => {
    const { pk } = makeEnv();
    const got = why(pk, item({ genres: [35], cert: certObj(pk, null, '0+') }), { company: 'solo' });
    return { ok: got === 'проходит', got };
  } },
  { id: 'F8', title: 'Три «Не мой жанр» по фильмам с драмой не делают драму «нелюбимой»', fn: async () => {
    const likes = []; for (let i = 0; i < 12; i++) likes.push(card(100 + i));
    const env = makeEnv({ fav: { like: likes } });
    const t = env.clock.now, rej = {};
    [[18, 27], [18, 10752], [18, 53]].forEach((g, i) => { rej['movie:' + (900 + i)] = { t, r: 'genre', card: { id: 900 + i, genre_ids: g, method: 'movie' } }; });
    env.storage.picker_feedback = { rejected: rej, seen: {}, opened: {} };
    const { profile } = await env.profile();
    const d = (profile.f.genre || {})[18] || 0;
    return { ok: d > -0.6, got: 'вес драмы ' + r2(d) };
  } },
  { id: 'F8b', title: '«Не мой жанр» по-прежнему учится: три отказа на ужасах опускают ужасы', fn: async () => {
    const likes = []; for (let i = 0; i < 12; i++) likes.push(card(100 + i));
    const env = makeEnv({ fav: { like: likes } });
    const t = env.clock.now, rej = {};
    [[27], [27, 53], [18, 27]].forEach((g, i) => { rej['movie:' + (910 + i)] = { t, r: 'genre', card: { id: 910 + i, genre_ids: g, method: 'movie' } }; });
    env.storage.picker_feedback = { rejected: rej, seen: {}, opened: {} };
    const { profile } = await env.profile();
    const h = (profile.f.genre || {})[27] || 0, d = (profile.f.genre || {})[18] || 0;
    return { ok: h <= -0.6 && d > -0.3, got: 'ужасы ' + r2(h) + ', драма ' + r2(d) + ', rejGenres ' + JSON.stringify(profile.rejGenres) };
  } },
  { id: 'F9', title: 'Дедлайн старого подбора не выбрасывает задания КП нового', fn: async () => {
    const router = (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) {
        const id = +((url.match(/imdbId=tt(\d+)/) || [])[1] || 0);
        return { delay: id < 2000 ? 4000 : 300, body: { items: [{ ratingKinopoisk: 7.5, ratingImdb: 7.2, kinopoiskId: id }] } };
      }
      return def(url);
    };
    const env = makeEnv({ kp: true, router });
    const mk = (base, n) => Array.from({ length: n }, (_, i) => ({ k: 'movie:' + (base + i), id: base + i, type: 'movie', score: 1 - i / 100,
      c: { id: base + i, va: 7, vc: 5000, imdb: 'tt' + (base + i), title: 'F' } }));
    const A = mk(1000, 6), B = mk(3000, 20);
    const qB = () => (env.pk.KpNet.queue || []).filter(j => /imdbId=tt3\d{3}/.test(j.url || '')).length;
    env.pk.attachRatings(A, () => {});
    await env.clock.advance(1000);
    env.pk.attachRatings(B, () => {});
    await env.clock.advance(3950);                       // t = 4,95 с
    const before = qB();
    await env.clock.advance(150);                        // t = 5,1 с — сработал дедлайн A
    const after = qB();
    return { ok: before > 0 && after === before, got: 'заданий B в очереди: до дедлайна A ' + before + ', после ' + after };
  } },
  { id: 'F10', title: '429 от КП не блокирует ключ до конца суток', fn: async () => {
    const env = makeEnv({ kp: true, router: (url, p, def) => (url.indexOf('kinopoisk') > -1 ? { status: 429 } : def(url)) });
    await env.cb(cb => env.pk.fetchRatings({ k: 'movie:1', c: { id: 1, imdb: 'tt1', title: 'X', va: 7 } }, cb));
    const b = env.pk.kpQuota().blocked;
    return { ok: !b, got: 'blocked = ' + b };
  } },
  { id: 'F11', title: 'TMDB недоступен: подбор сообщает о сети, а не «ничего не нашлось»', fn: async () => {
    const env = makeEnv({ fav: { wath: [card(5)], like: [card(1)] }, router: () => ({ status: 0 }) });
    const r = await env.run({ time: '90', mood: 'relax', company: 'solo' });
    const flagged = !!(r.error || (r.st && (r.st.netError || r.st.netFail || r.st.offline)));
    return { ok: flagged, got: r.error ? 'error: ' + r.error : (r.st ? 'done, финал ' + r.st.rest.length + ', отсев ' + JSON.stringify(r.st.journal && r.st.journal.dropped) : 'нет результата') };
  } },
  { id: 'F12a', title: 'Язык данных TMDB берётся из tmdb_lang', fn: async () => {
    const { pk } = makeEnv({ storage: { language: 'ru', tmdb_lang: 'uk' } });
    const lang = (pk.tmdbUrl('movie/1', {}).match(/language=([^&]+)/) || [])[1];
    return { ok: lang === 'uk', got: 'language=' + lang };
  } },
  { id: 'F12b', title: 'Смена языка TMDB не отдаёт кеш на старом языке', fn: async () => {
    const env = makeEnv({ storage: { language: 'ru', tmdb_lang: 'ru' } });
    await env.cb(cb => env.pk.tmdb('movie/7', {}, 86400000, cb));
    env.storage.tmdb_lang = 'uk'; env.storage.language = 'uk';
    await env.cb(cb => env.pk.tmdb('movie/7', {}, 86400000, cb));
    const n = env.log.urls.filter(u => u.indexOf('/3/movie/7?') > -1).length;
    return { ok: n === 2, got: 'сетевых запросов ' + n + ' (второй ответ ' + (n === 2 ? 'из сети' : 'из кеша') + ')' };
  } },
  { id: 'F15', title: 'Начатое вчера (10 %) не даёт минус к вкусу', fn: async () => {
    const env = makeEnv({ fav: { history: [card(55)] } });
    env.timeline[hash('Film 55')] = { percent: 10, time: 600, duration: 6000, updated: env.clock.now - 86400000 };
    const ev = env.pk.collect();
    return { ok: ev[0].s >= 0, got: 'сигнал ' + ev[0].s };
  } },
  { id: 'F16', title: 'Пять отказов у нового пользователя — всё ещё холодный старт', fn: async () => {
    const env = makeEnv();
    const t = env.clock.now, rej = {};
    for (let i = 0; i < 5; i++) rej['movie:' + (70 + i)] = { t, r: 'meh', card: { id: 70 + i, genre_ids: [35], method: 'movie' } };
    env.storage.picker_feedback = { rejected: rej, seen: {}, opened: {} };
    const { profile } = await env.profile();
    const key = env.pk.pickWeights({ mood: 'relax', company: 'solo' }, profile).key;
    return { ok: key === 'cold', got: 'веса ' + key + ', profile.n ' + profile.n };
  } },
  { id: 'F17a', title: 'Durable: запись во время загрузки не теряется', fn: async () => {
    const env = makeEnv({ idb: 'fake', idbDelay: 50 });
    env.pk.Durable.load('kpmap', {});
    env.pk.Durable.set('kpmap', { 'movie:1': { kp: 8 } });
    await env.clock.advance(3000);
    const v = env.pk.Durable.get('kpmap', {});
    return { ok: !!v['movie:1'], got: JSON.stringify(v) };
  } },
  { id: 'F17b', title: 'Durable: «Очистить», пока журнал читается из IndexedDB, не откатывается', fn: async () => {
    const env = makeEnv({ idb: 'fake', idbDelay: 50, idbData: { 'durable:journal': { t: 1, v: [{ id: 'old1' }, { id: 'old2' }] } } });
    await env.cb(cb => env.pk.Cache.init(cb));           // база уже открыта, как после старта Lampa
    env.pk.Durable.load('journal', []);                  // чтение журнала из IndexedDB в полёте…
    env.pk.Journal.clear();                              // …и в этот момент «Очистить»
    await env.clock.advance(3000);
    const v = env.pk.Durable.get('journal', null);
    return { ok: Array.isArray(v) && v.length === 0, got: JSON.stringify(v) };
  } },
  { id: 'F18', title: 'ratingOffsets: одно наблюдение считается один раз', fn: async () => {
    const env = makeEnv();
    env.pk.Durable.vals.kpmap = { 'movie:1': { kp: 8, imdb: 7.5, va: 7, t: env.clock.now } };
    const off = env.pk.ratingOffsets([{ k: 'movie:1', c: { va: 7 }, rt: { kp: 8, imdb: 7.5, src: 'cache' } }]);
    return { ok: off.n === 1, got: 'наблюдений ' + off.n };
  } },
  { id: 'F19', title: '«Настроить вкус» запрашивает вторую страницу', fn: async () => {
    const env = await tasteEnv();
    for (let i = 0; i < 4; i++) await env.more();
    const p = env.pages();
    return { ok: p.indexOf(2) > -1, got: 'страницы ' + p.join(', ') };
  } },
  { id: 'F21', title: 'CUB: статус кроме completed/empty не кешируется на неделю', fn: async () => {
    let calls = 0;
    const env = makeEnv({ cub: true, router: (url, p, def) => {
      if (url.indexOf('cub.test') > -1) { calls++; return { body: calls === 1 ? { status: 'processing' } : { status: 'completed', review: [{ name: 'humor', avg: 7 }] } }; }
      return def(url);
    } });
    await env.cb(cb => env.pk.cubMeta(603, cb));
    await env.clock.advance(3600e3);
    const res = await env.cb(cb => env.pk.cubMeta(603, cb));
    return { ok: calls === 2, got: 'запросов к CUB ' + calls + ', шкалы ' + JSON.stringify(res && res[0]) };
  } },
  { id: 'F22', title: 'Сериал: длительность серии — медиана, а не минимум', fn: async () => {
    const { pk } = makeEnv();
    const c = pk.compact('tv', { id: 1, name: 'S', original_name: 'S', episode_run_time: [25, 40, 55], first_air_date: '2015-01-01', genres: [] });
    return { ok: c.runtime === 40, got: 'runtime ' + c.runtime };
  } },
  { id: 'F23', title: 'reset() не стирает даты первого знакомства (picker_seen)', fn: async () => {
    const env = makeEnv({ storage: { picker_seen: { 'movie:1': 1700000000000 } } });
    env.w.LampaPicker.reset();
    const s = env.storage.picker_seen;
    return { ok: !!(s && s['movie:1']), got: JSON.stringify(s) };
  } },
  { id: 'F15b', title: 'Начатое на 10 % месяц назад — всё ещё «брошено» (−0,5)', fn: async () => {
    const env = makeEnv({ fav: { history: [card(55)] } });
    const t = env.clock.now;
    env.storage.picker_seen_init = t - 60 * 86400000;
    env.storage.picker_seen = { 'movie:55': t - 30 * 86400000 };
    env.timeline[hash('Film 55')] = { percent: 10, time: 600, duration: 6000 };
    const ev = env.pk.collect();
    return { ok: ev[0].s === -0.5, got: 'сигнал ' + ev[0].s };
  } },
  { id: 'F17c', title: 'Durable: запись в журнал во время загрузки дописывается к прочитанному', fn: async () => {
    const env = makeEnv({ idb: 'fake', idbDelay: 50, idbData: { 'durable:journal': { t: 1, v: [{ id: 'old1' }] } } });
    await env.cb(cb => env.pk.Cache.init(cb));
    env.pk.Durable.load('journal', []);
    env.pk.Durable.set('journal', [{ id: 'new1' }]);
    await env.clock.advance(3000);
    const v = env.pk.Durable.get('journal', []);
    return { ok: v.length === 2 && v[0].id === 'old1' && v[1].id === 'new1', got: JSON.stringify(v) };
  } },
  { id: 'F19b', title: '«Настроить вкус»: страницы кончились — «Ещё фильмы» пропадает', fn: async () => {
    const env = await tasteEnv();
    const btn = () => env.$('.pkr-btn').filter(function () { return env.$(this).text().indexOf('Ещё фильмы') > -1; }).length;
    let clicks = 0;
    while (btn() && clicks < 40) { await env.more(); clicks++; }
    const p = env.pages();
    return { ok: !btn() && Math.max.apply(null, p) === 5, got: 'нажатий ' + clicks + ', кнопок ' + btn() + ', страницы ' + p.join(',') };
  } },
  { id: 'F21b', title: 'CUB: без шкал страха и насилия «Расслабиться» решают жанры, а не нули', fn: async () => {
    const { pk } = makeEnv();
    const m = pk.moodFromScales({ moods: { humor: 7 } }, { mood: 'relax', company: 'solo' });
    return { ok: m === null, got: 'оценка по шкалам ' + m };
  } },
  { id: 'F23b', title: 'picker_seen: даты пропавших из списков карточек вычищаются (не позже чем через 31 день)', fn: async () => {
    // Сразу или с отсрочкой — решает код (см. N3: смена профиля CUB не должна стирать даты в тот же день)
    const likes = []; for (let i = 0; i < 30; i++) likes.push(card(100 + i));
    const seen = {}; for (let i = 0; i < 300; i++) seen['movie:' + (5000 + i)] = 1700000000000;
    const env = makeEnv({ fav: { like: likes }, storage: { picker_seen: seen, picker_seen_init: 1700000000000 } });
    env.pk.collect();
    await env.clock.advance(31 * 864e5);
    env.pk.collect();
    const n = Object.keys(env.storage.picker_seen).length;
    return { ok: n === 30, got: 'дат в picker_seen: ' + n };
  } },
  { id: 'F23c', title: 'picker_seen: пустые списки (не загрузились) даты не стирают', fn: async () => {
    const seen = {}; for (let i = 0; i < 300; i++) seen['movie:' + (5000 + i)] = 1700000000000;
    const env = makeEnv({ storage: { picker_seen: seen, picker_seen_init: 1700000000000 } });
    env.pk.collect();
    const n = Object.keys(env.storage.picker_seen).length;
    return { ok: n === 300, got: 'дат в picker_seen: ' + n };
  } },
  { id: 'F26', title: 'Причина не зависит от того, какой источник ответил первым', fn: async () => {
    const { pk } = makeEnv();
    const it = { k: 'movie:1', c: { type: 'movie', dir: [], cast: [5], names: { p5: 'Энн Хэтэуэй' } }, src: 'disc', srcs: { disc: true, ppl: true }, seedHits: 0, seeds: [] };
    const profile = { f: { cast: { 5: 1 }, director: {}, genre: {} }, names: {} };
    const r = pk.reasonOf(it, { best: null, rb: 0, s: 0, a: 0.5, q: 0.5, n: 0 }, { q: 0.3, a: 0.35, m: 0.2, n: 0.05, s: 0.1 }, profile, { mood: 'any', company: 'solo' });
    return { ok: r === 'С Энн Хэтэуэй', got: r };
  } },
  { id: 'F24', title: 'Кеш kp_rating (ключ без типа) не применяется к сериалам', fn: async () => {
    const env = makeEnv({ storage: { kp_rating: { 5: { kp: 8.1, imdb: 7.9 } } } });
    const r = env.pk.cachedRatings({ id: 5, type: 'tv' }, 'tv:5');
    return { ok: !r, got: r ? 'взят рейтинг ' + JSON.stringify(r) : 'не взят' };
  } },
  { id: 'F25', title: 'Поиск КП по названию учитывает тип (фильм ≠ сериал)', fn: async () => {
    const env = makeEnv({ kp: true, router: (url, p, def) => {
      if (url.indexOf('search-by-keyword') > -1) return { body: { films: [{ filmId: 1, year: '2015', type: 'TV_SERIES' }, { filmId: 2, year: '2015', type: 'FILM' }] } };
      const m = url.match(/api\/v2\.2\/films\/(\d+)$/);
      if (m) return { body: { ratingKinopoisk: m[1] === '2' ? 7.7 : 5.5, ratingImdb: 7.0 } };
      return def(url);
    } });
    const res = await env.cb(cb => env.pk.fetchRatings({ k: 'movie:77', c: { id: 77, title: 'Same', original: 'Same', year: '2015', va: 7, imdb: null, type: 'movie' } }, cb));
    const kp = res && res[0] && res[0].kp;
    return { ok: kp === 7.7, got: 'КП ' + kp + (kp === 5.5 ? ' (взят сериал)' : '') };
  } },
  // ------------------------------------------------------------------ модель выдачи (P2, блок 2)
  { id: 'M25', title: 'Разброс оценки привязан к фильму, а не к месту в списке', fn: async () => {
    const { pk } = makeEnv();
    const mk = (k, score) => ({ k, score });
    const a = [mk('movie:1', 0.9), mk('movie:2', 0.8), mk('movie:3', 0.7)];
    const b = [mk('movie:9', 0.95), mk('movie:3', 0.85), mk('movie:1', 0.5)];
    pk.jitter(a); pk.jitter(b);
    const ja = a.find(x => x.k === 'movie:3').jmul, jb = b.find(x => x.k === 'movie:3').jmul;
    return { ok: ja === jb && ja >= 0.92 && ja <= 1.08, got: 'movie:3: ' + ja + ' и ' + jb };
  } },
  { id: 'M27a', title: 'Показанное сегодня при новом подборе идёт с ×0,85', fn: async () => {
    const env = makeEnv(baseWorld());
    const r1 = await env.run(ANY);
    const comp = r1.st;
    const page1 = env.pk.nextPage({ rest: comp.rest.slice(), shown: [] }, 5).map(x => x.k);
    env.storage.picker_shown_day = { d: env.pk.todaySeed(), k: Object.fromEntries(page1.map(k => [k, 1])) };
    const r2 = await env.run(ANY);
    const pen = r2.st.rest.filter(x => page1.indexOf(x.k) > -1).map(x => x.rp);
    const other = r2.st.rest.filter(x => page1.indexOf(x.k) < 0).every(x => x.rp === 1);
    return { ok: pen.length > 0 && pen.every(v => v === 0.85) && other, got: 'штрафов ' + pen.join(',') + ', остальные без штрафа: ' + other };
  } },
  { id: 'M27b', title: 'Вчерашние показы не штрафуются', fn: async () => {
    const env = makeEnv(baseWorld());
    env.storage.picker_shown_day = { d: 19990101, k: { 'movie:300': 1, 'movie:302': 1 } };
    const r = await env.run(ANY);
    const bad = r.st.rest.filter(x => x.rp !== 1).length;
    return { ok: bad === 0, got: 'со штрафом ' + bad };
  } },
  { id: 'M28', title: 'Нелюбимый жанр: штраф плавный (−0,3 → ×1, −0,59 → ×0,87…0,9, −0,9 → ×0,6)', fn: async () => {
    const { pk } = makeEnv();
    const d = g => pk.dislikeMult([27], { f: { genre: { 27: g } } });
    const raw = [d(-0.3), d(-0.59), d(-0.61), d(-0.9), d(-1)], v = raw.map(r2);
    const ok = v[0] === 1 && raw[1] > 0.85 && raw[1] < 0.9 && Math.abs(raw[1] - raw[2]) < 0.03 && v[3] === 0.6 && v[4] === 0.6;
    return { ok, got: v.join(' · ') };
  } },
  { id: 'M28b', title: 'Нелюбимый жанр — только с настоящим минусом: один открытый ТВ-фильм в положительной истории штрафа не даёт, три «Не то» — дают', fn: async () => {
    const { pk } = makeEnv();
    const now = Date.now();
    const ev = (s, genres, i) => ({ k: 'movie:' + i, s, date: now - i * 86400000, c: { id: i, type: 'movie', genres, year: '2015', lang: 'en' } });
    const base = [];
    for (let i = 1; i <= 30; i++) base.push(ev(1, i % 2 ? [18, 878] : [18, 35], i));
    // ТВ-фильм (10770): один открытый из подборки, +0,5
    const p1 = pk.buildProfile(base.concat([ev(0.5, [10770, 80], 100)]));
    // Ужасы (27): три отказа «Не то» (−0,2) и ни одного лайка
    const p2 = pk.buildProfile(base.concat([ev(-0.2, [27], 101), ev(-0.2, [27, 53], 102), ev(-0.2, [27], 103)]));
    const tvW = p1.f.genre[10770], tvD = pk.dislikeMult([10770, 80], p1), hD = pk.dislikeMult([27], p2);
    const ok = tvW < -0.45 && tvD === 1 && !p1.gneg[10770] && !!p2.gneg[27] && hD < 0.8;
    return { ok, got: 'ТВ-фильм: вес ' + tvW.toFixed(2) + ', штраф ×' + tvD.toFixed(2) + '; ужасы после трёх «Не то»: ×' + hD.toFixed(2) };
  } },
  { id: 'P10b', title: 'Причины: «Что-то новое» называет редкий в истории жанр, хотя после центрирования у него минус; любимый — нет', fn: async () => {
    const { pk } = makeEnv();
    const now = Date.now();
    const ev = (s, genres, i) => ({ k: 'movie:' + i, s, date: now - i * 86400000, c: { id: i, type: 'movie', genres, year: '2015', lang: 'en' } });
    const evs = [];
    for (let i = 1; i <= 30; i++) evs.push(ev(1, i % 2 ? [18, 878] : [18, 35], i));
    evs.push(ev(0.5, [37], 100));                               // вестерн — один раз
    const prof = pk.buildProfile(evs); prof.recentGenres = [];
    const w = { q: 0.3, a: 0.35, m: 0.2, n: 0.05, s: 0.1 }, ans = { mood: 'think', company: 'solo' };
    const mk = (id, genres) => ({ k: 'movie:' + id, c: { type: 'movie', title: 'W', genres, va: 6.5, vc: 800, dir: [], cast: [], names: {} }, src: 'disc', srcs: { disc: true }, seedHits: 0, seeds: [] });
    const a = pk.reasonOf(mk(500, [37]), { best: 'n', rb: 0, s: 0, a: 0.3, q: 0.3, n: 0.8, m: 0.2, r: 6.5 }, w, prof, ans);
    const b = pk.reasonOf(mk(501, [18]), { best: 'n', rb: 0, s: 0, a: 0.3, q: 0.3, n: 0.8, m: 0.2, r: 6.5 }, w, prof, ans);
    const ok = /^Что-то новое: вестерн/.test(a) && !/^Что-то новое/.test(b);
    return { ok, got: 'вестерн (вес ' + prof.f.genre[37].toFixed(2) + '): «' + a + '»; драма: «' + b + '»' };
  } },
  { id: 'M29', title: 'Теневая формула пишет свою пятёрку в журнал, выдача не меняется', fn: async () => {
    const env = makeEnv(baseWorld());
    const r = await env.run({ time: 'any', mood: 'any', company: 'solo' });
    const sh = r.st.journal && r.st.journal.shadow;
    const page = env.pk.nextPage({ rest: r.st.rest.slice(), shown: [] }, 5).map(x => x.k);
    const env2 = makeEnv(baseWorld());
    const r2 = await env2.run({ time: 'any', mood: 'any', company: 'solo' });
    const page2 = env2.pk.nextPage({ rest: r2.st.rest.slice(), shown: [] }, 5).map(x => x.k);
    const ok = !!(sh && sh.top.length === 5 && sh.same >= 0 && sh.same <= 5) && page.join() === page2.join();
    return { ok, got: sh ? 'тень: ' + sh.top.map(x => x.k).join(',') + ', совпало ' + sh.same : 'тени нет' };
  } },
  { id: 'F26b', title: 'Фильм из «Позже», который пришёл и из discover, не роняет подбор', fn: async () => {
    const w = baseWorld();
    w.fav.wath = [card(305)];                        // 305 есть и в discover
    const env = makeEnv(Object.assign(w, { idb: 'fake', idbDelay: 30 }));
    const errs = [];
    env.w.addEventListener('error', e => errs.push(e.message || String(e.error)));
    const r = await env.run(ANY);
    const it = r.st && r.st.rest.find(x => x.k === 'movie:305');
    return { ok: !!(r.st && !r.error && !errs.length), got: r.error ? 'ошибка: ' + r.error : (errs.length ? errs[0] : 'ок, 305: ' + (it ? it.src + ' ' + JSON.stringify(it.srcs) : 'нет в финале')) };
  } },
  { id: 'SM', title: 'Все сочетания ответов (5×6×4) с медленным кешем: без ошибок, дублей, NaN, лишней длительности и поздних частей франшиз', fn: async () => {
    const likes = []; for (let i = 0; i < 12; i++) likes.push(card(100 + i, { genre_ids: [[35], [18], [878, 28], [27, 53], [16, 10751]][i % 5] }));
    const world = { movies: {}, discover: [], recs: [], collections: { 980: [600, 601, 602] } };
    for (let i = 0; i < 60; i++) {
      const g = [[35], [18, 10749], [27, 53], [878, 9648], [16, 10751], [28, 12], [99], [80, 18]][i % 8];
      world.movies[300 + i] = movie(300 + i, { genre_ids: g, runtime: [30, 85, 100, 125, 150][i % 5], vote_average: 6 + (i % 30) / 10, vote_count: 500 + i * 100 });
      world.discover.push(300 + i);
    }
    for (let i = 0; i < 3; i++) world.movies[600 + i] = movie(600 + i, { coll: 980, release_date: (2001 + i * 3) + '-01-01', runtime: 100 + i * 20 });
    world.discover.push(602);
    for (let i = 0; i < 20; i++) world.recs.push(300 + i * 3);
    const problems = [];
    let n = 0;
    for (const time of ['40', '90', '120', 'series', 'any']) for (const mood of ['relax', 'laugh', 'nerves', 'think', 'surprise', 'any']) for (const company of ['solo', 'couple', 'kids', 'group']) {
      n++;
      const env = makeEnv({ fav: { like: likes, wath: [card(305), card(601)], history: [card(600)] }, world, idb: 'fake', idbDelay: 30 });
      const errs = [];
      env.w.addEventListener('error', e => errs.push(e.message || String(e.error)));
      const r = await env.run({ time, mood, company });
      const tag = time + '/' + mood + '/' + company;
      if (!r.st || r.error || errs.length) { problems.push(tag + ': ' + (r.error || errs[0] || 'нет результата')); continue; }
      const seenK = new Set();
      for (const it of r.st.rest) {
        if (seenK.has(it.k)) problems.push(tag + ': дубль ' + it.k);
        seenK.add(it.k);
        if (!(it.score >= 0) || !isFinite(it.jscore)) problems.push(tag + ': NaN у ' + it.k);
        if ((time === '90' || time === '120') && it.c.runtime > +time + 10) problems.push(tag + ': длинный ' + it.k);
        if (it.c.coll === 980 && it.id !== 601) problems.push(tag + ': часть франшизы ' + it.id);
      }
    }
    return { ok: !problems.length, got: n + ' подборов' + (problems.length ? ', проблемы: ' + problems.slice(0, 3).join('; ') : ', без проблем') };
  } },
  // ------------------------------------------------------------------ франшизы: всегда первая непросмотренная часть
  { id: 'FR1', title: 'Франшиза: первая часть длиннее выбранного времени — франшиза пропускается, поздней части нет', fn: async () => {
    const o = baseWorld();
    o.world.collections[970] = [410, 411, 412];
    o.world.movies[410] = movie(410, { coll: 970, release_date: '2001-01-01', runtime: 152, vote_average: 8.0 });
    o.world.movies[411] = movie(411, { coll: 970, release_date: '2005-01-01', runtime: 157, vote_average: 7.9 });
    o.world.movies[412] = movie(412, { coll: 970, release_date: '2011-01-01', runtime: 125, vote_average: 9.5, vote_count: 20000 });
    o.world.discover.push(412);
    const env = makeEnv(o);
    const r = await env.run({ time: '120', mood: 'any', company: 'solo' });
    const got = (r.st ? r.st.rest : []).filter(it => it.c.coll === 970).map(it => it.id);
    const fr = (r.st && r.st.journal.franchises || []).find(f => f.coll === 970);
    return { ok: !!r.st && !got.length && fr && fr.res === 'skip:too_long', got: 'в финале ' + (got.join(',') || 'ничего') + ', журнал ' + JSON.stringify(fr) };
  } },
  { id: 'FR2', title: 'Франшиза: подходящая первая часть подставляется вместо поздней', fn: async () => {
    const o = baseWorld();
    o.world.collections[971] = [420, 421, 422];
    o.world.movies[420] = movie(420, { coll: 971, release_date: '2001-01-01', runtime: 110, vote_average: 7.8 });
    o.world.movies[421] = movie(421, { coll: 971, release_date: '2005-01-01', runtime: 110, vote_average: 7.6 });
    o.world.movies[422] = movie(422, { coll: 971, release_date: '2011-01-01', runtime: 110, vote_average: 9.5, vote_count: 20000 });
    o.world.discover.push(422);
    const env = makeEnv(o);
    const r = await env.run({ time: '120', mood: 'any', company: 'solo' });
    const got = (r.st ? r.st.rest : []).filter(it => it.c.coll === 971).map(it => it.id);
    return { ok: got.join() === '420', got: 'в финале ' + (got.join(',') || 'ничего') };
  } },
  { id: 'FR3', title: 'Франшиза: первая часть в истории — предлагается вторая', fn: async () => {
    const o = baseWorld();
    o.world.collections[972] = [430, 431, 432];
    o.world.movies[430] = movie(430, { coll: 972, release_date: '2001-01-01', runtime: 110 });
    o.world.movies[431] = movie(431, { coll: 972, release_date: '2005-01-01', runtime: 110, vote_average: 7.6 });
    o.world.movies[432] = movie(432, { coll: 972, release_date: '2011-01-01', runtime: 110, vote_average: 9.5, vote_count: 20000 });
    o.world.discover.push(432);
    o.fav.history = o.fav.history.concat([card(430)]);
    const env = makeEnv(o);
    const r = await env.run({ time: '120', mood: 'any', company: 'solo' });
    const got = (r.st ? r.st.rest : []).filter(it => it.c.coll === 972).map(it => it.id);
    return { ok: got.join() === '431', got: 'в финале ' + (got.join(',') || 'ничего') };
  } },
  { id: 'FR4', title: 'Франшиза: первая часть в «Смотрю» — вторую не предлагаем', fn: async () => {
    const o = baseWorld();
    o.world.collections[973] = [440, 441];
    o.world.movies[440] = movie(440, { coll: 973, release_date: '2001-01-01', runtime: 110 });
    o.world.movies[441] = movie(441, { coll: 973, release_date: '2011-01-01', runtime: 110, vote_average: 9.5, vote_count: 20000 });
    o.world.discover.push(441);
    o.fav.look = [card(440)];
    const env = makeEnv(o);
    const r = await env.run({ time: '120', mood: 'any', company: 'solo' });
    const got = (r.st ? r.st.rest : []).filter(it => it.c.coll === 973).map(it => it.id);
    const fr = (r.st && r.st.journal.franchises || []).find(f => f.coll === 973);
    return { ok: !!r.st && !got.length && fr && fr.res === 'blocked:watching', got: 'в финале ' + (got.join(',') || 'ничего') + ', журнал ' + JSON.stringify(fr) };
  } },
  { id: 'FR5', title: '«С детьми»: первая часть длиннее времени — запасной части нет (запасная — только по возрасту)', fn: async () => {
    const o = baseWorld();
    o.world.collections[974] = [450, 451];
    o.world.movies[450] = movie(450, { coll: 974, release_date: '1995-01-01', runtime: 150, genre_ids: [16, 10751, 35], vote_average: 8.3, vote_count: 20000, cert: cert('G', '0+') });
    o.world.movies[451] = movie(451, { coll: 974, release_date: '2019-01-01', runtime: 100, genre_ids: [16, 10751, 35], vote_average: 9.5, vote_count: 20000, cert: cert('G', '0+') });
    o.world.discover.push(451);
    const env = makeEnv(o);
    const r = await env.run({ time: '120', mood: 'any', company: 'kids' });
    const got = (r.st ? r.st.rest : []).filter(it => it.c.coll === 974).map(it => it.id);
    return { ok: !!r.st && !got.length, got: 'в финале ' + (got.join(',') || 'ничего') };
  } },
  // ------------------------------------------------------------------ 0.12.1: остаток P2
  { id: 'P1', title: 'Повторы: ×0,85 за каждый показ сегодня, не ниже ×0,6; счётчик растёт с каждым подбором', fn: async () => {
    const env = makeEnv(baseWorld());
    env.storage.picker_shown_day = { d: env.pk.todaySeed(), k: { 'movie:300': 2, 'movie:302': 5 } };
    const r = await env.run(ANY);
    const rp = k => { const x = r.st.rest.find(it => it.k === k); return x ? Math.round(x.rp * 10000) / 10000 : 'нет'; };
    env.pk.markShownToday([{ k: 'movie:777' }]); env.pk.markShownToday([{ k: 'movie:777' }]);
    const cnt = env.pk.shownToday()['movie:777'];
    const ok = rp('movie:300') === 0.7225 && rp('movie:302') === 0.6 && cnt === 2;
    return { ok, got: '2 показа ×' + rp('movie:300') + ', 5 показов ×' + rp('movie:302') + ', счётчик после двух подборов ' + cnt };
  } },
  { id: 'P2a', title: 'Склонение: 1 голос, 2 голоса, 11 голосов, 21 голос, 322 голоса, 5 тыс. голосов', fn: async () => {
    const { pk } = makeEnv();
    const got = [1, 2, 11, 21, 322, 5000].map(pk.votesText).join(', ');
    return { ok: got === '1 голос, 2 голоса, 11 голосов, 21 голос, 322 голоса, 5 тыс. голосов', got };
  } },
  { id: 'P2b', title: 'Причина: «Высокий рейтинг» только от 7,0; у среднего фильма — жанр под настроение', fn: async () => {
    const { pk } = makeEnv();
    const mk = (va, vc) => ({ k: 'movie:1', c: { type: 'movie', title: 'X', genres: [35], va, vc, dir: [], cast: [], names: {} }, src: 'disc', srcs: { disc: true }, seedHits: 0, seeds: [] });
    const parts = r => ({ best: null, rb: 0, s: 0, a: 0.5, q: 0.9, n: 0, m: 0.6, r });
    const w = { q: 0.3, a: 0.35, m: 0.2, n: 0.05, s: 0.1 }, prof = { f: { genre: {} }, names: {} }, ans = { mood: 'laugh', company: 'solo' };
    const low = pk.reasonOf(mk(6.4, 322), parts(6.4), w, prof, ans);
    const high = pk.reasonOf(mk(8.0, 5000), parts(8.0), w, prof, ans);
    return { ok: !/^Высокий рейтинг/.test(low) && high === 'Высокий рейтинг: 8,0, 5 тыс. голосов', got: '6,4 → «' + low + '»; 8,0 → «' + high + '»' };
  } },
  { id: 'P3a', title: 'Журнал: КП выключен — у карточек без оценки причина offline', fn: async () => {
    const env = makeEnv(baseWorld());
    const r = await env.run(ANY);
    const miss = (r.st.journal.top || []).map(x => x.kpMiss);
    const ok = miss.length > 0 && miss.every(m => m === 'offline' || m === 'not_requested') && miss.indexOf('offline') > -1;
    return { ok, got: Array.from(new Set(miss)).join(', ') };
  } },
  { id: 'P3b', title: 'Журнал: КП не нашёл фильм — причина not_found, повторно — cached_miss', fn: async () => {
    const router = (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) {
        if (url.indexOf('imdbId=') > -1) return { body: { items: [] } };
        if (url.indexOf('search-by-keyword') > -1) return { body: { films: [] } };
      }
      return def(url);
    };
    const env = makeEnv(Object.assign(baseWorld(), { kp: true, router }));
    const r1 = await env.run(ANY);
    const m1 = Array.from(new Set((r1.st.journal.top || []).map(x => x.kpMiss)));
    const r2 = await env.run(ANY);
    const m2 = Array.from(new Set((r2.st.journal.top || []).map(x => x.kpMiss)));
    return { ok: m1.indexOf('not_found') > -1 && m2.indexOf('cached_miss') > -1, got: 'первый: ' + m1.join(', ') + '; второй: ' + m2.join(', ') };
  } },
  { id: 'P4a', title: 'Медленная сеть: детали по 3 с — подбор не падает, а останавливается раньше (detailsCut)', fn: async () => {
    const router = (url, p, def) => {
      const r = def(url);
      if (/\/3\/movie\/\d+\?/.test(url)) return Object.assign({}, r, { delay: 3000 });
      return r;
    };
    // Две трети кандидатов длиннее 1,5 часа — за одну пачку деталей нужных 30 не набрать
    const w = baseWorld();
    for (let i = 0; i < 60; i++) if (i % 3) w.world.movies[300 + i] = movie(300 + i, { runtime: 150 });
    const env = makeEnv(Object.assign(w, { router }));
    const t0 = env.clock.now;
    const r = await env.run({ time: '90', mood: 'any', company: 'solo' }, 200000);
    const sec = Math.round((env.clock.now - t0) / 1000);
    return { ok: !!r.st && !r.error && r.st.journal.detailsCut === true && r.st.rest.length >= 10, got: (r.error ? 'ошибка ' + r.error : 'готово, финал ' + r.st.rest.length + ', detailsCut ' + r.st.journal.detailsCut) + ', ' + sec + ' с' };
  } },
  { id: 'P4b', title: 'Сеть молчит — ошибка за ~20 с тишины, а не через минуты', fn: async () => {
    const router = (url, p, def) => {
      const r = def(url);
      if (/\/3\/(movie|tv)\/\d+/.test(url) || /discover|recommendations/.test(url)) return Object.assign({}, r, { delay: 100000 });
      return r;
    };
    const env = makeEnv(Object.assign(baseWorld(), { router }));
    const t0 = env.clock.now;
    const r = await env.run(ANY, 200000);
    const sec = Math.round((env.clock.now - t0) / 1000);
    return { ok: !!r.error && sec <= 45, got: (r.error ? 'ошибка ' + r.error : 'без ошибки') + ' через ' + sec + ' с' };
  } },
  { id: 'P5', title: 'Короткометражка на 4 минуты не предлагается (сериал с серией 11 мин — можно)', fn: async () => {
    const { pk } = makeEnv();
    const a = why(pk, item({ runtime: 4, vc: 600 }), { time: '40' });
    const b = why(pk, item({ runtime: 4, vc: 600 }), {});
    const c = why(pk, item({ type: 'tv', runtime: 11, vc: 600 }), { time: '40' });
    return { ok: a === 'too_short' && b === 'too_short' && c === 'проходит', got: '40 мин: ' + a + '; неважно: ' + b + '; сериал: ' + c };
  } },
  { id: 'P3c', title: 'Журнал: при «не найден» записано, что ответил КП (IMDb пусто, варианты поиска)', fn: async () => {
    const router = (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) {
        if (url.indexOf('imdbId=') > -1) return { body: { items: [] } };
        if (url.indexOf('search-by-keyword') > -1) return { body: { films: [{ filmId: 9, type: 'TV_SHOW', year: '2012', nameRu: 'Связь' }] } };
      }
      return def(url);
    };
    const env = makeEnv(Object.assign(baseWorld(), { kp: true, router }));
    const r = await env.run(ANY);
    const x = (r.st.journal.top || []).find(t => t.kpMiss === 'not_found' && t.kpProbe);
    const r2 = await env.run(ANY);
    const y = (r2.st.journal.top || []).find(t => t.kpMiss === 'cached_miss' && t.kpProbe);
    const ok = !!x && x.kpProbe.imdb === 'empty' && x.kpProbe.total === 1 && x.kpProbe.top[0][0] === 'TV_SHOW' && !!y;
    return { ok, got: (x ? JSON.stringify(x.kpProbe) : 'нет kpProbe') + '; из кеша: ' + (y ? 'с ответом КП' : 'без') };
  } },
  { id: 'P3d', title: 'Старое «не найден» без записи ответа КП переспрашивается один раз', fn: async () => {
    let n = 0;
    const router = (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) { n++; if (url.indexOf('imdbId=') > -1) return { body: { items: [] } }; return { body: { films: [] } }; }
      return def(url);
    };
    const env = makeEnv({ kp: true, router });
    env.pk.Durable.vals.kpmap = { 'movie:5': { kp: 0, imdb: 0, id: null, t: env.clock.now - 86400000, va: 7 } };
    env.pk.Durable.loaded.kpmap = true;
    const it = { k: 'movie:5', c: { id: 5, type: 'movie', imdb: 'tt5', title: 'X', original: 'X', year: '2014', va: 7 } };
    const a = await env.cb(cb => env.pk.fetchRatings(it, cb));
    const n1 = n;
    const b = await env.cb(cb => env.pk.fetchRatings({ k: 'movie:5', c: it.c }, cb));
    return { ok: n1 > 0 && n === n1 && a[1] === 'not_found' && b[1] === 'cached_miss', got: 'запросов после первого ' + n1 + ', после второго ' + n + ', причины ' + a[1] + ' / ' + b[1] };
  } },
  { id: 'P3e', title: 'Запись КП только с возрастом («С детьми») не считается «нет оценки»: оценка запрашивается по id', fn: async () => {
    const urls = [];
    const router = (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) { urls.push(url.replace(/^.*\/api\//, '')); return { body: { kinopoiskId: 77, ratingKinopoisk: 7.9, ratingImdb: 7.6 } }; }
      return def(url);
    };
    const env = makeEnv({ kp: true, router });
    env.pk.Durable.vals.kpmap = { 'movie:5': { kp: 0, imdb: 0, id: 77, age: 6, t: env.clock.now - 86400000, va: 7 } };
    env.pk.Durable.loaded.kpmap = true;
    const res = await env.cb(cb => env.pk.fetchRatings({ k: 'movie:5', c: { id: 5, type: 'movie', imdb: 'tt5', title: 'X', year: '2014', va: 7 } }, cb));
    const r = res && res[0];
    return { ok: !!r && r.kp === 7.9 && urls.length === 1 && /films\/77$/.test(urls[0]), got: (r ? 'КП ' + r.kp : 'нет оценки (' + (res && res[1]) + ')') + ', запросы: ' + urls.join(', ') };
  } },
  { id: 'P3g', title: 'КП: год расходится на 2 («Связь»: КП 2012, TMDB 2014) — находится по совпадению названия; чужое название — нет', fn: async () => {
    const mk = (nameEn) => (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) {
        if (url.indexOf('imdbId=') > -1) return { body: { items: [] } };
        if (url.indexOf('search-by-keyword') > -1) return { body: { films: [{ filmId: 4000, type: 'FILM', year: '2012', nameRu: 'Связь', nameEn }, { filmId: 4001, type: 'FILM', year: '2017', nameRu: 'Другое' }] } };
        if (/films\/4000$/.test(url)) return { body: { kinopoiskId: 4000, ratingKinopoisk: 7.0, ratingImdb: 7.2 } };
      }
      return def(url);
    };
    const it = () => ({ k: 'movie:220289', c: { id: 220289, type: 'movie', imdb: 'tt1', title: 'Связь', original: 'Coherence', year: '2014', va: 7.2 } });
    const e1 = makeEnv({ kp: true, router: mk('Coherence') });
    const a = await e1.cb(cb => e1.pk.fetchRatings(it(), cb));
    const e2 = makeEnv({ kp: true, router: mk('Something Else') });
    const it2 = it(); it2.c.title = 'Связь 2';
    const b = await e2.cb(cb => e2.pk.fetchRatings(it2, cb));
    return { ok: !!(a && a[0] && a[0].kp === 7) && !(b && b[0]), got: 'Coherence: ' + (a && a[0] ? 'КП ' + a[0].kp : a && a[1]) + '; другое название: ' + (b && b[0] ? 'КП ' + b[0].kp : b && b[1]) };
  } },
  { id: 'P3h', title: 'КП: «не найден» прежней версией сопоставления переспрашивается один раз', fn: async () => {
    let n = 0;
    const router = (url, p, def) => { if (url.indexOf('kinopoiskapiunofficial') > -1) { n++; return url.indexOf('imdbId=') > -1 ? { body: { items: [] } } : { body: { films: [] } }; } return def(url); };
    const env = makeEnv({ kp: true, router });
    env.pk.Durable.vals.kpmap = { 'movie:5': { kp: 0, imdb: 0, id: null, t: env.clock.now - 86400000, va: 7, r: 1, probe: { imdb: 'empty', q: 'X', year: 2014, total: 3, top: [] } } };
    env.pk.Durable.loaded.kpmap = true;
    const c = { id: 5, type: 'movie', imdb: 'tt5', title: 'X', original: 'X', year: '2014', va: 7 };
    await env.cb(cb => env.pk.fetchRatings({ k: 'movie:5', c }, cb));
    const n1 = n;
    await env.cb(cb => env.pk.fetchRatings({ k: 'movie:5', c }, cb));
    return { ok: n1 > 0 && n === n1, got: 'запросов: после первого ' + n1 + ', после второго ' + n };
  } },
  { id: 'P3i', title: 'КП: по IMDb нашёлся без оценок — оценка берётся из карточки КП по id', fn: async () => {
    const urls = [];
    const router = (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) {
        urls.push(url.replace(/^.*\/api\//, ''));
        if (url.indexOf('imdbId=') > -1) return { body: { items: [{ kinopoiskId: 555, ratingKinopoisk: null, ratingImdb: null }] } };
        if (/films\/555$/.test(url)) return { body: { kinopoiskId: 555, ratingKinopoisk: 7.6, ratingImdb: 7.4, type: 'FILM', year: 2013 } };
      }
      return def(url);
    };
    const env = makeEnv({ kp: true, router });
    const res = await env.cb(cb => env.pk.fetchRatings({ k: 'movie:206487', c: { id: 206487, type: 'movie', imdb: 'tt2397535', title: 'Патруль времени', original: 'Predestination', year: '2014', va: 7.4 } }, cb));
    const r = res && res[0];
    return { ok: !!r && r.kp === 7.6 && urls.length === 2, got: (r ? 'КП ' + r.kp : 'нет (' + (res && res[1]) + ')') + ', запросы: ' + urls.join(', ') };
  } },
  { id: 'P3j', title: 'Журнал: ответ КП, полученный уже на экране, попадает в показанные карточки', fn: async () => {
    const env = makeEnv(baseWorld());
    const r = await env.run(ANY);
    const page = env.pk.nextPage(r.st, 5);
    env.pk.Journal.shown(r.st.journal, page, 1);
    const it = page[0]; it.kp = 0; it.imdbR = 0; it.kpMiss = 'not_found'; it.kpProbe = { imdb: 'empty', q: 'X', year: 2026, total: 0, top: [] };
    env.pk.Journal.rating(r.st.journal, it);
    const x = env.pk.Journal.list().slice(-1)[0].shown.find(s => s.k === it.k);
    return { ok: !!(x && x.kpProbe && x.kpMiss === 'not_found'), got: x ? JSON.stringify({ kpMiss: x.kpMiss, kpProbe: x.kpProbe }) : 'нет' };
  } },
  { id: 'P3k', title: 'КП: «нашёлся без оценки» от прежней версии сопоставляется заново один раз (не по старому id)', fn: async () => {
    const urls = [];
    const router = (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) {
        urls.push(url.replace(/^.*\/api\//, ''));
        if (url.indexOf('imdbId=') > -1) return { body: { items: [] } };
        if (url.indexOf('search-by-keyword') > -1) return { body: { films: [{ filmId: 900, type: 'FILM', year: '2019', nameRu: 'Чужое', nameEn: 'Entangled' }, { filmId: 555, type: 'FILM', year: '2018', nameRu: 'Мультивселенная', nameEn: 'Multiverse' }] } };
        if (/films\/555$/.test(url)) return { body: { kinopoiskId: 555, ratingKinopoisk: 5.9, ratingImdb: 5.5 } };
        return { body: { kinopoiskId: 900 } };
      }
      return def(url);
    };
    const env = makeEnv({ kp: true, router });
    env.pk.Durable.vals.kpmap = { 'movie:7': { kp: 0, imdb: 0, id: 900, r: 1, mv: 2, t: env.clock.now - 86400000, va: 6 } };
    env.pk.Durable.loaded.kpmap = true;
    const c = { id: 7, type: 'movie', imdb: 'tt7', title: 'Мультивселенная', original: 'Multiverse', year: '2019', va: 6 };
    const a = await env.cb(cb => env.pk.fetchRatings({ k: 'movie:7', c }, cb));
    const n1 = urls.length;
    const b = await env.cb(cb => env.pk.fetchRatings({ k: 'movie:7', c }, cb));
    const ok = !!(a && a[0] && a[0].kp === 5.9) && !!(b && b[0] && b[0].src === 'cache') && urls.length === n1 && !urls.some(u => /films\/900$/.test(u));
    return { ok, got: 'первый: ' + (a && a[0] ? 'КП ' + a[0].kp : a && a[1]) + ', второй: ' + (b && b[0] ? b[0].src : b && b[1]) + ', запросы: ' + urls.join(', ') };
  } },
  { id: 'P3l', title: 'КП: по названию — чужой фильм того же года не берётся, нужный с разницей в год — да («Мультивселенная»)', fn: async () => {
    const urls = [];
    const films = [{ filmId: 900, type: 'FILM', year: '2019', nameRu: 'Запутанные', nameEn: 'Entangled' }, { filmId: 555, type: 'FILM', year: '2018', nameRu: 'Мультивселенная', nameEn: 'Multiverse' }];
    const mk = (list) => (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) {
        urls.push(url.replace(/^.*\/api\//, ''));
        if (url.indexOf('imdbId=') > -1) return { body: { items: [] } };
        if (url.indexOf('search-by-keyword') > -1) return { body: { films: list } };
        const m = url.match(/films\/(\d+)$/);
        if (m) return { body: m[1] === '555' ? { kinopoiskId: 555, ratingKinopoisk: 5.9, ratingImdb: 5.5 } : { kinopoiskId: +m[1] } };
      }
      return def(url);
    };
    const c = { id: 7, type: 'movie', imdb: 'tt7', title: 'Мультивселенная', original: 'Multiverse', year: '2019', va: 6 };
    const e1 = makeEnv({ kp: true, router: mk(films) });
    const a = await e1.cb(cb => e1.pk.fetchRatings({ k: 'movie:7', c }, cb));
    // Только чужой фильм того же года, название не совпадает, но вариант один — берётся (другой перевод)
    const e2 = makeEnv({ kp: true, router: mk([films[0]]) });
    const b = await e2.cb(cb => e2.pk.fetchRatings({ k: 'movie:7', c }, cb));
    // Два чужих того же года — не берётся ни один
    const e3 = makeEnv({ kp: true, router: mk([films[0], { filmId: 901, type: 'FILM', year: '2019', nameRu: 'Ещё', nameEn: 'Other' }]) });
    const d = await e3.cb(cb => e3.pk.fetchRatings({ k: 'movie:7', c }, cb));
    const ok = !!(a && a[0] && a[0].kp === 5.9) && b && b[1] === 'no_rating' && d && d[1] === 'not_found';
    return { ok, got: 'нужный: ' + (a && a[0] ? 'КП ' + a[0].kp : a && a[1]) + '; один чужой: ' + (b && (b[0] ? 'КП ' + b[0].kp : b[1])) + '; два чужих: ' + (d && (d[0] ? 'КП ' + d[0].kp : d[1])) };
  } },
  { id: 'P3m', title: 'КП: по IMDb-номеру пустой дубль и настоящая карточка — берётся карточка с оценкой («Патруль времени»)', fn: async () => {
    const urls = [];
    const router = (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) {
        urls.push(url.replace(/^.*\/api\//, ''));
        if (url.indexOf('imdbId=') > -1) return { body: { items: [
          { kinopoiskId: 1155501, type: 'FILM', year: 2014, nameOriginal: 'Predestination', ratingKinopoisk: null, ratingImdb: null },
          { kinopoiskId: 679924, type: 'FILM', year: 2014, nameRu: 'Патруль времени', ratingKinopoisk: 6.9, ratingImdb: 7.4 }] } };
        return { body: {} };
      }
      return def(url);
    };
    const env = makeEnv({ kp: true, router });
    const c = { id: 206487, type: 'movie', imdb: 'tt2397535', title: 'Патруль времени', original: 'Predestination', year: '2014', va: 7.4 };
    const a = await env.cb(cb => env.pk.fetchRatings({ k: 'movie:206487', c }, cb));
    const ok = !!(a && a[0] && a[0].kp === 6.9) && urls.length === 1;
    return { ok, got: (a && a[0] ? 'КП ' + a[0].kp : a && a[1]) + ', запросы: ' + urls.join(', ') };
  } },
  { id: 'P3n', title: 'КП: по IMDb только пустой дубль — один запасной поиск по названию находит настоящую карточку', fn: async () => {
    const urls = [];
    const router = (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) {
        urls.push(url.replace(/^.*\/api\//, ''));
        if (url.indexOf('imdbId=') > -1) return { body: { items: [{ kinopoiskId: 1155501, type: 'FILM', year: 2014, nameOriginal: 'Predestination' }] } };
        if (url.indexOf('search-by-keyword') > -1) return { body: { films: [
          { filmId: 1155501, type: 'FILM', year: '2014', nameEn: 'Predestination', rating: 'null', ratingVoteCount: 38 },
          { filmId: 679924, type: 'FILM', year: '2014', nameRu: 'Патруль времени', nameEn: 'Predestination', rating: '6.9', ratingVoteCount: 300000 }] } };
        if (/films\/679924$/.test(url)) return { body: { kinopoiskId: 679924, ratingKinopoisk: 6.9, ratingImdb: 7.4 } };
        if (/films\/1155501$/.test(url)) return { body: { kinopoiskId: 1155501, type: 'FILM', year: 2014, nameOriginal: 'Predestination', ratingKinopoiskVoteCount: 38 } };
      }
      return def(url);
    };
    const env = makeEnv({ kp: true, router });
    const c = { id: 206487, type: 'movie', imdb: 'tt2397535', title: 'Патруль времени', original: 'Predestination', year: '2014', va: 7.4 };
    const a = await env.cb(cb => env.pk.fetchRatings({ k: 'movie:206487', c }, cb));
    const n1 = urls.length;
    const b = await env.cb(cb => env.pk.fetchRatings({ k: 'movie:206487', c }, cb));
    const ok = !!(a && a[0] && a[0].kp === 6.9) && n1 === 4 && !!(b && b[0] && b[0].src === 'cache') && urls.length === n1;
    return { ok, got: 'первый: ' + (a && a[0] ? 'КП ' + a[0].kp : a && a[1]) + ', второй: ' + (b && b[0] ? b[0].src : b && b[1]) + ', запросы: ' + urls.join(', ') };
  } },
  { id: 'P3o', title: 'КП: запись «пустой дубль без оценки» от прежней версии и запись «только возраст» переспрашиваются и находят настоящую карточку', fn: async () => {
    const urls = [];
    const router = (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) {
        urls.push(url.replace(/^.*\/api\//, ''));
        if (url.indexOf('imdbId=') > -1) return { body: { items: [{ kinopoiskId: 1155501, type: 'FILM', year: 2014 }] } };
        if (url.indexOf('search-by-keyword') > -1) return { body: { films: [
          { filmId: 1155501, type: 'FILM', year: '2014', nameEn: 'Predestination', rating: 'null', ratingVoteCount: 38 },
          { filmId: 679924, type: 'FILM', year: '2014', nameRu: 'Патруль времени', nameEn: 'Predestination', rating: '6.9', ratingVoteCount: 300000 }] } };
        if (/films\/679924$/.test(url)) return { body: { kinopoiskId: 679924, ratingKinopoisk: 6.9, ratingImdb: 7.4, ratingAgeLimits: 'age16' } };
        if (/films\/1155501$/.test(url)) return { body: { kinopoiskId: 1155501, ratingKinopoiskVoteCount: 38, ratingAgeLimits: 'age18' } };
      }
      return def(url);
    };
    const env = makeEnv({ kp: true, router });
    env.pk.Durable.vals.kpmap = {
      'movie:206487': { kp: 0, imdb: 0, id: 1155501, r: 1, mv: 3, t: env.clock.now - 86400000, va: 7.4 },
      'movie:206488': { kp: 0, imdb: 0, id: 1155501, age: 18, t: env.clock.now - 86400000, va: 7.4 }
    };
    env.pk.Durable.loaded.kpmap = true;
    const c1 = { id: 206487, type: 'movie', imdb: 'tt2397535', title: 'Патруль времени', original: 'Predestination', year: '2014', va: 7.4 };
    const c2 = Object.assign({}, c1, { id: 206488 });
    const a = await env.cb(cb => env.pk.fetchRatings({ k: 'movie:206487', c: c1 }, cb));
    const b = await env.cb(cb => env.pk.fetchRatings({ k: 'movie:206488', c: c2 }, cb));
    const rec = env.pk.Durable.vals.kpmap['movie:206488'];
    const ok = !!(a && a[0] && a[0].kp === 6.9) && !!(b && b[0] && b[0].kp === 6.9) && rec && rec.id === 679924 && rec.age === 16;
    return { ok, got: 'прежняя запись: ' + (a && a[0] ? 'КП ' + a[0].kp : a && a[1]) + '; «только возраст»: ' + (b && b[0] ? 'КП ' + b[0].kp : b && b[1]) + ', id ' + (rec && rec.id) + ', возраст ' + (rec && rec.age) };
  } },
  { id: 'P3p', title: 'КП: оценки нет нигде — после пустой карточки ровно один поиск, дальше «без оценки» из кеша', fn: async () => {
    const urls = [];
    const router = (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) {
        urls.push(url.replace(/^.*\/api\//, ''));
        if (url.indexOf('imdbId=') > -1) return { body: { items: [{ kinopoiskId: 700, type: 'FILM', year: 2020 }] } };
        if (url.indexOf('search-by-keyword') > -1) return { body: { films: [{ filmId: 700, type: 'FILM', year: '2020', nameEn: 'Elize', rating: 'null', ratingVoteCount: 3 }] } };
        if (/films\/700$/.test(url)) return { body: { kinopoiskId: 700, type: 'FILM', year: 2020, nameOriginal: 'Elize', ratingKinopoiskVoteCount: 3 } };
      }
      return def(url);
    };
    const env = makeEnv({ kp: true, router });
    const c = { id: 9, type: 'movie', imdb: 'tt9', title: 'Elize', original: 'Elize', year: '2020', va: 6 };
    const a = await env.cb(cb => env.pk.fetchRatings({ k: 'movie:9', c }, cb));
    const n1 = urls.length;
    const b = await env.cb(cb => env.pk.fetchRatings({ k: 'movie:9', c }, cb));
    const rec = env.pk.Durable.vals.kpmap['movie:9'];
    const ok = a && a[1] === 'no_rating' && n1 === 3 && b && b[1] === 'cached_no_rating' && urls.length === n1 && rec && rec.id === 700;
    return { ok, got: 'первый: ' + (a && a[1]) + ', второй: ' + (b && b[1]) + ', запросы (' + urls.length + '): ' + urls.join(', ') };
  } },
  { id: 'P3q', title: 'КП: оригинал на TMDB и на КП разный — после пустой карточки находит по русскому названию, латинская «M» в нём не мешает («Мультивселенная»)', fn: async () => {
    const urls = [];
    const router = (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) {
        const u = decodeURIComponent(url);
        urls.push(u.replace(/^.*\/api\//, ''));
        if (u.indexOf('imdbId=') > -1) return { body: { items: [{ kinopoiskId: 4892996, type: 'FILM', year: 2021, nameOriginal: 'Entangled' }] } };
        if (u.indexOf('keyword=Entangled') > -1) return { body: { films: [
          { filmId: 4892996, type: 'FILM', year: '2021', nameEn: 'Entangled', rating: 'null', ratingVoteCount: 1 },
          { filmId: 3000, type: 'FILM', year: '2019', nameEn: 'Entangled', rating: 'null', ratingVoteCount: 4 }] } };
        if (u.indexOf('keyword=Мультивселенная') > -1) return { body: { films: [
          { filmId: 1180000, type: 'FILM', year: '2018', nameRu: 'Мультивселенная', nameEn: 'Multiverse', rating: '5.9', ratingVoteCount: 25695 }] } };
        if (u.indexOf('keyword=') > -1) return { body: { films: [] } };
        if (/films\/1180000$/.test(u)) return { body: { kinopoiskId: 1180000, ratingKinopoisk: 5.9, ratingImdb: 5.6 } };
        if (/films\/3000$/.test(u)) return { body: { kinopoiskId: 3000, ratingKinopoiskVoteCount: 4 } };
        if (/films\/4892996$/.test(u)) return { body: { kinopoiskId: 4892996, type: 'FILM', year: 2021, nameOriginal: 'Entangled', ratingKinopoiskVoteCount: 1 } };
      }
      return def(url);
    };
    const env = makeEnv({ kp: true, router });
    const c = { id: 660833, type: 'movie', imdb: 'tt15706538', title: 'Mультивселенная', original: 'Entangled', year: '2021', va: 6.6 };
    const a = await env.cb(cb => env.pk.fetchRatings({ k: 'movie:660833', c }, cb));
    const ok = !!(a && a[0] && a[0].kp === 5.9) && urls.some(u => u.indexOf('keyword=Мультивселенная') > -1);
    return { ok, got: (a && a[0] ? 'КП ' + a[0].kp : a && a[1]) + ', запросы: ' + urls.join(', ') };
  } },
  { id: 'P3r', title: 'КП: по оригинальному названию ничего — находит по русскому («Шерлок: Безобразная невеста»)', fn: async () => {
    const urls = [];
    const router = (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) {
        const u = decodeURIComponent(url);
        urls.push(u.replace(/^.*\/api\//, ''));
        if (u.indexOf('imdbId=') > -1) return { body: { items: [] } };
        if (u.indexOf('keyword=Шерлок') > -1) return { body: { films: [
          { filmId: 893621, type: 'FILM', year: '2015', nameRu: 'Шерлок: Безобразная невеста', nameEn: 'Sherlock: The Abominable Bride', rating: '7.8', ratingVoteCount: 90000 }] } };
        if (u.indexOf('keyword=') > -1) return { body: { films: [] } };
        if (/films\/893621$/.test(u)) return { body: { kinopoiskId: 893621, ratingKinopoisk: 7.8, ratingImdb: 7.6 } };
      }
      return def(url);
    };
    const env = makeEnv({ kp: true, router });
    const c = { id: 379170, type: 'movie', imdb: 'tt3845232', title: 'Шерлок: Безобразная Невеста', original: 'Sherlock: The Abominable Bride', year: '2016', va: 7.8 };
    const a = await env.cb(cb => env.pk.fetchRatings({ k: 'movie:379170', c }, cb));
    const ok = !!(a && a[0] && a[0].kp === 7.8) && urls.length === 4;
    return { ok, got: (a && a[0] ? 'КП ' + a[0].kp : a && a[1]) + ', запросы (' + urls.length + '): ' + urls.join(', ') };
  } },
  { id: 'P3s', title: 'КП: «не найден» от прежней версии переспрашивается один раз (теперь находится по русскому названию)', fn: async () => {
    const urls = [];
    const router = (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) {
        const u = decodeURIComponent(url);
        urls.push(u.replace(/^.*\/api\//, ''));
        if (u.indexOf('imdbId=') > -1) return { body: { items: [] } };
        if (u.indexOf('keyword=Шерлок') > -1) return { body: { films: [
          { filmId: 893621, type: 'FILM', year: '2015', nameRu: 'Шерлок: Безобразная невеста', rating: '7.8', ratingVoteCount: 90000 }] } };
        if (u.indexOf('keyword=') > -1) return { body: { films: [] } };
        if (/films\/893621$/.test(u)) return { body: { kinopoiskId: 893621, ratingKinopoisk: 7.8, ratingImdb: 7.6 } };
      }
      return def(url);
    };
    const env = makeEnv({ kp: true, router });
    const old = { kp: 0, imdb: 0, id: null, r: 1, mv: 4, t: env.clock.now - 86400000, va: 7.8,
      probe: { imdb: 'empty', q: 'Sherlock: The Abominable Bride', year: 2016, total: 0, top: [] } };
    env.pk.Durable.vals.kpmap = { 'movie:379170': old, 'movie:5': Object.assign({}, old, { mv: 99 }) };
    env.pk.Durable.loaded.kpmap = true;
    const c = { id: 379170, type: 'movie', imdb: 'tt3845232', title: 'Шерлок: Безобразная Невеста', original: 'Sherlock: The Abominable Bride', year: '2016', va: 7.8 };
    const a = await env.cb(cb => env.pk.fetchRatings({ k: 'movie:379170', c }, cb));
    const n1 = urls.length;
    const b = await env.cb(cb => env.pk.fetchRatings({ k: 'movie:5', c: Object.assign({}, c, { id: 5 }) }, cb));
    const ok = !!(a && a[0] && a[0].kp === 7.8) && b && b[1] === 'cached_miss' && urls.length === n1;
    return { ok, got: 'прежняя запись: ' + (a && a[0] ? 'КП ' + a[0].kp : a && a[1]) + '; запись текущей версии: ' + (b && (b[0] ? 'КП ' + b[0].kp : b[1])) + ', запросов ' + urls.length };
  } },
  { id: 'CS1', title: 'Карточки из CUB Sync / сторонних каталогов: дата числом, жанры объектами и null — подбор проходит, dateFixes в журнале', fn: async () => {
    const odd = [
      Object.assign(card(901, {}), { release_date: 2019 }),
      Object.assign(card(902, {}), { genre_ids: undefined, genres: [{ id: 18, name: 'Драма' }, null], release_date: 2015 }),
      Object.assign(card(903, {}), { vote_average: '7.5', vote_count: '1200' })
    ];
    const likes = []; for (let i = 0; i < 10; i++) likes.push(card(100 + i, { genre_ids: [[35], [18], [878]][i % 3] }));
    const res = [];
    for (const ans of [{ time: 'any', mood: 'any', company: 'solo' }, { time: '120', mood: 'think', company: 'couple' }, { time: 'any', mood: 'any', company: 'kids' }]) {
      const env = makeEnv({ fav: { like: likes.concat(odd.slice(0, 2)), wath: [odd[0], odd[2]], history: [odd[1]] } });
      const errs = [];
      env.w.addEventListener('error', e => errs.push(e.message || String(e.error)));
      const r = await env.run(ans);
      const j = r.st && r.st.journal;
      res.push({ ok: !!r.st && !r.error && !errs.length && !(j && j.errors), err: r.error || errs[0] || (j && j.errors && j.errors[0].msg), df: j && j.dateFixes });
    }
    return { ok: res.every(x => x.ok) && res.every(x => x.df > 0), got: JSON.stringify(res) };
  } },
  { id: 'CS2', title: 'Исключение на шаге подбора — экран ошибки сразу (не сторож через 20 с), запись в журнале ошибок, в окно не уходит', fn: async () => {
    const likes = []; for (let i = 0; i < 10; i++) likes.push(card(100 + i, { genre_ids: [18] }));
    const bad = card(950, {});
    Object.defineProperty(bad, 'id', { get() { throw new Error('boom id'); }, enumerable: true });
    const env = makeEnv({ fav: { like: likes.concat([bad]) } });
    const errs = [];
    env.w.addEventListener('error', e => errs.push(e.message || String(e.error)));
    const t0 = env.clock.now;
    const r = await env.run({ time: 'any', mood: 'any', company: 'solo' });
    const saved = env.w.LampaPicker && env.w.LampaPicker.errors ? env.w.LampaPicker.errors() : null;
    const exp = env.w.LampaPicker && env.w.LampaPicker.journal ? String(env.w.LampaPicker.journal()) : '';
    return { ok: !r.st && r.error === 'error' && !errs.length && (env.clock.now - t0) <= 5000 && !!saved && saved.length > 0 && exp.indexOf('boom id') > -1,
      got: JSON.stringify({ st: !!r.st, error: r.error, ms: env.clock.now - t0, winErrs: errs, saved: saved && saved.map(x => x.tag + ': ' + x.msg), inExport: exp.indexOf('boom id') > -1 }) };
  } },
  { id: 'CS3', title: 'cardCompact: рейтинг и голоса строкой — числа, дата числом — строка, жанры без null', fn: async () => {
    const { pk } = makeEnv();
    const c = pk.cardCompact({ id: 5, title: 'X', release_date: 2019, vote_average: '7.5', vote_count: '1200', genres: [{ id: 18 }, null, 35] });
    const ok = c.va === 7.5 && c.vc === 1200 && c.year === '2019' && JSON.stringify(c.genres) === JSON.stringify([18, 35]);
    return { ok, got: JSON.stringify({ va: c.va, vc: c.vc, year: c.year, genres: c.genres }) };
  } },
  { id: 'P8', title: 'Опорные — только «Нравится» и просмотренное; открытое из подборки и закладки — нет', fn: async () => {
    const w = baseWorld();
    w.fav.like = [card(100, { title: 'Liked' })];
    w.fav.viewed = [card(101, { title: 'Viewed' })];
    w.fav.book = [card(102, { title: 'Bookmarked' })];
    w.fav.history = [card(103, { title: 'Finished' })];
    const env = makeEnv(w);
    env.timeline[hash('Finished')] = { percent: 100, time: 6000, duration: 6000 };
    env.storage.picker_feedback = { rejected: {}, seen: {}, opened: { 'movie:104': { t: env.clock.now, card: { id: 104, title: 'Opened', genre_ids: [28, 878], method: 'movie' } } } };
    const r = await env.run(ANY);
    const seeds = (r.st && r.st.journal.profile.seeds) || [];
    // названия опорных — из деталей TMDB: Film 100 (Нравится), 101 (Просмотрено), 103 (досмотрено), 102 (закладка), 104 (открыто)
    const has = id => seeds.indexOf('Film ' + id) > -1;
    const ok = has(100) && has(101) && has(103) && !has(102) && !has(104);
    return { ok, got: 'опорные: ' + seeds.join(', ') };
  } },
  { id: 'P6', title: 'Причина «Высоко на Кинопоиске» в запасном варианте — только от 7,5', fn: async () => {
    const { pk } = makeEnv();
    const mk = kp => ({ k: 'movie:1', kp, c: { type: 'movie', title: 'X', genres: [80], va: 6.8, vc: 2000, dir: [], cast: [], names: {} }, src: 'disc', srcs: { disc: true }, seedHits: 0, seeds: [] });
    const parts = { best: null, rb: 0, s: 0, a: 0.5, q: 0.9, n: 0, m: 0.6, r: 6.8 };
    const w = { q: 0.3, a: 0.35, m: 0.2, n: 0.05, s: 0.1 }, prof = { f: { genre: { 80: 0.4 } }, names: {} }, ans = { mood: 'any', company: 'solo' };
    const a = pk.reasonOf(mk(7.1), parts, w, prof, ans), b = pk.reasonOf(mk(7.8), parts, w, prof, ans);
    return { ok: !/Кинопоиске/.test(a) && b === 'Высоко на Кинопоиске: 7,8', got: 'КП 7,1 → «' + a + '»; КП 7,8 → «' + b + '»' };
  } },
  { id: 'P7a', title: 'Причина: TMDB 8,8 при КП 6,5 — не «Высокий рейтинг»', fn: async () => {
    const { pk } = makeEnv();
    const it = { k: 'movie:1', kp: 6.5, c: { type: 'movie', title: 'X', genres: [80, 28], va: 8.8, vc: 974, dir: [], cast: [], names: {} }, src: 'disc', srcs: { disc: true }, seedHits: 0, seeds: [] };
    const r = pk.reasonOf(it, { best: null, rb: -0.9, s: 0, a: 0.5, q: 0.9, n: 0, m: 0.8, r: 8.8 }, { q: 0.3, a: 0.35, m: 0.2, n: 0.05, s: 0.1 }, { f: { genre: {} }, names: {} }, { mood: 'nerves', company: 'solo' });
    return { ok: !/^Высокий рейтинг/.test(r), got: r };
  } },
  { id: 'P7b', title: 'Причина «Что-то новое» называет новый для вас жанр, а не первый', fn: async () => {
    const { pk } = makeEnv();
    const it = { k: 'movie:1', c: { type: 'movie', title: 'X', genres: [80, 28, 18], va: 6.8, vc: 2000, dir: [], cast: [], names: {} }, src: 'disc', srcs: { disc: true }, seedHits: 0, seeds: [] };
    const prof = { f: { genre: { 80: 0.45 } }, names: {}, recentGenres: [80, 18] };
    const r = pk.reasonOf(it, { best: null, rb: 0, s: 0, a: 0.5, q: 0.4, n: 0.15, m: 0.6, r: 6.8 }, { q: 0.3, a: 0.35, m: 0.2, n: 0.05, s: 0.1 }, prof, { mood: 'any', company: 'solo' });
    return { ok: r === 'Что-то новое: боевик', got: r };
  } },
  { id: 'P3f', title: 'LPJ2: у карточки без оценки КП есть причина и ответ КП (km)', fn: async () => {
    const router = (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) {
        if (url.indexOf('imdbId=') > -1) return { body: { items: [] } };
        if (url.indexOf('search-by-keyword') > -1) return { body: { films: [{ filmId: 9, type: 'FILM', year: '2012', nameRu: 'Связь' }] } };
      }
      return def(url);
    };
    const env = makeEnv(Object.assign(baseWorld(), { kp: true, router }));
    const r = await env.run(ANY);
    env.pk.Journal.shown(r.st.journal, env.pk.nextPage(r.st, 5), 1);
    const o = env.pk.Journal.compactEntry(env.pk.Journal.list().slice(-1)[0], true, null).o;
    const row = (o.km || [])[0];
    return { ok: !!row && row[1] === 'not_found' && row[2] === 'e' && row[3] === 1 && row[4] === 'FILM 2012', got: JSON.stringify(o.km) };
  } },
  { id: 'P10', title: 'Причины: «Что-то новое» не называет нелюбимый жанр; «Высокий рейтинг» при 239 голосах без КП — нет', fn: async () => {
    const { pk } = makeEnv();
    const w = { q: 0.3, a: 0.35, m: 0.2, n: 0.05, s: 0.1 }, ans = { mood: 'nerves', company: 'solo' };
    const horror = { k: 'movie:1', c: { type: 'movie', title: 'H', genres: [27, 53], va: 6.7, vc: 3000, dir: [], cast: [], names: {} }, src: 'disc', srcs: { disc: true }, seedHits: 0, seeds: [] };
    const a = pk.reasonOf(horror, { best: null, rb: 0, s: 0, a: 0.4, q: 0.3, n: 0.15, m: 0.6, r: 6.7 }, w, { f: { genre: { 27: -0.51 } }, names: {}, recentGenres: [] }, ans);
    const few = { k: 'movie:2', kp: 0, c: { type: 'movie', title: 'E', genres: [53, 80, 18], va: 7.4, vc: 239, dir: [], cast: [], names: {} }, src: 'disc', srcs: { disc: true }, seedHits: 0, seeds: [] };
    const b = pk.reasonOf(few, { best: null, rb: 0, s: 0, a: 0.5, q: 0.6, n: 0, m: 0.8, r: 7.4 }, w, { f: { genre: {} }, names: {}, recentGenres: [] }, ans);
    return { ok: !/^Что-то новое: ужасы/.test(a) && !/^Высокий рейтинг/.test(b), got: 'ужасы (нелюбимые): «' + a + '»; 239 голосов: «' + b + '»' };
  } },
  { id: 'P9a', title: 'IndexedDB не отвечает на чтение — подбор идёт дальше (сторож 8 с), а не ждёт до ошибки', fn: async () => {
    const env = makeEnv(Object.assign(baseWorld(), { idb: 'fake', idbDelay: 600000, idbData: { 'durable:journal': { t: 1, v: [{ id: 'old1' }] } } }));
    const t0 = env.clock.now;
    const r = await env.run(ANY, 120000);
    const sec = Math.round((env.clock.now - t0) / 1000);
    return { ok: !!r.st && !r.error && sec < 20, got: (r.error ? 'ошибка ' + r.error : (r.st ? 'готово' : 'нет результата')) + ' за ' + sec + ' с' };
  } },
  { id: 'P9b', title: 'Журнал не прочитался вовремя — старый журнал на диске не перезаписывается', fn: async () => {
    const env = makeEnv(Object.assign(baseWorld(), { idb: 'fake', idbDelay: 600000, idbData: { 'durable:journal': { t: 1, v: [{ id: 'old1' }, { id: 'old2' }] } } }));
    await env.run(ANY, 120000);
    await env.clock.advance(5000);
    const disk = env.idb.data['durable:journal'];
    const v = disk && disk.v;
    return { ok: Array.isArray(v) && v.length === 2 && v[0].id === 'old1', got: JSON.stringify(v) };
  } },
  { id: 'F27', title: 'poster_path с кавычками не ломает разметку', fn: async () => {
    const env = await tasteEnv('/x.jpg\')" onmouseover="alert(1)" data-x="');
    const n = env.$('[onmouseover]').length;
    return { ok: n === 0, got: 'элементов с onmouseover: ' + n };
  } },
  { id: 'F28', title: 'Экран журнала не пишет весь журнал в консоль', fn: async () => {
    const likes = []; for (let i = 0; i < 6; i++) likes.push(card(100 + i));
    const env = makeEnv({ fav: { like: likes } });
    env.pk.Durable.vals.journal = [{ id: env.clock.now, answers: 'a', counts: {}, shown: [], actions: [] }];
    const comp = new env.pk.PickerComponent({});
    env.w.document.body.appendChild(comp.create()[0]);
    env.$('.pkr-btn').filter(function () { return env.$(this).text().indexOf('Журнал') > -1; }).eq(0).trigger('hover:enter');
    await env.clock.advance(100);
    const n = env.log.console.filter(s => s.indexOf('[Picker] journal') === 0).length;
    return { ok: n === 0, got: 'выводов журнала в консоль: ' + n };
  } },
  { id: 'F29', title: 'diag() не показывает api_key', fn: async () => {
    const env = makeEnv();
    const rep = env.w.LampaPicker.diag();
    const s = JSON.stringify(rep);
    const leak = s.indexOf('PUBLICKEY') > -1;               // ключ из мока Lampa.TMDB.key()
    return { ok: !leak, got: leak ? 'в отчёте виден ключ TMDB' : 'ключ замаскирован' };
  } },
  { id: 'F30', title: 'Начатость видна по привязке к карточке, если сменилось название', fn: async () => {
    const env = makeEnv({ timelineFn: (h, meta) => (meta && meta.card === 'movie_201' ? { percent: 40, time: 2400, duration: 6000 } : null) });
    const started = env.pk.startedAny({ id: 201, title: 'Новое название', original_title: 'New Title' }, 'movie');
    return { ok: !!started, got: started ? 'видно' : 'не видно (view вызывается без привязки)' };
  } },
  { id: 'F31', title: 'Без Lampa.TMDB.api запросы не уходят на bylampa.online', fn: async () => {
    const { pk } = makeEnv({ noTmdbApi: true });
    const u = pk.tmdbUrl('movie/1', {});
    return { ok: u.indexOf('bylampa') < 0, got: u.replace(/api_key=[^&]+/, 'api_key=…') };
  } },
  { id: 'F31b', title: 'Без Lampa.TMDB.api: свой прокси из настроек → прокси CUB → напрямую (как в самой Lampa)', fn: async () => {
    const url = st => makeEnv({ noTmdbApi: true, storage: st }).pk.tmdbUrl('movie/1', {}).replace(/\?.*$/, '');
    const own = url({ proxy_tmdb: true, tmdb_proxy_api: 'my.proxy.example/' });
    const cub = url({ proxy_tmdb: true });
    const dir = url({});
    const ok = own === 'https://my.proxy.example/https://api.themoviedb.org/3/movie/1' && cub === 'https://apitmdb.cub.test/3/movie/1' && dir === 'https://api.themoviedb.org/3/movie/1';
    return { ok, got: [own, cub, dir].join(' | ') };
  } }
];

// ------------------------------------------------------------------ аудит 0.13.1 (AUDIT_lampa-picker_0.13.1.md)
CHECKS.push(
  { id: 'N1', title: 'Любитель анимации: семейный мультфильм не тонет в оценке настроения (−0,4)', fn: async () => {
    const { pk } = makeEnv();
    const prof = { n: 20, pos: 20, animShare: 0.6, f: { genre: {} } };
    const ans = { time: 'any', mood: 'any', company: 'solo' };
    const fam = pk.moodScore({ genres: [16, 10751], cert: null, moods: null }, ans, prof);
    const adv = pk.moodScore({ genres: [16, 12], cert: null, moods: null }, ans, prof);
    const pass = why(pk, item({ genres: [16, 10751], cert: certObj(pk, 'PG', '6+') }), { company: 'solo' }, { n: 20, pos: 20, animShare: 0.6, f: {} });
    return { ok: fam >= adv - 0.05, got: 'фильтр: ' + pass + '; M семейного ' + r2(fam) + ', M приключенческого ' + r2(adv) };
  } },
  { id: 'N2', title: 'reset() забывает и выученные «не мой жанр»', fn: async () => {
    const likes = []; for (let i = 0; i < 12; i++) likes.push(card(100 + i));
    const env = makeEnv({ fav: { like: likes } });
    const t = env.clock.now, rej = {};
    [900, 901, 902].forEach(id => { rej['movie:' + id] = { t, r: 'genre', card: { id, genre_ids: [27], method: 'movie' } }; });
    env.storage.picker_feedback = { rejected: rej, seen: {}, opened: {} };
    const before = (await env.profile()).profile.rejGenres || {};
    env.w.LampaPicker.reset();
    const after = (await env.profile()).profile.rejGenres || {};
    return { ok: !Object.keys(after).length, got: 'до reset: ' + JSON.stringify(before) + ', после: ' + JSON.stringify(after) };
  } },
  { id: 'N3', title: 'Смена профиля CUB (другие списки) не стирает даты знакомства прежнего профиля', fn: async () => {
    // Профиль А: 250 «Нравится» и 40 в истории, знакомы давно. Профиль Б: 25 других «Нравится»
    const A = []; for (let i = 0; i < 250; i++) A.push(card(1000 + i));
    const H = []; for (let i = 0; i < 40; i++) H.push(card(5000 + i));
    const B = []; for (let i = 0; i < 25; i++) B.push(card(8000 + i));
    const seen = {}, old = Date.now() - 400 * 864e5;
    A.forEach((c, i) => { seen['movie:' + c.id] = old + i * 864e5; });
    H.forEach((c, i) => { seen['movie:' + c.id] = old + i * 864e5; });
    const env = makeEnv({ fav: { like: A, history: H }, storage: { picker_seen: seen, picker_seen_init: old, account: { profile: { id: 1 } } } });
    env.pk.collect();                                          // профиль А
    env.storage.account = { profile: { id: 2 } };              // переключились на Б (как profile_select в Lampa)
    env.fav.like = B; env.fav.history = [];
    env.pk.collect();
    await env.clock.advance(864e5);                             // назавтра снова А
    env.storage.account = { profile: { id: 1 } };
    env.fav.like = A; env.fav.history = H;
    const ev = env.pk.collect();
    const kept = A.filter(c => (env.storage.picker_seen || {})['movie:' + c.id] === seen['movie:' + c.id]).length;
    const batch = ev.filter(e => e.batch).length;
    return { ok: kept === A.length, got: 'даты сохранились у ' + kept + ' из ' + A.length + ' «Нравится» профиля А; помечено пачкой: ' + batch };
  } },
  { id: 'N6', title: 'Второй профиль CUB: первый запуск на нём — импорт истории, а не «пачка» лайков', fn: async () => {
    const A = []; for (let i = 0; i < 50; i++) A.push(card(1000 + i));
    const B = []; for (let i = 0; i < 30; i++) B.push(card(8000 + i));
    const HB = []; for (let i = 0; i < 60; i++) HB.push(card(9000 + i));
    const env = makeEnv({ fav: { like: A }, storage: { account: { profile: { id: 1 } } } });
    env.pk.collect();                                          // первый запуск плагина — на профиле А
    await env.clock.advance(3 * 864e5);
    env.storage.account = { profile: { id: 2 } };              // через три дня — профиль Б со своей историей
    env.fav.like = B; env.fav.history = HB;
    const likes = env.pk.collect().filter(e => e.flags.like);
    const b = likes.filter(e => e.batch).length;
    return { ok: likes.length === 30 && b === 0, got: '«Нравится» профиля Б: ' + likes.length + ', пачкой ' + b + (b ? ' (вес ' + likes[0].s + ')' : '') };
  } },
  { id: 'N4', title: 'Отменённый подбор не шлёт новых запросов к КП', fn: async () => {
    const router = (url, p, def) => (url.indexOf('kinopoiskapiunofficial') > -1
      ? { delay: 1500, body: { items: [{ ratingKinopoisk: 7.5, ratingImdb: 7.2, kinopoiskId: 1 }] } } : def(url));
    const env = makeEnv(Object.assign(baseWorld(), { kp: true, router }));
    const kp = () => env.log.urls.filter(u => u.indexOf('kinopoiskapiunofficial') > -1).length;
    env.pk.run(ANY, { stage() {}, done() {}, error() {} });
    await env.clock.until(() => kp() > 0, 60000);
    const atCancel = kp();
    env.pk.cancelRun();                                        // «Назад» во время «Уточняю настроение и рейтинги»
    await env.clock.advance(10000);
    const after = kp() - atCancel;
    return { ok: after === 0, got: 'запросов к КП до отмены ' + atCancel + ', после отмены ещё ' + after };
  } },
  { id: 'N5', title: 'КП ушёл в офлайн — подбор не ждёт дедлайн впустую', fn: async () => {
    const env = makeEnv({ kp: true, router: (url, p, def) => (url.indexOf('kinopoisk') > -1 ? { status: 0 } : def(url)) });
    const list = Array.from({ length: 20 }, (_, i) => ({ k: 'movie:' + (3000 + i), id: 3000 + i, type: 'movie', score: 1 - i / 100,
      c: { id: 3000 + i, va: 7, vc: 5000, imdb: 'tt' + (3000 + i), title: 'F' } }));
    const t0 = env.clock.now;
    await env.cb(cb => env.pk.attachRatings(list, cb));
    const ms = env.clock.now - t0;
    return { ok: ms < 1500, got: 'офлайн КП: ' + !!(env.storage.picker_kp_off > env.clock.now) + ', подбор ждал ' + (ms / 1000) + ' с' };
  } },
  { id: 'N7', title: 'Кеш в памяти — LRU (как в DOCS): часто читаемое не вытесняется', fn: async () => {
    const { pk } = makeEnv();
    pk.Cache.set('hot', { v: 1 });
    for (let i = 0; i < 450; i++) { pk.Cache.set('k' + i, i); if (i % 10 === 0) pk.Cache.get('hot', 1e9, () => {}); }
    return { ok: !!pk.Cache.mem.hot, got: pk.Cache.mem.hot ? 'горячий ключ в памяти' : 'горячий ключ вытеснен (FIFO)' };
  } },
  { id: 'N8', title: 'Экран журнала без отладки не сериализует весь журнал', fn: async () => {
    const likes = []; for (let i = 0; i < 6; i++) likes.push(card(100 + i));
    const env = makeEnv({ fav: { like: likes } });
    env.pk.Durable.vals.journal = [{ id: env.clock.now, answers: 'a', counts: {}, shown: [], actions: [] }];
    let calls = 0; const orig = env.pk.Journal.exportText;
    env.pk.Journal.exportText = function () { calls++; return orig.apply(this, arguments); };
    const comp = new env.pk.PickerComponent({});
    env.w.document.body.appendChild(comp.create()[0]);
    env.$('.pkr-btn').filter(function () { return env.$(this).text().indexOf('Журнал') > -1; }).eq(0).trigger('hover:enter');
    await env.clock.advance(100);
    return { ok: calls === 0, got: 'exportText при открытии экрана: ' + calls };
  } }
);


CHECKS.push(
  { id: 'N17', title: '«С детьми»: возраст с КП — в том же бюджете подбора, что и оценки (≤ 12 запросов со встроенным ключом)', fn: async () => {
    const router = (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) {
        if (/films\/\d+$/.test(url)) return { delay: 50, body: { kinopoiskId: 1, ratingKinopoisk: 7, ratingAgeLimits: 'age6' } };
        return { delay: 50, body: { items: [{ kinopoiskId: 1 }] } };          // по IMDb: нашёлся, без оценок
      }
      return def(url);
    };
    const o = baseWorld({ kp: true, router });
    for (let i = 0; i < 40; i++) o.world.movies[300 + i] = movie(300 + i, { genre_ids: [10751, 12], cert: cert('PG-13', null) });
    const env = makeEnv(o);
    const r = await env.run({ time: 'any', mood: 'any', company: 'kids' });
    const n = env.log.urls.filter(u => u.indexOf('kinopoiskapiunofficial') > -1).length;
    return { ok: !!r.st && n <= 12, got: 'запросов к КП за один подбор: ' + n };
  } },
  { id: 'N17b', title: '«С детьми»: у фильма с российским рейтингом возраст на КП не спрашивается', fn: async () => {
    const urls = [];
    const env = makeEnv({ kp: true, router: (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) { urls.push(url); return { body: { kinopoiskId: 1, ratingAgeLimits: 'age6', items: [{ kinopoiskId: 1 }] } }; }
      return def(url);
    } });
    const list = [
      { k: 'movie:1', score: 1, c: { id: 1, type: 'movie', imdb: 'tt1', cert: { ru: '6+', us: 'PG' } } },
      { k: 'movie:2', score: 0.9, c: { id: 2, type: 'movie', imdb: 'tt2', cert: { us: 'PG-13' } } }
    ];
    await env.cb(cb => env.pk.attachKidsAge(list, cb));
    const askedRu = urls.some(u => u.indexOf('tt1') > -1);
    return { ok: !askedRu && list[1].c.kpAge === 6, got: 'с RU: ' + (askedRu ? 'спрошен' : 'не спрошен') + '; без RU: возраст КП ' + list[1].c.kpAge };
  } },
  { id: 'N12', title: 'КП ушёл в офлайн — задания из очереди сразу получают отказ, а не ждут дедлайн', fn: async () => {
    const env = makeEnv({ kp: true, router: (url, p, def) => (url.indexOf('kinopoisk') > -1 ? { delay: 200, status: 0 } : def(url)) });
    const mk = base => Array.from({ length: 10 }, (_, i) => ({ k: 'movie:' + (base + i), score: 1 - i / 100,
      c: { id: base + i, type: 'movie', va: 7, vc: 5000, imdb: 'tt' + (base + i), title: 'F', cert: { us: 'PG' } } }));
    const t0 = env.clock.now;
    let tA = 0, tB = 0;
    env.pk.attachRatings(mk(3000), () => { tA = env.clock.now - t0; });     // оценки и возраст идут одновременно —
    env.pk.attachKidsAge(mk(4000), () => { tB = env.clock.now - t0; });    // в очереди КП есть ждущие задания
    await env.clock.until(() => tA && tB, 20000);
    return { ok: tA < 1500 && tB < 1500, got: 'оценки закончили через ' + tA / 1000 + ' с, возраст — через ' + tB / 1000 + ' с' };
  } },
  { id: 'N13', title: 'Один зависший запрос КП — один сбой, а не два (КП не выключается на час)', fn: async () => {
    let n = 0;
    const env = makeEnv({ kp: true, router: (url, p, def) => {
      if (url.indexOf('kinopoiskapiunofficial') > -1) { n++; return { delay: 6000, status: 0, ignoreTimeout: true }; }
      return def(url);
    } });
    env.pk.fetchRatings({ k: 'movie:5', c: { id: 5, type: 'movie', imdb: 'tt5', title: 'X', original: 'X', year: '2014', va: 7 } }, () => {});
    await env.clock.advance(8000);
    const off = env.storage.picker_kp_off > env.clock.now;
    return { ok: n === 1 && !off, got: 'запросов ' + n + ', КП выключен на час: ' + (off ? 'да' : 'нет') };
  } }
);
module.exports = CHECKS;
