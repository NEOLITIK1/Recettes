// ─────────────────────────────────────────────────────────────────────────────
// Helpers composition
// ─────────────────────────────────────────────────────────────────────────────

// Champs de composition (%) figés dans les snapshots de batch
export const PCT_FIELDS = [
  'pct_pp', 'pct_pe', 'pct_alu', 'pct_autres', 'pct_autres_plastiques',
  'pct_blanc', 'pct_transparent', 'pct_noir', 'pct_autres_couleurs',
  'pct_sable', 'pct_charge_minerale',
]

// Renvoie une MP "effective" : si un override (ou un snapshot figé) existe, il prime.
// override : objet { pct_pp, pct_pe, ... } ou null
// Si la MP a été supprimée (mp absent) mais qu'un snapshot existe, on se rabat
// dessus → l'historique reste juste même après suppression d'une matière.
export function effectiveMp(mp, override) {
  if (!mp && !override) return mp
  if (!mp) return { ...override }
  if (!override) return mp
  return { ...mp, ...override }
}

// Extrait la composition (% uniquement) d'une MP effective, pour la figer sur une
// ligne de batch. Garantit que l'historique ne bouge plus si la MP est modifiée
// ou supprimée plus tard.
export function snapshotComposition(mpEffectif) {
  if (!mpEffectif) return null
  const snap = {}
  for (const f of PCT_FIELDS) snap[f] = mpEffectif[f] ?? 0
  return snap
}

// ─────────────────────────────────────────────────────────────────────────────
// Calcule la composition résultante d'un ensemble de lignes de batch
// lignes: [{ mp: matierePremiere, masse_totale_kg: number }]
//
// Modèle :
//   - Non plastique  = sable (EcoLithe / béton concassé) + charge_minerale
//   - Plastique      = masse totale - non plastique
//   - %PP/PE/Alu/AutresPlast = sur la fraction plastique
//   - %Blanc/Transp/Noir/AutresCoul = sur la fraction plastique
//   - %EcoLithe = sable / total      (béton concassé recyclé)
//   - %ChargeMin = charge_minerale / total
// ─────────────────────────────────────────────────────────────────────────────
export function calcComposition(lignes) {
  let total = 0
  let pp = 0, pe = 0, alu = 0, blanc = 0, transp = 0, noir = 0
  let sable = 0, chargeMin = 0, autres = 0, autresPlast = 0, autresCoul = 0

  for (const { mp, masse_totale_kg: m } of lignes) {
    if (!mp || !m) continue
    // Masse plastique de CETTE matière (le reste = sable + charge minérale)
    const mPlast = m * Math.max(0, 1 - ((mp.pct_sable ?? 0) + (mp.pct_charge_minerale ?? 0)) / 100)
    total       += m
    // Polymères : exprimés en % de la masse TOTALE de la matière
    pp          += m * (mp.pct_pp ?? 0) / 100
    pe          += m * (mp.pct_pe ?? 0) / 100
    alu         += m * (mp.pct_alu ?? 0) / 100
    autres      += m * (mp.pct_autres ?? 0) / 100
    autresPlast += m * (mp.pct_autres_plastiques ?? 0) / 100
    // Couleurs : exprimées en % de la fraction PLASTIQUE de la matière
    blanc       += mPlast * (mp.pct_blanc ?? 0) / 100
    transp      += mPlast * (mp.pct_transparent ?? 0) / 100
    noir        += mPlast * (mp.pct_noir ?? 0) / 100
    autresCoul  += mPlast * (mp.pct_autres_couleurs ?? 0) / 100
    sable       += m * (mp.pct_sable ?? 0) / 100
    chargeMin   += m * (mp.pct_charge_minerale ?? 0) / 100
  }

  if (total === 0) return null

  const nonPlast  = sable + chargeMin
  const plastique = total - nonPlast

  return {
    total,
    pp:          plastique > 0 ? (pp          / plastique) * 100 : 0,
    pe:          plastique > 0 ? (pe          / plastique) * 100 : 0,
    alu:         plastique > 0 ? (alu         / plastique) * 100 : 0,
    autres:      plastique > 0 ? (autres      / plastique) * 100 : 0,
    autresPlast: plastique > 0 ? (autresPlast / plastique) * 100 : 0,
    // Cumul des deux champs "autres plastiques" (pct_autres legacy + pct_autres_plastiques)
    autresPlastTotal: plastique > 0 ? ((autres + autresPlast) / plastique) * 100 : 0,
    blanc:       plastique > 0 ? (blanc       / plastique) * 100 : 0,
    transp:      plastique > 0 ? (transp      / plastique) * 100 : 0,
    noir:        plastique > 0 ? (noir        / plastique) * 100 : 0,
    autresCoul:  plastique > 0 ? (autresCoul  / plastique) * 100 : 0,
    ecoLithe:    (sable     / total) * 100,
    chargeMin:   (chargeMin / total) * 100,
  }
}

