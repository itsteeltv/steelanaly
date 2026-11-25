import { Chess } from './vendor/chess.js';
import * as M from './metrics.js';
import { initEngine, analyzeGame, cancelAnalysis } from './engine.js';

const API = 'https://api.chess.com/pub/player/';
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (x, t) => (t ? (100 * x / t).toFixed(0) : '0');

const state = { user: '', metas: [], view: [], ana: null, ply: 0, flip: false, depth: 11 };

function status(msg, isErr) {
  const el = $('#status');
  el.textContent = msg || '';
  el.classList.toggle('err', !!isErr);
}

async function json(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status === 404 ? 'pseudo introuvable sur chess.com' : 'erreur réseau ' + r.status);
  return r.json();
}

/* ---------------------------------------------------------- chargement ---- */

const z = () => ({ n: 0, w: 0, l: 0, d: 0 });

function meta(g, user) {
  const color = g.white.username.toLowerCase() === user ? 'w' : 'b';
  const me = color === 'w' ? g.white : g.black;
  const opp = color === 'w' ? g.black : g.white;
  const outcome = me.result === 'win' ? 'w' : M.DRAWS.has(me.result) ? 'd' : 'l';
  return {
    g, color, me, opp, outcome,
    reason: outcome === 'w' ? opp.result : me.result,
    opening: M.openingName(g.pgn),
    date: new Date(g.end_time * 1000),
    cls: g.time_class,
    acc: g.accuracies ? (color === 'w' ? g.accuracies.white : g.accuracies.black) : null,
  };
}

async function load(user, months) {
  status('Recherche du compte…');
  const [prof, stats] = await Promise.all([json(API + user), json(API + user + '/stats').catch(() => ({}))]);
  renderProfile(prof, stats);

  const arch = await json(API + user + '/games/archives');
  const urls = arch.archives.slice(-months);
  if (!urls.length) throw new Error('aucune partie publique sur ce compte');

  const games = [];
  for (let i = 0; i < urls.length; i++) {
    status('Téléchargement ' + (i + 1) + '/' + urls.length + '… (' + games.length + ' parties)');
    const m = await json(urls[i]);
    for (const g of m.games) if (g.rules === 'chess' && g.pgn) games.push(g);
  }
  games.sort((a, b) => b.end_time - a.end_time);
  state.user = user;
  state.metas = games.map(g => meta(g, user));
  status(state.metas.length + ' parties chargées.');
}

function renderProfile(p, stats) {
  const bits = [];
  if (p.name) bits.push('<b>' + esc(p.name) + '</b>');
  bits.push('@' + esc(p.username));
  for (const [k, lab] of [['chess_bullet', 'bullet'], ['chess_blitz', 'blitz'], ['chess_rapid', 'rapide'], ['chess_daily', 'corresp.']]) {
    const r = stats[k] && stats[k].last && stats[k].last.rating;
    if (r) bits.push(lab + ' <b>' + r + '</b>');
  }
  $('#profile').innerHTML = bits.join(' · ');
}

/* ------------------------------------------------------- rapport global ---- */

function aggregate(list) {
  const a = { n: 0, w: 0, l: 0, d: 0, byColor: { w: z(), b: z() }, byClass: {}, lossReasons: {}, winReasons: {}, openings: new Map(), accSum: 0, accN: 0 };
  for (const m of list) {
    a.n++; a[m.outcome]++;
    const c = a.byColor[m.color]; c.n++; c[m.outcome]++;
    const k = a.byClass[m.cls] || (a.byClass[m.cls] = z()); k.n++; k[m.outcome]++;
    const bucket = m.outcome === 'w' ? a.winReasons : m.outcome === 'l' ? a.lossReasons : null;
    if (bucket) bucket[m.reason] = (bucket[m.reason] || 0) + 1;
    const o = a.openings.get(m.opening) || z(); o.n++; o[m.outcome]++; a.openings.set(m.opening, o);
    if (m.acc != null) { a.accSum += m.acc; a.accN++; }
  }
  return a;
}

const card = (v, lab) => '<div class="card"><b>' + v + '</b><span>' + lab + '</span></div>';

