import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { BATCHES } from '../data/seed.js'
import { calcComposition, calcCout, fmt1 } from '../lib/calculs.js'
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
      const lignesPayload = lignes.map((l, i) => ({
        batch_id: batch.id,
        mp_id: l.mp_id,
        masse_totale_kg: l.masse_totale_kg,
        sacs_kg: l.sacs_kg,
        ordre: i,
      }))
      await supabase.from('batch_lignes').upsert(lignesPayload, { onConflict: 'id' })
    }
    setSeeded(true)
    fetchAll()
  }

  function openDetail(batch) {
    setDetailBatch(batch)
    setNote(batch.notes ?? '')
  }

  async function supprimerBatch(batch) {
    if (!confirm(`Supprimer définitivement le batch "${batch.nom}" ?`)) return
    await supabase.from('batch_lignes').delete().eq('batch_id', batch.id)
    await supabase.from('batches').delete().eq('id', batch.id)
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

  const COMP_PARAMS = [
    { key: 'pp',       label: '%PP',       cibleKey: 'pct_pp_cible' },
    { key: 'pe',       label: '%PE',       cibleKey: 'pct_pe_cible' },
    { key: 'alu',      label: '%Alu',      cibleKey: 'pct_alu_cible' },
    { key: 'ecoLithe', label: '%EcoLithe', cibleKey: 'pct_ecolithe_cible' },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Historique des batchs</h1>
          <p className="text-sm text-gray-500 mt-0.5">Batchs clôturés</p>
        </div>
        {batches.length === 0 && !loading && (
          <button onClick={handleSeed} className="px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600">
            Importer 20 batchs historiques
          </button>
        )}
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
            const lignesEnrichies = batch.lignes.map(l => ({ mp: mpsMap[l.mp_id], masse_totale_kg: l.masse_totale_kg }))
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
                    <button onClick={() => supprimerBatch(batch)} className="text-xs px-3 py-1.5 border border-red-100 text-red-600 rounded-lg hover:bg-red-50">
                      Supprimer
                    </button>
                  </div>
                </div>
                <div className="flex gap-6 text-sm flex-wrap">
                  <span><strong className="text-gray-900">{Math.round(masseTotale).toLocaleString('fr-FR')} kg</strong> <span className="text-gray-400">total</span></span>
                  {comp && <span><strong className="text-gray-900">{fmt1(comp.pp)}% PP</strong> <span className="text-gray-400">/ {fmt1(comp.pe)}% PE / {fmt1(comp.alu)}% Alu</span></span>}
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
          const lignesEnrichies = detailBatch.lignes.map(l => ({ mp: mpsMap[l.mp_id], masse_totale_kg: l.masse_totale_kg, sacs_kg: l.sacs_kg }))
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
                      {COMP_PARAMS.filter(p => (rc[p.cibleKey] ?? 0) > 0 || comp[p.key] > 0).map(p => (
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
    </div>
  )
}
