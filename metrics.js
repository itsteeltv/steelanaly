// Fonctions pures (aucun import) -> testables avec `node test.mjs`.

export const MATE_CP = 1000;
export const PIECE_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export const DRAWS = new Set([
  'stalemate', 'insufficient', '50move', 'repetition', 'agreed', 'timevsinsufficient',
]);

export const TAGS = {
  meilleur:    { label: 'Meilleur coup', sym: '★' },
  bon:         { label: 'Correct',       sym: '' },
  imprecision: { label: 'Imprécision',   sym: '?!' },
  erreur:      { label: 'Erreur',        sym: '?' },
  gaffe:       { label: 'Gaffe',         sym: '??' },
};

export const REASONS = {
  win: 'victoire', checkmated: 'mat', timeout: 'temps écoulé', resigned: 'abandon',
  abandoned: 'partie abandonnée', stalemate: 'pat', insufficient: 'matériel insuffisant',
  '50move': 'règle des 50 coups', repetition: 'répétition', agreed: 'nulle acceptée',
  timevsinsufficient: 'temps vs matériel insuffisant', lose: 'défaite',
};

// Motifs d'erreur détectés coup par coup : ce qui s'est passé, pourquoi on le fait,
// et la correction concrète.
export const MOTIFS = {
  prise: {
    label: 'Tu laisses du matériel en prise',
    why: "Tu suis ton propre plan sans regarder ce que le coup adverse vient de changer. Le cerveau traite le coup d'en face comme du bruit et enchaîne l'idée préparée deux coups plus tôt.",
    how: "Routine de 3 secondes avant CHAQUE coup : 1) quelles captures l'adversaire peut-il jouer ? 2) quels échecs ? 3) laquelle de mes pièces n'est défendue par rien ? Tant que la réponse à 3 n'est pas « aucune », ne joue pas ton plan.",
  },
  mat: {
    label: 'Tu permets un mat forcé',
    why: "Tu comptes le matériel, pas les attaquants autour de ton roi. Un mat arrive presque toujours après l'ouverture d'une colonne ou d'une diagonale vers ton roi, ou l'affaiblissement des pions f, g et h.",
    how: "Dès que deux pièces adverses (souvent dame + fou ou dame + cavalier) pointent vers ton roi, compte attaquants contre défenseurs. S'il en a plus que toi, échange un attaquant ou ramène un défenseur AVANT de continuer ton plan.",
  },
  mat_manque: {
    label: 'Tu rates un mat forcé',
    why: "Quand ta position est très bonne, tu passes en pilote automatique et tu joues le coup « solide » au lieu de chercher le coup décisif.",
    how: "Règle ÉCM : dès que ton avantage est net, examine d'abord tous les Échecs, puis les Captures, puis les Menaces. Le mat est presque toujours dans cette liste. Fais 10 puzzles « mat en 2 » par jour pendant deux semaines.",
  },
  gain_manque: {
    label: 'Tu rates un gain de matériel',
    why: "Tu ne cherches la tactique que lorsqu'elle est annoncée (dans un puzzle). En partie, personne ne te prévient qu'il y a un coup à trouver.",
    how: "À chaque coup de l'adversaire, demande-toi : quelle pièce vient-il de quitter ou de laisser sans défense ? Cherche les fourchettes, clouages et enfilades sur ses pièces non défendues.",
  },
};

// Score UCI (du point de vue du joueur au trait) -> centipawns bornés.
export function scoreToCp(score) {
  if (!score) return 0;
  if (score.mate !== undefined) return score.mate > 0 ? MATE_CP : -MATE_CP;
  return Math.max(-MATE_CP, Math.min(MATE_CP, score.cp));
}

// Probabilité de gain (%) pour le joueur au trait (formule Lichess).
export const winPct = cp => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);

// `isBest` testé en premier : dans une position perdue, le meilleur coup perd
// quand même de la proba de gain et ne doit pas être étiqueté "gaffe".
export function classify(wpLoss, isBest) {
  if (isBest) return 'meilleur';
  if (wpLoss >= 20) return 'gaffe';
  if (wpLoss >= 10) return 'erreur';
  if (wpLoss >= 5) return 'imprecision';
  return 'bon';
}

// Précision % à partir de la perte moyenne de proba de gain (formule Lichess).
export const accuracy = avgWpLoss =>
  Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * avgWpLoss) - 3.1669));

export function phaseOf(fen, ply) {
  if (ply < 16) return 'ouverture';
  const pieces = fen.split(' ')[0].replace(/[^a-zA-Z]/g, '').length;
  return pieces <= 12 ? 'finale' : 'milieu';
}

