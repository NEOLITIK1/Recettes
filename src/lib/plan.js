// ─────────────────────────────────────────────────────────────────────────────
// Plan de stockage : 15 rangées, place 1 au fond (mur), dernière place côté allée.
// Un emplacement = 1 grand big bag, ou jusqu'à 3 petits empilés.
// Les positions sont calculées côté base (migration v12) : ici, lecture et affichage.
// ─────────────────────────────────────────────────────────────────────────────

import { normaliser } from './recherche.js'

// Doit rester identique à capacite_rangee() dans migration-v12.sql
export const RANGEES = [
  ...'ABCDEFGHIJK'.split('').map(code => ({ code, places: 6 })),
  { code: 'L', places: 5 }, { code: 'M', places: 5 },
  { code: 'N', places: 4 }, { code: 'O', places: 4 },
]
export const TOTAL_PLACES = RANGEES.reduce((s, r) => s + r.places, 0)
export const PROFONDEUR_MAX = Math.max(...RANGEES.map(r => r.places))
export const MAX_PILE = 3

// "A4", "B2 (2e niveau)" pour un petit sac empilé, sinon l'emplacement libre saisi
export function lieuSac(sac) {
  if (!sac) return ''
  if (!sac.rangee) return sac.emplacement ?? ''
  const niveau = sac.taille === 'petit' && sac.niveau > 1 ? ` (${sac.niveau}e niveau)` : ''
  return `${sac.rangee}${sac.place}${niveau}`
}

// Recherche par emplacement : "A" = rangée A, "A4" = place A4, "hors plan", ou un bout
// d'emplacement libre ("atelier"). Plusieurs emplacements séparés par des virgules.
export function correspondLieu(recherche, sac) {
  const net = s => normaliser(s).replace(/\s+/g, '')
  const lieu = net(lieuSac(sac))
  return recherche.split(/[,;]/).map(net).filter(Boolean).some(q => {
    if (q === 'horsplan') return !sac.rangee
    if (/^[a-o]$/.test(q)) return lieu.startsWith(q) && !/[a-z]/.test(lieu[1] ?? '')
    if (/^[a-o]\d+$/.test(q)) return lieu.startsWith(q) && !/\d/.test(lieu[q.length] ?? '')
    return lieu.includes(q)
  })
}

// { A: [ {place, taille, sacs:[bas → haut]} | null, … ], … }
export function construirePlan(sacs) {
  const plan = {}
  for (const r of RANGEES) plan[r.code] = Array(r.places).fill(null)
  for (const s of sacs) {
    const rangee = plan[s.rangee]
    if (!rangee || !(s.place >= 1 && s.place <= rangee.length)) continue
    const c = rangee[s.place - 1] ?? (rangee[s.place - 1] = { place: s.place, taille: s.taille, sacs: [] })
    c.sacs.push(s)
  }
  for (const rangee of Object.values(plan)) {
    for (const c of rangee) c?.sacs.sort((a, b) => a.niveau - b.niveau)
  }
  return plan
}

// Places libres et capacité de commande
export function statsPlan(sacs) {
  const plan = construirePlan(sacs)
  let libres = 0, complements = 0
  const parRangee = RANGEES.map(r => {
    const l = plan[r.code].filter(c => !c).length
    const comp = plan[r.code].reduce((s, c) => s + (c?.taille === 'petit' ? MAX_PILE - c.sacs.length : 0), 0)
    libres += l
    complements += comp
    return { code: r.code, places: r.places, libres: l, complements: comp }
  })
  return {
    total: TOTAL_PLACES, libres, occupees: TOTAL_PLACES - libres,
    grands: libres,                         // grands big bags stockables
    petits: libres * MAX_PILE + complements, // petits big bags stockables
    complements,                            // dont pour compléter des piles existantes
    parRangee,
    horsPlan: sacs.filter(s => !s.rangee && s.statut !== 'consomme' && (s.masse_kg ?? 0) > 0).length,
  }
}

