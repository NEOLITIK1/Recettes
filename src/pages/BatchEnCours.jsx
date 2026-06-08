import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { calcComposition, calcCout, fmt1, effectiveMp } from '../lib/calculs.js'
import EcartBadge from '../components/EcartBadge.jsx'
import Modal from '../components/Modal.jsx'

export default function BatchEnCours() {
  const [batches, setBatches] = useState([])
  const [recettes, setRecettes] = useState([])
  const [mpsMap, setMpsMap] = useState({})
  const [mpsListe, setMpsListe] = useState([])
  const [loading, setLoading] = useState(true)
  const [openConsoHist, setOpenConsoHist] = useState({}) // batchId → bool
  const [sacsMap, setSacsMap] = useState({}) // id → sac (pour retrouver réf/fournisseur/lot à l'impression)

  // Modal ajout MP
  const [modalAjout, setModalAjout] = useState(null)
  const [ajoutMpId, setAjoutMpId] = useState('')
  const [ajoutSacs, setAjoutSacs] = useState([0])

  // Modal reste
  const [modalReste, setModalReste] = useState(null)
  const [resteKg, setResteKg] = useState('')

  // Modal consommation
  const [modalConso, setModalConso] = useState(null) // batch
  const [consoForm, setConsoForm] = useState({ date: '', masse: '', notes: '', operateur: '' })

  // Modal suppression
  const [modalSuppr, setModalSuppr] = useState(null) // batch

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
      supabase.from('sacs').select('id, reference, fournisseur, numero_lot_fournisseur'),
    ])
    const mps = {}
    for (const mp of (mpsData ?? [])) mps[mp.id] = mp
    setMpsMap(mps)
    setMpsListe(mpsData ?? [])
    setRecettes(rcData ?? [])
    const sacsM = {}
    for (const s of (sacsData ?? [])) sacsM[s.id] = s
    setSacsMap(sacsM)

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
    const restanteMelange = Math.max(0, total - consommee - reste)
    const ecartPct = total > 0 ? Math.abs(restanteMelange) / total * 100 : 0
    return { total, consommee, reste, restanteMelange, ecartPct }
  }

  // ── Restauration des sacs depuis sacs_consommes ────────────────────────────
  // Ajoute la masse prise à chaque sac source et restaure son statut.
  // Robuste si d'autres batchs ont touché le sac entretemps (on additionne sans dépasser l'état initial).
  async function restaurerSacsBatch(batch) {
    for (const ligne of batch.lignes) {
      const sc = ligne.sacs_consommes ?? []
      if (!Array.isArray(sc) || sc.length === 0) continue
      for (const entry of sc) {
        if (!entry?.sac_id) continue
        const { data: sacActuel } = await supabase
          .from('sacs')
          .select('id, masse_kg, statut')
          .eq('id', entry.sac_id)
          .maybeSingle()
        if (!sacActuel) continue // sac supprimé entretemps, on ne peut rien restaurer
        const masseRestauree = (sacActuel.masse_kg ?? 0) + (entry.masse_prise ?? 0)
        const masseAvant = entry.masse_avant_kg ?? masseRestauree
        const statutFinal = masseRestauree >= masseAvant - 0.5
          ? (entry.statut_avant ?? 'disponible')
          : 'partiel'
        await supabase.from('sacs').update({
          masse_kg: Math.round(masseRestauree),
          statut: statutFinal,
          updated_at: new Date().toISOString(),
        }).eq('id', entry.sac_id)
      }
    }
  }

  // ── Repasser en optimiseur ─────────────────────────────────────────────────
  async function repasserEnOptimiseur(batch) {
    if (!confirm(`Repasser le batch "${batch.nom}" en optimiseur ? Les sacs originaux seront restaurés en stock.`)) return
    await restaurerSacsBatch(batch)
    await supabase.from('batch_consommations').delete().eq('batch_id', batch.id)
    await supabase.from('batch_lignes').delete().eq('batch_id', batch.id)
    await supabase.from('batches').delete().eq('id', batch.id)
    localStorage.setItem('optimiseur_prefill', JSON.stringify({
      recetteId: batch.recette_id,
      masse: Math.round(masseTotaleBatch(batch)),
      nom: batch.nom,
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
      await restaurerSacsBatch(batch)
    }
    await supabase.from('batch_consommations').delete().eq('batch_id', batch.id)
    await supabase.from('batch_lignes').delete().eq('batch_id', batch.id)
    await supabase.from('batches').delete().eq('id', batch.id)
    setModalSuppr(null)
    fetchAll()
  }
  function batchPeutEtreRestaure(batch) {
    return batch.lignes.some(l => Array.isArray(l.sacs_consommes) && l.sacs_consommes.length > 0)
  }

  // ── Clôture ────────────────────────────────────────────────────────────────
  async function cloturerBatch(batch) {
    const { total, consommee, reste, ecartPct } = bilanBatch(batch)
    const masseNonDeclaree = total - consommee - reste
    if (ecartPct > 5) {
      alert(`Impossible de clôturer : ${Math.round(masseNonDeclaree)} kg de mélange ne sont ni consommés ni déclarés en reste (écart ${ecartPct.toFixed(1)}% > 5%).\n\nDéclarez une consommation ou un reste avant de clôturer.`)
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

  // ── Supprimer une ligne ────────────────────────────────────────────────────
  async function supprimerLigne(ligneId) {
    if (!confirm('Supprimer cette ligne ? Le sac source ne sera PAS remis en stock (utilisez plutôt Repasser en optimiseur).')) return
    await supabase.from('batch_lignes').delete().eq('id', ligneId)
    fetchAll()
  }

  // ── Ajouter MP ────────────────────────────────────────────────────────────
  async function ajouterMp() {
    const masse = ajoutSacs.reduce((s, v) => s + (parseFloat(v) || 0), 0)
    if (!ajoutMpId || masse <= 0) return
    await supabase.from('batch_lignes').insert({
      batch_id: modalAjout,
      mp_id: ajoutMpId,
      masse_totale_kg: masse,
      sacs_kg: ajoutSacs.map(s => parseFloat(s) || 0).filter(s => s > 0),
      ordre: 99,
      sacs_consommes: [],
    })
    setModalAjout(null)
    setAjoutSacs([0])
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
    const lignesEnrichies = batch.lignes.map(l => ({ mp: effectiveMp(mpsMap[l.mp_id], l.composition_snapshot), masse_totale_kg: l.masse_totale_kg }))
    const comp = calcComposition(lignesEnrichies)
    if (!comp) return
    const coutBatch = calcCout(lignesEnrichies)
    const masseBatch = lignesEnrichies.reduce((s, l) => s + l.masse_totale_kg, 0)
    const coutReste = masseBatch > 0 ? Math.round(coutBatch / masseBatch * 1000) : 0

    const mpId = `MP_${batch.id}`
    await supabase.from('matieres_premieres').upsert({
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

    await supabase.from('sacs').insert({
      mp_id: mpId,
      masse_kg: kg,
      reference: `Reste-${batch.id}`,
      statut: 'disponible',
    })

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
    const masseTotale = batch.lignes.reduce((s, l) => s + l.masse_totale_kg, 0)

    const COMP_PARAMS_PRINT = [
      { key: 'pp',        label: '%PP',          cibleKey: 'pct_pp_cible' },
      { key: 'pe',        label: '%PE',          cibleKey: 'pct_pe_cible' },
      { key: 'alu',       label: '%Alu',         cibleKey: 'pct_alu_cible' },
      { key: 'blanc',     label: '%Blanc',       cibleKey: 'pct_blanc_cible' },
      { key: 'transp',    label: '%Transp.',     cibleKey: 'pct_transparent_cible' },
      { key: 'noir',      label: '%Noir',        cibleKey: 'pct_noir_cible' },
      { key: 'ecoLithe',  label: '%EcoLithe',    cibleKey: 'pct_ecolithe_cible' },
      { key: 'chargeMin', label: '%Charge min.', cibleKey: 'pct_charge_minerale_cible' },
    ]

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
          // Priorité d'affichage : N° lot fournisseur (lisible sur le big bag)
          const idPrincipal = info.numero_lot_fournisseur
            ? `<strong>N°lot ${esc(info.numero_lot_fournisseur)}</strong>`
            : info.reference ? `<strong>${esc(info.reference)}</strong>` : `<strong>Sac ${i + 1}</strong>`
          const meta = []
          if (info.fournisseur) meta.push(esc(info.fournisseur))
          if (info.numero_lot_fournisseur && info.reference) meta.push(`réf. ${esc(info.reference)}`)
          const metaStr = meta.length ? ` <span style="color:#999;">· ${meta.join(' · ')}</span>` : ''
          return `<div style="padding:3px 0 3px 10px;border-left:2px solid #ddd;margin:2px 0;">
            ${idPrincipal}${metaStr} — <strong>${masse} kg</strong>
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
      .filter(p => (rc[p.cibleKey] ?? 0) > 0 || comp[p.key] > 0)
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

  const COMP_PARAMS = [
    { key: 'pp',        label: '%PP',          cibleKey: 'pct_pp_cible' },
    { key: 'pe',        label: '%PE',          cibleKey: 'pct_pe_cible' },
    { key: 'alu',       label: '%Alu',         cibleKey: 'pct_alu_cible' },
    { key: 'ecoLithe',  label: '%EcoLithe',    cibleKey: 'pct_ecolithe_cible' },
    { key: 'chargeMin', label: '%Charge min.', cibleKey: 'pct_charge_minerale_cible' },
  ]

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
                    <button onClick={() => { setModalAjout(batch.id); setAjoutMpId(mpsListe[0]?.id ?? '') }} className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50">
                      + Ajouter MP
                    </button>
                    <button onClick={() => ouvrirConso(batch)} className="text-xs px-3 py-1.5 border border-indigo-200 text-indigo-700 rounded-lg hover:bg-indigo-50">
                      + Consommation
                    </button>
                    <button onClick={() => { setModalReste(batch); setResteKg('') }} className="text-xs px-3 py-1.5 border border-emerald-200 text-emerald-700 rounded-lg hover:bg-emerald-50">
                      Déclarer reste
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
                    {batch.lignes.map(l => (
                      <tr key={l.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-gray-900">{mpsMap[l.mp_id]?.nom ?? l.mp_id}</td>
                        <td className="px-4 py-3 text-right font-semibold tabular-nums">{Math.round(l.masse_totale_kg).toLocaleString('fr-FR')} kg</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {(l.sacs_kg ?? [l.masse_totale_kg]).map((s, i) => (
                              <span key={i} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{Math.round(s)} kg</span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button onClick={() => supprimerLigne(l.id)} className="text-xs text-red-400 hover:text-red-600">Supprimer</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Composition vs cible */}
                {comp && rc && (
                  <div className="px-4 py-3 bg-gray-50 border-t border-gray-100">
                    <p className="text-xs font-medium text-gray-500 mb-2">Composition vs cible</p>
                    <div className="flex flex-wrap gap-3">
                      {COMP_PARAMS.filter(p => (rc[p.cibleKey] ?? 0) > 0 || comp[p.key] > 0).map(p => (
                        <div key={p.key} className="flex items-center gap-1.5 text-xs">
                          <span className="text-gray-500">{p.label}</span>
                          <span className="font-medium">{fmt1(comp[p.key])}%</span>
                          <EcartBadge valeur={comp[p.key]} cible={rc[p.cibleKey] ?? 0} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Modal ajout MP */}
      <Modal
        open={!!modalAjout}
        onClose={() => setModalAjout(null)}
        title="Ajouter une matière"
        footer={
          <>
            <button onClick={() => setModalAjout(null)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Annuler</button>
            <button onClick={ajouterMp} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">Ajouter</button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Matière première</label>
            <select value={ajoutMpId} onChange={e => setAjoutMpId(e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2">
              {mpsListe.map(m => <option key={m.id} value={m.id}>{m.id} — {m.nom}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-2">Sacs (kg)</label>
            {ajoutSacs.map((s, i) => (
              <div key={i} className="flex gap-2 items-center mb-2">
                <input type="number" min="0" value={s || ''} onChange={e => setAjoutSacs(prev => prev.map((v, idx) => idx === i ? parseFloat(e.target.value) || 0 : v))}
                  placeholder="kg" className="w-32 text-sm border border-gray-200 rounded-lg px-3 py-2" />
                <span className="text-xs text-gray-400">kg</span>
                {ajoutSacs.length > 1 && <button onClick={() => setAjoutSacs(prev => prev.filter((_, idx) => idx !== i))} className="text-red-400">×</button>}
              </div>
            ))}
            <button onClick={() => setAjoutSacs(prev => [...prev, 0])} className="text-xs text-blue-600 border border-blue-200 rounded px-2 py-1">+ sac</button>
          </div>
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
