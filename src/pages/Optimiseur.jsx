import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { calcComposition, fmt1 } from '../lib/calculs.js'
import EcartBadge from '../components/EcartBadge.jsx'

// Algorithme greedy : sélectionne les sacs dont la composition
// minimise la distance euclidienne avec la recette cible
function optimiser(sacsDispo, mpsMap, recette, masseCible) {
  if (!sacsDispo.length || !recette) return []

  function distMp(mp) {
    return Math.sqrt(
      Math.pow((mp.pct_pp ?? 0)  - recette.pct_pp_cible,  2) +
      Math.pow((mp.pct_pe ?? 0)  - recette.pct_pe_cible,  2) +
      Math.pow((mp.pct_alu ?? 0) - recette.pct_alu_cible,  2)
    )
  }

  const ranked = [...sacsDispo]
    .map(sac => ({ sac, mp: mpsMap[sac.mp_id], dist: distMp(mpsMap[sac.mp_id] ?? {}) }))
    .filter(({ mp }) => !!mp)
    .sort((a, b) => a.dist - b.dist)

  const selection = []
  let totalMasse = 0

  for (const { sac, mp } of ranked) {
    if (totalMasse >= masseCible * 0.9) break
    const remaining = masseCible - totalMasse
    const masseSac = sac.masse_kg ?? 0
    let taken = masseSac
    let partial = false

    if (taken > remaining * 1.15) {
      taken = Math.round(remaining)
      partial = true
    }

    selection.push({ sac, mp, taken, partial })
    totalMasse += taken
  }

  return selection
}

export default function Optimiseur() {
  const [recettes, setRecettes] = useState([])
  const [sacs, setSacs] = useState([])
  const [mpsMap, setMpsMap] = useState({})
  const [loading, setLoading] = useState(true)

  const [rcId, setRcId] = useState('')
  const [masseCible, setMasseCible] = useState(5000)
  const [nomBatch, setNomBatch] = useState('')
  const [selection, setSelection] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    const [{ data: rc }, { data: sacsData }, { data: mpsData }] = await Promise.all([
      supabase.from('recettes_cibles').select('*').order('id'),
      supabase.from('sacs').select('*').eq('statut', 'disponible'),
      supabase.from('matieres_premieres').select('*'),
    ])
    setRecettes(rc ?? [])
    setSacs(sacsData ?? [])
    const map = {}
    for (const mp of (mpsData ?? [])) map[mp.id] = mp
    setMpsMap(map)
    if (rc?.length) setRcId(rc[0].id)
    setLoading(false)
  }

  function lancer() {
    setSaved(false)
    const recette = recettes.find(r => r.id === rcId)
    const sel = optimiser(sacs, mpsMap, recette, masseCible)
    setSelection(sel)
  }

  async function valider() {
    if (!selection?.length) return
    setSaving(true)

    const recette = recettes.find(r => r.id === rcId)
    const batchId = 'B' + String(Date.now()).slice(-6)
    const nom = nomBatch.trim() || `Batch ${batchId} — ${recette?.nom ?? ''}`

    // Créer le batch
    const { error: bErr } = await supabase.from('batches').insert({
      id: batchId,
      nom,
      recette_id: rcId,
      date_creation: new Date().toISOString().slice(0, 10),
    })
    if (bErr) { setSaving(false); return }

    // Créer les lignes
    const lignes = selection.map(({ sac, taken }, i) => ({
      batch_id: batchId,
      mp_id: sac.mp_id,
      masse_totale_kg: taken,
      sacs_kg: [taken],
      ordre: i,
    }))
    await supabase.from('batch_lignes').insert(lignes)

    // Mettre à jour les sacs
    for (const { sac, taken, partial } of selection) {
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
    setSelection(null)
    setNomBatch('')
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
          ✓ Batch créé avec succès. Stock mis à jour.
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

        <div className="flex items-center gap-3">
          <button
            onClick={lancer}
            disabled={loading || sacs.length === 0}
            className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-40"
          >
            ⚙ Composer le batch
          </button>
          {sacs.length === 0 && !loading && (
            <p className="text-xs text-amber-600">Aucun sac disponible en stock — ajoutez des sacs d'abord.</p>
          )}
        </div>
      </div>

      {selection && (
        <div className="space-y-4">
          {/* Alerte masse */}
          {comp && (() => {
            const ecartPct = Math.round((comp.total - masseCible) / masseCible * 100)
            const cls = Math.abs(ecartPct) > 10 ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-blue-50 text-blue-700 border-blue-200'
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
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Référence</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Matière</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Masse</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {selection.map(({ sac, mp, taken, partial }) => (
                  <tr key={sac.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-400">{sac.reference || '—'}</td>
                    <td className="px-4 py-3 text-gray-900">{mp?.nom ?? sac.mp_id}</td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">{Math.round(taken).toLocaleString('fr-FR')} kg</td>
                    <td className="px-4 py-3">
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
