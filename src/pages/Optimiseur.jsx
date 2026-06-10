import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { calcComposition, calcCout, fmt1, effectiveMp, COMP_PARAMS_FULL } from '../lib/calculs.js'
import { creerBatchAvecStock, lignePourSac, sacUpdatePourPrise } from '../lib/batchOps.js'
import EcartBadge from '../components/EcartBadge.jsx'

// ─────────────────────────────────────────────────────────────────────────────
// Algorithme : sélection greedy diversifiée + phase d'optimisation fine
// ─────────────────────────────────────────────────────────────────────────────
function optimiser(sacsDispo, mpsMap, recette, masseCible, mpsForcees = [], seed = 0, recetteId = '') {
  if (!recette) return []

  // Une MP autorisée pour une recette l'est aussi pour ses versions (famille = recette parente)
  const recetteIdsOk = new Set([recetteId, recette.parent_recette_id].filter(Boolean))

  // Générateur pseudo-aléatoire déterministe basé sur le seed
  function pseudoRand(i) {
    const x = Math.sin(seed * 9301 + i * 49297 + 233720) * 10000
    return x - Math.floor(x)
  }

  // 1. MP forcées : sélection de VRAIS sacs du stock pour couvrir la masse imposée
  // (au lieu d'un sac virtuel, on prend les sacs réels les plus lourds en premier)
  const idsDejaForcees = new Set()
  const selectionForcee = []
  for (const f of mpsForcees) {
    if (!f.mpId || parseFloat(f.masse) <= 0 || !mpsMap[f.mpId]) continue
    let masseRestante = parseFloat(f.masse)
    const sacsDeMP = [...sacsDispo]
      .filter(s => s.mp_id === f.mpId && !idsDejaForcees.has(s.id))
      .sort((a, b) => (b.masse_kg ?? 0) - (a.masse_kg ?? 0))
    for (const sac of sacsDeMP) {
      if (masseRestante <= 0) break
      const masseSac = sac.masse_kg ?? 0
      if (masseSac <= 0) continue
      const taken = Math.min(masseSac, masseRestante)
      selectionForcee.push({
        sac,
        mp: effectiveMp(mpsMap[sac.mp_id], sac.composition_override),
        taken,
        partial: taken < masseSac,
        forced: true,
        masse_avant_kg: masseSac,
        statut_avant: sac.statut ?? 'disponible',
      })
      idsDejaForcees.add(sac.id)
      masseRestante -= taken
    }
  }

  const masseDejaCouverte = selectionForcee.reduce((s, f) => s + f.taken, 0)
  const masseRestante = masseCible - masseDejaCouverte
  if (masseRestante <= 0) return selectionForcee

  // Helper : composition effective d'un sac (override prime sur MP)
  function mpDuSac(sac) {
    return effectiveMp(mpsMap[sac.mp_id], sac.composition_override)
  }

  // 2. Score d'un sac dans le contexte d'une sélection en cours
  function scoreSac(sac, selectionActuelle, idx) {
    const mp = mpDuSac(sac)
    if (!mp) return Infinity

    // Distance compositionnelle plastiques
    const distPolymere = Math.sqrt(
      Math.pow((mp.pct_pp  ?? 0) - (recette.pct_pp_cible  ?? 0), 2) +
      Math.pow((mp.pct_pe  ?? 0) - (recette.pct_pe_cible  ?? 0), 2) +
      Math.pow((mp.pct_alu ?? 0) - (recette.pct_alu_cible ?? 0), 2)
    )

    // Distance couleur (blanc/transp poids 1.5, noir poids 2)
    const distCouleur = Math.sqrt(
      Math.pow(((mp.pct_blanc       ?? 0) - (recette.pct_blanc_cible       ?? 0)) * 1.5, 2) +
      Math.pow(((mp.pct_transparent ?? 0) - (recette.pct_transparent_cible ?? 0)) * 1.5, 2) +
      Math.pow(((mp.pct_noir        ?? 0) - (recette.pct_noir_cible        ?? 0)) * 2.0, 2)
    )

    // Distance charge minérale + EcoLithe (sable)
    const distCharge = Math.sqrt(
      Math.pow((mp.pct_sable           ?? 0) - (recette.pct_ecolithe_cible        ?? 0), 2) +
      Math.pow((mp.pct_charge_minerale ?? 0) - (recette.pct_charge_minerale_cible ?? 0), 2)
    )

    // Pénalité dure : MP noire dans recette claire → INTERDIT (tout le lot serait gâché)
    const penaliteNoirDansClair = (recette.pct_noir_cible ?? 0) < 5 && (mp.pct_noir ?? 0) > 10
      ? 500 : 0
    // Note: MP blanche dans recette noire = juste sous-optimal, pas de pénalité dure (juste gaspillage)

    const dist = distPolymere + distCouleur + distCharge + penaliteNoirDansClair

    // Pénalité de diversification : éviter qu'une seule MP domine
    const masseDejaMP = selectionActuelle.filter(s => s.sac.mp_id === sac.mp_id).reduce((sum, s) => sum + s.taken, 0)
    const masseTotal = selectionActuelle.reduce((sum, s) => sum + s.taken, 0)
    const partMP = masseTotal > 0 ? masseDejaMP / masseTotal : 0
    const penaliteConcentration = partMP > 0.4 ? (partMP - 0.4) * 50 : 0

    // Variation pseudo-aléatoire pour générer des propositions différentes au même seed
    const variation = seed > 0 ? (pseudoRand(idx) - 0.5) * 0.3 * Math.max(distPolymere, 1) : 0

    // Plus c'est BAS, mieux c'est (on minimise)
    return dist + penaliteConcentration + variation
  }

  // Pool de sacs candidats : copie qu'on va consommer petit à petit
  // On garde une map id→sac pour pouvoir tracker l'état initial
  const sacsInitiaux = new Map()
  for (const s of sacsDispo) sacsInitiaux.set(s.id, { ...s })

  const selection = [...selectionForcee]
  let totalMasse = masseDejaCouverte
  // Exclure du pool greedy les sacs déjà assignés aux MP forcées
  const candidats = sacsDispo.filter(s => !idsDejaForcees.has(s.id))

  // ── PHASE 1 : sélection greedy ────────────────────────────────────────────
  let iterations = 0
  while (totalMasse < masseCible * 0.95 && candidats.length > 0 && iterations < 50) {
    iterations++

    // Bug fix : pré-calculer les scores une seule fois pour ce tri (pas d'indexOf pendant le sort)
    const scoresMap = new Map()
    candidats.forEach((sac, idx) => {
      scoresMap.set(sac, scoreSac(sac, selection, idx))
    })
    candidats.sort((a, b) => scoresMap.get(a) - scoresMap.get(b))

    const meilleur = candidats.shift()
    const masseSac = meilleur.masse_kg ?? 0
    if (masseSac <= 0) continue

    let taken = masseSac
    let partial = false

    // Bug fix : viser la masse cible EXACTE, pas 105%
    // Si le sac entier ferait dépasser la cible, on coupe au plus juste
    if (totalMasse + taken > masseCible) {
      taken = Math.max(0, Math.round(masseCible - totalMasse))
      partial = taken < masseSac
    }
    if (taken <= 0) continue

    selection.push({
      sac: meilleur,
      mp: mpDuSac(meilleur),
      taken,
      partial,
      forced: false,
    })
    totalMasse += taken
  }

  // ── PHASE 2 : optimisation fine ──────────────────────────────────────────
  function compCourante(sel) {
    let tot = 0, pp = 0, pe = 0, alu = 0, blanc = 0, noir = 0, sable = 0, chargeMin = 0
    for (const { mp, taken: t } of sel) {
      if (!mp) continue
      tot       += t
      pp        += t * (mp.pct_pp              ?? 0) / 100
      pe        += t * (mp.pct_pe              ?? 0) / 100
      alu       += t * (mp.pct_alu             ?? 0) / 100
      blanc     += t * (mp.pct_blanc           ?? 0) / 100
      noir      += t * (mp.pct_noir            ?? 0) / 100
      sable     += t * (mp.pct_sable           ?? 0) / 100
      chargeMin += t * (mp.pct_charge_minerale ?? 0) / 100
    }
    const nonPlast = sable + chargeMin
    const plast = tot - nonPlast
    return {
      total: tot,
      pp:        plast > 0 ? pp/plast*100        : 0,
      pe:        plast > 0 ? pe/plast*100        : 0,
      alu:       plast > 0 ? alu/plast*100       : 0,
      blanc:     plast > 0 ? blanc/plast*100     : 0,
      noir:      plast > 0 ? noir/plast*100      : 0,
      ecoLithe:  tot > 0 ? sable/tot*100         : 0,
      chargeMin: tot > 0 ? chargeMin/tot*100     : 0,
    }
  }

  function scoreEcart(comp) {
    return Math.sqrt(
      Math.pow(comp.pp        - (recette.pct_pp_cible              ?? 0), 2) +
      Math.pow(comp.pe        - (recette.pct_pe_cible              ?? 0), 2) +
      Math.pow(comp.alu       - (recette.pct_alu_cible             ?? 0), 2) +
      Math.pow((comp.blanc     - (recette.pct_blanc_cible           ?? 0)) * 1.5, 2) +
      Math.pow((comp.noir      - (recette.pct_noir_cible            ?? 0)) * 2.0, 2) +
      Math.pow(comp.ecoLithe  - (recette.pct_ecolithe_cible        ?? 0), 2) +
      Math.pow(comp.chargeMin - (recette.pct_charge_minerale_cible ?? 0), 2)
    )
  }

  const SEUIL_ECART = 3.0
  const MAX_PASSES  = 5

  // Bug fix : pool dédoublonné. On garde aussi la masse "encore disponible" de chaque sac
  // (en cas de sac partiel déjà utilisé en phase 1)
  const sacsParId = new Map()
  for (const s of sacsDispo) sacsParId.set(s.id, s.masse_kg ?? 0)
  // candidats non utilisés en phase 1 : leur masse complète est encore dispo
  // candidats utilisés partiellement : masse restante = masse_initiale - taken
  for (const sel of selection) {
    if (sel.forced) continue
    const restant = (sacsParId.get(sel.sac.id) ?? 0) - sel.taken
    sacsParId.set(sel.sac.id, Math.max(0, restant))
  }

  const sacsDuPool = sacsDispo.filter(s => {
    if (idsDejaForcees.has(s.id)) return false  // déjà utilisé en forcé
    const baseMp = mpsMap[s.mp_id]
    if (!baseMp) return false
    const mp = mpDuSac(s)
    // Filtre noir dans clair (sur la compo EFFECTIVE du sac)
    if ((recette.pct_noir_cible ?? 0) < 5 && (mp.pct_noir ?? 0) > 10) return false
    // Filtre recettes autorisées (sur la MP de référence, pas l'override)
    const autorisees = baseMp.recettes_autorisees ?? []
    if (autorisees.length > 0 && !autorisees.some(a => recetteIdsOk.has(a))) return false
    return true
  })

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const compNow = compCourante(selection)
    const ecartActuel = scoreEcart(compNow)
    if (ecartActuel <= SEUIL_ECART) break

    let meilleurCorrecteur = null
    let meilleurScore = ecartActuel

    for (const sac of sacsDuPool) {
      const mp = mpDuSac(sac)
      if (!mp) continue

      const masseRestanteDuSac = sacsParId.get(sac.id) ?? 0
      if (masseRestanteDuSac <= 0) continue

      // Tester différentes fractions DE LA MASSE RESTANTE (pas de la masse initiale)
      for (const fraction of [0.25, 0.5, 0.75, 1.0]) {
        const ajout = Math.round(masseRestanteDuSac * fraction)
        if (ajout <= 0) continue

        const masseActuelle = selection.reduce((s, x) => s + x.taken, 0)
        // Bug fix : tolérance ±5% strictement
        if (masseActuelle + ajout > masseCible * 1.05) continue

        // Simuler : ajouter le sac (ou agrandir la ligne s'il y est déjà)
        const existantIdx = selection.findIndex(s => s.sac.id === sac.id && !s.forced)
        let selTest
        if (existantIdx >= 0) {
          selTest = selection.map((s, i) => i === existantIdx
            ? { ...s, taken: s.taken + ajout, partial: (s.taken + ajout) < (sac.masse_kg ?? 0) }
            : s)
        } else {
          selTest = [...selection, {
            sac, mp, taken: ajout,
            partial: ajout < (sac.masse_kg ?? 0),
            forced: false,
          }]
        }
        const compTest = compCourante(selTest)
        const ecartTest = scoreEcart(compTest)

        if (ecartTest < meilleurScore) {
          meilleurScore = ecartTest
          meilleurCorrecteur = { sac, mp, ajout, existantIdx }
        }
      }
    }

    if (!meilleurCorrecteur) break

    const { sac, mp, ajout, existantIdx } = meilleurCorrecteur
    if (existantIdx >= 0) {
      const cur = selection[existantIdx]
      const newTaken = cur.taken + ajout
      selection[existantIdx] = {
        ...cur,
        taken: newTaken,
        partial: newTaken < (sac.masse_kg ?? 0),
      }
    } else {
      selection.push({ sac, mp, taken: ajout, partial: ajout < (sac.masse_kg ?? 0), forced: false })
    }
    sacsParId.set(sac.id, (sacsParId.get(sac.id) ?? 0) - ajout)
  }

  // Annoter l'état initial du sac (pour permettre une restauration propre lors d'une suppression)
  for (const sel of selection) {
    if (sel.forced) continue
    const init = sacsInitiaux.get(sel.sac.id)
    if (init) {
      sel.masse_avant_kg = init.masse_kg ?? 0
      sel.statut_avant = init.statut ?? 'disponible'
    }
  }

  return selection
}