const adviceHtml = list => list.map(x =>
  '<li><b>' + esc(x.t) + '</b>' +
  (x.why ? '<p><span class="lbl">Pourquoi</span>' + esc(x.why) + '</p>' : '') +
  (x.how ? '<p><span class="lbl ok">Comment corriger</span>' + esc(x.how) + '</p>' : '') +
  '</li>').join('');

function renderReport() {
  const a = aggregate(state.metas);
  $('#reportCount').textContent = '(' + a.n + ' parties, ' + state.user + ')';
  $('#cards').innerHTML = [
    card(a.n, 'parties'),
    card(pct(a.w + a.d / 2, a.n) + ' %', 'score'),
    card('<span class="res-w">' + a.w + '</span>/<span class="res-d">' + a.d + '</span>/<span class="res-l">' + a.l + '</span>', 'v / n / d'),
    card(pct(a.byColor.w.w + a.byColor.w.d / 2, a.byColor.w.n) + ' %', 'score blancs'),
    card(pct(a.byColor.b.w + a.byColor.b.d / 2, a.byColor.b.n) + ' %', 'score noirs'),
    a.accN ? card((a.accSum / a.accN).toFixed(1) + ' %', 'précision chess.com') : '',
  ].join('');

  const ops = [...a.openings.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 12);
  $('#openings').innerHTML = '<thead><tr><th>Ouverture</th><th class="num">n</th><th class="num">V</th><th class="num">N</th><th class="num">D</th><th class="num">score</th></tr></thead><tbody>' +
    ops.map(([k, o]) => '<tr><td>' + esc(k) + '</td><td class="num">' + o.n + '</td><td class="num res-w">' + o.w + '</td><td class="num res-d">' + o.d + '</td><td class="num res-l">' + o.l + '</td><td class="num">' + pct(o.w + o.d / 2, o.n) + ' %</td></tr>').join('') +
    '</tbody>';

  const rows = (obj, cls, lab, tot) => Object.entries(obj).sort((x, y) => y[1] - x[1])
    .map(([k, v]) => '<tr><td class="nw ' + cls + '">' + lab + '</td><td>' + esc(M.REASONS[k] || k) + '</td><td class="num">' + v + '</td><td class="num">' + pct(v, tot) + ' %</td></tr>').join('');
  $('#reasons').innerHTML = '<thead><tr><th>Issue</th><th>Fin de partie</th><th class="num">n</th><th class="num">%</th></tr></thead><tbody>' +
    rows(a.lossReasons, 'res-l', 'défaite', a.l) + rows(a.winReasons, 'res-w', 'victoire', a.w) + '</tbody>';

  $('#globalAdvice').innerHTML = adviceHtml(M.globalAdvice(a));
  $('#reportSec').hidden = false;
}

/* ------------------------------------------------------ liste de parties ---- */

const RES = { w: 'gagné', l: 'perdu', d: 'nulle' };

function applyFilters() {
  const c = $('#fClass').value, col = $('#fColor').value, r = $('#fRes').value;
  const op = $('#fOpening').value.trim().toLowerCase();
  state.view = state.metas.filter(m =>
    (!c || m.cls === c) && (!col || m.color === col) && (!r || m.outcome === r) &&
    (!op || m.opening.toLowerCase().includes(op)));
}

function renderGames() {
  applyFilters();
  $('#gamesCount').textContent = '(' + state.view.length + ' affichées sur ' + state.metas.length + ')';
  const rows = state.view.slice(0, 300).map((m, i) => {
    const cached = cacheGet(m);
    return '<tr data-i="' + i + '">' +
      '<td class="nw">' + m.date.toLocaleDateString('fr-FR') + '</td>' +
      '<td class="nw">' + esc(m.cls) + '</td>' +
      '<td class="nw">' + (m.color === 'w' ? 'blancs' : 'noirs') + '</td>' +
      '<td>' + esc(m.opp.username) + ' <span class="muted">' + (m.opp.rating || '') + '</span></td>' +
      '<td class="nw res-' + m.outcome + '">' + RES[m.outcome] + ' <span class="muted">' + esc(M.REASONS[m.reason] || m.reason) + '</span></td>' +
      '<td class="num">' + (m.acc != null ? m.acc.toFixed(1) : '—') + '</td>' +
      '<td class="num">' + (cached ? cached.summary.accuracy.toFixed(1) + ' %' : '—') + '</td>' +
      '<td>' + esc(m.opening) + '</td>' +
      '<td class="nw"><button type="button" data-open="' + i + '">voir</button></td></tr>';
  }).join('');
  $('#games').innerHTML = '<thead><tr><th>Date</th><th>Cadence</th><th>Couleur</th><th>Adversaire</th><th>Résultat</th><th class="num">préc. c.com</th><th class="num">préc. moteur</th><th>Ouverture</th><th></th></tr></thead><tbody>' + rows + '</tbody>';
  $('#gamesSec').hidden = false;
  $('#batchSec').hidden = false;
}

