// Vérification du calcul d'analyse : `node test.mjs`
import assert from 'node:assert/strict';
import * as M from './metrics.js';

// scores -> centipawns bornés
assert.equal(M.scoreToCp({ cp: 42 }), 42);
assert.equal(M.scoreToCp({ cp: 99999 }), M.MATE_CP);
assert.equal(M.scoreToCp({ mate: 3 }), M.MATE_CP);
assert.equal(M.scoreToCp({ mate: -1 }), -M.MATE_CP);
assert.equal(M.scoreToCp(null), 0);

// probabilité de gain
assert.equal(M.winPct(0).toFixed(6), '50.000000');
assert.ok(M.winPct(300) > M.winPct(100) && M.winPct(100) > M.winPct(-100));
assert.ok(M.winPct(M.MATE_CP) > 97 && M.winPct(-M.MATE_CP) < 3);

// classement des coups : le meilleur coup n'est jamais une faute, même en position perdue
assert.equal(M.classify(35, true), 'meilleur');
assert.equal(M.classify(25, false), 'gaffe');
assert.equal(M.classify(10, false), 'erreur');
assert.equal(M.classify(5, false), 'imprecision');
assert.equal(M.classify(4.9, false), 'bon');

// précision
assert.ok(M.accuracy(0) > 99.9 && M.accuracy(0) <= 100);
assert.ok(M.accuracy(5) > M.accuracy(15));
assert.ok(M.accuracy(500) >= 0);

// phases
const FULL = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ENDG = '8/5k2/8/5p1p/4b3/R7/PP1B1K1P/8 b - - 0 40';
assert.equal(M.phaseOf(FULL, 4), 'ouverture');
assert.equal(M.phaseOf(FULL, 30), 'milieu');
assert.equal(M.phaseOf(ENDG, 30), 'finale');

// horloges et cadences
assert.equal(M.parseClock('0:02:59.9'), 179.9);
assert.equal(M.parseClock('2:30'), 150);
assert.equal(M.incrementOf('600+5'), 5);
assert.equal(M.incrementOf('180'), 0);

// ouvertures
assert.equal(
  M.openingName('[ECOUrl "https://www.chess.com/openings/Closed-Sicilian-Defense-Grand-Prix-Attack-3...g6-4.Bc4"]'),
  'Closed Sicilian Defense Grand Prix Attack');
assert.equal(M.openingName('rien'), 'Inconnue');

// synthèse + conseils
const ply = (o) => Object.assign({
  color: 'w', tag: 'bon', cpLoss: 0, wpLoss: 0, cpBefore: 0, phase: 'milieu', secs: 20,
  threat: null, san: 'Nf3', moveNo: 1, n: 0,
}, o);

const plies = [
  ply({ tag: 'meilleur' }),
  ply({ tag: 'gaffe', cpLoss: 400, wpLoss: 30, threat: 'prise', secs: 2, cpBefore: 250 }),
  ply({ tag: 'erreur', cpLoss: 200, wpLoss: 12, threat: 'prise', secs: 3, phase: 'finale' }),
  ply({ tag: 'imprecision', cpLoss: 80, wpLoss: 6 }),
  ply({ color: 'b', tag: 'gaffe', cpLoss: 900, wpLoss: 40 }), // adversaire : ignoré
];

const s = M.summarize(plies, 'w');
assert.equal(s.moves, 4, 'seuls mes demi-coups comptent');
assert.equal(s.counts.gaffe, 1);
assert.equal(s.counts.erreur, 1);
assert.equal(s.acpl, Math.round((400 + 200 + 80) / 4));
assert.equal(s.motifs.prise, 2, 'deux pièces laissées en prise');
assert.equal(s.motifs.mat, 0);
assert.equal(s.fastBad, 2, 'deux fautes jouées en moins de 5 s');
assert.equal(s.peak, 250);
assert.equal(s.phases.finale.n, 1);
assert.equal(s.worst[0].tag, 'gaffe', 'les coups les plus coûteux viennent en premier');
assert.equal(s.worst.length, 3, 'les coups corrects ne sont pas listés');

const a = M.advice(s, { outcome: 'l' });
assert.ok(a.some(x => /en prise/.test(x.t)), 'le matériel en prise doit être signalé');
assert.ok(a.some(x => /moins de 5 secondes/.test(x.t)), 'le jeu trop rapide doit être signalé');
assert.ok(a.some(x => /gagnante/.test(x.t)), 'la non-conversion doit être signalée');
// chaque conseil explique la cause ET la correction
for (const x of a) {
  assert.ok(x.why && x.why.length > 40, 'conseil sans cause : ' + x.t);
  assert.ok(x.how && x.how.length > 40, 'conseil sans correction : ' + x.t);
}

// aucune faute -> message neutre, pas de faux positif
const clean = M.summarize([ply({ tag: 'meilleur' }), ply({ tag: 'bon' })], 'w');
assert.equal(M.advice(clean, { outcome: 'w' }).length, 1);
assert.ok(/Rien de grave/.test(M.advice(clean, {})[0].t));

// chaque motif détecté a son texte pourquoi/comment
for (const [k, m] of Object.entries(M.MOTIFS)) {
  assert.ok(m.label && m.why.length > 40 && m.how.length > 40, 'motif incomplet : ' + k);
  assert.ok(M.advice(M.summarize([ply({ tag: 'gaffe', wpLoss: 30, cpLoss: 400, threat: k })], 'w'), {})
    .some(x => x.t.startsWith(m.label)), 'motif non remonté en conseil : ' + k);
}

// conseils globaux
const g = M.globalAdvice({
  n: 40, w: 15, l: 20, d: 5,
  byColor: { w: { n: 20, w: 12, l: 6, d: 2 }, b: { n: 20, w: 3, l: 14, d: 3 } },
  byClass: { blitz: { n: 40, w: 15, l: 20, d: 5 } },
  lossReasons: { timeout: 8, resigned: 12 },
  winReasons: { resigned: 15 },
  openings: new Map([['Scandinavian Defense', { n: 8, w: 1, l: 7, d: 0 }], ['Italian Game', { n: 10, w: 7, l: 2, d: 1 }]]),
  accSum: 0, accN: 0,
});
assert.ok(g.some(x => /au temps/.test(x.t)), 'les défaites au temps doivent sortir');
assert.ok(g.some(x => /noirs/.test(x.t)), 'le déséquilibre de couleur doit sortir');
assert.ok(g.some(x => /Scandinavian/.test(x.t)), 'la pire ouverture doit sortir');
assert.ok(g.some(x => /Italian/.test(x.t)), 'la meilleure ouverture doit sortir');
for (const x of g) {
  assert.ok(x.why && x.how, 'conseil global sans pourquoi/comment : ' + x.t);
}

console.log('OK — tous les contrôles passent');
