// Stockfish (asm.js, mono-thread) piloté en UCI dans un Worker + analyse de partie.
import { Chess } from './vendor/chess.js';
import * as M from './metrics.js';

const SF_URL = 'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js';

let worker = null;
let handlers = [];
let cancelled = false;

function send(cmd) { worker.postMessage(cmd); }

function waitFor(pred) {
  return new Promise(res => {
    const h = line => { if (pred(line)) { handlers = handlers.filter(x => x !== h); res(line); } };
    handlers.push(h);
  });
}

// Un Worker ne peut pas charger un script cross-origin : on récupère la source
// et on la passe par un blob (même origine).
export async function initEngine(onStatus) {
  if (worker) return;
  if (onStatus) onStatus('Téléchargement du moteur (~1,6 Mo, une seule fois)…');
  const src = await fetch(SF_URL).then(r => {
    if (!r.ok) throw new Error('moteur indisponible (' + r.status + ')');
    return r.text();
  });
  worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  worker.onmessage = e => {
    const line = typeof e.data === 'string' ? e.data : (e.data && e.data.line) || '';
    for (const h of handlers.slice()) h(line);
  };
  if (onStatus) onStatus('Démarrage du moteur…');
  send('uci');
  await waitFor(l => l === 'uciok');
  send('isready');
  await waitFor(l => l === 'readyok');
}

export function cancelAnalysis() {
  cancelled = true;
  if (worker) send('stop');
}

function terminal(fen) {
  const c = new Chess(fen);
  if (!c.isGameOver()) return null;
  return { score: c.isCheckmate() ? { mate: -1 } : { cp: 0 }, best: null, pv: [] };
}

export function evalPosition(fen, depth) {
  const end = terminal(fen);
  if (end) return Promise.resolve(end);
  return new Promise(res => {
    let score = null, pv = [];
    const h = line => {
      if (line.startsWith('info') && line.indexOf(' score ') > -1) {
        const s = /score (cp|mate) (-?\d+)/.exec(line);
        if (s) score = s[1] === 'cp' ? { cp: +s[2] } : { mate: +s[2] };
        const p = / pv (.+)$/.exec(line);
        if (p) pv = p[1].trim().split(/\s+/);
      } else if (line.startsWith('bestmove')) {
        handlers = handlers.filter(x => x !== h);
        const best = line.split(/\s+/)[1];
        res({ score, pv, best: best === '(none)' ? null : best });
      }
    };
    handlers.push(h);
    send('position fen ' + fen);
    send('go depth ' + depth);
  });
}

function moveInfo(fen, uci) {
  if (!uci) return null;
  try {
    const c = new Chess(fen);
    const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return mv ? { san: mv.san, captured: mv.captured || null, from: mv.from, to: mv.to } : null;
  } catch (_) { return null; }
}

// Horodatages chess.com : un {[%clk ...]} par demi-coup, dans l'ordre.
function clockSeconds(pgn) {
  return [...pgn.matchAll(/\[%clk ([0-9:.]+)\]/g)].map(m => M.parseClock(m[1]));
}

/**
 * Analyse une partie. `color` = 'w'|'b' = le joueur étudié.
 * Une seule évaluation par position : l'éval après le coup N est aussi
 * l'éval avant le coup N+1.
 */
export async function analyzeGame(pgn, color, depth, onProgress) {
  cancelled = false;
  const chess = new Chess();
  chess.loadPgn(pgn);
  const hist = chess.history({ verbose: true });
  if (!hist.length) throw new Error('partie vide');

  const headers = chess.getHeaders();
  const inc = M.incrementOf(headers.TimeControl);
  // "600+5" -> 600, "180" -> 180, "1/86400" (par correspondance) -> pas de temps par coup
  const base = /\//.test(headers.TimeControl || '') ? 0 : parseInt(headers.TimeControl, 10) || 0;
  const clocks = clockSeconds(pgn);
  const positions = [hist[0].before, ...hist.map(h => h.after)];

  send('ucinewgame');
  send('isready');
  await waitFor(l => l === 'readyok');

  const evals = [];
  for (let i = 0; i < positions.length; i++) {
    if (cancelled) return null;
    if (onProgress) onProgress(i, positions.length);
    evals.push(await evalPosition(positions[i], depth));
  }
  if (onProgress) onProgress(positions.length, positions.length);

  const plies = hist.map((h, i) => {
    // cp du point de vue de celui qui joue le coup i
    const cpBefore = M.scoreToCp(evals[i].score);
    const cpAfter = -M.scoreToCp(evals[i + 1].score);
    const wpLoss = Math.max(0, M.winPct(cpBefore) - M.winPct(cpAfter));
    const isBest = evals[i].best === h.lan;
    const best = isBest ? null : moveInfo(h.before, evals[i].best);
    const reply = evals[i + 1].best ? moveInfo(h.after, evals[i + 1].best) : null;
    const tag = M.classify(wpLoss, isBest);

    // ponytail: heuristique simple (mat annoncé / capture d'une pièce >= cavalier).
    // Ne distingue pas une pièce vraiment indéfendue d'un simple échange ;
    // suffisant pour nommer la faute au joueur.
    let threat = null;
    if (tag === 'gaffe' || tag === 'erreur' || tag === 'imprecision') {
      const before = evals[i].score, after = evals[i + 1].score;
      const mateAllowed = after && after.mate !== undefined && after.mate > 0;
      const mateMissed = before && before.mate !== undefined && before.mate > 0;
      if (mateAllowed) threat = 'mat';
      else if (mateMissed) threat = 'mat_manque';
      else if (reply && reply.captured && M.PIECE_VAL[reply.captured] >= 3) threat = 'prise';
      else if (best && best.captured && M.PIECE_VAL[best.captured] >= 3) threat = 'gain_manque';
    }

    let secs = null;
    if (clocks.length === hist.length && base) {
      const prev = i >= 2 ? clocks[i - 2] : base;
      secs = Math.max(0, Math.round((prev - clocks[i] + (i >= 2 ? inc : 0)) * 10) / 10);
    }

    return {
      n: i, moveNo: Math.floor(i / 2) + 1, color: h.color, san: h.san, lan: h.lan,
      from: h.from, to: h.to, fenBefore: h.before, fenAfter: h.after,
      cpBefore, cpAfter, cpLoss: Math.max(0, cpBefore - cpAfter), wpLoss, tag,
      best: best ? best.san : null, bestFrom: best ? best.from : null, bestTo: best ? best.to : null,
      replySan: reply ? reply.san : null,
      phase: M.phaseOf(h.before, i), secs, threat,
    };
  });

  const summary = M.summarize(plies, color);
  return { pgn, color, plies, summary, headers, startFen: positions[0] };
}