/* ---------------------------------------------------------------- cache ---- */

const key = (m, depth) => 'sfa:' + m.g.url + ':' + (depth || state.depth);

function cacheGet(m, depth) {
  try { return JSON.parse(localStorage.getItem(key(m, depth)) || 'null'); } catch (_) { return null; }
}

function cacheSet(m, depth, res) {
  try {
    localStorage.setItem(key(m, depth), JSON.stringify({ color: res.color, plies: res.plies, summary: res.summary }));
  } catch (_) {
    // quota plein : on vide les analyses les plus anciennes et on réessaie une fois
    for (const k of Object.keys(localStorage)) if (k.startsWith('sfa:')) localStorage.removeItem(k);
    try { localStorage.setItem(key(m, depth), JSON.stringify({ color: res.color, plies: res.plies, summary: res.summary })); } catch (_) {}
  }
}

/* ------------------------------------------------------- analyse moteur ---- */

let running = false;

async function runBatch() {
  if (running) return;
  state.depth = +$('#depth').value;
  const targets = state.view.slice(0, +$('#batchN').value).filter(m => !cacheGet(m));
  if (!targets.length) { status('Ces parties sont déjà analysées à cette profondeur.'); renderPooled(); return; }

  running = true;
  $('#runBatch').disabled = true;
  $('#stopBatch').hidden = false;
  $('#prog').hidden = false;
  try {
    await initEngine(status);
    for (let i = 0; i < targets.length; i++) {
      const m = targets[i];
      status('Analyse ' + (i + 1) + '/' + targets.length + ' — ' + m.opp.username + ' (profondeur ' + state.depth + ')');
      const res = await analyzeGame(m.g.pgn, m.color, state.depth, (done, total) => {
        $('#prog').max = total; $('#prog').value = done;
        $('#progTxt').textContent = 'coup ' + done + '/' + total;
      });
      if (!res) { status('Analyse interrompue.'); break; }
      cacheSet(m, state.depth, res);
      renderPooled();
      renderGames();
    }
    if (!$('#status').textContent.startsWith('Analyse interrompue')) status('Analyse terminée.');
  } catch (e) {
    status(e.message, true);
  } finally {
    running = false;
    $('#runBatch').disabled = false;
    $('#stopBatch').hidden = true;
    $('#prog').hidden = true;
    $('#progTxt').textContent = '';
  }
}

