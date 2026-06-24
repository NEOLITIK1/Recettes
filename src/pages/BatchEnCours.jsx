import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { calcComposition, calcCout, fmt1, effectiveMp, COMP_PARAMS_FULL, ratioProduction } from '../lib/calculs.js'
import { restaurerSacsConsommes, lignesRestaurables, lignePourSac, sacUpdatePourPrise } from '../lib/batchOps.js'
import EcartBadge from '../components/EcartBadge.jsx'
import Modal from '../components/Modal.jsx'
import TooltipMp from '../components/TooltipMp.jsx'

export default function BatchEnCours() {
  const [batches, setBatches] = useState([])
  const [recettes, setRecettes] = useState([])
  const [mpsMap, setMpsMap] = useState({})
  const [loading, setLoading] = useState(true)
  const [openConsoHist, setOpenConsoHist] = useState({}) // batchId → bool
  const [sacsMap, setSacsMap] = useState({}) // id → sac (pour retrouver réf/fournisseur/lot à l'impression)

  // Modal ajout de sacs du stock
  const [modalAjout, setModalAjout] = useState(null)
  const [ajoutPrises, setAjoutPrises] = useState([])
  const [sacsStock, setSacsStock] = useState([]) // sacs dispo/partiel pour l'ajout

  // Modal reste
  const [modalReste, setModalReste] = useState(null)
  const [resteKg, setResteKg] = useState('')

  // Modal consommation
  const [modalConso, setModalConso] = useState(null) // batch
  const [consoForm, setConsoForm] = useState({ date: '', masse: '', notes: '', operateur: '' })

  // Modal suppression
  const [modalSuppr, setModalSuppr] = useState(null) // batch

  // Modal récupération du batch en stock (batch pollué/déclassé → nouvelle MP réutilisable)
  const [modalRecup, setModalRecup] = useState(null) // batch
  const [recupForm, setRecupForm] = useState({ nom: '', masse: '', recettes: [] })

  // Modal édition masse d'une ligne (correction opérateur sans repasser par l'optimiseur)
  const [modalEditLigne, setModalEditLigne] = useState(null) // ligne
  const [editMasse, setEditMasse] = useState('')

  // Modal substitution de sac sur une ligne
  const [modalSubst, setModalSubst] = useState(null) // ligne
  const [substSacId, setSubstSacId] = useState('')
  const [substMasse, setSubstMasse] = useState('')

  const navigate = useNavigate()

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    const [{ data: batchData }, { data: rcData }, { data: mpsData }, { data: lignesData }, { data: consoData }, { data: sacsData }] = await Promise.all([
      supabase.from('batches').select('*').eq('statut', 'en_cours').order('created_at', { ascending: false }),
      supabase.from('recettes_cibles').select('*'),
      supabase.from('matieres_premieres').select('*').order('id'),
      supabase.from('batch_lignes').select('*'),
      supabase.from('batch_consommations').select('*').order('date_consommation', { ascending: false }),
      supabase.from('sacs').select('*'),
    ])
    const mps = {}
    for (const mp of (mpsData ?? [])) mps[mp.id] = mp
    setMpsMap(mps)
    setRecettes(rcData ?? [])
    const sacsM = {}
    for (const s of (sacsData ?? [])) sacsM[s.id] = s
    setSacsMap(sacsM)
    setSacsStock((sacsData ?? []).filter(s => s.statut === 'disponible' || s.statut === 'partiel'))

    const lignesParBatch = {}
    for (const l of (lignesData ?? [])) {
      if (!lignesParBatch[l.batch_id]) lignesParBatch[l.batch_id] = []
      lignesParBatch[l.batch_id].push(l)
    }
    const consoParBatch = {}
    for (const c of (consoData ?? [])) {
      if (!consoParBatch[c.batch_id]) consoParBatch[c.batch_id] = []
      consoParBatch[c.batch_id].push(c)
    }
    setBatches((batchData ?? []).map(b => ({
      ...b,
      lignes: lignesParBatch[b.id] ?? [],
      consommations: consoParBatch[b.id] ?? [],
    })))
    setLoading(false)
  }

  // ── Helpers calculs batch ──────────────────────────────────────────────────
  function masseTotaleBatch(batch) {
    return batch.lignes.reduce((s, l) => s + (l.masse_totale_kg ?? 0), 0)
  }
  function masseConsommeeBatch(batch) {
    return (batch.consommations ?? []).reduce((s, c) => s + (c.masse_kg ?? 0), 0)
  }
  function bilanBatch(batch) {
    const total = masseTotaleBatch(batch)
    const consommee = masseConsommeeBatch(batch)
    const reste = batch.reste_declare_kg ?? 0
    // Écart signé : positif = masse non déclarée, négatif = sur-déclaration (saisie erronée)
    const nonComptabilise = total - consommee - reste
    const restanteMelange = Math.max(0, nonComptabilise)
    const ecartPct = total > 0 ? Math.abs(nonComptabilise) / total * 100 : 0
    return { total, consommee, reste, restanteMelange, nonComptabilise, ecartPct }
  }

  // ── Repasser en optimiseur ─────────────────────────────────────────────────
  async function repasserEnOptimiseur(batch) {
    if (!confirm(`Repasser le batch "${batch.nom}" en optimiseur ? Les sacs originaux seront restaurés en stock.`)) return
    await restaurerSacsConsommes(batch.lignes)
    await supabase.from('batch_consommations').delete().eq('batch_id', batch.id)
    await supabase.from('batch_lignes').delete().eq('batch_id', batch.id)
    await supabase.from('batches').delete().eq('id', batch.id)
    // Restituer aussi les sacs imposés / restrictions mémorisés à la création
    localStorage.setItem('optimiseur_prefill', JSON.stringify({
      recetteId: batch.recette_id,
      masse: Math.round(masseTotaleBatch(batch)),
      nom: batch.nom,
      sacsForces: batch.optimiseur_params?.sacsForces ?? [],
      restrictions: batch.optimiseur_params?.restrictions ?? [],
    }))
    navigate('/optimiseur')
  }

  // ── Suppression avec choix ─────────────────────────────────────────────────
  function ouvrirSuppression(batch) {
    setModalSuppr(batch)
  }
  async function confirmerSuppression(restaurer) {
    const batch = modalSuppr
    if (!batch) return
    if (restaurer) {
      await restaurerSacsConsommes(batch.lignes)
    }
    await supabase.from('batch_consommations').delete().eq('batch_id', batch.id)
    await supabase.from('batch_lignes').delete().eq('batch_id', batch.id)
    await supabase.from('batches').delete().eq('id', batch.id)
    setModalSuppr(null)
    fetchAll()
  }
  function batchPeutEtreRestaure(batch) {
    return lignesRestaurables(batch.lignes)
  }

  // ── Clôture ────────────────────────────────────────────────────────────────
  async function cloturerBatch(batch) {
    const { ecartPct, nonComptabilise } = bilanBatch(batch)
    const masseNonDeclaree = nonComptabilise
    if (ecartPct > 5) {
      const detail = masseNonDeclaree >= 0
        ? `${Math.round(masseNonDeclaree)} kg de mélange ne sont ni consommés ni déclarés en reste`
        : `${Math.round(-masseNonDeclaree)} kg déclarés EN TROP par rapport à la masse du batch (vérifiez les consommations saisies)`
      alert(`Impossible de clôturer : ${detail} (écart ${ecartPct.toFixed(1)}% > 5%).\n\nCorrigez les déclarations avant de clôturer.`)
      return
    }
    let msg = `Clôturer le batch "${batch.nom}" ? Il passera dans l'historique.`
    if (masseNonDeclaree > 0) {
      msg += `\n\n⚠ Attention : ${Math.round(masseNonDeclaree)} kg non déclarés (perte technique acceptée).`
    }
    if (!confirm(msg)) return
    await supabase.from('batches').update({ statut: 'cloture' }).eq('id', batch.id)
    fetchAll()
  }

  // ── Modifier la masse d'une ligne (correction directe, sans optimiseur) ──────
  // Le delta est répercuté sur le sac source : réduire la ligne restitue la
  // matière au sac, augmenter prélève davantage (dans la limite du disponible).
  function ouvrirEditLigne(ligne) {
    setModalEditLigne(ligne)
    setEditMasse(String(Math.round(ligne.masse_totale_kg ?? 0)))
  }
  // mode (réduction d'un sac tracé) :
  //   'restituer' = la différence existe physiquement → remise au stock
  //   'ecart'     = écart de pesée (poids palette fournisseur) → sac clôturé,
  //                 rien n'est restitué et le total réel du sac est corrigé
  async function modifierMasseLigne(mode) {
    const ligne = modalEditLigne
    if (!ligne) return
    const nouvelleMasse = parseFloat(editMasse)
    if (!nouvelleMasse || nouvelleMasse <= 0) { alert('Masse invalide.'); return }
    const ancienneMasse = ligne.masse_totale_kg ?? 0
    const delta = nouvelleMasse - ancienneMasse // >0 = prélever plus, <0 = réduire
    if (Math.abs(delta) < 0.5) { setModalEditLigne(null); return }

    const sc = Array.isArray(ligne.sacs_consommes) ? ligne.sacs_consommes : []
    const trackedSingle = sc.length === 1 && sc[0]?.sac_id

    if (trackedSingle) {
      const entry = sc[0]
      const newEntry = { ...entry, masse_prise: nouvelleMasse }
      const { data: sac } = await supabase
        .from('sacs').select('id, masse_kg, statut').eq('id', entry.sac_id).maybeSingle()
      if (!sac) {
        if (!confirm("Le sac source n'existe plus en stock. Modifier seulement la masse de la ligne, sans ajuster le stock ?")) return
      } else if (delta > 0) {
        // Prélèvement supplémentaire sur le sac
        const nouvelleMasseSac = (sac.masse_kg ?? 0) - delta
        if (nouvelleMasseSac < -0.5) {
          alert(`Impossible : il faudrait prélever ${Math.round(delta)} kg de plus, mais le sac ne contient que ${Math.round(sac.masse_kg ?? 0)} kg disponibles.`)
          return
        }
        const masseAvant = entry.masse_avant_kg ?? nouvelleMasse
        const masseSacFinale = Math.max(0, Math.round(nouvelleMasseSac))
        const statutFinal = masseSacFinale <= 0 ? 'consomme'
          : (masseSacFinale >= masseAvant - 0.5 ? (entry.statut_avant ?? 'disponible') : 'partiel')
        const err = await majStockSac(sac.id, masseSacFinale, statutFinal)
        if (err) return
      } else if (mode === 'ecart') {
        // Écart de pesée : ne rien restituer, corriger le total réel du sac (masse_avant)
        const masseAvantCorrige = Math.max(0, Math.round((entry.masse_avant_kg ?? ancienneMasse) + delta))
        const masseSacFinale = Math.max(0, Math.round(sac.masse_kg ?? 0)) // inchangé
        const statutFinal = masseSacFinale <= 0 ? 'consomme'
          : (masseSacFinale >= masseAvantCorrige - 0.5 ? (entry.statut_avant ?? 'disponible') : 'partiel')
        const err = await majStockSac(sac.id, masseSacFinale, statutFinal)
        if (err) return
        newEntry.masse_avant_kg = masseAvantCorrige
      } else {
        // Restituer la différence au stock (prélèvement partiel : la matière existe)
        const masseAvant = entry.masse_avant_kg ?? nouvelleMasse
        const masseSacFinale = Math.max(0, Math.round((sac.masse_kg ?? 0) - delta)) // delta<0 → ajoute
        const statutFinal = masseSacFinale <= 0 ? 'consomme'
          : (masseSacFinale >= masseAvant - 0.5 ? (entry.statut_avant ?? 'disponible') : 'partiel')
        const err = await majStockSac(sac.id, masseSacFinale, statutFinal)
        if (err) return
      }
      const { error: lErr } = await supabase.from('batch_lignes').update({
        masse_totale_kg: nouvelleMasse, sacs_kg: [nouvelleMasse], sacs_consommes: [newEntry],
      }).eq('id', ligne.id)
      if (lErr) { alert(`Erreur lors de la mise à jour de la ligne.\n${lErr.message}`); return }
    } else {
      if (!confirm("Cette ligne n'a pas de sac source unique tracé (batch ancien ou manuel) : la masse sera modifiée mais le stock ne sera PAS ajusté automatiquement. Continuer ?")) return
      const { error: lErr } = await supabase.from('batch_lignes').update({
        masse_totale_kg: nouvelleMasse, sacs_kg: [nouvelleMasse],
      }).eq('id', ligne.id)
      if (lErr) { alert(`Erreur lors de la mise à jour de la ligne.\n${lErr.message}`); return }
    }
    setModalEditLigne(null)
    setEditMasse('')
    fetchAll()
  }

  // Helper : met à jour masse + statut d'un sac, retourne l'erreur éventuelle
  async function majStockSac(id, masse_kg, statut) {
    const { error } = await supabase.from('sacs')
      .update({ masse_kg, statut, updated_at: new Date().toISOString() }).eq('id', id)
    if (error) alert(`Erreur lors de l'ajustement du stock.\n${error.message}`)
    return error
  }

  // ── Substituer le sac d'une ligne par un autre sac du stock ──────────────────
  // Restitue l'ancien sac, prélève le nouveau, et met la ligne à jour
  // (la matière/composition de la ligne suit le nouveau sac).
  function ouvrirSubst(ligne) {
    setModalSubst(ligne)
    setSubstSacId('')
    setSubstMasse(String(Math.round(ligne.masse_totale_kg ?? 0)))
  }
  async function substituerSac() {
    const ligne = modalSubst
    if (!ligne) return
    const masse = parseFloat(substMasse)
    if (!substSacId) { alert('Sélectionnez un sac de remplacement.'); return }
    if (!masse || masse <= 0) { alert('Masse invalide.'); return }

    // 1. Restituer l'ancien sac (si la ligne le traçait)
    await restaurerSacsConsommes([ligne])

    // 2. Relire le nouveau sac APRÈS restitution (gère le cas du même sac, masse à jour)
    const { data: nouveauSac } = await supabase.from('sacs').select('*').eq('id', substSacId).maybeSingle()
    if (!nouveauSac) { alert('Sac de remplacement introuvable.'); fetchAll(); return }
    if (masse > (nouveauSac.masse_kg ?? 0) + 0.5) {
      alert(`Le sac sélectionné ne contient que ${Math.round(nouveauSac.masse_kg ?? 0)} kg — impossible d'en prélever ${Math.round(masse)} kg. L'ancien sac a été restitué ; relancez la substitution.`)
      fetchAll()
      return
    }

    // 3. Prélever le nouveau sac
    const upd = sacUpdatePourPrise(nouveauSac, masse)
    const err = await majStockSac(nouveauSac.id, upd.masse_kg, upd.statut)
    if (err) { fetchAll(); return }

    // 4. Réécrire la ligne avec le nouveau sac (mp_id, snapshot, composition)
    const nl = lignePourSac(nouveauSac, masse, ligne.ordre ?? 0, effectiveMp(mpsMap[nouveauSac.mp_id], nouveauSac.composition_override))
    const { error: lErr } = await supabase.from('batch_lignes').update({
      mp_id: nl.mp_id,
      masse_totale_kg: nl.masse_totale_kg,
      sacs_kg: nl.sacs_kg,
      sacs_consommes: nl.sacs_consommes,
      composition_snapshot: nl.composition_snapshot,
    }).eq('id', ligne.id)
    if (lErr) { alert(`Erreur lors de la mise à jour de la ligne.\n${lErr.message}`); fetchAll(); return }

    setModalSubst(null)
    setSubstSacId('')
    setSubstMasse('')
    fetchAll()
  }

  // ── Récupérer le batch en stock (batch pollué / déclassé) ────────────────────
  // Tout le batch devient UNE nouvelle MP interne + un sac, avec un nom libre et
  // des recettes autorisées choisies (ex: un Sable Éclatant pollué de noir, qu'on
  // ne réautorise que dans les recettes Noir). Le batch est clôturé.
  function ouvrirRecup(batch) {
    setModalRecup(batch)
    setRecupForm({
      nom: `Récupéré — ${batch.nom}`,
      masse: String(Math.round(masseTotaleBatch(batch))),
      recettes: [],
    })
  }
  async function recupererBatchEnStock() {
    const batch = modalRecup
    if (!batch) return
    const masse = parseFloat(recupForm.masse)
    if (!recupForm.nom.trim()) { alert('Donnez un nom à la matière récupérée.'); return }
    if (!masse || masse <= 0) { alert('Masse invalide.'); return }
    if (!recupForm.recettes.length) {
      if (!confirm("Aucune recette autorisée sélectionnée : la matière sera utilisable dans TOUTES les recettes. Continuer ?")) return
    }

    const lignesEnrichies = batch.lignes.map(l => ({ mp: effectiveMp(mpsMap[l.mp_id], l.composition_snapshot), masse_totale_kg: l.masse_totale_kg }))
    const comp = calcComposition(lignesEnrichies)
    if (!comp) { alert('Composition du batch vide.'); return }
    const coutBatch = calcCout(lignesEnrichies)
    const masseBatch = lignesEnrichies.reduce((s, l) => s + l.masse_totale_kg, 0)
    const coutT = masseBatch > 0 ? Math.round(coutBatch / masseBatch * 1000) : 0
    const r1 = v => Math.round((v ?? 0) * 10) / 10

    const mpId = `MP_REC_${batch.id}`
    const { error: mpErr } = await supabase.from('matieres_premieres').upsert({
      id: mpId,
      nom: recupForm.nom.trim(),
      type_appro: 'Interne',
      description: `Batch récupéré : ${batch.nom}`,
      cout_par_tonne: coutT,
      pct_pp: r1(comp.pp), pct_pe: r1(comp.pe), pct_alu: r1(comp.alu),
      pct_autres: r1(comp.autres), pct_autres_plastiques: r1(comp.autresPlast),
      pct_blanc: r1(comp.blanc), pct_transparent: r1(comp.transp), pct_noir: r1(comp.noir),
      pct_autres_couleurs: r1(comp.autresCoul), pct_sable: r1(comp.ecoLithe), pct_charge_minerale: r1(comp.chargeMin),
      recettes_autorisees: recupForm.recettes,
    }, { onConflict: 'id' })
    if (mpErr) { alert(`Erreur : la matière récupérée n'a pas pu être créée.\n${mpErr.message}`); return }

    const { error: sacErr } = await supabase.from('sacs').insert({
      mp_id: mpId, masse_kg: masse, reference: `Récup-${batch.id}`, statut: 'disponible',
    })
    if (sacErr) { alert(`Erreur : le sac récupéré n'a pas pu être ajouté au stock.\n${sacErr.message}`); return }

    const { error: cErr } = await supabase.from('batches').update({ statut: 'cloture' }).eq('id', batch.id)
    if (cErr) { alert(`La matière a été créée mais le batch n'a pas pu être clôturé.\n${cErr.message}`) }

    setModalRecup(null)
    fetchAll()
  }

  // ── Supprimer une ligne ────────────────────────────────────────────────────
  async function supprimerLigne(ligne) {
    const tracked = Array.isArray(ligne.sacs_consommes) && ligne.sacs_consommes.length > 0
    const msg = tracked
      ? 'Supprimer cette ligne ? Le(s) sac(s) prélevé(s) seront remis en stock.'
      : 'Supprimer cette ligne ? Pas de tracking du sac source : le stock ne sera pas modifié.'
    if (!confirm(msg)) return
    if (tracked) await restaurerSacsConsommes([ligne])
    const { error } = await supabase.from('batch_lignes').delete().eq('id', ligne.id)
    if (error) alert(`Erreur lors de la suppression de la ligne.\n${error.message}`)
    fetchAll()
  }

  // ── Ajouter des sacs du stock ─────────────────────────────────────────────
  const sacsStockById = Object.fromEntries(sacsStock.map(s => [s.id, s]))
  function labelSacStock(sac) {
    const mp = mpsMap[sac.mp_id]
    const ref = sac.reference || (sac.numero_lot_fournisseur ? `N°${sac.numero_lot_fournisseur}` : sac.id.slice(0, 8))
    return `${ref} — ${mp?.nom ?? sac.mp_id} — ${Math.round(sac.masse_kg ?? 0)} kg${sac.fournisseur ? ' · ' + sac.fournisseur : ''}`
  }
  function majAjoutPrise(i, field, value) {
    setAjoutPrises(prev => prev.map((p, idx) => {
      if (idx !== i) return p
      if (field === 'sacId') {
        const sac = sacsStockById[value]
        return { sacId: value, taken: sac ? String(Math.round(sac.masse_kg ?? 0)) : '' }
      }
      return { ...p, [field]: value }
    }))
  }
  async function ajouterSacsAuBatch() {
    const selection = ajoutPrises
      .map(p => ({ sac: sacsStockById[p.sacId], taken: parseFloat(p.taken) || 0 }))
      .filter(s => s.sac && s.taken > 0)
    if (!modalAjout || selection.length === 0) return

    const idsVus = new Set()
    for (const { sac, taken } of selection) {
      if (idsVus.has(sac.id)) {
        alert(`Le sac "${labelSacStock(sac)}" apparaît deux fois. Fusionnez les lignes.`)
        return
      }
      idsVus.add(sac.id)
      if (taken > (sac.masse_kg ?? 0) + 0.5) {
        alert(`Le sac "${labelSacStock(sac)}" ne contient que ${Math.round(sac.masse_kg)} kg — impossible d'en prélever ${Math.round(taken)} kg.`)
        return
      }
    }

    const lignes = selection.map(({ sac, taken }, i) => ({
      ...lignePourSac(sac, taken, 99 + i, effectiveMp(mpsMap[sac.mp_id], sac.composition_override)),
      batch_id: modalAjout,
    }))
    const { error: lErr } = await supabase.from('batch_lignes').insert(lignes)
    if (lErr) {
      alert(`Erreur : impossible d'ajouter les sacs au batch (stock inchangé).\n${lErr.message}`)
      return
    }
    for (const { sac, taken } of selection) {
      const upd = sacUpdatePourPrise(sac, taken)
      const { error: sErr } = await supabase.from('sacs')
        .update({ masse_kg: upd.masse_kg, statut: upd.statut, updated_at: new Date().toISOString() })
        .eq('id', sac.id)
      if (sErr) alert(`Attention : la ligne a été ajoutée mais le stock du sac n'a pas pu être mis à jour.\n${sErr.message}`)
    }
    setModalAjout(null)
    setAjoutPrises([])
    fetchAll()
  }

  // ── Déclarer consommation ──────────────────────────────────────────────────
  function ouvrirConso(batch) {
    setModalConso(batch)
    setConsoForm({
      date: new Date().toISOString().slice(0, 10),
      masse: '',
      notes: '',
      operateur: '',
    })
  }
  async function enregistrerConso() {
    const masse = parseFloat(consoForm.masse)
    if (!modalConso || !masse || masse <= 0) return
    const batch = modalConso
    const { total, consommee, reste } = bilanBatch(batch)
    const restant = total - consommee - reste
    if (masse > restant + 0.5) {
      if (!confirm(`Vous déclarez ${masse} kg mais il ne reste que ${Math.round(restant)} kg dans le batch. Continuer quand même ?`)) return
    }
    await supabase.from('batch_consommations').insert({
      batch_id: batch.id,
      date_consommation: consoForm.date || new Date().toISOString().slice(0, 10),
      masse_kg: masse,
      notes: consoForm.notes || null,
      operateur: consoForm.operateur || null,
    })
    setModalConso(null)
    setConsoForm({ date: '', masse: '', notes: '', operateur: '' })
    fetchAll()
  }
  async function supprimerConso(consoId) {
    if (!confirm('Supprimer cette ligne de consommation ?')) return
    await supabase.from('batch_consommations').delete().eq('id', consoId)
    fetchAll()
  }

  // ── Déclarer reste ─────────────────────────────────────────────────────────
  async function declarerReste() {
    const kg = parseFloat(resteKg)
    if (!kg || kg <= 0 || !modalReste) return
    const batch = modalReste
    const { restanteMelange } = bilanBatch(batch)
    if (kg > restanteMelange + 0.5) {
      if (!confirm(`Vous déclarez ${Math.round(kg)} kg de reste mais il ne reste que ${Math.round(restanteMelange)} kg non comptabilisés dans ce batch. Continuer quand même ?`)) return
    }
    const lignesEnrichies = batch.lignes.map(l => ({ mp: effectiveMp(mpsMap[l.mp_id], l.composition_snapshot), masse_totale_kg: l.masse_totale_kg }))
    const comp = calcComposition(lignesEnrichies)
    if (!comp) return
    const coutBatch = calcCout(lignesEnrichies)
    const masseBatch = lignesEnrichies.reduce((s, l) => s + l.masse_totale_kg, 0)
    const coutReste = masseBatch > 0 ? Math.round(coutBatch / masseBatch * 1000) : 0

    const mpId = `MP_${batch.id}`
    const { error: mpErr } = await supabase.from('matieres_premieres').upsert({
      id: mpId,
      nom: `Reste batch ${batch.id}`,
      type_appro: 'Interne',
      description: `Reste non utilisé du batch ${batch.nom}`,
      cout_par_tonne: coutReste,
      pct_pp:                Math.round(comp.pp          * 10) / 10,
      pct_pe:                Math.round(comp.pe          * 10) / 10,
      pct_alu:               Math.round(comp.alu         * 10) / 10,
      pct_autres:            Math.round(comp.autres      * 10) / 10,
      pct_autres_plastiques: Math.round(comp.autresPlast * 10) / 10,
      pct_blanc:             Math.round(comp.blanc       * 10) / 10,
      pct_transparent:       Math.round(comp.transp      * 10) / 10,
      pct_noir:              Math.round(comp.noir        * 10) / 10,
      pct_autres_couleurs:   Math.round(comp.autresCoul  * 10) / 10,
      pct_sable:             Math.round(comp.ecoLithe    * 10) / 10,
      pct_charge_minerale:   Math.round(comp.chargeMin   * 10) / 10,
    }, { onConflict: 'id' })
    if (mpErr) {
      alert(`Erreur : la MP "Reste batch" n'a pas pu être créée.\n${mpErr.message}`)
      return
    }

    const { error: sacErr } = await supabase.from('sacs').insert({
      mp_id: mpId,
      masse_kg: kg,
      reference: `Reste-${batch.id}`,
      statut: 'disponible',
    })
    if (sacErr) {
      alert(`Erreur : le sac de reste n'a pas pu être ajouté au stock.\n${sacErr.message}`)
      return
    }

    // Met à jour le batch pour mémoriser la quantité déclarée en reste
    const newResteDeclare = (batch.reste_declare_kg ?? 0) + kg
    await supabase.from('batches').update({
      reste_declare_kg: newResteDeclare,
    }).eq('id', batch.id)

    // Si de la masse n'est pas comptabilisée (ni consommée, ni en reste), proposer de la solder
    const totalBatch = masseTotaleBatch(batch)
    const consoBatch = masseConsommeeBatch(batch)
    const masseNonComptabilisee = totalBatch - consoBatch - newResteDeclare

    if (masseNonComptabilisee > 0.5) {
      const ok = confirm(
        `Reste enregistré : ${Math.round(kg)} kg.\n\n` +
        `Il reste ${Math.round(masseNonComptabilisee)} kg du batch non comptabilisés (ni consommés, ni en reste).\n\n` +
        `Voulez-vous les déclarer comme consommés en production aujourd'hui ?\n\n` +
        `OK → solde le batch en ajoutant une conso "Solde batch" de ${Math.round(masseNonComptabilisee)} kg. Le batch sera prêt à clôturer.\n` +
        `Annuler → vous compléterez la conso jour par jour avant de clôturer.`
      )
      if (ok) {
        await supabase.from('batch_consommations').insert({
          batch_id: batch.id,
          date_consommation: new Date().toISOString().slice(0, 10),
          masse_kg: Math.round(masseNonComptabilisee),
          notes: 'Solde batch (auto)',
        })
      }
    }

    setModalReste(null)
    setResteKg('')
    fetchAll()
  }

  // ── Impression ─────────────────────────────────────────────────────────────
  function imprimerBatch(batch) {
    const rc = recettes.find(r => r.id === batch.recette_id)
    const lignesEnrichies = batch.lignes.map(l => ({ mp: effectiveMp(mpsMap[l.mp_id], l.composition_snapshot), masse_totale_kg: l.masse_totale_kg, sacs_kg: l.sacs_kg }))
    const comp = calcComposition(lignesEnrichies)
    const ratioProd = ratioProduction(comp)
    const masseTotale = batch.lignes.reduce((s, l) => s + l.masse_totale_kg, 0)

    const COMP_PARAMS_PRINT = COMP_PARAMS_FULL

    // Échappement HTML basique pour les valeurs venant de l'utilisateur
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))

    // Récupère l'identifiant le plus utile pour un sac donné :
    // 1. snapshot stocké dans sacs_consommes (résiste à la suppression du sac)
    // 2. sinon, lookup dans sacsMap (sacs courants en DB)
    function sacInfo(sacEntry) {
      const fromMap = sacEntry?.sac_id ? sacsMap[sacEntry.sac_id] : null
      return {
        reference:              sacEntry?.reference              ?? fromMap?.reference              ?? null,
        fournisseur:            sacEntry?.fournisseur            ?? fromMap?.fournisseur            ?? null,
        numero_lot_fournisseur: sacEntry?.numero_lot_fournisseur ?? fromMap?.numero_lot_fournisseur ?? null,
        emplacement:            sacEntry?.emplacement            ?? fromMap?.emplacement            ?? null,
      }
    }

    const lignesHtml = batch.lignes.map(l => {
      const mp = mpsMap[l.mp_id]
      const sacsConsommes = Array.isArray(l.sacs_consommes) ? l.sacs_consommes : []

      let sacsHtml
      if (sacsConsommes.length > 0) {
        // Nouveau format détaillé : référence fournisseur en premier plan
        sacsHtml = sacsConsommes.map((sc, i) => {
          const info = sacInfo(sc)
          const masse = Math.round(sc.masse_prise ?? 0)
          // Sac partiel : on ne prélève qu'une partie du big bag → à signaler clairement
          const masseSac = Math.round(sc.masse_avant_kg ?? 0)
          const estPartiel = masseSac > 0 && masse < masseSac - 0.5
          // Priorité d'affichage : N° lot fournisseur (lisible sur le big bag)
          const idPrincipal = info.numero_lot_fournisseur
            ? `<strong>N°lot ${esc(info.numero_lot_fournisseur)}</strong>`
            : info.reference ? `<strong>${esc(info.reference)}</strong>` : `<strong>Sac ${i + 1}</strong>`
          const meta = []
          if (info.fournisseur) meta.push(esc(info.fournisseur))
          if (info.numero_lot_fournisseur && info.reference) meta.push(`réf. ${esc(info.reference)}`)
          if (info.emplacement) meta.push(`📍 ${esc(info.emplacement)}`)
          const metaStr = meta.length ? ` <span style="color:#999;">· ${meta.join(' · ')}</span>` : ''
          const partielBadge = estPartiel
            ? ` <span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;font-weight:700;font-size:11px;">⚠ PARTIEL — prélever ${masse} kg sur ${masseSac} kg</span>`
            : ''
          const masseStr = estPartiel
            ? `<strong>${masse} kg</strong> <span style="color:#999;">(sac de ${masseSac} kg)</span>`
            : `<strong>${masse} kg</strong>`
          return `<div style="padding:3px 0 3px 10px;border-left:2px solid ${estPartiel ? '#f59e0b' : '#ddd'};margin:2px 0;">
            ${idPrincipal}${metaStr} — ${masseStr}${partielBadge}
          </div>`
        }).join('')
      } else {
        // Fallback pour batchs anciens / manuels sans tracking : juste les masses
        sacsHtml = (l.sacs_kg ?? [l.masse_totale_kg])
          .map((s, i) => `Sac ${i + 1}: ${Math.round(s)} kg`).join(' | ')
      }

      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;vertical-align:top;">${esc(mp?.nom ?? l.mp_id)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;font-weight:600;vertical-align:top;">${Math.round(l.masse_totale_kg)} kg</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;color:#666;">${sacsHtml}</td>
      </tr>`
    }).join('')

    const compHtml = comp && rc ? COMP_PARAMS_PRINT
      .map(p => {
        const e = comp[p.key] - (rc[p.cibleKey] ?? 0)
        const color = Math.abs(e) <= 2 ? '#166534' : Math.abs(e) <= 5 ? '#92400e' : '#991b1b'
        return `<tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;">${p.label}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${fmt1(comp[p.key])}%</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;color:#999;">${rc[p.cibleKey] ?? 0}%</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;color:${color};font-weight:600;">${e >= 0 ? '+' : ''}${fmt1(e)}%</td>
        </tr>`
      }).join('') : ''

    // Bloc "Mélange production" : ratio sable/plastique à viser
    let prodHtml = ''
    if (ratioProd) {
      const sableAjout = Math.round(masseTotale * ratioProd.sablePct / ratioProd.plastiquePct)
      if (ratioProd.impossible) {
        prodHtml = `<div style="margin-bottom:24px;padding:12px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;">
          <div style="font-weight:700;color:#92400e;margin-bottom:4px;">🏭 Mélange production</div>
          <div style="font-size:13px;color:#92400e;">Ce batch contient déjà <strong>${fmt1(ratioProd.mineralPct)}%</strong> de sable/minéral, soit autant ou plus que la cible standard (${ratioProd.sableStd}/${ratioProd.plastStd}). <strong>Ne pas ajouter de sable</strong> en production.</div>
        </div>`
      } else if (ratioProd.standard) {
        prodHtml = `<div style="margin-bottom:24px;padding:12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;">
          <div style="font-weight:700;color:#1e3a8a;margin-bottom:4px;">🏭 Mélange production</div>
          <div style="font-size:16px;font-weight:700;color:#1e3a8a;">Viser ${ratioProd.sableStd}% sable · ${ratioProd.plastStd}% plastique (ce batch)</div>
          <div style="font-size:12px;color:#1d4ed8;margin-top:2px;">soit ≈ <strong>${sableAjout.toLocaleString('fr-FR')} kg de sable à ajouter</strong> pour ${Math.round(masseTotale).toLocaleString('fr-FR')} kg de batch</div>
        </div>`
      } else {
        prodHtml = `<div style="margin-bottom:24px;padding:12px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;">
          <div style="font-weight:700;color:#92400e;margin-bottom:4px;">🏭 Mélange production — sable déjà pré-intégré</div>
          <div style="font-size:13px;color:#92400e;">Ce batch contient déjà <strong>${fmt1(ratioProd.mineralPct)}%</strong> de sable/minéral. Au lieu du standard ${ratioProd.sableStd}/${ratioProd.plastStd}, viser :</div>
          <div style="font-size:16px;font-weight:700;color:#78350f;margin-top:4px;">${Math.round(ratioProd.sablePct)}% sable · ${Math.round(ratioProd.plastiquePct)}% plastique (ce batch)</div>
          <div style="font-size:12px;color:#a16207;margin-top:2px;">soit ≈ <strong>${sableAjout.toLocaleString('fr-FR')} kg de sable à ajouter</strong> pour ${Math.round(masseTotale).toLocaleString('fr-FR')} kg de batch</div>
        </div>`
      }
    }

    const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Fiche batch ${batch.id}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 14px; color: #111; margin: 32px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th { text-align: left; padding: 8px; background: #f5f5f5; font-size: 12px; color: #555; }
  .footer { margin-top: 40px; font-size: 12px; color: #999; border-top: 1px solid #eee; padding-top: 12px; }
  @media print { body { margin: 16px; } }
</style>
</head>
<body>
<div style="display:flex;justify-content:space-between;align-items:start;">
  <div>
    <h1>${batch.nom}</h1>
    <div class="sub">${batch.id} · ${rc?.nom ?? ''} · ${batch.date_creation ?? ''} · Total : ${Math.round(masseTotale).toLocaleString('fr-FR')} kg</div>
  </div>
  <div style="font-size:20px;font-weight:700;color:#16a34a;">NEOLITIK</div>
</div>

<h2 style="font-size:14px;margin-bottom:8px;">Matières à mélanger</h2>
<table>
  <thead><tr><th>Matière</th><th style="text-align:right;">Total</th><th>Répartition sacs</th></tr></thead>
  <tbody>${lignesHtml}</tbody>
</table>

${prodHtml}

${compHtml ? `<h2 style="font-size:14px;margin-bottom:8px;">Composition résultante vs cible</h2>
<table>
  <thead><tr><th>Paramètre</th><th style="text-align:right;">Résultat</th><th style="text-align:right;">Cible</th><th style="text-align:right;">Écart</th></tr></thead>
  <tbody>${compHtml}</tbody>
</table>` : ''}

<div class="footer">
  Imprimé le ${new Date().toLocaleDateString('fr-FR')} · NEOLITIK Production
  <div style="margin-top:16px;">Signature opérateur : ___________________________</div>
</div>
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 100));</script>
</body></html>`

    const win = window.open('', '_blank')
    if (!win) {
      alert('Bloqué par le navigateur. Autorisez les pop-ups pour imprimer.')
      return
    }
    win.document.write(html)
    win.document.close()
  }

  const COMP_PARAMS = COMP_PARAMS_FULL

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Batchs en cours</h1>
        <p className="text-sm text-gray-500 mt-0.5">{batches.length} batch{batches.length !== 1 ? 's' : ''} actif{batches.length !== 1 ? 's' : ''}</p>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400 text-center py-8">Chargement…</p>
      ) : batches.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400 text-sm">
          Aucun batch en cours. Créez-en un via l'Optimiseur ou la Composition manuelle.
        </div>
      ) : (
        <div className="space-y-6">
          {batches.map(batch => {
            const rc = recettes.find(r => r.id === batch.recette_id)
            const lignesEnrichies = batch.lignes.map(l => ({ mp: effectiveMp(mpsMap[l.mp_id], l.composition_snapshot), masse_totale_kg: l.masse_totale_kg }))
            const comp = calcComposition(lignesEnrichies)
            const ratioProd = ratioProduction(comp)
            const { total, consommee, reste, restanteMelange, ecartPct } = bilanBatch(batch)
            const pctConso = total > 0 ? Math.min(100, (consommee / total) * 100) : 0
            const pctReste = total > 0 ? Math.min(100 - pctConso, (reste / total) * 100) : 0
            const peutCloturer = ecartPct <= 5
            const consoOpen = !!openConsoHist[batch.id]

            return (
              <div key={batch.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                {/* En-tête batch */}
                <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                      <span className="font-mono text-xs text-gray-400">{batch.id}</span>
                      {rc && <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{rc.nom}</span>}
                      <span className="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">En cours</span>
                      {batch.cout_par_tonne_eur && <span className="text-xs text-gray-400">{batch.cout_par_tonne_eur} €/t</span>}
                    </div>
                    <h2 className="font-medium text-gray-900">{batch.nom}</h2>
                    <p className="text-sm text-gray-500 mt-0.5">
                      {Math.round(total).toLocaleString('fr-FR')} kg total · {batch.lignes.length} matière{batch.lignes.length !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-wrap justify-end">
                    <button onClick={() => imprimerBatch(batch)} className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50">
                      🖨 Imprimer
                    </button>
                    <button onClick={() => repasserEnOptimiseur(batch)} className="text-xs px-3 py-1.5 border border-amber-200 text-amber-700 rounded-lg hover:bg-amber-50">
                      ↩ Optimiseur
                    </button>
                    <button onClick={() => { setModalAjout(batch.id); setAjoutPrises([{ sacId: '', taken: '' }]) }} className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50">
                      + Ajouter MP
                    </button>
                    <button onClick={() => ouvrirConso(batch)} className="text-xs px-3 py-1.5 border border-indigo-200 text-indigo-700 rounded-lg hover:bg-indigo-50">
                      + Consommation
                    </button>
                    <button onClick={() => { setModalReste(batch); setResteKg('') }} className="text-xs px-3 py-1.5 border border-emerald-200 text-emerald-700 rounded-lg hover:bg-emerald-50">
                      Déclarer reste
                    </button>
                    <button onClick={() => ouvrirRecup(batch)} title="Reclasser tout le batch en nouvelle matière réutilisable (batch pollué/déclassé)" className="text-xs px-3 py-1.5 border border-purple-200 text-purple-700 rounded-lg hover:bg-purple-50">
                      ♻ Récupérer en stock
                    </button>
                    <button
                      onClick={() => cloturerBatch(batch)}
                      disabled={!peutCloturer}
                      title={peutCloturer ? 'Clôturer ce batch' : `${Math.round(restanteMelange)} kg non déclarés (écart ${ecartPct.toFixed(1)}% > 5%)`}
                      className="text-xs px-3 py-1.5 border border-blue-200 text-blue-700 rounded-lg hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Clôturer
                    </button>
                    <button onClick={() => ouvrirSuppression(batch)} className="text-xs px-3 py-1.5 border border-red-100 text-red-600 rounded-lg hover:bg-red-50">
                      Supprimer
                    </button>
                  </div>
                </div>

                {/* Jauge consommation */}
                <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span><span className="font-semibold text-gray-900">{Math.round(consommee).toLocaleString('fr-FR')} kg</span> <span className="text-gray-500">consommés</span></span>
                      {reste > 0 && <span><span className="font-semibold text-emerald-700">{Math.round(reste).toLocaleString('fr-FR')} kg</span> <span className="text-gray-500">en reste</span></span>}
                      <span><span className="font-semibold text-gray-700">{Math.round(restanteMelange).toLocaleString('fr-FR')} kg</span> <span className="text-gray-500">dans le mélangeur</span></span>
                    </div>
                    <span className="text-gray-500 tabular-nums">{pctConso.toFixed(0)}% / 100%</span>
                  </div>
                  <div className="w-full h-2 bg-gray-200 rounded overflow-hidden flex">
                    <div className="h-full bg-indigo-500" style={{ width: `${pctConso}%` }} title={`Consommé: ${Math.round(consommee)} kg`} />
                    <div className="h-full bg-emerald-400" style={{ width: `${pctReste}%` }} title={`Reste déclaré: ${Math.round(reste)} kg`} />
                  </div>
                  {(batch.consommations ?? []).length > 0 && (
                    <button
                      onClick={() => setOpenConsoHist(o => ({ ...o, [batch.id]: !o[batch.id] }))}
                      className="text-xs text-gray-500 hover:text-gray-700 mt-2"
                    >
                      {consoOpen ? '▾' : '▸'} Historique consommations ({batch.consommations.length})
                    </button>
                  )}
                  {consoOpen && batch.consommations.length > 0 && (
                    <table className="w-full text-xs mt-2">
                      <thead>
                        <tr className="text-gray-500">
                          <th className="text-left py-1 font-medium">Date</th>
                          <th className="text-right py-1 font-medium">Masse</th>
                          <th className="text-left py-1 pl-3 font-medium">Opérateur</th>
                          <th className="text-left py-1 pl-3 font-medium">Notes</th>
                          <th className="py-1"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {batch.consommations.map(c => (
                          <tr key={c.id} className="border-t border-gray-200">
                            <td className="py-1 text-gray-700">{c.date_consommation ? new Date(c.date_consommation).toLocaleDateString('fr-FR') : '—'}</td>
                            <td className="py-1 text-right font-semibold tabular-nums">{Math.round(c.masse_kg).toLocaleString('fr-FR')} kg</td>
                            <td className="py-1 pl-3 text-gray-600">{c.operateur || '—'}</td>
                            <td className="py-1 pl-3 text-gray-500">{c.notes || '—'}</td>
                            <td className="py-1 text-right">
                              <button onClick={() => supprimerConso(c.id)} className="text-red-400 hover:text-red-600 text-xs">×</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Lignes de matières */}
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-50">
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Matière</th>
                      <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Total</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Sacs</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {batch.lignes.map(l => {
                      const sc = Array.isArray(l.sacs_consommes) ? l.sacs_consommes : []
                      const lotInfo = sc.length === 1
                        ? (sc[0].numero_lot_fournisseur ? `N°lot ${sc[0].numero_lot_fournisseur}` : sc[0].reference)
                        : null
                      const empl = sc.length === 1 ? (sc[0].emplacement ?? sacsMap[sc[0].sac_id]?.emplacement) : null
                      return (
                      <tr key={l.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-gray-900">
                          <TooltipMp mp={effectiveMp(mpsMap[l.mp_id], l.composition_snapshot)}>
                            <span className="cursor-default">{mpsMap[l.mp_id]?.nom ?? l.mp_id}</span>
                          </TooltipMp>
                          {lotInfo && <span className="ml-2 text-xs text-gray-400">{lotInfo}</span>}
                          {empl && <span className="ml-2 text-xs text-gray-400">📍 {empl}</span>}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold tabular-nums">{Math.round(l.masse_totale_kg).toLocaleString('fr-FR')} kg</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {(l.sacs_kg ?? [l.masse_totale_kg]).map((s, i) => (
                              <span key={i} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{Math.round(s)} kg</span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <button onClick={() => ouvrirEditLigne(l)} className="text-xs text-blue-500 hover:text-blue-700 mr-3">Modifier</button>
                          <button onClick={() => ouvrirSubst(l)} className="text-xs text-indigo-500 hover:text-indigo-700 mr-3">Substituer</button>
                          <button onClick={() => supprimerLigne(l)} className="text-xs text-red-400 hover:text-red-600">Supprimer</button>
                        </td>
                      </tr>
                      )
                    })}
                  </tbody>
                </table>

                {/* Composition vs cible */}
                {comp && rc && (
                  <div className="px-4 py-3 bg-gray-50 border-t border-gray-100">
                    <p className="text-xs font-medium text-gray-500 mb-2">Composition vs cible</p>
                    <div className="flex flex-wrap gap-3">
                      {COMP_PARAMS.map(p => (
                        <div key={p.key} className="flex items-center gap-1.5 text-xs">
                          <span className="text-gray-500">{p.label}</span>
                          <span className="font-medium">{fmt1(comp[p.key])}%</span>
                          <EcartBadge valeur={comp[p.key]} cible={rc[p.cibleKey] ?? 0} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Ratio sable/plastique à viser en production */}
                {ratioProd && (
                  <div className={`px-4 py-3 border-t ${ratioProd.standard ? 'bg-blue-50 border-blue-100' : 'bg-amber-50 border-amber-100'}`}>
                    <p className={`text-xs font-medium mb-1 ${ratioProd.standard ? 'text-blue-900' : 'text-amber-900'}`}>
                      🏭 Mélange production{ratioProd.standard ? '' : ' — sable déjà pré-intégré'}
                    </p>
                    {ratioProd.impossible ? (
                      <p className="text-xs text-amber-800">
                        Ce batch contient déjà <strong>{fmt1(ratioProd.mineralPct)}%</strong> de sable/minéral,
                        soit autant ou plus que la cible standard ({ratioProd.sableStd}/{ratioProd.plastStd}). Ne pas ajouter de sable en production
                        (le batch dépasse déjà la proportion minérale visée).
                      </p>
                    ) : ratioProd.standard ? (
                      <p className="text-sm font-semibold text-blue-900">
                        Viser {ratioProd.sableStd}% sable · {ratioProd.plastStd}% plastique (ce batch)
                        <span className="font-normal text-blue-700 text-xs ml-2">
                          soit ≈ {Math.round(total * ratioProd.sablePct / ratioProd.plastiquePct).toLocaleString('fr-FR')} kg de sable à ajouter pour {Math.round(total).toLocaleString('fr-FR')} kg de batch
                        </span>
                      </p>
                    ) : (
                      <>
                        <p className="text-xs text-amber-800">
                          Ce batch contient déjà <strong>{fmt1(ratioProd.mineralPct)}%</strong> de sable/minéral.
                          Au lieu du standard {ratioProd.sableStd}/{ratioProd.plastStd}, viser en production :
                        </p>
                        <p className="text-sm font-semibold text-amber-900 mt-1">
                          {Math.round(ratioProd.sablePct)}% sable · {Math.round(ratioProd.plastiquePct)}% plastique (ce batch)
                          <span className="font-normal text-amber-700 text-xs ml-2">
                            soit ≈ {Math.round(total * ratioProd.sablePct / ratioProd.plastiquePct).toLocaleString('fr-FR')} kg de sable à ajouter pour {Math.round(total).toLocaleString('fr-FR')} kg de batch
                          </span>
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Modal ajout de sacs du stock */}
      <Modal
        open={!!modalAjout}
        onClose={() => setModalAjout(null)}
        title="Ajouter des sacs du stock au batch"
        footer={
          <>
            <button onClick={() => setModalAjout(null)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Annuler</button>
            <button onClick={ajouterSacsAuBatch} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">Ajouter et décompter le stock</button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            Les sacs sélectionnés sont prélevés du stock et tracés : ils seront restitués
            si la ligne ou le batch est annulé.
          </p>
          {sacsStock.length === 0 && (
            <p className="text-xs text-amber-600">Aucun sac disponible en stock.</p>
          )}
          {ajoutPrises.map((p, i) => {
            const sac = sacsStockById[p.sacId]
            const dejaPris = new Set(ajoutPrises.map(x => x.sacId).filter(Boolean))
            return (
              <div key={i} className="flex gap-2 items-center flex-wrap">
                <TooltipMp mp={sac ? effectiveMp(mpsMap[sac.mp_id], sac.composition_override) : null}>
                  <select
                    value={p.sacId}
                    onChange={e => majAjoutPrise(i, 'sacId', e.target.value)}
                    className="flex-1 min-w-[220px] text-sm border border-gray-200 rounded-lg px-3 py-2"
                  >
                    <option value="">Sélectionner un sac…</option>
                    {sacsStock
                      .filter(s => s.id === p.sacId || !dejaPris.has(s.id))
                      .map(s => <option key={s.id} value={s.id}>{labelSacStock(s)}</option>)}
                  </select>
                </TooltipMp>
                <input
                  type="number" min="1"
                  value={p.taken}
                  onChange={e => majAjoutPrise(i, 'taken', e.target.value)}
                  placeholder="kg"
                  className="w-24 text-sm border border-gray-200 rounded-lg px-3 py-2"
                />
                <span className="text-xs text-gray-400">kg{sac ? ` / ${Math.round(sac.masse_kg ?? 0)}` : ''}</span>
                {ajoutPrises.length > 1 && (
                  <button onClick={() => setAjoutPrises(prev => prev.filter((_, idx) => idx !== i))} className="text-red-400">×</button>
                )}
              </div>
            )
          })}
          <button onClick={() => setAjoutPrises(prev => [...prev, { sacId: '', taken: '' }])} className="text-xs text-blue-600 border border-blue-200 rounded px-2 py-1">
            + autre sac
          </button>
        </div>
      </Modal>

      {/* Modal consommation */}
      <Modal
        open={!!modalConso}
        onClose={() => setModalConso(null)}
        title={modalConso ? `Déclarer une consommation — ${modalConso.nom}` : ''}
        footer={
          <>
            <button onClick={() => setModalConso(null)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Annuler</button>
            <button onClick={enregistrerConso} className="px-4 py-2 text-sm bg-indigo-700 text-white rounded-lg hover:bg-indigo-800">Enregistrer</button>
          </>
        }
      >
        {modalConso && (() => {
          const { total, consommee, reste, restanteMelange } = bilanBatch(modalConso)
          return (
            <div className="space-y-3">
              <div className="bg-gray-50 rounded-lg p-3 text-xs space-y-1">
                <div className="flex justify-between"><span className="text-gray-500">Masse totale du batch</span><span className="font-semibold tabular-nums">{Math.round(total).toLocaleString('fr-FR')} kg</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Déjà consommé</span><span className="font-semibold tabular-nums">{Math.round(consommee).toLocaleString('fr-FR')} kg</span></div>
                {reste > 0 && <div className="flex justify-between"><span className="text-gray-500">Reste déclaré</span><span className="font-semibold tabular-nums">{Math.round(reste).toLocaleString('fr-FR')} kg</span></div>}
                <div className="flex justify-between pt-1 border-t border-gray-200"><span className="text-gray-700">Reste dans le mélangeur</span><span className="font-bold tabular-nums">{Math.round(restanteMelange).toLocaleString('fr-FR')} kg</span></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Date</label>
                  <input type="date" value={consoForm.date} onChange={e => setConsoForm(f => ({ ...f, date: e.target.value }))}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Masse consommée (kg) *</label>
                  <input type="number" min="1" value={consoForm.masse} onChange={e => setConsoForm(f => ({ ...f, masse: e.target.value }))}
                    placeholder="ex: 1000" className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2" autoFocus />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Opérateur</label>
                <input value={consoForm.operateur} onChange={e => setConsoForm(f => ({ ...f, operateur: e.target.value }))}
                  placeholder="Nom de l'opérateur" className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Notes (optionnel)</label>
                <textarea value={consoForm.notes} onChange={e => setConsoForm(f => ({ ...f, notes: e.target.value }))}
                  rows={2} placeholder="Observations, incidents…" className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 resize-none" />
              </div>
            </div>
          )
        })()}
      </Modal>

      {/* Modal reste */}
      <Modal
        open={!!modalReste}
        onClose={() => setModalReste(null)}
        title="Déclarer un reste de batch"
        footer={
          <>
            <button onClick={() => setModalReste(null)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Annuler</button>
            <button onClick={declarerReste} className="px-4 py-2 text-sm bg-emerald-700 text-white rounded-lg hover:bg-emerald-800">Créer la MP + sac</button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            La composition du batch sera utilisée pour créer une nouvelle matière première interne,
            et un sac sera ajouté au stock avec la masse déclarée.
          </p>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Masse restante (kg)</label>
            <input type="number" min="1" value={resteKg} onChange={e => setResteKg(e.target.value)}
              placeholder="ex: 500" className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2" />
          </div>
        </div>
      </Modal>

      {/* Modal récupération du batch en stock */}
      <Modal
        open={!!modalRecup}
        onClose={() => setModalRecup(null)}
        title={modalRecup ? `Récupérer en stock — ${modalRecup.nom}` : ''}
        footer={
          <>
            <button onClick={() => setModalRecup(null)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Annuler</button>
            <button onClick={recupererBatchEnStock} className="px-4 py-2 text-sm bg-purple-700 text-white rounded-lg hover:bg-purple-800">Créer la matière + clôturer</button>
          </>
        }
      >
        {modalRecup && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              Tout le batch devient <strong>une nouvelle matière première</strong> (avec sa composition réelle)
              et un sac est ajouté au stock. Le batch est ensuite <strong>clôturé</strong> (passe dans l'historique).
              Utile pour un batch pollué ou déclassé : on le reclasse pour ne l'autoriser que dans certaines recettes.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Nom de la matière récupérée</label>
                <input value={recupForm.nom} onChange={e => setRecupForm(f => ({ ...f, nom: e.target.value }))}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Masse à remettre en stock (kg)</label>
                <input type="number" min="1" value={recupForm.masse} onChange={e => setRecupForm(f => ({ ...f, masse: e.target.value }))}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2" />
              </div>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-700 mb-2">
                Recettes autorisées <span className="text-gray-400 font-normal">(ex: ne réautoriser que dans les recettes Noir)</span>
              </p>
              {recettes.filter(r => !r.archivee).length === 0 ? (
                <p className="text-xs text-gray-400 italic">Aucune recette disponible.</p>
              ) : (
                <div className="space-y-1.5 max-h-44 overflow-y-auto border border-gray-100 rounded-lg p-2">
                  {recettes.filter(r => !r.archivee).map(rc => {
                    const checked = recupForm.recettes.includes(rc.id)
                    return (
                      <label key={rc.id} className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={checked}
                          onChange={() => setRecupForm(f => ({
                            ...f,
                            recettes: checked ? f.recettes.filter(id => id !== rc.id) : [...f.recettes, rc.id],
                          }))}
                          className="rounded border-gray-300 text-gray-900" />
                        <span className="text-sm text-gray-700">{rc.nom}</span>
                        <span className="text-xs text-gray-400">{rc.id}</span>
                      </label>
                    )
                  })}
                </div>
              )}
              <p className="text-xs text-gray-400 mt-1">Laissez vide pour autoriser dans toutes les recettes.</p>
            </div>
          </div>
        )}
      </Modal>

      {/* Modal édition masse d'une ligne */}
      <Modal
        open={!!modalEditLigne}
        onClose={() => setModalEditLigne(null)}
        title={modalEditLigne ? `Modifier la masse — ${mpsMap[modalEditLigne.mp_id]?.nom ?? modalEditLigne.mp_id}` : ''}
        footer={(() => {
          if (!modalEditLigne) return null
          const sc = Array.isArray(modalEditLigne.sacs_consommes) ? modalEditLigne.sacs_consommes : []
          const trackedSingle = sc.length === 1 && sc[0]?.sac_id
          const delta = Math.round((parseFloat(editMasse) || 0) - (modalEditLigne.masse_totale_kg ?? 0))
          const annuler = <button onClick={() => setModalEditLigne(null)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Annuler</button>
          // Réduction d'un sac tracé : choix restituer / écart de pesée
          if (trackedSingle && delta < 0) {
            return (
              <>
                {annuler}
                <button onClick={() => modifierMasseLigne('restituer')} className="px-3 py-2 text-sm border border-emerald-200 text-emerald-700 rounded-lg hover:bg-emerald-50">
                  Restituer {Math.abs(delta)} kg
                </button>
                <button onClick={() => modifierMasseLigne('ecart')} className="px-3 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
                  Écart de pesée
                </button>
              </>
            )
          }
          return (
            <>
              {annuler}
              <button onClick={() => modifierMasseLigne()} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">Enregistrer</button>
            </>
          )
        })()}
      >
        {modalEditLigne && (() => {
          const sc = Array.isArray(modalEditLigne.sacs_consommes) ? modalEditLigne.sacs_consommes : []
          const trackedSingle = sc.length === 1 && sc[0]?.sac_id
          const ancienne = Math.round(modalEditLigne.masse_totale_kg ?? 0)
          const nouvelle = parseFloat(editMasse) || 0
          const delta = Math.round(nouvelle - ancienne)
          const sacActuel = trackedSingle ? sacsMap[sc[0].sac_id] : null
          return (
            <div className="space-y-3">
              <div className="bg-gray-50 rounded-lg p-3 text-xs space-y-1">
                <div className="flex justify-between"><span className="text-gray-500">Masse actuelle de la ligne</span><span className="font-semibold tabular-nums">{ancienne.toLocaleString('fr-FR')} kg</span></div>
                {trackedSingle && (
                  <div className="flex justify-between"><span className="text-gray-500">Reste du sac source en stock</span><span className="font-semibold tabular-nums">{Math.round(sacActuel?.masse_kg ?? 0).toLocaleString('fr-FR')} kg</span></div>
                )}
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Nouvelle masse réellement utilisée (kg)</label>
                <input
                  type="number" min="1" autoFocus
                  value={editMasse}
                  onChange={e => setEditMasse(e.target.value)}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
                />
              </div>
              {delta > 0 && trackedSingle && (
                <p className="text-xs text-gray-600">→ {delta} kg supplémentaires seront prélevés du sac source.</p>
              )}
              {delta < 0 && trackedSingle && (
                <div className="text-xs text-gray-600 space-y-2 border-l-2 border-gray-200 pl-3">
                  <p className="text-gray-700 font-medium">Que faire des {Math.abs(delta)} kg de différence ?</p>
                  <div>
                    <span className="font-semibold text-emerald-700">Restituer {Math.abs(delta)} kg</span> — la matière existe encore (prélèvement partiel). Les {Math.abs(delta)} kg retournent au sac, disponibles pour un autre batch.
                  </div>
                  <div>
                    <span className="font-semibold text-gray-800">Écart de pesée</span> — la différence n'a jamais existé (poids de palette compté à la réception). Le sac est clôturé, rien n'est restitué, et son poids réel est corrigé.
                  </div>
                </div>
              )}
              {!trackedSingle && (
                <p className="text-xs text-amber-700 bg-amber-50 rounded p-2">
                  ⚠ Pas de sac source unique tracé : la masse de la ligne sera modifiée mais le stock ne sera pas ajusté automatiquement.
                </p>
              )}
            </div>
          )
        })()}
      </Modal>

      {/* Modal substitution de sac */}
      <Modal
        open={!!modalSubst}
        onClose={() => setModalSubst(null)}
        title={modalSubst ? `Substituer le sac — ${mpsMap[modalSubst.mp_id]?.nom ?? modalSubst.mp_id}` : ''}
        footer={
          <>
            <button onClick={() => setModalSubst(null)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Annuler</button>
            <button onClick={substituerSac} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">Remplacer et ajuster le stock</button>
          </>
        }
      >
        {modalSubst && (() => {
          const sc = Array.isArray(modalSubst.sacs_consommes) ? modalSubst.sacs_consommes : []
          const tracked = sc.length >= 1 && sc.some(e => e?.sac_id)
          const nouveauSac = sacsStockById[substSacId]
          return (
            <div className="space-y-3">
              <p className="text-xs text-gray-600">
                L'opérateur a utilisé un autre big bag que prévu. Le sac actuel sera
                {tracked ? ' restitué au stock' : ' (non tracé — non restitué)'} et remplacé par celui choisi ci-dessous.
                La matière et la composition de la ligne suivront le nouveau sac.
              </p>
              {!tracked && (
                <p className="text-xs text-amber-700 bg-amber-50 rounded p-2">
                  ⚠ La ligne actuelle n'a pas de sac source tracé : l'ancien ne sera pas restitué, mais le nouveau sera bien décompté.
                </p>
              )}
              <div>
                <label className="block text-xs text-gray-500 mb-1">Sac de remplacement</label>
                <TooltipMp mp={nouveauSac ? effectiveMp(mpsMap[nouveauSac.mp_id], nouveauSac.composition_override) : null}>
                  <select value={substSacId} onChange={e => {
                    const s = sacsStockById[e.target.value]
                    setSubstSacId(e.target.value)
                    if (s) setSubstMasse(String(Math.round(Math.min(s.masse_kg ?? 0, modalSubst.masse_totale_kg ?? 0))))
                  }} className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2">
                    <option value="">Sélectionner un sac…</option>
                    {sacsStock.map(s => <option key={s.id} value={s.id}>{labelSacStock(s)}</option>)}
                  </select>
                </TooltipMp>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Masse à prélever (kg)</label>
                <input type="number" min="1" value={substMasse} onChange={e => setSubstMasse(e.target.value)}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2" />
                {nouveauSac && <p className="text-xs text-gray-400 mt-1">{Math.round(nouveauSac.masse_kg ?? 0)} kg disponibles dans ce sac</p>}
              </div>
            </div>
          )
        })()}
      </Modal>

      {/* Modal suppression */}
      <Modal
        open={!!modalSuppr}
        onClose={() => setModalSuppr(null)}
        title="Supprimer ce batch"
        footer={
          <div className="flex gap-2 w-full flex-wrap">
            <button onClick={() => setModalSuppr(null)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
              Annuler
            </button>
            <div className="flex-1" />
            <button
              onClick={() => confirmerSuppression(false)}
              className="px-4 py-2 text-sm border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
            >
              Apurer l'historique (sans restaurer)
            </button>
            <button
              onClick={() => confirmerSuppression(true)}
              disabled={!modalSuppr || !batchPeutEtreRestaure(modalSuppr)}
              title={modalSuppr && !batchPeutEtreRestaure(modalSuppr) ? 'Pas de tracking des sacs sources (batch ancien ou manuel)' : ''}
              className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Annuler erreur (restaurer les sacs)
            </button>
          </div>
        }
      >
        {modalSuppr && (
          <div className="space-y-3">
            <p className="text-sm text-gray-700 font-medium">
              Deux options pour ce batch :
            </p>
            <div className="text-xs text-gray-600 space-y-2 border-l-2 border-gray-200 pl-3">
              <div>
                <span className="font-semibold text-gray-800">Annuler erreur</span> — utilisé si ce batch a été validé par erreur et que le mélange n'a pas eu lieu physiquement.
                Les sacs originaux sont restaurés dans le stock à leur état initial.
              </div>
              <div>
                <span className="font-semibold text-gray-800">Apurer l'historique</span> — utilisé pour effacer un batch ancien qui a réellement été consommé.
                Aucun sac n'est restauré (la matière n'existe plus physiquement).
              </div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3 space-y-1">
              <p className="text-xs text-gray-500 mb-1">Matières du batch :</p>
              {modalSuppr.lignes.map((l, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className="text-gray-700">{mpsMap[l.mp_id]?.nom ?? l.mp_id}</span>
                  <span className="font-medium tabular-nums">{Math.round(l.masse_totale_kg).toLocaleString('fr-FR')} kg</span>
                </div>
              ))}
            </div>
            {!batchPeutEtreRestaure(modalSuppr) && (
              <p className="text-xs text-amber-700 bg-amber-50 rounded p-2">
                ⚠ Ce batch ne contient pas le tracking des sacs sources (batch créé en mode manuel, ou avant la mise à jour). Seule l'option "Apurer l'historique" est disponible.
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