// Liste complète des paramètres de composition à afficher dans les tableaux
// "résultat vs cible" (écran ET impression) — source unique pour toutes les pages.
// Les couleurs (blanc, transparent, noir, autres) font partie des statistiques.
export const COMP_PARAMS_FULL = [
  { key: 'pp',               label: '%PP',            cibleKey: 'pct_pp_cible' },
  { key: 'pe',               label: '%PE',            cibleKey: 'pct_pe_cible' },
  { key: 'alu',              label: '%Alu',           cibleKey: 'pct_alu_cible' },
  { key: 'autresPlastTotal', label: '%Autres plast.', cibleKey: 'pct_autres_cible' },
  { key: 'blanc',            label: '%Blanc',         cibleKey: 'pct_blanc_cible' },
  { key: 'transp',           label: '%Transparent',   cibleKey: 'pct_transparent_cible' },
  { key: 'noir',             label: '%Noir',          cibleKey: 'pct_noir_cible' },
  { key: 'autresCoul',       label: '%Autres coul.',  cibleKey: 'pct_autres_coul_cible' },
  { key: 'ecoLithe',         label: '%EcoLithe',      cibleKey: 'pct_ecolithe_cible' },
  { key: 'chargeMin',        label: '%Charge min.',   cibleKey: 'pct_charge_minerale_cible' },
]

// ─────────────────────────────────────────────────────────────────────────────
// Ratio sable/plastique à viser en PRODUCTION
// ─────────────────────────────────────────────────────────────────────────────
// Le batch créé ici est notre "plastique". En production il est mélangé avec du
// sable pour faire la dalle finale. Standard : 60% sable / 40% plastique.
// MAIS si le batch contient déjà du sable/minéral (EcoLithe à 60% sable, charge
// minérale…), ce sable est "pré-intégré" : il faut donc en ajouter MOINS en
// production pour que la dalle finale garde la bonne proportion de plastique pur.
//
// Pour atteindre PROD_PLAST_STD% de plastique PUR dans la dalle finale, la part
// de batch dans le mélange doit être (PROD_PLAST_STD / p), où p = fraction de
// plastique pur du batch. Le sable ajouté occupe le reste.
export const PROD_SABLE_STD = 60 // % de sable dans la dalle standard
export const PROD_PLAST_STD = 40 // % de plastique pur dans la dalle standard