export function parseClock(s) {
  const p = s.split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

export function incrementOf(timeControl) {
  const m = /\+(\d+)/.exec(String(timeControl || ''));
  return m ? +m[1] : 0;
}

// ".../openings/Closed-Sicilian-Defense-Grand-Prix-Attack-4.Bc4" -> famille d'ouverture
export function openingName(pgn) {
  const m = /\[ECOUrl "[^"]*\/openings\/([^"]+)"\]/.exec(pgn || '');
  if (!m) return 'Inconnue';
  const parts = m[1].split('-');
  const cut = parts.findIndex(s => /^\d/.test(s));
  return (cut > 0 ? parts.slice(0, cut) : parts).join(' ').replace(/\.+$/, '');
}

const blankPhase = () => ({ n: 0, cpLoss: 0, bad: 0, acpl: 0 });

// `plies` = demi-coups analysés ; `color` = 'w'|'b' (le joueur étudié).
export function summarize(plies, color) {
  const mine = plies.filter(p => p.color === color);
  const counts = { meilleur: 0, bon: 0, imprecision: 0, erreur: 0, gaffe: 0 };
  const motifs = { prise: 0, mat: 0, mat_manque: 0, gain_manque: 0 };
  const phases = { ouverture: blankPhase(), milieu: blankPhase(), finale: blankPhase() };
  let cpLoss = 0, wpLoss = 0, fast = 0, fastBad = 0, peak = -MATE_CP;

  for (const p of mine) {
    counts[p.tag]++;
    cpLoss += p.cpLoss;
    wpLoss += p.wpLoss;
    const ph = phases[p.phase];
    ph.n++;
    ph.cpLoss += p.cpLoss;
    if (p.threat && motifs[p.threat] !== undefined) motifs[p.threat]++;
    if (p.tag === 'gaffe' || p.tag === 'erreur') {
      ph.bad++;
      if (p.secs != null && p.secs <= 5) fastBad++;
    }
    if (p.secs != null && p.secs <= 3) fast++;
    peak = Math.max(peak, p.cpBefore);
  }

  const n = mine.length || 1;
  for (const ph of Object.values(phases)) ph.acpl = ph.n ? Math.round(ph.cpLoss / ph.n) : 0;

  return {
    moves: mine.length, counts, motifs, phases,
    acpl: Math.round(cpLoss / n),
    avgWpLoss: wpLoss / n,
    accuracy: accuracy(wpLoss / n),
    fast, fastBad, peak,
    worst: mine.slice().sort((a, b) => b.wpLoss - a.wpLoss).filter(p => p.wpLoss >= 5).slice(0, 5),
  };
}

const PHASE_TIP = {
  ouverture: {
    why: "Tu joues des coups « naturels » sans savoir ce que l'ouverture cherche à obtenir, donc au premier coup inhabituel de l'adversaire tu improvises et tu perds le fil.",
    how: "Apprends UN système : une ouverture avec les blancs, une réponse à 1.e4, une à 1.d4 — 8 à 10 coups chacune, avec l'idée derrière (quel centre, quel fou, de quel côté roquer). Après chaque partie, repère le premier coup où tu sors de la théorie et apprends-le.",
  },
  milieu: {
    why: "Tu n'as pas de plan : tu réponds coup par coup à ce que fait l'adversaire, donc tes pièces finissent mal placées et les tactiques arrivent contre toi.",
    how: "Avant de choisir un coup, réponds à deux questions : quelle est MA pièce la plus mal placée (améliore-la) et quelle est LA faiblesse adverse (pion arriéré, case faible, roi au centre) ? À côté de ça, 10 puzzles tactiques par jour.",
  },
  finale: {
    why: "La finale demande du calcul concret et des connaissances théoriques, pas de l'intuition. C'est la phase que presque personne ne travaille, donc c'est là que les points se perdent le plus vite.",
    how: "Dans l'ordre : opposition, règle du carré, roi + pion contre roi, puis Lucena et Philidor aux tours. 15 minutes par jour pendant deux semaines suffisent à changer tes résultats. Pense aussi à activer ton roi : en finale, c'est une pièce d'attaque.",
  },
};

// Conseils déduits de summarize(). Retourne [{t, why, how}], du plus urgent au moins.
export function advice(s, ctx) {
  ctx = ctx || {};
  const out = [];
  const m = s.motifs;
  const bad = s.counts.gaffe + s.counts.erreur;
  const worstPhase = Object.entries(s.phases)
    .filter(([, p]) => p.n >= 5)
    .sort((a, b) => b[1].acpl - a[1].acpl)[0];

  for (const k of ['prise', 'mat', 'mat_manque', 'gain_manque']) {
    if (m[k] > 0) out.push({ t: MOTIFS[k].label + ' — ' + m[k] + ' fois', why: MOTIFS[k].why, how: MOTIFS[k].how });
  }

  if (worstPhase && worstPhase[1].acpl >= 60)
    out.push({
      t: 'Phase la plus faible : ' + worstPhase[0] + ' (' + worstPhase[1].acpl + ' centipions perdus par coup)',
      why: PHASE_TIP[worstPhase[0]].why,
      how: PHASE_TIP[worstPhase[0]].how,
    });

  if (s.fastBad >= 2)
    out.push({
      t: s.fastBad + ' faute(s) jouée(s) en moins de 5 secondes',
      why: "Tu joues au rythme du « ça a l'air bien » : ton cerveau reconnaît un motif connu et ta main suit avant la vérification. Les fautes n'arrivent presque jamais quand tu réfléchis.",
      how: "Déclencheur obligatoire : dès que l'adversaire capture, donne échec, ou avance une pièce dans ton camp, tu t'imposes 10 secondes. Et réduis le bullet : il entraîne exactement le réflexe qui te coûte des parties.",
    });

  if (ctx.outcome === 'l' && s.peak >= 200)
    out.push({
      t: 'Position gagnante non convertie (tu as été à +' + (s.peak / 100).toFixed(1) + ')',
      why: "Avec l'avantage, soit tu veux finir vite et tu cherches le coup spectaculaire, soit tu te crispes et tu deviens passif. Dans les deux cas tu redonnes du contre-jeu.",
      how: "En position gagnante : échange les pièces (surtout les dames), pas les pions. Ramène toutes tes pièces dans le jeu avant d'attaquer. Un pion de plus dans une finale simple vaut mieux qu'une attaque compliquée.",
    });

  if (bad <= 1 && s.counts.imprecision >= 4 && s.acpl > 40)
    out.push({
      t: 'Beaucoup de petites imprécisions',
      why: "Pas de grosse faute tactique, mais tu perds du terrain en continu : tes pièces vont sur des cases « correctes » plutôt que sur les meilleures, et au bout de 20 coups l'avantage a changé de camp.",
      how: "Travaille le positionnel : avant de bouger, demande-toi quelle est la meilleure case possible pour cette pièce dans les 5 prochains coups. Étudie les structures de pions de tes ouvertures (où vont les pièces dans CETTE structure).",
    });

  if (!out.length)
    out.push({
      t: 'Rien de grave à corriger ici',
      why: 'Précision ' + s.accuracy.toFixed(1) + ' %, ' + s.acpl + ' centipions perdus par coup : aucune fuite marquée sur cet échantillon.',
      how: 'Continue sur le même régime : puzzles tactiques quotidiens et finales de base. Analyse surtout tes défaites, pas tes victoires.',
    });

  return out;
}

// Conseils sur l'ensemble des parties (sans moteur).
export function globalAdvice(a) {
  const out = [];
  const pct = (x, t) => (t ? 100 * x / t : 0);
  const losses = a.l || 1;

  if (pct(a.lossReasons.timeout || 0, losses) >= 20)
    out.push({
      t: Math.round(pct(a.lossReasons.timeout || 0, losses)) + ' % de tes défaites sont au temps',
      why: "Tu dépenses ton temps sur les coups faciles (début de partie, reprises forcées) et il ne t'en reste plus pour les positions réellement difficiles. Ce n'est pas un problème d'échecs, c'est un problème de budget.",
      how: "Budget d'horloge : les 10 premiers coups en moins de 15 % de ton temps ; un coup forcé (reprise unique, seule case légale) se joue en moins de 2 secondes. Garde le gros du temps pour les positions où plusieurs coups se valent. Si ça ne suffit pas, monte d'une cadence.",
    });

  if (pct(a.lossReasons.abandoned || 0, losses) >= 10)
    out.push({
      t: 'Parties abandonnées ou déconnexions',
      why: 'Des points perdus sans jouer : connexion instable, ou parties lancées avant de devoir partir.',
      how: "Ne lance pas de partie si tu as moins de temps devant toi que la durée maximale de la cadence. Vérifie ta connexion avant une session.",
    });

  for (const [c, lab] of [['w', 'blancs'], ['b', 'noirs']]) {
    const s = a.byColor[c], o = a.byColor[c === 'w' ? 'b' : 'w'];
    const r = pct(s.w + s.d / 2, s.n), ro = pct(o.w + o.d / 2, o.n);
    if (s.n >= 10 && o.n >= 10 && ro - r >= 12)
      out.push({
        t: 'Tu scores beaucoup moins avec les ' + lab + ' (' + r.toFixed(0) + ' % contre ' + ro.toFixed(0) + ' %)',
        why: "Un écart de cette taille vient presque toujours du répertoire : avec les " + lab + " tu subis l'ouverture de l'adversaire au lieu d'imposer une position que tu connais.",
        how: 'Choisis une réponse unique et joue-la systématiquement avec les ' + lab + '. Note les 3 positions qui reviennent le plus souvent et apprends le plan type de chacune (pas les coups : le plan).',
      });
  }

  const ops = [...a.openings.entries()]
    .filter(([, o]) => o.n >= 5)
    .map(([k, o]) => [k, o, pct(o.w + o.d / 2, o.n)])
    .sort((x, y) => x[2] - y[2]);
  if (ops.length && ops[0][2] <= 35)
    out.push({
      t: 'Ouverture à revoir : ' + ops[0][0] + ' (' + ops[0][2].toFixed(0) + ' % sur ' + ops[0][1].n + ' parties)',
      why: "Tu arrives dans des positions que tu ne comprends pas : soit tu sors de la théorie très tôt, soit tu connais les coups mais pas les plans qui suivent.",
      how: "Rejoue ces parties et repère le premier coup où tu hésites : c'est là qu'il faut apprendre. Si tu ne veux pas l'étudier, change d'ouverture — mais une seule à la fois.",
    });
  if (ops.length > 1 && ops[ops.length - 1][2] >= 60)
    out.push({
      t: 'Ton point fort : ' + ops[ops.length - 1][0] + ' (' + ops[ops.length - 1][2].toFixed(0) + ' %)',
      why: 'Tu connais les plans de cette structure, donc tu joues plus vite et plus juste.',
      how: "Cherche-la plus souvent (choix du premier coup, ordre des coups) et approfondis-la : c'est le meilleur rapport effort/points. Regarde les parties de maîtres dans cette ouverture.",
    });

  const classes = Object.entries(a.byClass).filter(([, c]) => c.n >= 10);
  const worstC = classes.map(([k, c]) => [k, pct(c.w + c.d / 2, c.n), c.n]).sort((x, y) => x[1] - y[1])[0];
  if (classes.length > 1 && worstC && worstC[1] <= 42)
    out.push({
      t: 'Cadence la moins rentable : ' + worstC[0] + ' (' + worstC[1].toFixed(0) + ' % sur ' + worstC[2] + ' parties)',
      why: 'Cette cadence ne laisse pas assez de temps pour la façon dont tu calcules, ou au contraire tu la joues sans te concentrer.',
      how: "Pour gagner du classement : joue la cadence où tu scores le mieux. Pour progresser réellement : joue plus lent (10+0 minimum) et analyse chaque partie — le blitz entretient le niveau, il ne le construit pas.",
    });

  if (a.accN >= 5) {
    const avg = a.accSum / a.accN;
    out.push({
      t: 'Précision moyenne (chess.com) : ' + avg.toFixed(1) + ' %',
      why: avg < 70
        ? 'Sous 70 %, ce sont les fautes tactiques qui décident tes parties, pas la stratégie.'
        : avg < 82
          ? 'À ce niveau les grosses fautes se raréfient : ce sont les plans et les finales qui font la différence.'
          : 'Très peu de fautes : ton niveau se joue sur les détails positionnels.',
      how: avg < 70
        ? '15 puzzles par jour, sans chrono, en vérifiant la réponse de l\'adversaire à chaque coup candidat.'
        : avg < 82
          ? 'Analyse une partie par jour SANS moteur d\'abord, puis compare avec le moteur : c\'est ce qui fait progresser le jugement.'
          : 'Travaille les finales techniques et les structures de pions ; étudie des parties annotées de maîtres.',
    });
  }

  if (!out.length)
    out.push({
      t: 'Pas de fuite évidente sur ces parties',
      why: "Les statistiques globales (résultats, ouvertures, fins de partie) ne montrent rien d'anormal.",
      how: "Lance l'analyse moteur sur un lot de parties : les fuites sont au niveau des coups, pas des statistiques.",
    });
  return out;
}
