import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { BATCHES } from '../data/seed.js'
import { calcComposition, calcCout, fmt1, effectiveMp, COMP_PARAMS_FULL } from '../lib/calculs.js'
import { restaurerSacsConsommes } from '../lib/batchOps.js'
import EcartBadge from '../components/EcartBadge.jsx'
import Modal from '../components/Modal.jsx'

export default function Historique() {
  const [batches, setBatches] = useState([])
  const [recettes, setRecettes] = useState([])
  const [mpsMap, setMpsMap] = useState({})
  const [loading, setLoading] = useState(true)
  const [detailBatch, setDetailBatch] = useState(null)
  const [note, setNote] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [seeded, setSeeded] = useState(false)
  const [modalSuppr, setModalSuppr] = useState(null) // batch à supprimer

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    const [{ data: batchData }, { data: rcData }, { data: mpsData }, { data: lignesData }] = await Promise.all([
      supabase.from('batches').select('*').eq('statut', 'cloture').order('date_creation', { ascending: false }),
      supabase.from('recettes_cibles').select('*'),
      supabase.from('matieres_premieres').select('*'),
      supabase.from('batch_lignes').select('*'),
    ])
    const mps = {}
    for (const mp of (mpsData ?? [])) mps[mp.id] = mp
    setMpsMap(mps)
    setRecettes(rcData ?? [])
    const lignesParBatch = {}
    for (const l of (lignesData ?? [])) {
      if (!lignesParBatch[l.batch_id]) lignesParBatch[l.batch_id] = []
      lignesParBatch[l.batch_id].push(l)
    }
    setBatches((batchData ?? []).map(b => ({ ...b, lignes: lignesParBatch[b.id] ?? [] })))
    setLoading(false)
  }

  async function handleSeed() {
    for (const batch of BATCHES) {
      const { lignes, ...batchData } = batch
      await supabase.from('batches').upsert({ ...batchData, statut: 'cloture' }, { onConflict: 'id' })
      // Delete existing lignes for this batch to avoid duplicates on re-import
      await supabase.from('batch_lignes').delete().eq('batch_id', batch.id)
      const lignesPayload = lignes.map((l, i) => ({
        batch_id: batch.id,
        mp_id: l.mp_id,
        masse_totale_kg: l.masse_totale_kg,
        sacs_kg: l.sacs_kg,
        ordre: i,
        sacs_consommes: [], // batchs historiques importés : pas de tracking sac source
      }))
      await supabase.from('batch_lignes').insert(lignesPayload)
    }
    setSeeded(true)
    fetchAll()
  }

  function openDetail(batch) {
    setDetailBatch(batch)
    setNote(batch.notes ?? '')
  }

  function supprimerBatch(batch) {
    setModalSuppr(batch)
  }

  async function confirmerSuppression(reinintegrer) {
    const batch = modalSuppr
    if (!batch) return

    if (reinintegrer) {
      // Lignes avec tracking : restaurer les VRAIS sacs sources (masse + statut,
      // composition spécifique préservée). Lignes sans tracking (batchs anciens
      // ou importés) : recréer un nouveau sac générique de la MP.
      const lignesTrackees = batch.lignes.filter(l => Array.isArray(l.sacs_consommes) && l.sacs_consommes.length > 0)
      const lignesSansTracking = batch.lignes.filter(l => !Array.isArray(l.sacs_consommes) || l.sacs_consommes.length === 0)
      await restaurerSacsConsommes(lignesTrackees)
      for (const ligne of lignesSansTracking) {
        if (!ligne.mp_id || !ligne.masse_totale_kg) continue
        const { error } = await supabase.from('sacs').insert({
          mp_id: ligne.mp_id,
          masse_kg: ligne.masse_totale_kg,
          reference: `Récupéré-${batch.id}`,
          statut: 'disponible',
          // Préserver la composition figée de la ligne si elle existait
          composition_override: ligne.composition_snapshot ?? null,
        })
        if (error) alert(`Erreur : le sac "${ligne.mp_id}" n'a pas pu être recréé en stock.\n${error.message}`)
      }
    }

    await supabase.from('batch_consommations').delete().eq('batch_id', batch.id)
    await supabase.from('batch_lignes').delete().eq('batch_id', batch.id)
    const { error: bErr } = await supabase.from('batches').delete().eq('id', batch.id)
    if (bErr) alert(`Erreur lors de la suppression du batch.\n${bErr.message}`)
    setModalSuppr(null)
    fetchAll()
  }

  // Rouvrir un batch clôturé : il repasse dans "Batchs en cours" où toutes les
  // actions redeviennent possibles (déclarer un reste oublié, corriger une
  // consommation…), puis on le re-clôture.
  async function rouvrirBatch(batch) {
    if (!confirm(`Rouvrir le batch "${batch.nom}" ?\n\nIl repassera dans "Batchs en cours" où vous pourrez déclarer un reste oublié ou corriger les consommations, puis le clôturer à nouveau.`)) return
    const { error } = await supabase.from('batches').update({ statut: 'en_cours' }).eq('id', batch.id)
    if (error) {
      alert(`Erreur : le batch n'a pas pu être rouvert.\n${error.message}`)
      return
    }
    fetchAll()
  }

  async function saveNote() {
    if (!detailBatch) return
    setSavingNote(true)
    await supabase.from('batches').update({ notes: note }).eq('id', detailBatch.id)
    setSavingNote(false)
    setDetailBatch(prev => ({ ...prev, notes: note }))
    fetchAll()
  }

  const totalKg = batches.reduce((a, b) => a + b.lignes.reduce((s, l) => s + (l.masse_totale_kg ?? 0), 0), 0)

  // Export CSV (UTF-8 BOM pour Excel)
  function exportCsv() {
    const cols = [
      'ID', 'Nom', 'Date', 'Recette', 'Masse totale (kg)', 'Cout total (EUR)', 'Cout par tonne (EUR/t)',
      '%PP', '%PE', '%Alu', '%Blanc', '%Transp', '%Noir', '%EcoLithe', '%ChargeMin',
      'Nb matieres', 'Detail matieres', 'Notes',
    ]
    const escape = v => {
      if (v === null || v === undefined) return ''
      const s = String(v).replace(/"/g, '""')
      return /[",;\n\r]/.test(s) ? `"${s}"` : s
    }
    const lignesCsv = batches.map(b => {
      const rc = recettes.find(r => r.id === b.recette_id)
      const le = b.lignes.map(l => ({ mp: effectiveMp(mpsMap[l.mp_id], l.composition_snapshot), masse_totale_kg: l.masse_totale_kg }))
      const comp = calcComposition(le) ?? {}
      const masseTotale = b.lignes.reduce((s, l) => s + (l.masse_totale_kg ?? 0), 0)
      const cout = b.cout_total_eur ?? calcCout(le)
      const coutT = b.cout_par_tonne_eur ?? (masseTotale > 0 ? Math.round(cout / masseTotale * 1000) : 0)
      const detail = b.lignes.map(l => `${mpsMap[l.mp_id]?.nom ?? l.mp_id}: ${Math.round(l.masse_totale_kg)}kg`).join(' | ')
      return [
        b.id, b.nom, b.date_creation, rc?.nom ?? '',
        Math.round(masseTotale), Math.round(cout), coutT,
        comp.pp?.toFixed(1) ?? '', comp.pe?.toFixed(1) ?? '', comp.alu?.toFixed(1) ?? '',
        comp.blanc?.toFixed(1) ?? '', comp.transp?.toFixed(1) ?? '', comp.noir?.toFixed(1) ?? '',
        comp.ecoLithe?.toFixed(1) ?? '', comp.chargeMin?.toFixed(1) ?? '',
        b.lignes.length, detail, b.notes ?? '',
      ].map(escape).join(';')
    })
    const csv = '﻿' + [cols.join(';'), ...lignesCsv].join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `neolitik-historique-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const COMP_PARAMS = COMP_PARAMS_FULL

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Historique des batchs</h1>
          <p className="text-sm text-gray-500 mt-0.5">Batchs clôturés</p>
        </div>
        <div className="flex gap-2">
          {batches.length > 0 && (
            <button onClick={exportCsv} className="px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600">
              ⬇ Export CSV
            </button>
          )}
          {batches.length === 0 && !loading && (
            <button onClick={handleSeed} className="px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600">
              Importer 20 batchs historiques
            </button>
          )}
        </div>
      </div>

      {seeded && (
        <div className="mb-4 p-3 bg-emerald-50 text-emerald-700 rounded-lg text-sm">
          ✓ Historique importé ({BATCHES.length} batchs)
        </div>
      )}

      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Batchs clôturés', val: batches.length },
          { label: 'Tonnes produites', val: (totalKg / 1000).toFixed(1) + ' t' },
          { label: 'Recettes utilisées', val: new Set(batches.map(b => b.recette_id)).size },
        ].map(({ label, val }) => (
          <div key={label} className="bg-white border border-gray-200 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">{label}</p>
            <p className="text-2xl font-semibold text-gray-900">{val}</p>
          </div>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-gray-400 text-center py-8">Chargement…</p>
      ) : (
        <div className="space-y-3">
          {batches.map(batch => {
            const rc = recettes.find(r => r.id === batch.recette_id)
            const lignesEnrichies = batch.lignes.map(l => ({ mp: effectiveMp(mpsMap[l.mp_id], l.composition_snapshot), masse_totale_kg: l.masse_totale_kg }))
            const comp = calcComposition(lignesEnrichies)
            const masseTotale = batch.lignes.reduce((s, l) => s + (l.masse_totale_kg ?? 0), 0)
            // Utiliser le coût figé si disponible, sinon recalculer
            const cout = batch.cout_total_eur ?? calcCout(lignesEnrichies)
            const coutParTonne = batch.cout_par_tonne_eur ?? (masseTotale > 0 ? Math.round(cout / masseTotale * 1000) : 0)

            return (
              <div key={batch.id} className="bg-white rounded-xl border border-gray-200 p-5">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-mono text-xs text-gray-400">{batch.id}</span>
                      {batch.date_creation && <span className="text-xs text-gray-400">{new Date(batch.date_creation).toLocaleDateString('fr-FR')}</span>}
                      {rc && <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{rc.nom}</span>}
                    </div>
                    <h2 className="font-medium text-gray-900">{batch.nom}</h2>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => openDetail(batch)} className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50">
                      Détail
                    </button>
                    <button
                      onClick={() => rouvrirBatch(batch)}
                      title="Repasser en 'Batchs en cours' pour déclarer un reste oublié ou corriger les consommations"
                      className="text-xs px-3 py-1.5 border border-amber-200 text-amber-700 rounded-lg hover:bg-amber-50"
                    >
                      ↩ Rouvrir
                    </button>
                    <button onClick={() => supprimerBatch(batch)} className="text-xs px-3 py-1.5 border border-red-100 text-red-600 rounded-lg hover:bg-red-50">
                      Supprimer
                    </button>
                  </div>
                </div>
                <div className="flex gap-6 text-sm flex-wrap">
                  <span><strong className="text-gray-900">{Math.round(masseTotale).toLocaleString('fr-FR')} kg</strong> <span className="text-gray-400">total</span></span>
                  {comp && <span><strong className="text-gray-900">{fmt1(comp.pp)}% PP</strong> <span className="text-gray-400">/ {fmt1(comp.pe)}% PE / {fmt1(comp.alu)}% Alu</span></span>}
                  {comp && <span className="text-gray-400">{fmt1(comp.blanc)}% Blanc / {fmt1(comp.transp)}% Transp. / {fmt1(comp.noir)}% Noir</span>}
                  {cout > 0 && <span><strong className="text-gray-900">{Math.round(cout).toLocaleString('fr-FR')} €</strong> <span className="text-gray-400">({coutParTonne} €/t)</span></span>}
                </div>
                {batch.notes && <p className="mt-2 text-xs text-gray-400 border-t border-gray-50 pt-2">📝 {batch.notes}</p>}
              </div>
            )
          })}
        </div>
      )}

      <Modal
        open={!!detailBatch}
        onClose={() => setDetailBatch(null)}
        title={detailBatch ? `${detailBatch.id} — ${detailBatch.nom}` : ''}
        footer={<button onClick={() => setDetailBatch(null)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Fermer</button>}
      >
        {detailBatch && (() => {
          const rc = recettes.find(r => r.id === detailBatch.recette_id)
          const lignesEnrichies = detailBatch.lignes.map(l => ({ mp: effectiveMp(mpsMap[l.mp_id], l.composition_snapshot), masse_totale_kg: l.masse_totale_kg, sacs_kg: l.sacs_kg }))
          const comp = calcComposition(lignesEnrichies)

          return (
            <div className="space-y-4">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-gray-100">
                  <th className="text-left py-2 text-xs font-medium text-gray-500">Matière</th>
                  <th className="text-right py-2 text-xs font-medium text-gray-500">Total</th>
                  <th className="text-left py-2 pl-4 text-xs font-medium text-gray-500">Sacs</th>
                </tr></thead>
                <tbody className="divide-y divide-gray-50">
                  {lignesEnrichies.map((l, i) => (
                    <tr key={i}>
                      <td className="py-2 text-gray-900">{l.mp?.nom ?? detailBatch.lignes[i]?.mp_id}</td>
                      <td className="py-2 text-right font-semibold tabular-nums">{Math.round(l.masse_totale_kg).toLocaleString('fr-FR')} kg</td>
                      <td className="py-2 pl-4">
                        <div className="flex flex-wrap gap-1">
                          {(detailBatch.lignes[i]?.sacs_kg ?? [l.masse_totale_kg]).filter(s => s > 0).map((s, j) => (
                            <span key={j} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{Math.round(s)} kg</span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {comp && rc && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-2">Composition vs cible ({rc.nom})</p>
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-gray-100">
                      <th className="text-left py-1 text-xs font-medium text-gray-500">Param.</th>
                      <th className="text-right py-1 text-xs font-medium text-gray-500">Résultat</th>
                      <th className="text-right py-1 text-xs font-medium text-gray-500">Cible</th>
                      <th className="text-right py-1 text-xs font-medium text-gray-500">Écart</th>
                    </tr></thead>
                    <tbody className="divide-y divide-gray-50">
                      {COMP_PARAMS.map(p => (
                        <tr key={p.key}>
                          <td className="py-2 font-medium text-gray-700">{p.label}</td>
                          <td className="py-2 text-right tabular-nums">{fmt1(comp[p.key])}%</td>
                          <td className="py-2 text-right tabular-nums text-gray-400">{rc[p.cibleKey] ?? 0}%</td>
                          <td className="py-2 text-right"><EcartBadge valeur={comp[p.key]} cible={rc[p.cibleKey] ?? 0} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="border-t border-gray-100 pt-4">
                <label className="block text-xs text-gray-500 mb-1">Notes de production</label>
                <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:border-gray-400"
                  placeholder="Observations, incidents, qualité…" />
                <button onClick={saveNote} disabled={savingNote}
                  className="mt-2 px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40">
                  {savingNote ? 'Enregistrement…' : 'Enregistrer la note'}
                </button>
              </div>
            </div>
          )
        })()}
      </Modal>

      {/* Modal suppression avec choix réintégration stock */}
      <Modal
        open={!!modalSuppr}
        onClose={() => setModalSuppr(null)}
        title="Supprimer ce batch"
        footer={
          <div className="flex gap-2 w-full">
            <button onClick={() => setModalSuppr(null)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
              Annuler
            </button>
            <div className="flex-1" />
            <button
              onClick={() => confirmerSuppression(false)}
              className="px-4 py-2 text-sm border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
            >
              Supprimer sans récupérer
            </button>
            <button
              onClick={() => confirmerSuppression(true)}
              className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700"
            >
              Récupérer les MP en stock
            </button>
          </div>
        }
      >
        {modalSuppr && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Voulez-vous réintégrer les matières de ce batch dans le stock ?
            </p>
            <div className="bg-gray-50 rounded-lg p-3 space-y-1">
              {modalSuppr.lignes.map((l, i) => {
                const mp = mpsMap[l.mp_id]
                return (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-gray-700">{mp?.nom ?? l.mp_id}</span>
                    <span className="font-medium tabular-nums">{Math.round(l.masse_totale_kg).toLocaleString('fr-FR')} kg</span>
                  </div>
                )
              })}
            </div>
            <p className="text-xs text-gray-400">
              "Récupérer en stock" restaure les sacs d'origine (masse et statut) quand le batch
              a tracé ses sacs sources, sinon recrée des sacs équivalents — à utiliser si la
              matière existe encore physiquement.
              "Supprimer sans récupérer" efface le batch définitivement sans toucher au stock
              — à utiliser si la matière a réellement été consommée.
            </p>
          </div>
        )}
      </Modal>
    </div>
  )
}
