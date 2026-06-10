// ─────────────────────────────────────────────────────────────────────────────
// Helpers composition
// ─────────────────────────────────────────────────────────────────────────────

// Renvoie une MP "effective" : si un override existe, fusionne avec la MP
// override : objet { pct_pp, pct_pe, ... } ou null
export function effectiveMp(mp, override) {
  if (!mp) return mp
  if (!override) return mp
  return { ...mp, ...override }
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
    total       += m
    pp          += m * (mp.pct_pp ?? 0) / 100
    pe          += m * (mp.pct_pe ?? 0) / 100
    alu         += m * (mp.pct_alu ?? 0) / 100
    autres      += m * (mp.pct_autres ?? 0) / 100
    autresPlast += m * (mp.pct_autres_plastiques ?? 0) / 100
    blanc       += m * (mp.pct_blanc ?? 0) / 100
    transp      += m * (mp.pct_transparent ?? 0) / 100
    noir        += m * (mp.pct_noir ?? 0) / 100
    autresCoul  += m * (mp.pct_autres_couleurs ?? 0) / 100
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