// comp = sortie de calcComposition (ecoLithe% et chargeMin% sont exprimés sur le total).
// Retourne null seulement si la composition est vide.
//   standard:true   → batch sans sable pré-intégré, le ratio 60/40 s'applique tel quel
//   impossible:true → batch déjà trop chargé en minéral, on ne peut plus viser la cible
export function ratioProduction(comp, { sableStd = PROD_SABLE_STD, plastStd = PROD_PLAST_STD } = {}) {
  if (!comp || !comp.total) return null
  const mineralPct = (comp.ecoLithe ?? 0) + (comp.chargeMin ?? 0) // sable EcoLithe + charge minérale
  const p = 1 - mineralPct / 100 // fraction de plastique PUR dans le batch
  if (p <= 0) return { impossible: true, standard: false, mineralPct, plastiquePct: 100, sablePct: 0, sableStd, plastStd }
  const fBatch = (plastStd / 100) / p // part du batch ("plastique") dans le mélange de production
  if (fBatch >= 1) {
    // Le batch contient déjà autant ou plus de minéral que la cible : on ne peut
    // plus atteindre la proportion voulue en ajoutant du sable.
    return { impossible: true, standard: false, mineralPct, plastiquePct: 100, sablePct: 0, sableStd, plastStd }
  }
  return {
    impossible: false,
    standard: mineralPct <= 0.05,     // pas de sable pré-intégré → ratio standard 60/40
    mineralPct,                       // % sable/minéral déjà dans le batch
    plastiquePct: fBatch * 100,       // % de batch à mettre dans le mélange production
    sablePct: (1 - fBatch) * 100,     // % de sable à AJOUTER en production
    sableStd, plastStd,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Suggestions de réapprovisionnement
// ─────────────────────────────────────────────────────────────────────────────
// À partir de la composition actuelle (comp), de la recette cible et d'une MASSE
// TOTALE VISÉE (≤ capacité du mélangeur), calcule les AJUSTEMENTS par composant
// pour atteindre les ratios : delta > 0 = ajouter, delta < 0 = retrancher.
//
// Cohérence capacité : on impose la masse totale cible (totalCible). Tant que
// totalCible ≤ capacité, la proposition respecte le mélangeur. À volume constant
// (totalCible = masse actuelle) la somme des ajouts ≈ somme des retraits.
//
// Estimations par axe (polymères / couleurs / minéral) : polymères et couleurs
// sont deux découpages du MÊME plastique → un sac réel (ex: PE blanc) couvre une
// ligne de chaque axe à la fois.
const SEUIL_DELTA = 5 // kg : on ignore les écarts négligeables
export function ajustementsPourCible(comp, recette, totalCible) {
  if (!comp || !comp.total || !recette || !totalCible || totalCible <= 0) return null
  const T = totalCible
  const mineralCible = (recette.pct_ecolithe_cible ?? 0) + (recette.pct_charge_minerale_cible ?? 0)
  const P = T * (1 - mineralCible / 100)                                  // plastique visé
  const Pcur = comp.total * (1 - ((comp.ecoLithe ?? 0) + (comp.chargeMin ?? 0)) / 100) // plastique actuel

  // items: { label, curPct, ciblePct, baseCur, baseCible }
  function axeDelta(items) {
    return items.map(it => {
      const masseCible = (it.ciblePct / 100) * it.baseCible
      const masseCur = (it.curPct / 100) * it.baseCur
      return { label: it.label, delta: Math.round(masseCible - masseCur), ciblePct: it.ciblePct }
    }).filter(d => Math.abs(d.delta) >= SEUIL_DELTA)
  }

  const polymeres = axeDelta([
    { label: 'PP', curPct: comp.pp ?? 0, ciblePct: recette.pct_pp_cible ?? 0, baseCur: Pcur, baseCible: P },
    { label: 'PE', curPct: comp.pe ?? 0, ciblePct: recette.pct_pe_cible ?? 0, baseCur: Pcur, baseCible: P },
    { label: 'Alu', curPct: comp.alu ?? 0, ciblePct: recette.pct_alu_cible ?? 0, baseCur: Pcur, baseCible: P },
  ])
  const couleurs = axeDelta([
    { label: 'Blanc', curPct: comp.blanc ?? 0, ciblePct: recette.pct_blanc_cible ?? 0, baseCur: Pcur, baseCible: P },
    { label: 'Transparent', curPct: comp.transp ?? 0, ciblePct: recette.pct_transparent_cible ?? 0, baseCur: Pcur, baseCible: P },
    { label: 'Noir', curPct: comp.noir ?? 0, ciblePct: recette.pct_noir_cible ?? 0, baseCur: Pcur, baseCible: P },
  ])
  const minerals = axeDelta([
    { label: 'Sable (EcoLithe)', curPct: comp.ecoLithe ?? 0, ciblePct: recette.pct_ecolithe_cible ?? 0, baseCur: comp.total, baseCible: T },
    { label: 'Charge minérale', curPct: comp.chargeMin ?? 0, ciblePct: recette.pct_charge_minerale_cible ?? 0, baseCur: comp.total, baseCible: T },
  ])

  const rien = polymeres.length === 0 && couleurs.length === 0 && minerals.length === 0
  return { polymeres, couleurs, minerals, totalCible: Math.round(T), totalActuel: Math.round(comp.total), rien }
}

// Coût total d'un batch en euros
export function calcCout(lignes) {
  return lignes.reduce((sum, { mp, masse_totale_kg }) => {
    if (!mp || !masse_totale_kg) return sum
    return sum + (masse_totale_kg * (mp.cout_par_tonne ?? 0)) / 1000
  }, 0)
}

// Formate un nombre avec 1 décimale
export function fmt1(v) {
  return typeof v === 'number' ? v.toFixed(1) : '—'
}
