import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { RECETTES } from '../data/seed.js'
import Modal from '../components/Modal.jsx'

const PARAMS = [
  { key: 'pct_pp_cible',          label: 'PP',          color: 'bg-blue-400' },
  { key: 'pct_pe_cible',          label: 'PE',          color: 'bg-emerald-400' },
  { key: 'pct_alu_cible',         label: 'Alu',         color: 'bg-amber-400' },
  { key: 'pct_blanc_cible',       label: 'Blanc',       color: 'bg-gray-200' },
  { key: 'pct_transparent_cible', label: 'Transparent', color: 'bg-sky-300' },
  { key: 'pct_noir_cible',        label: 'Noir',        color: 'bg-gray-700' },
  { key: 'pct_ecolithe_cible',    label: 'EcoLithe',    color: 'bg-green-400' },
]

const EMPTY = {
  id: '', nom: '',
  pct_pp_cible: 0, pct_pe_cible: 0, pct_alu_cible: 0, pct_autres_cible: 0,
  pct_blanc_cible: 0, pct_transparent_cible: 0, pct_noir_cible: 0,
  pct_autres_coul_cible: 0, pct_ecolithe_cible: 0,
}

export default function Recettes() {
  const [recettes, setRecettes] = useState([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [editId, setEditId] = useState(null)

  useEffect(() => { fetch() }, [])

  async function fetch() {
    setLoading(true)
    const { data } = await supabase.from('recettes_cibles').select('*').order('id')
    setRecettes(data ?? [])
    setLoading(false)
  }

  async function handleSeed() {
    await supabase.from('recettes_cibles').upsert(RECETTES, { onConflict: 'id' })
    fetch()
  }

  function openNew() { setForm(EMPTY); setEditId(null); setModalOpen(true) }
  function openEdit(r) { setForm({ ...r }); setEditId(r.id); setModalOpen(true) }

  async function handleSave() {
    if (!form.id || !form.nom) return
    const { error } = editId
      ? await supabase.from('recettes_cibles').update(form).eq('id', editId)
      : await supabase.from('recettes_cibles').insert(form)
    if (!error) { setModalOpen(false); fetch() }
  }

  const fNum = (field) => ({
    value: form[field] ?? 0,
    onChange: (e) => setForm(p => ({ ...p, [field]: parseFloat(e.target.value) || 0 })),
  })

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Recettes cibles</h1>
          <p className="text-sm text-gray-500 mt-0.5">Compositions de référence pour la production</p>
        </div>
        <div className="flex gap-2">
          {recettes.length === 0 && !loading && (
            <button onClick={handleSeed} className="px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600">
              Importer recettes initiales
            </button>
          )}
          <button onClick={openNew} className="px-3 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
            + Nouvelle recette
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400 text-center py-8">Chargement…</p>
      ) : (
        <div className="grid gap-4">
          {recettes.map(rc => (
            <div key={rc.id} className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <span className="text-xs font-mono text-gray-400">{rc.id}</span>
                  <h2 className="font-medium text-gray-900 text-base mt-0.5">{rc.nom}</h2>
                </div>
                <button onClick={() => openEdit(rc)} className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50">
                  Modifier
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {PARAMS.filter(p => rc[p.key] > 0).map(p => (
                  <div key={p.key} className="flex items-center gap-1.5 text-xs bg-gray-50 border border-gray-100 rounded-full px-3 py-1">
                    <span className={`w-2 h-2 rounded-full ${p.color}`} />
                    <span className="text-gray-500">{p.label}</span>
                    <span className="font-semibold text-gray-900">{rc[p.key]}%</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editId ? 'Modifier la recette' : 'Nouvelle recette cible'}
        footer={
          <>
            <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Annuler</button>
            <button onClick={handleSave} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">Enregistrer</button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="ID" value={form.id} onChange={e => setForm(p => ({...p, id: e.target.value}))} disabled={!!editId} placeholder="RC004" />
            <Field label="Nom" value={form.nom} onChange={e => setForm(p => ({...p, nom: e.target.value}))} placeholder="Gris Béton" />
          </div>
          <p className="text-xs font-medium text-gray-500 pt-2 border-t">Cibles (%)</p>
          <div className="grid grid-cols-3 gap-3">
            <Field label="% PP"  type="number" {...fNum('pct_pp_cible')} />
            <Field label="% PE"  type="number" {...fNum('pct_pe_cible')} />
            <Field label="% Alu" type="number" {...fNum('pct_alu_cible')} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="% Blanc"       type="number" {...fNum('pct_blanc_cible')} />
            <Field label="% Transparent" type="number" {...fNum('pct_transparent_cible')} />
            <Field label="% Noir"        type="number" {...fNum('pct_noir_cible')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="% EcoLithe" type="number" {...fNum('pct_ecolithe_cible')} />
            <Field label="% Autres mat." type="number" {...fNum('pct_autres_cible')} />
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
      <input className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400 disabled:bg-gray-50" {...props} />
    </div>
  )
}