// Choix proposés pour ranger un sac. Valeurs : 'R:A' = rangée, 'S:<id>' = sur la pile de ce sac
export function optionsRangement(sacs, taille) {
  const plan = construirePlan(sacs)
  const options = []
  for (const r of RANGEES) {
    const cases = plan[r.code]
    const occupees = cases.filter(Boolean)
    const devant = occupees[occupees.length - 1]
    const pileDevant = taille === 'petit' && devant?.taille === 'petit' && devant.sacs.length < MAX_PILE
    if (pileDevant) {
      options.push({ value: `R:${r.code}`, label: `Rangée ${r.code} → ${r.code}${devant.place}, sur la pile (${devant.sacs.length + 1}/${MAX_PILE})` })
    } else if (occupees.length < r.places) {
      const libres = r.places - occupees.length
      options.push({ value: `R:${r.code}`, label: `Rangée ${r.code} → ${r.code}${occupees.length + 1} (${libres} place${libres > 1 ? 's' : ''} libre${libres > 1 ? 's' : ''})` })
    }
    if (taille === 'petit') {
      for (const c of occupees) {
        if (c === devant || c.taille !== 'petit' || c.sacs.length >= MAX_PILE) continue
        options.push({ value: `S:${c.sacs[0].id}`, label: `Compléter la pile ${r.code}${c.place} (${c.sacs.length + 1}/${MAX_PILE})` })
      }
    }
  }
  return options
}

// Supabase limite une lecture à 1000 lignes : les sacs rangés sont lus par une requête
// dédiée puis fusionnés, pour que le plan soit toujours complet.
export function fusionnerSacs(sacs, sacsRanges) {
  const vus = new Set((sacs ?? []).map(s => s.id))
  return [...(sacs ?? []), ...(sacsRanges ?? []).filter(s => !vus.has(s.id))]
}

// Sacs encore à sortir pour un ensemble de lignes de batch (non confirmées "sorties")
export function idsASortir(lignes) {
  const ids = new Set()
  for (const l of lignes ?? []) {
    if (l.sortie_at) continue
    for (const e of Array.isArray(l.sacs_consommes) ? l.sacs_consommes : []) if (e?.sac_id) ids.add(e.sac_id)
  }
  return ids
}

// Carte à imprimer (noir et blanc) : grand sac = case blanche, petits = nombre de sacs,
// libre = pointillés, à sortir = gris à bord épais
export function planImpressionHtml(sacs, aSortir) {
  const plan = construirePlan(sacs)
  let html = '<table class="plan"><thead><tr>'
  for (const r of RANGEES) html += `<th>${r.code}</th>`
  html += `</tr></thead><tbody><tr><td class="bord" colspan="${RANGEES.length}">FOND (MUR)</td></tr>`
  for (let i = 0; i < PROFONDEUR_MAX; i++) {
    html += '<tr>'
    for (const r of RANGEES) {
      if (i >= r.places) { html += '<td class="vide"></td>'; continue }
      const c = plan[r.code][i]
      const num = `<span class="num">${r.code}${i + 1}</span>`
      if (!c) { html += `<td class="libre">${num}</td>`; continue }
      const n = c.sacs.filter(s => aSortir.has(s.id)).length
      const contenu = c.taille === 'petit'
        ? `<strong>${c.sacs.length}</strong>${n > 0 && n < c.sacs.length ? `<span class="detail">sortir ${n}</span>` : ''}`
        : ''
      html += `<td class="${n > 0 ? 'sortir' : 'plein'}">${num}${contenu}</td>`
    }
    html += '</tr>'
  }
  return html + `<tr><td class="bord" colspan="${RANGEES.length}">ALLÉE</td></tr></tbody></table>`
}

export const PLAN_IMPRESSION_CSS = `
  table.plan { width: 100%; border-collapse: separate; border-spacing: 3px; table-layout: fixed; }
  table.plan th { font-size: 15px; padding: 2px 0; }
  table.plan td { height: 62px; text-align: center; vertical-align: middle; position: relative; font-size: 18px; padding: 0; }
  table.plan td.bord { height: auto; background: none; border: 0; font-size: 11px; letter-spacing: 3px; padding: 3px 0; }
  table.plan td.plein { border: 1.5px solid #333; }
  table.plan td.libre { border: 1px dotted #aaa; }
  table.plan td.sortir { border: 3.5px solid #000; background: #b5b5b5 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  table.plan td.vide { border: 0; }
  table.plan .num { position: absolute; top: 1px; left: 3px; font-size: 9px; color: #444; }
  table.plan td.sortir .num { color: #000; }
  table.plan td.libre .num { color: #aaa; }
  table.plan .detail { display: block; font-size: 10px; font-weight: 700; }
  .legende { display: flex; flex-wrap: wrap; gap: 6px 22px; font-size: 12px; margin-top: 12px; }
  .legende span.c { display: inline-block; width: 22px; height: 16px; vertical-align: middle; margin-right: 6px; text-align: center; font-weight: 700; line-height: 16px; }
  .legende .sortir { border: 3px solid #000; background: #b5b5b5 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .legende .plein { border: 1.5px solid #333; }
  .legende .libre { border: 1px dotted #999; }
`
