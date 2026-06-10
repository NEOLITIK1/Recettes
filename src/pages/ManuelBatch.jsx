import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { calcComposition, calcCout, fmt1 } from '../lib/calculs.js'
import EcartBadge from '../components/EcartBadge.jsx'

export default function ManuelBatch() {
  const [recettes, setRecettes] = useState([])
  const [mpsListe, setMpsListe] = useState([])
  const [mpsMap, setMpsMap] = useState({})
  const [loading, setLoading] = useState(true)

  const [rcId, setRcId] = useState('')
  const [nomBatch, setNomBatch] = useState('')
  // lignes : [{ mpId, masse, sacs: [kg, kg, ...] }]
  const [lignes, setLignes] = useState([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    const [{ data: rc }, { data: mpsData }] = await Promise.all([
      supabase.from('recettes_cibles').select('*').eq('archivee', false).order('id'),
      supabase.from('matieres_premieres').select('*').order('id'),
    ])
    setRecettes(rc ?? [])
    setMpsListe(mpsData ?? [])
    const map = {}
    for (const mp of (mpsData ?? [])) map[mp.id] = mp
    setMpsMap(map)
    if (rc?.length) setRcId(rc[0].id)
    setLoading(false)
  }

  function ajouterLigne() {
    setLignes(prev => [...prev, { mpId: mpsListe[0]?.id ?? '', sacs: [0] }])
  }

  function supprimerLigne(i) {
    setLignes(prev => prev.filter((_, idx) => idx !== i))
  }

  function majMp(i, mpId) {
    setLignes(prev => prev.map((l, idx) => idx === i ? { ...l, mpId } : l))
  }

  function ajouterSac(ligneIdx) {
    setLignes(prev => prev.map((l, idx) =>
      idx === ligneIdx ? { ...l, sacs: [...l.sacs, 0] } : l
    ))
  }

  function supprimerSac(ligneIdx, sacIdx) {
    setLignes(prev => prev.map((l, idx) =>
      idx === ligneIdx ? { ...l, sacs: l.sacs.filter((_, si) => si !== sacIdx) } : l
    ))
  }

  function majSac(ligneIdx, sacIdx, val) {
    setLignes(prev => prev.map((l, idx) =>
      idx === ligneIdx
        ? { ...l, sacs: l.sacs.map((s, si) => si === sacIdx ? parseFloat(val) || 0 : s) }
        : l
    ))
  }

  // Calcul composition en temps réel
  const lignesEnrichies = lignes.map(l => ({
    mp: mpsMap[l.mpId],
    masse_totale_kg: l.sacs.reduce((s, v) => s + v, 0),
  })).filter(l => l.mp && l.masse_totale_kg > 0)

  const comp = lignesEnrichies.length > 0 ? calcComposition(lignesEnrichies) : null
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
    if (!lignes.length || !rcId) return
    setSaving(true)

    // Base 36 du timestamp : unique à la milliseconde, pas de cycle de réutilisation
    const batchId = 'B' + Date.now().toString(36).toUpperCase()
    const nom = nomBatch.trim() || `Batch ${batchId} — ${recette?.nom ?? ''} (manuel)`

    // Calculer et figer le coût au moment de la création
    const lignesEnrichiesCout = lignes
      .filter(l => l.sacs.reduce((s, v) => s + v, 0) > 0)
      .map(l => ({ mp: mpsMap[l.mpId], masse_totale_kg: l.sacs.reduce((s, v) => s + v, 0) }))
    const coutTotal = calcCout(lignesEnrichiesCout)
    const masseTotaleKg = lignesEnrichiesCout.reduce((s, l) => s + l.masse_totale_kg, 0)
    const coutParTonne = masseTotaleKg > 0 ? coutTotal / masseTotaleKg * 1000 : 0

    const { error } = await supabase.from('batches').insert({
      id: batchId,
      nom,
      recette_id: rcId,
      date_creation: new Date().toISOString().slice(0, 10),
      statut: 'en_cours',
      cout_total_eur: Math.round(coutTotal),
      cout_par_tonne_eur: Math.round(coutParTonne),
    })
    if (error) {
      setSaving(false)
      alert(`Erreur : le batch n'a pas pu être créé.\n${error.message}`)
      return
    }

    const lignesPayload = lignes
      .filter(l => l.sacs.reduce((s, v) => s + v, 0) > 0)
      .map((l, i) => ({
        batch_id: batchId,
        mp_id: l.mpId,
        masse_totale_kg: l.sacs.reduce((s, v) => s + v, 0),
        sacs_kg: l.sacs.filter(s => s > 0),
        ordre: i,
        sacs_consommes: [], // mode manuel : pas de lien sac → restauration auto impossible
      }))

    const { error: lErr } = await supabase.from('batch_lignes').insert(lignesPayload)
    if (lErr) {
      await supabase.from('batches').delete().eq('id', batchId)
      setSaving(false)
      alert(`Erreur : les lignes du batch n'ont pas pu être enregistrées.\n${lErr.message}`)
      return
    }

    setSaving(false)
    setSaved(true)
    setLignes([])
    setNomBatch('')
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Composition manuelle</h1>
        <p className="text-sm text-gray-500 mt-0.5">Composez un batch librement, sac par sac</p>
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
            <label className="block text-xs text-gray-500 mb-1">Nom du batch (optionnel)</label>
            <input
              value={nomBatch}
              onChange={e => setNomBatch(e.target.value)}
              placeholder={`Batch — ${recette?.nom ?? ''}`}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
            />
          </div>
        </div>

        {/* Lignes de matières */}
        <div className="mb-4 space-y-3">
          {lignes.map((ligne, li) => (
            <div key={li} className="border border-gray-100 rounded-lg p-3 bg-gray-50">
              <div className="flex items-center gap-2 mb-2">
                <select
                  value={ligne.mpId}
                  onChange={e => majMp(li, e.target.value)}
                  className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-gray-400"
                >
                  {mpsListe.map(m => <option key={m.id} value={m.id}>{m.id} — {m.nom}</option>)}
                </select>
                <button onClick={() => supprimerLigne(li)} className="text-red-400 hover:text-red-600 text-xl leading-none px-1">×</button>
              </div>
              {/* Sacs */}
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-xs text-gray-500">Sacs :</span>
                {ligne.sacs.map((s, si) => (
                  <div key={si} className="flex items-center gap-1">
                    <input
                      type="number" min="0"
                      value={s || ''}
                      onChange={e => majSac(li, si, e.target.value)}
                      placeholder="kg"
                      className="w-24 text-sm border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:border-gray-400"
                    />
                    <span className="text-xs text-gray-400">kg</span>
                    {ligne.sacs.length > 1 && (
                      <button onClick={() => supprimerSac(li, si)} className="text-gray-300 hover:text-red-400 text-sm">×</button>
                    )}
                  </div>
                ))}
                <button onClick={() => ajouterSac(li)} className="text-xs text-blue-600 hover:text-blue-800 px-2 py-1 border border-blue-200 rounded">
                  + sac
                </button>
                <span className="text-xs text-gray-400 ml-1">
                  Total : <strong>{ligne.sacs.reduce((s, v) => s + v, 0).toLocaleString('fr-FR')} kg</strong>
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <button onClick={ajouterLigne} className="px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
            + Ajouter une matière
          </button>
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

      {lignes.length > 0 && (
        <button
          onClick={valider}
          disabled={saving}
          className="w-full py-3 text-sm bg-gray-900 text-white rounded-xl hover:bg-gray-700 disabled:opacity-40 font-medium"
        >
          {saving ? 'Enregistrement…' : '✓ Valider et créer le batch'}
        </button>
      )}
    </div>
  )
}
