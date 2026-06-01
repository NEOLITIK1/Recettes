import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { calcComposition, calcCout, fmt1 } from '../lib/calculs.js'
import EcartBadge from '../components/EcartBadge.jsx'

// Algorithme greedy avec diversification et MP forcées
// mpsForcees : [{ mpId, masse }] — MP à inclure obligatoirement
function optimiser(sacsDispo, mpsMap, recette, masseCible, mpsForcees = [], seed = 0) {
  if (!recette) return []

  // 1. Construire les lignes forcées d'abord
  const selectionForcee = mpsForcees
    .filter(f => f.mpId && f.masse > 0)
    .map(f => ({
      sac: { id: 'forced-' + f.mpId, mp_id: f.mpId, masse_kg: f.masse, reference: 'Forcé' },
      mp: mpsMap[f.mpId],
      taken: parseFloat(f.masse),
      partial: false,
      forced: true,
    }))
    .filter(f => f.mp)

  const masseDejaCouverte = selectionForcee.reduce((s, f) => s + f.taken, 0)
  const masseRestante = masseCible - masseDejaCouverte

  if (masseRestante <= 0) return selectionForcee

  // 2. Score : distance euclidienne à la recette + pénalité de concentration
  // Générateur pseudo-aléatoire déterministe basé sur le seed
  function pseudoRand(i) {
    const x = Math.sin(seed * 9301 + i * 49297 + 233720) * 10000
    return x - Math.floor(x)
  }

  function scoreSac(sac, selectionActuelle, idx) {
    const mp = mpsMap[sac.mp_id]
    if (!mp) return -9999

    // Distance compositionnelle sur TOUS les paramètres de la recette
    // Poids doubles sur les couleurs car elles sont souvent discriminantes
    const distPolymere = Math.sqrt(
      Math.pow((mp.pct_pp  ?? 0) - recette.pct_pp_cible,  2) +
      Math.pow((mp.pct_pe  ?? 0) - recette.pct_pe_cible,  2) +
      Math.pow((mp.pct_alu ?? 0) - recette.pct_alu_cible, 2)
    )

    const distCouleur = Math.sqrt(
      Math.pow(((mp.pct_blanc       ?? 0) - recette.pct_blanc_cible)       * 1.5, 2) +
      Math.pow(((mp.pct_transparent ?? 0) - recette.pct_transparent_cible) * 1.5, 2) +
      Math.pow(((mp.pct_noir        ?? 0) - recette.pct_noir_cible)        * 2.0, 2)
    )

    // Pénalité dure si la MP apporte du noir alors que la recette n'en veut pas
    const penaliteNoir = (recette.pct_noir_cible ?? 0) < 5 && (mp.pct_noir ?? 0) > 10
      ? 500
      : 0

    const dist = distPolymere + distCouleur + penaliteNoir

    // Pénalité si cette MP est déjà très présente (diversification)
    const masseDejaMP = selectionActuelle
      .filter(s => s.sac.mp_id === sac.mp_id)
      .reduce((sum, s) => sum + s.taken, 0)
    const masseTotal = selectionActuelle.reduce((sum, s) => sum + s.taken, 0)
    const partMP = masseTotal > 0 ? masseDejaMP / masseTotal : 0
    const penaliteConcentration = partMP > 0.4 ? (partMP - 0.4) * 50 : 0

    // Variation aléatoire contrôlée pour explorer d'autres combinaisons
    const variation = seed > 0 ? (pseudoRand(idx) - 0.5) * 0.3 * Math.max(distPolymere, 1) : 0

    return -(dist + penaliteConcentration + variation)
  }

  const selection = [...selectionForcee]
  let totalMasse = masseDejaCouverte

  // Trier les sacs disponibles dynamiquement à chaque étape
  const sacsDisponibles = [...sacsDispo]

  let iterations = 0
  while (totalMasse < masseCible * 0.9 && sacsDisponibles.length > 0 && iterations < 50) {
    iterations++

    // Re-scorer avec la sélection actuelle (tient compte de la diversification)
    sacsDisponibles.sort((a, b) => scoreSac(b, selection, sacsDisponibles.indexOf(b)) - scoreSac(a, selection, sacsDisponibles.indexOf(a)))

    const meilleur = sacsDisponibles[0]
    sacsDisponibles.splice(0, 1)

    const remaining = masseCible - totalMasse
    const masseSac = meilleur.masse_kg ?? 0
    if (masseSac <= 0) continue

    let taken = masseSac
    let partial = false

    // Utilisation partielle si le sac dépasse ce qu'il reste
    if (taken > remaining * 1.1) {
      taken = Math.round(remaining)
      partial = true
    }

    selection.push({
      sac: meilleur,
      mp: mpsMap[meilleur.mp_id],
      taken,
      partial,
      forced: false,
    })
    totalMasse += taken
  }

  // ── Ajustement fin de composition ──
  // Calculer l'écart actuel vs cible et ajuster le dernier sac non-forcé
  if (selection.length > 0) {
    // Composition actuelle
    function compCourante(sel) {
      let tot = 0, pp = 0, pe = 0, alu = 0, blanc = 0, noir = 0, sable = 0
      for (const { mp, taken: t } of sel) {
        if (!mp) continue
        tot   += t
        pp    += t * (mp.pct_pp    ?? 0) / 100
        pe    += t * (mp.pct_pe    ?? 0) / 100
        alu   += t * (mp.pct_alu   ?? 0) / 100
        blanc += t * (mp.pct_blanc ?? 0) / 100
        noir  += t * (mp.pct_noir  ?? 0) / 100
        sable += t * (mp.pct_sable ?? 0) / 100
      }
      const plast = tot > sable ? tot - sable : 1
      return {
        pp:    plast > 0 ? pp/plast*100    : 0,
        pe:    plast > 0 ? pe/plast*100    : 0,
        alu:   plast > 0 ? alu/plast*100   : 0,
        blanc: plast > 0 ? blanc/plast*100 : 0,
        noir:  plast > 0 ? noir/plast*100  : 0,
      }
    }

    const comp = compCourante(selection)
    const ecartPP = comp.pp - recette.pct_pp_cible
    const ecartPE = comp.pe - recette.pct_pe_cible

    // Si l'écart est significatif (>3%), tenter d'ajouter un sac correcteur partiel
    if ((Math.abs(ecartPP) > 3 || Math.abs(ecartPE) > 3) && sacsDisponibles.length > 0) {
      // Chercher dans les sacs restants celui qui réduit le plus l'écart
      const compCour = compCourante(selection)
      const ecartBlanc = compCour.blanc - (recette.pct_blanc_cible ?? 0)
      const ecartNoir  = compCour.noir  - (recette.pct_noir_cible  ?? 0)

      const correcteur = sacsDisponibles
        .map(sac => {
          const mp = mpsMap[sac.mp_id]
          if (!mp) return null
          // Exclure les MP qui introduisent du noir si la recette n'en veut pas
          if ((recette.pct_noir_cible ?? 0) < 5 && (mp.pct_noir ?? 0) > 10) return null
          // Score correctif sur polymères ET couleurs
          const scoreCorr = (ecartPP    > 0 ? -(mp.pct_pp        ?? 0) : (mp.pct_pp        ?? 0))
                          + (ecartPE    > 0 ? -(mp.pct_pe        ?? 0) : (mp.pct_pe        ?? 0))
                          + (ecartBlanc > 0 ? -(mp.pct_blanc     ?? 0) : (mp.pct_blanc     ?? 0)) * 1.5
                          + (ecartNoir  > 0 ? -(mp.pct_noir      ?? 0) : (mp.pct_noir      ?? 0)) * 2.0
          return { sac, mp, score: scoreCorr }
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)[0]

      if (correcteur) {
        // Ajouter une fraction de ce sac correcteur (max 20% de la masse totale)
        const masseMax = Math.min(masseCible * 0.2, correcteur.sac.masse_kg ?? 0)
        const masseCorr = Math.round(masseMax)
        if (masseCorr > 0) {
          selection.push({
            sac: correcteur.sac,
            mp: correcteur.mp,
            taken: masseCorr,
            partial: masseCorr < (correcteur.sac.masse_kg ?? 0),
            forced: false,
          })
        }
      }
    }
  }

  return selection
}

export default function Optimiseur() {
  const [recettes, setRecettes] = useState([])
  const [sacs, setSacs] = useState([])
  const [mpsMap, setMpsMap] = useState({})
  const [mpsListe, setMpsListe] = useState([])
  const [loading, setLoading] = useState(true)

  // Paramètres
  const [rcId, setRcId] = useState('')
  const [masseCible, setMasseCible] = useState(5000)
  const [nomBatch, setNomBatch] = useState('')
  const [mpsForcees, setMpsForcees] = useState([]) // [{ mpId, masse }]
  const [restrictions, setRestrictions] = useState([]) // [{ mpId, type: 'exclure'|'limiter', maxSacs: number }]

  // Résultat + historique des propositions
  const [propositions, setPropositions] = useState([]) // tableau de sélections
  const [propIndex, setPropIndex] = useState(-1)       // index courant
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Sélection courante dérivée de l'historique
  const selection = propIndex >= 0 ? propositions[propIndex] : null

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    const [{ data: rc }, { data: sacsData }, { data: mpsData }] = await Promise.all([
      supabase.from('recettes_cibles').select('*').order('id'),
      supabase.from('sacs').select('*').eq('statut', 'disponible'),
      supabase.from('matieres_premieres').select('*').order('id'),
    ])
    setRecettes(rc ?? [])
    setSacs(sacsData ?? [])
    // MP disponibles en stock uniquement (pour le sélecteur de MP forcées)
    const mpIdsEnStock = new Set((sacsData ?? []).map(s => s.mp_id))
    setMpsListe((mpsData ?? []).filter(m => mpIdsEnStock.has(m.id)))
    const map = {}
    for (const mp of (mpsData ?? [])) map[mp.id] = mp
    setMpsMap(map)
    if (rc?.length) setRcId(rc[0].id)
    setLoading(false)
  }

  function ajouterRestriction() {
    if (mpsListe.length === 0) return
    setRestrictions(prev => [...prev, { mpId: mpsListe[0]?.id ?? '', type: 'exclure', maxSacs: 1 }])
  }
  function majRestriction(i, field, value) {
    setRestrictions(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: value } : r))
  }
  function supprimerRestriction(i) {
    setRestrictions(prev => prev.filter((_, idx) => idx !== i))
  }

  function ajouterMpForcee() {
    setMpsForcees(prev => [...prev, { mpId: mpsListe[0]?.id ?? '', masse: 500 }])
  }

  function majMpForcee(i, field, value) {
    setMpsForcees(prev => prev.map((f, idx) => idx === i ? { ...f, [field]: value } : f))
  }

  function supprimerMpForcee(i) {
    setMpsForcees(prev => prev.filter((_, idx) => idx !== i))
  }

  function lancer() {
    setSaved(false)
    const recette = recettes.find(r => r.id === rcId)
    const seed = Math.floor(Math.random() * 100000)
    // Filtrer les sacs dont la MP n'est pas autorisée pour cette recette
    let sacsFiltrés = sacs.filter(sac => {
      const mp = mpsMap[sac.mp_id]
      if (!mp) return false
      const autorisees = mp.recettes_autorisees ?? []
      // Si la MP a des recettes définies, vérifier que la recette choisie en fait partie
      if (autorisees.length > 0) return autorisees.includes(rcId)
      // Si aucune recette définie (MP ancienne sans config), on l'inclut quand même
      return true
    })

    // Appliquer les restrictions manuelles : filtrer/limiter les sacs disponibles
    for (const r of restrictions) {
      if (r.type === 'exclure') {
        sacsFiltrés = sacsFiltrés.filter(s => s.mp_id !== r.mpId)
      } else if (r.type === 'limiter') {
        const maxSacs = parseInt(r.maxSacs) || 1
        let compteur = 0
        sacsFiltrés = sacsFiltrés.filter(s => {
          if (s.mp_id !== r.mpId) return true
          compteur++
          return compteur <= maxSacs
        })
      }
    }
    const sel = optimiser(sacsFiltrés, mpsMap, recette, masseCible, mpsForcees, seed)
    // Tronquer l'historique après l'index courant et ajouter la nouvelle proposition
    const nouvellesProps = [...propositions.slice(0, propIndex + 1), sel]
    setPropositions(nouvellesProps)
    setPropIndex(nouvellesProps.length - 1)
  }

  async function valider() {
    if (!selection?.length) return
    setSaving(true)

    const recette = recettes.find(r => r.id === rcId)
    const batchId = 'B' + String(Date.now()).slice(-6)
    const nom = nomBatch.trim() || `Batch ${batchId} — ${recette?.nom ?? ''}`

    // Calculer et figer le coût au moment de la création
    const lignesEnrichiesCout = selection.map(({ mp, taken }) => ({ mp, masse_totale_kg: taken }))
    const coutTotal = calcCout(lignesEnrichiesCout)
    const masseTotale = selection.reduce((s, { taken }) => s + taken, 0)
    const coutParTonne = masseTotale > 0 ? coutTotal / masseTotale * 1000 : 0

    const { error: bErr } = await supabase.from('batches').insert({
      id: batchId,
      nom,
      recette_id: rcId,
      date_creation: new Date().toISOString().slice(0, 10),
      statut: 'en_cours',
      cout_total_eur: Math.round(coutTotal),
      cout_par_tonne_eur: Math.round(coutParTonne),
    })
    if (bErr) { setSaving(false); return }

    const lignes = selection
      .filter(s => !s.forced)
      .map(({ sac, taken }, i) => ({
        batch_id: batchId,
        mp_id: sac.mp_id,
        masse_totale_kg: taken,
        sacs_kg: [taken],
        ordre: i,
      }))

    // Ajouter les MP forcées comme lignes aussi
    const lignesForcees = selection
      .filter(s => s.forced)
      .map(({ sac, taken }, i) => ({
        batch_id: batchId,
        mp_id: sac.mp_id,
        masse_totale_kg: taken,
        sacs_kg: [taken],
        ordre: lignes.length + i,
      }))

    await supabase.from('batch_lignes').insert([...lignesForcees, ...lignes])

    // Mettre à jour le stock — seulement pour les sacs réels (pas les forcés)
    for (const { sac, taken, partial, forced } of selection) {
      if (forced) continue
      if (partial) {
        await supabase.from('sacs').update({
          masse_kg: Math.round((sac.masse_kg ?? 0) - taken),
          statut: 'partiel',
          updated_at: new Date().toISOString(),
        }).eq('id', sac.id)
      } else {
        await supabase.from('sacs').update({
          statut: 'consomme',
          updated_at: new Date().toISOString(),
        }).eq('id', sac.id)
      }
    }

    setSaving(false)
    setSaved(true)
    setPropositions([])
    setPropIndex(-1)
    setNomBatch('')
    setMpsForcees([])
    setRestrictions([])
    fetchAll()
  }

  const recette = recettes.find(r => r.id === rcId)

  const comp = selection
    ? calcComposition(selection.map(({ mp, taken }) => ({ mp, masse_totale_kg: taken })))
    : null

  const COMP_PARAMS = [
    { key: 'pp',       label: '%PP',       cibleKey: 'pct_pp_cible' },
    { key: 'pe',       label: '%PE',       cibleKey: 'pct_pe_cible' },
    { key: 'alu',      label: '%Alu',      cibleKey: 'pct_alu_cible' },
    { key: 'blanc',    label: '%Blanc',    cibleKey: 'pct_blanc_cible' },
    { key: 'transp',   label: '%Transp.',  cibleKey: 'pct_transparent_cible' },
    { key: 'noir',     label: '%Noir',     cibleKey: 'pct_noir_cible' },
    { key: 'ecoLithe', label: '%EcoLithe', cibleKey: 'pct_ecolithe_cible' },
  ]

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Optimiseur de batch</h1>
        <p className="text-sm text-gray-500 mt-0.5">Composition automatique à partir du stock disponible</p>
      </div>

      {saved && (
        <div className="mb-4 p-3 bg-emerald-50 text-emerald-700 rounded-lg text-sm">
          ✓ Batch créé et disponible dans <strong>Batchs en cours</strong>.
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-5">
        {/* Paramètres de base */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Recette cible</label>
            <select
              value={rcId}
              onChange={e => setRcId(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
            >
              {recettes.map(r => <option key={r.id} value={r.id}>{r.nom}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Masse totale souhaitée (kg)</label>
            <input
              type="number" min="100"
              value={masseCible}
              onChange={e => setMasseCible(parseFloat(e.target.value) || 0)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
            />
          </div>
        </div>

        <div className="mb-4">
          <label className="block text-xs text-gray-500 mb-1">Nom du batch (optionnel)</label>
          <input
            value={nomBatch}
            onChange={e => setNomBatch(e.target.value)}
            placeholder={`Batch — ${recette?.nom ?? ''}`}
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
          />
        </div>

        {/* MP forcées */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-gray-700">Matières imposées <span className="text-gray-400 font-normal">(optionnel — l'algo optimise le reste)</span></p>
            <button onClick={ajouterMpForcee} className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50">
              + Ajouter
            </button>
          </div>
          {mpsForcees.length === 0 && (
            <p className="text-xs text-gray-400 italic">Aucune — l'optimiseur choisit librement dans le stock</p>
          )}
          {mpsForcees.map((f, i) => (
            <div key={i} className="flex gap-2 items-center mb-2">
              <select
                value={f.mpId}
                onChange={e => majMpForcee(i, 'mpId', e.target.value)}
                className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
              >
                {mpsListe.map(m => <option key={m.id} value={m.id}>{m.id} — {m.nom}</option>)}
              </select>
              <input
                type="number" min="1"
                value={f.masse}
                onChange={e => majMpForcee(i, 'masse', e.target.value)}
                placeholder="kg"
                className="w-28 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
              />
              <span className="text-xs text-gray-400">kg</span>
              <button onClick={() => supprimerMpForcee(i)} className="text-red-400 hover:text-red-600 text-lg leading-none px-1">×</button>
            </div>
          ))}
        </div>

        {/* Restrictions */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-gray-700">Restrictions <span className="text-gray-400 font-normal">(exclure ou limiter une MP)</span></p>
            <button onClick={ajouterRestriction} className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50">
              + Ajouter
            </button>
          </div>
          {restrictions.length === 0 && (
            <p className="text-xs text-gray-400 italic">Aucune — l'optimiseur utilise toutes les MP du stock</p>
          )}
          {restrictions.map((r, i) => (
            <div key={i} className="flex gap-2 items-center mb-2 flex-wrap">
              <select
                value={r.mpId}
                onChange={e => majRestriction(i, 'mpId', e.target.value)}
                className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
              >
                {mpsListe.map(m => <option key={m.id} value={m.id}>{m.id} — {m.nom}</option>)}
              </select>
              <select
                value={r.type}
                onChange={e => majRestriction(i, 'type', e.target.value)}
                className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
              >
                <option value="exclure">Exclure totalement</option>
                <option value="limiter">Limiter à</option>
              </select>
              {r.type === 'limiter' && (
                <>
                  <input
                    type="number" min="1"
                    value={r.maxSacs}
                    onChange={e => majRestriction(i, 'maxSacs', e.target.value)}
                    className="w-16 text-sm border border-gray-200 rounded-lg px-2 py-2 focus:outline-none focus:border-gray-400"
                  />
                  <span className="text-xs text-gray-400">sac(s) max</span>
                </>
              )}
              <button onClick={() => supprimerRestriction(i)} className="text-red-400 hover:text-red-600 text-lg leading-none px-1">×</button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={lancer}
            disabled={loading || sacs.length === 0}
            className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-40"
          >
            ⚙ {propositions.length === 0 ? 'Composer le batch' : 'Nouvelle proposition'}
          </button>
          {propositions.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPropIndex(i => Math.max(0, i - 1))}
                disabled={propIndex <= 0}
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-30"
                title="Proposition précédente"
              >
                ← Précédente
              </button>
              <span className="text-xs text-gray-400 tabular-nums">
                {propIndex + 1} / {propositions.length}
              </span>
              <button
                onClick={() => setPropIndex(i => Math.min(propositions.length - 1, i + 1))}
                disabled={propIndex >= propositions.length - 1}
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-30"
                title="Proposition suivante"
              >
                Suivante →
              </button>
            </div>
          )}
          {sacs.length === 0 && !loading && (
            <p className="text-xs text-amber-600">Aucun sac disponible — ajoutez des sacs dans Stock.</p>
          )}
        </div>
      </div>

      {/* Résultat */}
      {selection && (
        <div className="space-y-4">
          {comp && (() => {
            const ecartPct = Math.round((comp.total - masseCible) / masseCible * 100)
            const cls = Math.abs(ecartPct) > 10
              ? 'bg-amber-50 text-amber-700 border-amber-200'
              : 'bg-blue-50 text-blue-700 border-blue-200'
            return (
              <div className={`p-3 rounded-lg border text-sm ${cls}`}>
                Masse totale proposée : <strong>{Math.round(comp.total).toLocaleString('fr-FR')} kg</strong>
                {' '}(cible {masseCible.toLocaleString('fr-FR')} kg, écart {ecartPct > 0 ? '+' : ''}{ecartPct}%)
              </div>
            )
          })()}

          {/* Sacs sélectionnés */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <p className="text-sm font-medium text-gray-900">Sacs à utiliser</p>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-50">
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Réf.</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Matière</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Masse</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {selection.map(({ sac, mp, taken, partial, forced }, i) => (
                  <tr key={i} className={forced ? 'bg-blue-50' : 'hover:bg-gray-50'}>
                    <td className="px-4 py-3 font-mono text-xs text-gray-400">
                      {forced ? '—' : (sac.reference || '—')}
                    </td>
                    <td className="px-4 py-3 text-gray-900">{mp?.nom ?? sac.mp_id}</td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">
                      {Math.round(taken).toLocaleString('fr-FR')} kg
                    </td>
                    <td className="px-4 py-3 flex gap-1 flex-wrap">
                      {forced && <span className="text-xs text-blue-600 bg-blue-100 px-2 py-0.5 rounded">Imposé</span>}
                      {partial && <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded">Partiel</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Composition résultante */}
          {comp && recette && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100">
                <p className="text-sm font-medium text-gray-900">Composition résultante vs cible — {recette.nom}</p>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-50">
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Paramètre</th>
                    <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Résultat</th>
                    <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Cible</th>
                    <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Écart</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {COMP_PARAMS.filter(p => (recette[p.cibleKey] ?? 0) > 0 || comp[p.key] > 0).map(p => (
                    <tr key={p.key} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-700">{p.label}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{fmt1(comp[p.key])}%</td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-400">{recette[p.cibleKey] ?? 0}%</td>
                      <td className="px-4 py-3 text-right">
                        <EcartBadge valeur={comp[p.key]} cible={recette[p.cibleKey] ?? 0} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-5 py-2 border-t border-gray-50">
                <p className="text-xs text-gray-400">✓ = ±2% · △ = ±5% · ✗ = &gt;5%</p>
              </div>
            </div>
          )}

          <button
            onClick={valider}
            disabled={saving}
            className="w-full py-3 text-sm bg-gray-900 text-white rounded-xl hover:bg-gray-700 disabled:opacity-40 font-medium"
          >
            {saving ? 'Enregistrement…' : '✓ Valider et créer le batch'}
          </button>
        </div>
      )}
    </div>
  )
}
