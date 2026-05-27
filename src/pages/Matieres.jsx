import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { MATIERES } from '../data/seed.js'
import Modal from '../components/Modal.jsx'
import CompositionBar from '../components/CompositionBar.jsx'

const TYPE_STYLES = {
  'Interne':  'bg-emerald-50 text-emerald-700',
  'Régulier': 'bg-blue-50 text-blue-700',
  'Spot':     'bg-amber-50 text-amber-700',
}

const EMPTY_FORM = {
  id: '', nom: '', type_appro: 'Régulier', description: '', cout_par_tonne: 0,
  pct_pp: 0, pct_pe: 0, pct_alu: 0, pct_autres: 0,
  pct_blanc: 0, pct_transparent: 0, pct_noir: 0, pct_autres_couleurs: 0, pct_sable: 0,
}

export default function MatieresPremières() {
  const [mps, setMps] = useState([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [editId, setEditId] = useState(null)
  const [seeded, setSeeded] = useState(false)

  useEffect(() => { fetchMps() }, [])

  async function fetchMps() {
    setLoading(true)
    const { data, error } = await supabase
      .from('matieres_premieres')
      .select('*')
      .order('id')
    if (!error) setMps(data ?? [])
    setLoading(false)
  }

  async function handleSeed() {
    const { error } = await supabase
      .from('matieres_premieres')
      .upsert(MATIERES, { onConflict: 'id' })
    if (!error) { setSeeded(true); fetchMps() }
  }

  function openNew() {
    setForm(EMPTY_FORM)
    setEditId(null)
    setModalOpen(true)
  }

  function openEdit(mp) {
    setForm({ ...mp })
    setEditId(mp.id)
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.id || !form.nom) return
    const payload = { ...form }
    const { error } = editId
      ? await supabase.from('matieres_premieres').update(payload).eq('id', editId)
      : await supabase.from('matieres_premieres').insert(payload)
    if (!error) { setModalOpen(false); fetchMps() }
  }

  async function handleDelete(id) {
    if (!confirm('Supprimer cette matière ?')) return
    await supabase.from('matieres_premieres').delete().eq('id', id)
    fetchMps()
  }

  const f = (field) => ({
    value: form[field] ?? '',
    onChange: (e) => setForm(prev => ({ ...prev, [field]: e.target.value })),
  })

  const fNum = (field) => ({
    value: form[field] ?? 0,
    onChange: (e) => setForm(prev => ({ ...prev, [field]: parseFloat(e.target.value) || 0 })),
  })

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Matières premières</h1>
          <p className="text-sm text-gray-500 mt-0.5">Catalogue des matières utilisées en production</p>
        </div>
        <div className="flex gap-2">
          {mps.length === 0 && !loading && (
            <button
              onClick={handleSeed}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600"
            >
              Importer données initiales
            </button>
          )}
          <button
            onClick={openNew}
            className="px-3 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700"
          >
            + Nouvelle MP
          </button>
        </div>
      </div>

      {seeded && (
        <div className="mb-4 p-3 bg-emerald-50 text-emerald-700 rounded-lg text-sm">
          ✓ Données initiales importées ({MATIERES.length} matières)
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Chargement…</div>
        ) : mps.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">
            Aucune matière première. Cliquez sur "Importer données initiales" ou "Nouvelle MP".
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">ID</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Nom</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Type</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Coût €/t</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Compo.</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500">%PP</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500">%PE</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500">%Alu</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {mps.map((mp) => (
                  <tr key={mp.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-gray-400">{mp.id}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{mp.nom}</td>
                    <td className="px-4 py-3">
                      {mp.type_appro ? (
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${TYPE_STYLES[mp.type_appro] ?? 'bg-gray-100 text-gray-600'}`}>
                          {mp.type_appro}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {mp.cout_par_tonne > 0 ? `${mp.cout_par_tonne} €` : <span className="text-gray-400">gratuit</span>}
                    </td>
                    <td className="px-4 py-3"><CompositionBar mp={mp} /></td>
                    <td className="px-4 py-3 text-right tabular-nums">{mp.pct_pp}%</td>
                    <td className="px-4 py-3 text-right tabular-nums">{mp.pct_pe}%</td>
                    <td className="px-4 py-3 text-right tabular-nums">{mp.pct_alu}%</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => openEdit(mp)}
                          className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50"
                        >
                          Modifier
                        </button>
                        <button
                          onClick={() => handleDelete(mp.id)}
                          className="text-xs px-2 py-1 border border-red-100 text-red-600 rounded hover:bg-red-50"
                        >
                          Supprimer
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editId ? 'Modifier la matière première' : 'Nouvelle matière première'}
        footer={
          <>
            <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
              Annuler
            </button>
            <button onClick={handleSave} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
              Enregistrer
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="ID" {...f('id')} disabled={!!editId} placeholder="MP027" />
            <Field label="Nom" {...f('nom')} placeholder="PP Blanc Berry" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Type</label>
              <select {...f('type_appro')} className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2">
                <option value="Régulier">Régulier</option>
                <option value="Spot">Spot</option>
                <option value="Interne">Interne</option>
                <option value="">Autre</option>
              </select>
            </div>
            <Field label="Coût (€/t)" type="number" {...fNum('cout_par_tonne')} placeholder="500" />
          </div>
          <Field label="Description" {...f('description')} placeholder="Broyat moyen" />

          <p className="text-xs font-medium text-gray-500 pt-2 border-t">Composition plastique (%)</p>
          <div className="grid grid-cols-3 gap-3">
            <Field label="% PP"  type="number" {...fNum('pct_pp')} />
            <Field label="% PE"  type="number" {...fNum('pct_pe')} />
            <Field label="% Alu" type="number" {...fNum('pct_alu')} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="% Blanc"       type="number" {...fNum('pct_blanc')} />
            <Field label="% Transparent" type="number" {...fNum('pct_transparent')} />
            <Field label="% Noir"        type="number" {...fNum('pct_noir')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="% Autres couleurs" type="number" {...fNum('pct_autres_couleurs')} />
            <Field label="% Sable/Charge"    type="number" {...fNum('pct_sable')} />
          </div>
        </div>
      </Modal>
    </div>
  )
}

function Field({ label, ...props }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <input
        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400 disabled:bg-gray-50 disabled:text-gray-400"
        {...props}
      />
    </div>
  )
}