// Met toutes les analyses en cache dans un seul sac de demi-coups "les miens",
// pour sortir les tendances sur plusieurs parties.
function renderPooled() {
  const pool = [];
  let games = 0, lostWinning = 0, accSum = 0;
  for (const m of state.metas) {
    const c = cacheGet(m);
    if (!c) continue;
    games++;
    accSum += c.summary.accuracy;
    if (m.outcome === 'l' && c.summary.peak >= 200) lostWinning++;
    for (const p of c.plies) if (p.color === c.color) pool.push(Object.assign({}, p, { color: 'w' }));
  }
  if (!games) { $('#pooled').hidden = true; return; }

  const s = M.summarize(pool, 'w');
  $('#pooledCount').textContent = '(' + games + ' parties, ' + s.moves + ' coups)';
  $('#pooledCards').innerHTML = [
    card(s.accuracy.toFixed(1) + ' %', 'précision'),
    card(s.acpl, 'cp perdus / coup'),
    card((s.counts.gaffe / games).toFixed(1), 'gaffes / partie'),
    card((s.counts.erreur / games).toFixed(1), 'erreurs / partie'),
    card(s.phases.ouverture.acpl + ' / ' + s.phases.milieu.acpl + ' / ' + s.phases.finale.acpl, 'cp ouv / mil / fin'),
  ].join('');

  const list = M.advice(s, {});
  if (lostWinning >= 2) list.unshift({
    t: lostWinning + ' parties perdues depuis une position gagnante',
    why: "C'est ta fuite principale : tu obtiens l'avantage mais tu ne sais pas le transformer. Avec du matériel en plus on veut finir vite, on cherche le coup brillant, et on redonne du contre-jeu.",
    how: 'Méthode de conversion : échange les pièces (pas les pions), garde le roi adverse passif, ramène toutes tes pièces avant d\'attaquer, et accepte de jouer 20 coups techniques sans rien forcer.',
  });
  $('#pooledAdvice').innerHTML = adviceHtml(list);
  $('#pooled').hidden = false;
}

/* --------------------------------------------------------- vue d'une partie ---- */

const GLYPH = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
const FILES = 'abcdefgh';
const BADGED = new Set(['meilleur', 'imprecision', 'erreur', 'gaffe']);

function fmtCp(cp) {
  if (cp >= M.MATE_CP) return '#';
  if (cp <= -M.MATE_CP) return '-#';
  return (cp > 0 ? '+' : '') + (cp / 100).toFixed(2);
}

function renderBoard(fen, hl) {
  const rows = fen.split(' ')[0].split('/');
  const grid = rows.map(row => {
    const out = [];
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') for (let i = 0; i < +ch; i++) out.push(null);
      else out.push(ch);
    }
    return out;
  });
  let html = '';
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const r = state.flip ? 7 - i : i;      // r = 0 -> 8e rangée
      const c = state.flip ? 7 - j : j;
      const sq = FILES[c] + (8 - r);
      const p = grid[r][c];
      const cls = ['sq', (r + c) % 2 ? 'd' : 'l'];
      if (p) cls.push(p === p.toUpperCase() ? 'w' : 'b');
      if (hl && (hl.from === sq || hl.to === sq)) cls.push('played');
      else if (hl && (hl.bFrom === sq || hl.bTo === sq)) cls.push('best');
      // coordonnées dans les coins, comme sur chess.com
      const coord = (i === 7 ? ' data-f="' + FILES[c] + '"' : '') + (j === 0 ? ' data-r="' + (8 - r) + '"' : '');
      const badge = hl && hl.to === sq && hl.tag && BADGED.has(hl.tag)
        ? '<i class="badge t-' + hl.tag + '">' + (M.TAGS[hl.tag].sym || '') + '</i>' : '';
      html += '<div class="' + cls.join(' ') + '"' + coord + '>' +
        (p ? '<span class="pc">' + GLYPH[p.toLowerCase()] + '</span>' : '') + badge + '</div>';
    }
  }
  $('#board').innerHTML = html;
}

