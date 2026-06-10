import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { calcComposition, calcCout, fmt1, effectiveMp } from '../lib/calculs.js'
import { creerBatchAvecStock, lignePourSac, sacUpdatePourPrise } from '../lib/batchOps.js'
import EcartBadge from '../components/EcartBadge.jsx'

export default function ManuelBatch() {
  const [recettes, setRecettes] = useState([])
  const [sacs, setSacs] = useState([])
  const [mpsMap, setMpsMap] = useState({})
  const [loading, setLoading] = useState(true)

  const [rcId, setRcId] = useState('')
  const [nomBatch, setNomBatch] = useState('')
  // prises : [{ sacId, taken }] — chaque ligne est un prélèvement sur un vrai sac du stock
  const [prises, setPrises] = useState([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    const [{ data: rc }, { data: sacsData }, { data: mpsData }] = await Promise.all([
      supabase.from('recettes_cibles').select('*').eq('archivee', false).order('id'),
      supabase.from('sacs').select('*').in('statut', ['disponible', 'partiel']).order('created_at', { ascending: false }),
      supabase.from('matieres_premieres').select('*').order('id'),
    ])
    setRecettes(rc ?? [])
    setSacs(sacsData ?? [])
    const map = {}
    for (const mp of (mpsData ?? [])) map[mp.id] = mp
    setMpsMap(map)
    if (rc?.length) setRcId(rc[0].id)
    setLoading(false)
  }

  const sacById = Object.fromEntries(sacs.map(s => [s.id, s]))
  const sacsDejaPris = new Set(prises.map(p => p.sacId).filter(Boolean))

  function labelSac(sac) {
    const mp = mpsMap[sac.mp_id]
    const ref = sac.reference || (sac.numero_lot_fournisseur ? `N°${sac.numero_lot_fournisseur}` : sac.id.slice(0, 8))
    const fourn = sac.fournisseur ? ` · ${sac.fournisseur}` : ''
    return `${ref} — ${mp?.nom ?? sac.mp_id} — ${Math.round(sac.masse_kg ?? 0)} kg${fourn}`
  }

  function ajouterPrise() {
    setPrises(prev => [...prev, { sacId: '', taken: '' }])
  }
  function supprimerPrise(i) {
    setPrises(prev => prev.filter((_, idx) => idx !== i))
  }
  function majPrise(i, field, value) {
    setPrises(prev => prev.map((p, idx) => {
      if (idx !== i) return p
      if (field === 'sacId') {
        // Pré-remplir la masse avec la masse disponible du sac
        const sac = sacById[value]
        return { sacId: value, taken: sac ? String(Math.round(sac.masse_kg ?? 0)) : '' }
      }
      return { ...p, [field]: value }
    }))
  }

  // Sélection effective (sacs valides + masse > 0) pour calculs temps réel
  const selection = prises
    .map(p => ({ sac: sacById[p.sacId], taken: parseFloat(p.taken) || 0 }))
    .filter(s => s.sac && s.taken > 0)

  const lignesEnrichies = selection.map(({ sac, taken }) => ({
    mp: effectiveMp(mpsMap[sac.mp_id], sac.composition_override),
    masse_totale_kg: taken,
  }))
  const comp = lignesEnrichies.length > 0 ? calcComposition(lignesEnrichies) : null
  const coutTotal = calcCout(lignesEnrichies)
  const recette = recettes.find(r => r.id === rcId)

  const COMP_PARAMS = [
    { key: 'pp',        label: '%PP',          cibleKey: 'pct_pp_cible' },
    { key: 'pe',        label: '%PE',          cibleKey: 'pct_pe_cible' },
    { key: 'alu',       label: '%Alu',         cibleKey: 'pct_alu_cible' },
    { key: 'blanc',     label: '%Blanc',       cibleKey: 'pct_blanc_cible' },
    { key: 'transp',    label: '%Transp.',     cibleKey: 'pct_transparent_cible' },
    { key: 'noir',      label: '%Noir',        cibleKey: 'pct_noir_cible' },
    { key: 'ecoLithe',  label: '%EcoLithe',    cibleKey: 'pct_ecolithe_cible' },
    { key: 'chargeMin', label: '%Charge min.', cibleKey: 'pct_charge_minerale_cible' },
  ]

  async function valider() {
    if (!selection.length || !rcId) return

    // Validations : masse prélevée ≤ masse du sac, pas de sac en double
    const idsVus = new Set()
    for (const { sac, taken } of selection) {
      if (idsVus.has(sac.id)) {
        alert(`Le sac "${labelSac(sac)}" apparaît deux fois. Fusionnez les lignes.`)
        return
      }
      idsVus.add(sac.id)
      if (taken > (sac.masse_kg ?? 0) + 0.5) {
        alert(`Le sac "${labelSac(sac)}" ne contient que ${Math.round(sac.masse_kg)} kg — impossible d'en prélever ${Math.round(taken)} kg.`)
        return
      }
    }

    setSaving(true)
    // Base 36 du timestamp : unique à la milliseconde, pas de cycle de réutilisation
    const batchId = 'B' + Date.now().toString(36).toUpperCase()
    const nom = nomBatch.trim() || `Batch ${batchId} — ${recette?.nom ?? ''} (manuel)`

    const masseTotaleKg = selection.reduce((s, { taken }) => s + taken, 0)
    const coutParTonne = masseTotaleKg > 0 ? coutTotal / masseTotaleKg * 1000 : 0

    const batch = {
      id: batchId,
      nom,
      recette_id: rcId,
      date_creation: new Date().toISOString().slice(0, 10),
      statut: 'en_cours',
      cout_total_eur: Math.round(coutTotal),
      cout_par_tonne_eur: Math.round(coutParTonne),
    }
    const lignes = selection.map(({ sac, taken }, i) => lignePourSac(sac, taken, i))
    const sacUpdates = selection.map(({ sac, taken }) => sacUpdatePourPrise(sac, taken))

    const err = await creerBatchAvecStock(batch, lignes, sacUpdates)
    setSaving(false)
    if (err) {
      alert(`Erreur : le batch n'a pas pu être créé (stock inchangé).\n${err.message}`)
      return
    }
    setSaved(true)
    setPrises([])
    setNomBatch('')
    fetchAll()
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Composition manuelle</h1>
        <p className="text-sm text-gray-500 mt-0.5">Composez un batch en prélevant des sacs du stock — le stock est mis à jour à la validation</p>
      </div>

      {saved && (
        <div className="mb-4 p-3 bg-emerald-50 text-emerald-700 rounded-lg text-sm">
          ✓ Batch créé, stock mis à jour. Disponible dans <strong>Batchs en cours</strong>.
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
            <label className="block text-xs text-gray-500 mb-1">Nom du batch (optionnel)</label>
            <input
              value={nomBatch}
              onChange={e => setNomBatch(e.target.value)}
              placeholder={`Batch — ${recette?.nom ?? ''}`}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
            />
          </div>
        </div>

        {/* Prélèvements sur le stock */}
        <div className="mb-4 space-y-2">
          {prises.length === 0 && (
            <p className="text-xs text-gray-400 italic">Aucun sac sélectionné — cliquez sur "+ Prélever un sac".</p>
          )}
          {prises.map((p, i) => {
            const sac = sacById[p.sacId]
            const taken = parseFloat(p.taken) || 0
            const depasse = sac && taken > (sac.masse_kg ?? 0) + 0.5
            return (
              <div key={i} className="flex gap-2 items-center flex-wrap border border-gray-100 rounded-lg p-2 bg-gray-50">
                <select
                  value={p.sacId}
                  onChange={e => majPrise(i, 'sacId', e.target.value)}
                  className="flex-1 min-w-[280px] text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-gray-400"
                >
                  <option value="">Sélectionner un sac…</option>
                  {sacs
                    .filter(s => s.id === p.sacId || !sacsDejaPris.has(s.id))
                    .map(s => <option key={s.id} value={s.id}>{labelSac(s)}</option>)}
                </select>
                <input
                  type="number" min="1"
                  value={p.taken}
                  onChange={e => majPrise(i, 'taken', e.target.value)}
                  placeholder="kg"
                  className={`w-28 text-sm border rounded-lg px-3 py-2 bg-white focus:outline-none ${depasse ? 'border-red-400 text-red-600' : 'border-gray-200 focus:border-gray-400'}`}
                />
                <span className="text-xs text-gray-400">kg{sac ? ` / ${Math.round(sac.masse_kg ?? 0)} dispo` : ''}</span>
                {sac?.composition_override && (
                  <span title="Composition spécifique au sac" className="text-xs bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded">spéc.</span>
                )}
                {depasse && <span className="text-xs text-red-600">⚠ dépasse le sac</span>}
                <button onClick={() => supprimerPrise(i)} className="text-red-400 hover:text-red-600 text-xl leading-none px-1">×</button>
              </div>
            )
          })}
        </div>

        <div className="flex gap-2 items-center flex-wrap">
          <button onClick={ajouterPrise} disabled={loading || sacs.length === 0} className="px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40">
            + Prélever un sac
          </button>
          {sacs.length === 0 && !loading && (
            <p className="text-xs text-amber-600">Aucun sac disponible — ajoutez des sacs dans Stock.</p>
          )}
          {selection.length > 0 && (
            <span className="text-xs text-gray-500 ml-1">
              {selection.length} sac{selection.length !== 1 ? 's' : ''} · Total : <strong>{Math.round(selection.reduce((s, x) => s + x.taken, 0)).toLocaleString('fr-FR')} kg</strong>
              {coutTotal > 0 && <> · {Math.round(coutTotal).toLocaleString('fr-FR')} €</>}
            </span>
          )}
        </div>
      </div>

      {/* Calcul en temps réel */}
      {comp && recette && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-4">
          <div className="px-5 py-3 border-b border-gray-100 flex justify-between">
            <p className="text-sm font-medium text-gray-900">Composition en temps réel vs {recette.nom}</p>
            <p className="text-sm text-gray-500">Total : <strong>{Math.round(comp.total).toLocaleString('fr-FR')} kg</strong></p>
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
        </div>
      )}

      {selection.length > 0 && (
        <button
          onClick={valider}
          disabled={saving}
          className="w-full py-3 text-sm bg-gray-900 text-white rounded-xl hover:bg-gray-700 disabled:opacity-40 font-medium"
        >
          {saving ? 'Enregistrement…' : '✓ Valider, créer le batch et décompter le stock'}
        </button>
      )}
    </div>
  )
}
