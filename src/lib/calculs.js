// Calcule la composition résultante d'un ensemble de lignes de batch
// lignes: [{ mp: matierePremiere, masse_totale_kg: number }]
export function calcComposition(lignes) {
  let total = 0
  let pp = 0, pe = 0, alu = 0, blanc = 0, transp = 0, noir = 0, sable = 0, autres = 0

  for (const { mp, masse_totale_kg: m } of lignes) {
    if (!mp || !m) continue
    total += m
    pp     += m * (mp.pct_pp ?? 0) / 100
    pe     += m * (mp.pct_pe ?? 0) / 100
    alu    += m * (mp.pct_alu ?? 0) / 100
    blanc  += m * (mp.pct_blanc ?? 0) / 100
    transp += m * (mp.pct_transparent ?? 0) / 100
    noir   += m * (mp.pct_noir ?? 0) / 100
    sable  += m * (mp.pct_sable ?? 0) / 100
    autres += m * (mp.pct_autres ?? 0) / 100
  }

  if (total === 0) return null

  const plastique = total - sable

  return {
    total,
    pp:       plastique > 0 ? (pp  / plastique) * 100 : 0,
    pe:       plastique > 0 ? (pe  / plastique) * 100 : 0,
    alu:      plastique > 0 ? (alu / plastique) * 100 : 0,
    blanc:    plastique > 0 ? (blanc / plastique) * 100 : 0,
    transp:   plastique > 0 ? (transp / plastique) * 100 : 0,
    noir:     plastique > 0 ? (noir / plastique) * 100 : 0,
    autres:   plastique > 0 ? (autres / plastique) * 100 : 0,
    ecoLithe: total > 0     ? (sable / total) * 100 : 0,
  }
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