// ─────────────────────────────────────────────────────────────────────────────
// Composant
// ─────────────────────────────────────────────────────────────────────────────
export default function Optimiseur() {
  const [recettes, setRecettes] = useState([])
  const [sacs, setSacs] = useState([])
  const [mpsMap, setMpsMap] = useState({})
  const [mpsListe, setMpsListe] = useState([])
  const [loading, setLoading] = useState(true)

  const [rcId, setRcId] = useState('')
  const [masseCible, setMasseCible] = useState(5000)
  const [nomBatch, setNomBatch] = useState('')
  const [mpsForcees, setMpsForcees] = useState([])
  const [restrictions, setRestrictions] = useState([])

  const [propositions, setPropositions] = useState([])
  const [propIndex, setPropIndex] = useState(-1)
  const [saving, setSaving] = useState(false)
  const [prefillPending, setPrefillPending] = useState(false)
  const [saved, setSaved] = useState(false)

  const selection = propIndex >= 0 ? propositions[propIndex] : null

  useEffect(() => {
    fetchAll()
    const prefill = localStorage.getItem('optimiseur_prefill')
    if (prefill) {
      try {
        const { recetteId, masse, nom, mpsForcees: pf, restrictions: pr } = JSON.parse(prefill)
        if (recetteId) setRcId(recetteId)
        if (masse) setMasseCible(masse)
        if (nom) setNomBatch(nom)
        // Retrouver les MP imposées et restrictions du batch d'origine
        if (Array.isArray(pf) && pf.length) setMpsForcees(pf)
        if (Array.isArray(pr) && pr.length) setRestrictions(pr)
        localStorage.removeItem('optimiseur_prefill')
        setPrefillPending(true)
      } catch(e) {}
    }
  }, [])

  useEffect(() => {
    if (prefillPending && recettes.length > 0 && sacs.length > 0) {
      setPrefillPending(false)
      setTimeout(() => lancer(), 100)
    }
  }, [prefillPending, recettes, sacs])

  async function fetchAll() {
    setLoading(true)
    const [{ data: rc }, { data: sacsData }, { data: mpsData }] = await Promise.all([
      supabase.from('recettes_cibles').select('*').eq('archivee', false).order('id'),
      supabase.from('sacs').select('*').in('statut', ['disponible', 'partiel']),
      supabase.from('matieres_premieres').select('*').order('id'),
    ])
    setRecettes(rc ?? [])
    setSacs(sacsData ?? [])
    const mpIdsEnStock = new Set((sacsData ?? []).map(s => s.mp_id))
    setMpsListe((mpsData ?? []).filter(m => mpIdsEnStock.has(m.id)))
    const map = {}
    for (const mp of (mpsData ?? [])) map[mp.id] = mp
    setMpsMap(map)
    if (rc?.length && !rcId) setRcId(rc[0].id)
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
    if (!recette) return
    const seed = Math.floor(Math.random() * 100000)

    // Autorisation par famille : une MP autorisée pour RC001 l'est aussi pour RC001_v2
    const recetteIdsOk = new Set([rcId, recette.parent_recette_id].filter(Boolean))
    let sacsFiltrés = sacs.filter(sac => {
      const mp = mpsMap[sac.mp_id]
      if (!mp) return false
      const autorisees = mp.recettes_autorisees ?? []
      if (autorisees.length > 0) return autorisees.some(a => recetteIdsOk.has(a))
      return true
    })

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
    const sel = optimiser(sacsFiltrés, mpsMap, recette, masseCible, mpsForcees, seed, rcId)
    const nouvellesProps = [...propositions.slice(0, propIndex + 1), sel]
    setPropositions(nouvellesProps)
    setPropIndex(nouvellesProps.length - 1)
  }

  async function valider() {
    if (!selection?.length) return
    setSaving(true)

    const recette = recettes.find(r => r.id === rcId)
    // Base 36 du timestamp : unique à la milliseconde, pas de cycle de réutilisation
    const batchId = 'B' + Date.now().toString(36).toUpperCase()
    const nom = nomBatch.trim() || `Batch ${batchId} — ${recette?.nom ?? ''}`

    const lignesEnrichiesCout = selection.map(({ mp, taken }) => ({ mp, masse_totale_kg: taken }))
    const coutTotal = calcCout(lignesEnrichiesCout)
    const masseTotale = selection.reduce((s, { taken }) => s + taken, 0)
    const coutParTonne = masseTotale > 0 ? coutTotal / masseTotale * 1000 : 0

    // Batch + lignes + stock en une transaction (lib partagée, RPC v9 avec fallback).
    // Chaque ligne fige sa composition effective et trace son sac source pour
    // permettre une restauration fidèle (annulation, repasser en optimiseur…).
    const batch = {
      id: batchId,
      nom,
      recette_id: rcId,
      date_creation: new Date().toISOString().slice(0, 10),
      statut: 'en_cours',
      cout_total_eur: Math.round(coutTotal),
      cout_par_tonne_eur: Math.round(coutParTonne),
    }
    // Mémoriser MP imposées / restrictions pour un futur "Repasser en optimiseur"
    if (mpsForcees.length > 0 || restrictions.length > 0) {
      batch.optimiseur_params = { mpsForcees, restrictions }
    }
    const lignes = selection.map((s, i) => {
      const ligne = lignePourSac(s.sac, s.taken, i)
      // L'algo a annoté l'état initial du sac (avant prélèvements multi-passes)
      ligne.sacs_consommes[0].masse_avant_kg = s.masse_avant_kg ?? (s.sac.masse_kg ?? 0)
      ligne.sacs_consommes[0].statut_avant = s.statut_avant ?? 'disponible'
      return ligne
    })
    // MAJ stock : cumul des prélèvements par sac (un même sac peut apparaître
    // en MP forcée puis en phase d'optimisation)
    const priseParSac = new Map()
    for (const { sac, taken } of selection) {
      const cur = priseParSac.get(sac.id) ?? { sac, taken: 0 }
      cur.taken += taken
      priseParSac.set(sac.id, cur)
    }
    const sacUpdates = [...priseParSac.values()].map(({ sac, taken }) => sacUpdatePourPrise(sac, taken))

    const err = await creerBatchAvecStock(batch, lignes, sacUpdates)
    if (err) {
      setSaving(false)
      alert(`Erreur : le batch n'a pas pu être créé (stock inchangé).\n${err.message}`)
      return
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
  const coutEstime = selection ? calcCout(selection.map(({ mp, taken }) => ({ mp, masse_totale_kg: taken }))) : 0
  const masseSelection = selection ? selection.reduce((s, { taken }) => s + taken, 0) : 0
  const coutParTonneEstime = masseSelection > 0 ? Math.round(coutEstime / masseSelection * 1000) : 0

  const COMP_PARAMS = COMP_PARAMS_FULL

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
            disabled={loading || (sacs.length === 0 && mpsForcees.length === 0)}
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
              <div className={`p-3 rounded-lg border text-sm flex items-center justify-between flex-wrap gap-2 ${cls}`}>
                <span>
                  Masse totale proposée : <strong>{Math.round(comp.total).toLocaleString('fr-FR')} kg</strong>
                  {' '}(cible {masseCible.toLocaleString('fr-FR')} kg, écart {ecartPct > 0 ? '+' : ''}{ecartPct}%)
                </span>
                {coutEstime > 0 && (
                  <span className="text-gray-700">
                    Coût estimé : <strong>{Math.round(coutEstime).toLocaleString('fr-FR')} €</strong>
                    {' '}<span className="text-gray-500">({coutParTonneEstime} €/t)</span>
                  </span>
                )}
              </div>
            )
          })()}

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
                      {sac.reference || '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-900">
                      {mp?.nom ?? sac.mp_id}
                      {sac.numero_lot_fournisseur && (
                        <span className="ml-2 text-xs text-gray-400">N°{sac.numero_lot_fournisseur}</span>
                      )}
                    </td>
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
                  {COMP_PARAMS.map(p => (
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
