import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import Modal from '../components/Modal.jsx'
import TooltipMp from '../components/TooltipMp.jsx'

const STATUT_STYLES = {
  disponible: 'bg-emerald-50 text-emerald-700',
  partiel:    'bg-amber-50 text-amber-700',
  consomme:   'bg-gray-100 text-gray-500',
}
const STATUT_LABELS = { disponible: 'Disponible', partiel: 'Partiel', consomme: 'Consommé' }

export default function Stock() {
  const [sacs, setSacs] = useState([])
  const [mps, setMps] = useState([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState({ mp_id: '', masse_kg: '', reference: '', statut: 'disponible' })
  const [filtre, setFiltre] = useState('disponible')

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    const [{ data: sacsData }, { data: mpsData }] = await Promise.all([
      supabase.from('sacs').select('*').order('created_at', { ascending: false }),
      supabase.from('matieres_premieres').select('*').order('id'),
    ])
    setSacs(sacsData ?? [])
    setMps(mpsData ?? [])
    setLoading(false)
  }

  function getMpNom(id) {
    return mps.find(m => m.id === id)?.nom ?? id
  }

  async function handleSave() {
    if (!form.mp_id || !form.masse_kg) return
    const payload = {
      mp_id: form.mp_id,
      masse_kg: parseFloat(form.masse_kg),
      reference: form.reference || null,
      statut: form.statut,
    }
    await supabase.from('sacs').insert(payload)
    setModalOpen(false)
    fetchAll()
  }

  async function handleDelete(id) {
    if (!confirm('Supprimer ce sac ?')) return
    await supabase.from('sacs').delete().eq('id', id)
    fetchAll()
  }

  async function handleStatut(id, statut) {
    await supabase.from('sacs').update({ statut, updated_at: new Date().toISOString() }).eq('id', id)
    fetchAll()
  }

  const sacsFiltres = filtre === 'tous' ? sacs : sacs.filter(s => s.statut === filtre)
  const sacsDispo = sacs.filter(s => s.statut !== 'consomme')
  const totalKg = sacsDispo.reduce((a, s) => a + (s.masse_kg ?? 0), 0)
  const nbMps = new Set(sacsDispo.map(s => s.mp_id)).size

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Stock de sacs</h1>
          <p className="text-sm text-gray-500 mt-0.5">Big bags disponibles pour la production</p>
        </div>
        <button onClick={() => setModalOpen(true)} className="px-3 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
          + Ajouter un sac
        </button>
      </div>

      {/* Métriques */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Sacs disponibles', val: sacsDispo.length },
          { label: 'Kg en stock', val: Math.round(totalKg).toLocaleString('fr-FR') + ' kg' },
          { label: 'Matières différentes', val: nbMps },
        ].map(({ label, val }) => (
          <div key={label} className="bg-white border border-gray-200 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">{label}</p>
            <p className="text-2xl font-semibold text-gray-900">{val}</p>
          </div>
        ))}
      </div>

      {/* Filtre */}
      <div className="flex gap-2 mb-4">
        {[
          { key: 'disponible', label: 'Disponibles' },
          { key: 'partiel',    label: 'Partiels' },
          { key: 'consomme',   label: 'Consommés' },
          { key: 'tous',       label: 'Tous' },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFiltre(key)}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
              filtre === key ? 'bg-gray-900 text-white' : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <p className="text-sm text-gray-400 text-center p-8">Chargement…</p>
        ) : sacsFiltres.length === 0 ? (
          <p className="text-sm text-gray-400 text-center p-8">Aucun sac dans cette catégorie.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Référence</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Matière</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500">Masse</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Statut</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {sacsFiltres.map(sac => (
                <tr key={sac.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-gray-400">{sac.reference || '—'}</td>
                  <td className="px-4 py-3 text-gray-900">{getMpNom(sac.mp_id)}</td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">{Math.round(sac.masse_kg).toLocaleString('fr-FR')} kg</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUT_STYLES[sac.statut]}`}>
                      {STATUT_LABELS[sac.statut]}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2 justify-end">
                      {sac.statut === 'disponible' && (
                        <button onClick={() => handleStatut(sac.id, 'partiel')} className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50">
                          Marquer partiel
                        </button>
                      )}
                      <button onClick={() => handleDelete(sac.id)} className="text-xs px-2 py-1 border border-red-100 text-red-600 rounded hover:bg-red-50">
                        Supprimer
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Ajouter un sac"
        footer={
          <>
            <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Annuler</button>
            <button onClick={handleSave} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">Enregistrer</button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Matière première</label>
            <select
              value={form.mp_id}
              onChange={e => setForm(p => ({...p, mp_id: e.target.value}))}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
            >
              <option value="">Sélectionner…</option>
              {mps.map(m => <option key={m.id} value={m.id}>{m.id} — {m.nom}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Masse (kg)</label>
              <input
                type="number" min="1"
                value={form.masse_kg}
                onChange={e => setForm(p => ({...p, masse_kg: e.target.value}))}
                placeholder="500"
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Référence</label>
              <input
                value={form.reference}
                onChange={e => setForm(p => ({...p, reference: e.target.value}))}
                placeholder="SAC-2026-001"
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
              />
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
