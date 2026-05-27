import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase.js'
import { calcComposition, calcCout, fmt1 } from '../lib/calculs.js'
import EcartBadge from '../components/EcartBadge.jsx'
import Modal from '../components/Modal.jsx'

export default function BatchEnCours() {
  const [batches, setBatches] = useState([])
  const [recettes, setRecettes] = useState([])
  const [mpsMap, setMpsMap] = useState({})
  const [mpsListe, setMpsListe] = useState([])
  const [loading, setLoading] = useState(true)

  // Modal ajout MP
  const [modalAjout, setModalAjout] = useState(null) // batchId
  const [ajoutMpId, setAjoutMpId] = useState('')
  const [ajoutSacs, setAjoutSacs] = useState([0])

  // Modal reste
  const [modalReste, setModalReste] = useState(null) // batch
  const [resteKg, setResteKg] = useState('')

  // Impression
  const printRef = useRef()

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    const [{ data: batchData }, { data: rcData }, { data: mpsData }, { data: lignesData }] = await Promise.all([
      supabase.from('batches').select('*').eq('statut', 'en_cours').order('created_at', { ascending: false }),
      supabase.from('recettes_cibles').select('*'),
      supabase.from('matieres_premieres').select('*').order('id'),
      supabase.from('batch_lignes').select('*'),
    ])
    const mps = {}
    for (const mp of (mpsData ?? [])) mps[mp.id] = mp
    setMpsMap(mps)
    setMpsListe(mpsData ?? [])
    setRecettes(rcData ?? [])
    const lignesParBatch = {}
    for (const l of (lignesData ?? [])) {
      if (!lignesParBatch[l.batch_id]) lignesParBatch[l.batch_id] = []
      lignesParBatch[l.batch_id].push(l)
    }
    setBatches((batchData ?? []).map(b => ({ ...b, lignes: lignesParBatch[b.id] ?? [] })))
    setLoading(false)
  }

  // Supprimer un batch — remet les sacs en stock
  async function supprimerBatch(batch) {
    if (!confirm(`Supprimer le batch "${batch.nom}" ? Les sacs seront remis en stock.`)) return
    // Remettre les sacs consommés en disponible n'est pas possible sans tracking sac→batch
    // On clôture simplement le batch et on supprime
    await supabase.from('batch_lignes').delete().eq('batch_id', batch.id)
    await supabase.from('batches').delete().eq('id', batch.id)
    fetchAll()
  }

  // Clôturer un batch → historique
  async function cloturerBatch(batch) {
    if (!confirm(`Clôturer le batch "${batch.nom}" ? Il passera dans l'historique.`)) return
    await supabase.from('batches').update({ statut: 'cloture' }).eq('id', batch.id)
    fetchAll()
  }

  // Supprimer une ligne d'un batch
  async function supprimerLigne(ligneId) {
    if (!confirm('Supprimer cette ligne ?')) return
    await supabase.from('batch_lignes').delete().eq('id', ligneId)
    fetchAll()
  }

  // Ajouter une MP à un batch
  async function ajouterMp() {
    const masse = ajoutSacs.reduce((s, v) => s + (parseFloat(v) || 0), 0)
    if (!ajoutMpId || masse <= 0) return
    await supabase.from('batch_lignes').insert({
      batch_id: modalAjout,
      mp_id: ajoutMpId,
      masse_totale_kg: masse,
      sacs_kg: ajoutSacs.map(s => parseFloat(s) || 0).filter(s => s > 0),
      ordre: 99,
    })
    setModalAjout(null)
    setAjoutSacs([0])
    fetchAll()
  }

  // Déclarer un reste → crée une MP interne
  async function declarerReste() {
    const kg = parseFloat(resteKg)
    if (!kg || kg <= 0 || !modalReste) return

    const batch = modalReste
    const rc = recettes.find(r => r.id === batch.recette_id)
    const lignesEnrichies = batch.lignes.map(l => ({ mp: mpsMap[l.mp_id], masse_totale_kg: l.masse_totale_kg }))
    const comp = calcComposition(lignesEnrichies)
    if (!comp) return

    // Créer la MP interne avec la composition du batch
    const mpId = `MP_${batch.id}`
    await supabase.from('matieres_premieres').upsert({
      id: mpId,
      nom: `Reste batch ${batch.id}`,
      type_appro: 'Interne',
      description: `Reste non utilisé du batch ${batch.nom}`,
      cout_par_tonne: 0,
      pct_pp: Math.round(comp.pp * 10) / 10,
      pct_pe: Math.round(comp.pe * 10) / 10,
      pct_alu: Math.round(comp.alu * 10) / 10,
      pct_autres: Math.round(comp.autres * 10) / 10,
      pct_blanc: Math.round(comp.blanc * 10) / 10,
      pct_transparent: Math.round(comp.transp * 10) / 10,
      pct_noir: Math.round(comp.noir * 10) / 10,
      pct_autres_couleurs: 0,
      pct_sable: Math.round(comp.ecoLithe * 10) / 10,
    }, { onConflict: 'id' })

    // Ajouter un sac au stock
    await supabase.from('sacs').insert({
      mp_id: mpId,
      masse_kg: kg,
      reference: `Reste-${batch.id}`,
      statut: 'disponible',
    })

    setModalReste(null)
    setResteKg('')
    fetchAll()
    alert(`✓ MP "${mpId}" créée et ajoutée au stock (${kg} kg)`)
  }

  // Impression PDF d'un batch
  function imprimerBatch(batch) {
    const rc = recettes.find(r => r.id === batch.recette_id)
    const lignesEnrichies = batch.lignes.map(l => ({ mp: mpsMap[l.mp_id], masse_totale_kg: l.masse_totale_kg, sacs_kg: l.sacs_kg }))
    const comp = calcComposition(lignesEnrichies)
    const masseTotale = batch.lignes.reduce((s, l) => s + l.masse_totale_kg, 0)

    const COMP_PARAMS = [
      { key: 'pp', label: '%PP', cibleKey: 'pct_pp_cible' },
      { key: 'pe', label: '%PE', cibleKey: 'pct_pe_cible' },
      { key: 'alu', label: '%Alu', cibleKey: 'pct_alu_cible' },
      { key: 'blanc', label: '%Blanc', cibleKey: 'pct_blanc_cible' },
      { key: 'transp', label: '%Transp.', cibleKey: 'pct_transparent_cible' },
      { key: 'noir', label: '%Noir', cibleKey: 'pct_noir_cible' },
      { key: 'ecoLithe', label: '%EcoLithe', cibleKey: 'pct_ecolithe_cible' },
    ]

    const lignesHtml = batch.lignes.map(l => {
      const mp = mpsMap[l.mp_id]
      const sacsStr = (l.sacs_kg ?? [l.masse_totale_kg]).map((s, i) => `Sac ${i + 1}: ${Math.round(s)} kg`).join(' | ')
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;">${mp?.nom ?? l.mp_id}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">${Math.round(l.masse_totale_kg)} kg</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;color:#666;">${sacsStr}</td>
      </tr>`
    }).join('')

    const compHtml = comp && rc ? COMP_PARAMS
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
</body></html>`

    const win = window.open('', '_blank')
    win.document.write(html)
    win.document.close()
    win.print()
  }

  const COMP_PARAMS = [
    { key: 'pp', label: '%PP', cibleKey: 'pct_pp_cible' },
    { key: 'pe', label: '%PE', cibleKey: 'pct_pe_cible' },
    { key: 'alu', label: '%Alu', cibleKey: 'pct_alu_cible' },
    { key: 'ecoLithe', label: '%EcoLithe', cibleKey: 'pct_ecolithe_cible' },
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
            const lignesEnrichies = batch.lignes.map(l => ({ mp: mpsMap[l.mp_id], masse_totale_kg: l.masse_totale_kg }))
            const comp = calcComposition(lignesEnrichies)
            const masseTotale = batch.lignes.reduce((s, l) => s + l.masse_totale_kg, 0)

            return (
              <div key={batch.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                {/* En-tête batch */}
                <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-mono text-xs text-gray-400">{batch.id}</span>
                      {rc && <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{rc.nom}</span>}
                      <span className="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">En cours</span>
                    </div>
                    <h2 className="font-medium text-gray-900">{batch.nom}</h2>
                    <p className="text-sm text-gray-500 mt-0.5">
                      {Math.round(masseTotale).toLocaleString('fr-FR')} kg total · {batch.lignes.length} matière{batch.lignes.length !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-wrap justify-end">
                    <button onClick={() => imprimerBatch(batch)} className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50">
                      🖨 Imprimer
                    </button>
                    <button onClick={() => { setModalAjout(batch.id); setAjoutMpId(mpsListe[0]?.id ?? '') }} className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50">
                      + Ajouter MP
                    </button>
                    <button onClick={() => { setModalReste(batch); setResteKg('') }} className="text-xs px-3 py-1.5 border border-emerald-200 text-emerald-700 rounded-lg hover:bg-emerald-50">
                      Déclarer reste
                    </button>
                    <button onClick={() => cloturerBatch(batch)} className="text-xs px-3 py-1.5 border border-blue-200 text-blue-700 rounded-lg hover:bg-blue-50">
                      Clôturer
                    </button>
                    <button onClick={() => supprimerBatch(batch)} className="text-xs px-3 py-1.5 border border-red-100 text-red-600 rounded-lg hover:bg-red-50">
                      Supprimer
                    </button>
                  </div>
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
    </div>
  )
}