function openGame(m) {
  const cached = cacheGet(m);
  const chess = new Chess();
  chess.loadPgn(m.g.pgn);
  const hist = chess.history({ verbose: true });

  state.ana = {
    m, hist,
    plies: cached ? cached.plies : null,
    summary: cached ? cached.summary : null,
    startFen: hist.length ? hist[0].before : new Chess().fen(),
  };
  state.flip = m.color === 'b';
  state.ply = hist.length;

  $('#gameTitle').innerHTML = esc(m.g.white.username) + ' (' + (m.g.white.rating || '?') + ') — ' +
    esc(m.g.black.username) + ' (' + (m.g.black.rating || '?') + ') · ' + esc(m.cls) + ' · ' +
    m.date.toLocaleDateString('fr-FR') + ' · <span class="res-' + m.outcome + '">' + RES[m.outcome] + '</span>' +
    (cached ? '' : ' <small>— non analysée, lance l\'analyse moteur ci-dessus</small>');
  $('#chesscom').href = m.g.url;

  renderMoves();
  renderGameSummary();
  goTo(state.ply);
  $('#gameSec').hidden = false;
  $('#gameSec').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderMoves() {
  const { hist, plies } = state.ana;
  let html = '<thead><tr><th>#</th><th>blancs</th><th>noirs</th></tr></thead><tbody>';
  for (let i = 0; i < hist.length; i += 2) {
    html += '<tr><td class="muted">' + (i / 2 + 1) + '</td>' + cell(i) + cell(i + 1) + '</tr>';
  }
  $('#moves').innerHTML = html + '</tbody>';

  function cell(i) {
    if (i >= hist.length) return '<td></td>';
    const p = plies && plies[i];
    const tag = p ? ' class="san t-' + p.tag + '" ' : ' class="san" ';
    const sym = p && p.tag !== 'bon' && p.tag !== 'meilleur' ? ' ' + M.TAGS[p.tag].sym : '';
    // éval après le coup, toujours du point de vue des blancs
    const ev = p ? '<span class="ev">' + fmtCp(p.color === 'w' ? p.cpAfter : -p.cpAfter) + '</span>' : '';
    return '<td' + tag + 'data-ply="' + (i + 1) + '">' + esc(hist[i].san) + sym + ev + '</td>';
  }
}

function goTo(ply) {
  const { hist, plies, startFen } = state.ana;
  state.ply = Math.max(0, Math.min(hist.length, ply));
  const i = state.ply - 1;
  const fen = state.ply === 0 ? startFen : hist[i].after;
  const p = plies && i >= 0 ? plies[i] : null;
  renderBoard(fen, i >= 0 ? {
    from: hist[i].from, to: hist[i].to,
    bFrom: p && p.bestFrom, bTo: p && p.bestTo,
    tag: p && p.tag,
  } : null);

  const cpWhite = p ? (p.color === 'w' ? p.cpAfter : -p.cpAfter) : 0;
  $('#evalFill').style.width = M.winPct(cpWhite).toFixed(1) + '%';

  let txt = '';
  if (p) {
    txt = '<div class="ply-head"><b>' + (p.moveNo) + (p.color === 'w' ? '. ' : '... ') + esc(p.san) + '</b>' +
      '<span class="pill t-' + p.tag + '">' + (M.TAGS[p.tag].sym ? M.TAGS[p.tag].sym + ' ' : '') + M.TAGS[p.tag].label + '</span>' +
      '<span class="muted">éval ' + fmtCp(p.cpBefore) + ' → ' + fmtCp(p.cpAfter) +
      (p.secs != null ? ' · ' + p.secs + ' s' : '') + '</span></div>';
    if (p.best) txt += '<p class="tip">À jouer : <b class="t-meilleur">' + esc(p.best) + '</b>' +
      (p.replySan ? ' <span class="muted">— après ton coup, sa meilleure réponse est ' + esc(p.replySan) + '</span>' : '') + '</p>';
    const mo = p.threat && M.MOTIFS[p.threat];
    if (mo) txt += '<div class="motif"><b class="t-' + p.tag + '">' + esc(mo.label) + '</b>' +
      '<p><span class="lbl">Pourquoi</span>' + esc(mo.why) + '</p>' +
      '<p><span class="lbl ok">Comment corriger</span>' + esc(mo.how) + '</p></div>';
  } else if (state.ply > 0) {
    txt = '<b>' + esc(hist[i].san) + '</b> <span class="muted">(partie non analysée)</span>';
  } else {
    txt = '<span class="muted">Position de départ.</span>';
  }
  $('#plyInfo').innerHTML = txt;

  for (const td of $('#moves').querySelectorAll('td.san')) td.parentElement.classList.remove('sel');
  const sel = $('#moves').querySelector('td[data-ply="' + state.ply + '"]');
  if (sel) { sel.parentElement.classList.add('sel'); sel.scrollIntoView({ block: 'nearest' }); }
}

function renderGameSummary() {
  const { summary: s, m } = state.ana;
  if (!s) {
    $('#gameCards').innerHTML = '<p class="muted">Pas encore analysée par le moteur.</p>';
    $('#phases').innerHTML = ''; $('#gameAdvice').innerHTML = ''; $('#worst').innerHTML = '';
    return;
  }
  $('#gameCards').innerHTML = [
    card(s.accuracy.toFixed(1) + ' %', 'précision'),
    card(s.acpl, 'cp perdus / coup'),
    card('<span class="t-gaffe">' + s.counts.gaffe + '</span>', 'gaffes'),
    card('<span class="t-erreur">' + s.counts.erreur + '</span>', 'erreurs'),
    card('<span class="t-imprecision">' + s.counts.imprecision + '</span>', 'imprécisions'),
    card('<span class="t-meilleur">' + s.counts.meilleur + '</span>', 'meilleurs coups'),
  ].join('');

  $('#phases').innerHTML = '<thead><tr><th>Phase</th><th class="num">coups</th><th class="num">cp perdus/coup</th><th class="num">fautes</th></tr></thead><tbody>' +
    Object.entries(s.phases).map(([k, p]) => '<tr><td>' + k + '</td><td class="num">' + p.n + '</td><td class="num">' + p.acpl + '</td><td class="num">' + p.bad + '</td></tr>').join('') + '</tbody>';

  $('#gameAdvice').innerHTML = adviceHtml(M.advice(s, { outcome: m.outcome }));

  $('#worst').innerHTML = s.worst.map(p => '<li data-ply="' + (p.n + 1) + '">' +
    p.moveNo + (p.color === 'w' ? '. ' : '... ') + esc(p.san) +
    ' <span class="t-' + p.tag + '">' + M.TAGS[p.tag].sym + '</span> ' +
    fmtCp(p.cpBefore) + ' → ' + fmtCp(p.cpAfter) +
    (p.best ? ' · à jouer : <b>' + esc(p.best) + '</b>' : '') + '</li>').join('') ||
    '<li class="muted">Aucune faute notable.</li>';
}

/* ----------------------------------------------------------- événements ---- */

$('#load').addEventListener('submit', async e => {
  e.preventDefault();
  const user = $('#user').value.trim().toLowerCase();
  if (!user) return;
  localStorage.setItem('sfa:user', user);
  try {
    await load(user, +$('#months').value);
    const classes = [...new Set(state.metas.map(m => m.cls))];
    $('#fClass').innerHTML = '<option value="">toutes cadences</option>' +
      classes.map(c => '<option value="' + c + '">' + c + '</option>').join('');
    renderReport();
    renderGames();
    renderPooled();
  } catch (err) {
    status(err.message, true);
  }
});

for (const id of ['#fClass', '#fColor', '#fRes', '#fOpening']) $(id).addEventListener('input', renderGames);

// La profondeur fait partie de la clé de cache : on réaffiche ce qui existe pour elle.
$('#depth').addEventListener('change', () => {
  state.depth = +$('#depth').value;
  if (state.metas.length) { renderGames(); renderPooled(); }
});

$('#games').addEventListener('click', e => {
  const btn = e.target.closest('[data-open]');
  const tr = e.target.closest('tr[data-i]');
  const i = btn ? +btn.dataset.open : tr ? +tr.dataset.i : -1;
  if (i >= 0) openGame(state.view[i]);
});

$('#moves').addEventListener('click', e => {
  const td = e.target.closest('td[data-ply]');
  if (td) goTo(+td.dataset.ply);
});

$('#worst').addEventListener('click', e => {
  const li = e.target.closest('li[data-ply]');
  if (li) goTo(+li.dataset.ply);
});

$('#first').onclick = () => goTo(0);
$('#prev').onclick = () => goTo(state.ply - 1);
$('#next').onclick = () => goTo(state.ply + 1);
$('#last').onclick = () => goTo(state.ana.hist.length);
$('#flip').onclick = () => { state.flip = !state.flip; goTo(state.ply); };
$('#runBatch').onclick = runBatch;
$('#stopBatch').onclick = cancelAnalysis;

document.addEventListener('keydown', e => {
  if (!state.ana || /INPUT|SELECT/.test(e.target.tagName)) return;
  if (e.key === 'ArrowLeft') goTo(state.ply - 1);
  else if (e.key === 'ArrowRight') goTo(state.ply + 1);
  else return;
  e.preventDefault();
});

$('#user').value = localStorage.getItem('sfa:user') || '';
