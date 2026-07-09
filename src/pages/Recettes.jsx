import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { RECETTES } from '../data/seed.js'
import Modal from '../components/Modal.jsx'

const PARAMS = [
  { key: 'pct_pp_cible',              label: 'PP',              color: 'bg-blue-400' },
  { key: 'pct_pe_cible',              label: 'PE',              color: 'bg-emerald-400' },
  { key: 'pct_alu_cible',             label: 'Alu',             color: 'bg-amber-400' },
  { key: 'pct_blanc_cible',           label: 'Blanc',           color: 'bg-gray-200' },
  { key: 'pct_transparent_cible',     label: 'Transparent',     color: 'bg-sky-300' },
  { key: 'pct_noir_cible',            label: 'Noir',            color: 'bg-gray-700' },
  { key: 'pct_ecolithe_cible',        label: 'EcoLithe',        color: 'bg-green-400' },
  { key: 'pct_charge_minerale_cible', label: 'Charge minérale', color: 'bg-stone-600' },
]

const EMPTY = {
  id: '', nom: '', version_label: '', parent_recette_id: null, archivee: false, code_couleur: '',
  pct_pp_cible: 0, pct_pe_cible: 0, pct_alu_cible: 0, pct_autres_cible: 0,
  pct_blanc_cible: 0, pct_transparent_cible: 0, pct_noir_cible: 0,
  pct_autres_coul_cible: 0, pct_ecolithe_cible: 0, pct_charge_minerale_cible: 0,
}

export default function Recettes() {
  const [recettes, setRecettes] = useState([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [editId, setEditId] = useState(null)
  const [showArchivees, setShowArchivees] = useState(false)

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
  function openEdit(r) { setForm({ ...r, archivee: !!r.archivee }); setEditId(r.id); setModalOpen(true) }

  // Créer une nouvelle version (copie) d'une recette existante
  async function nouvelleVersion(source) {
    const baseId = source.parent_recette_id ?? source.id
    // Trouver le prochain numéro de version disponible
    const versionsExistantes = recettes.filter(r =>
      r.id === baseId || r.parent_recette_id === baseId
    )
    const nextNum = versionsExistantes.length + 1
    const newId = `${baseId}_v${nextNum}`
    const label = prompt('Libellé de cette version (ex: "v2 — printemps 2026") :', `v${nextNum}`)
    if (label === null) return // annulé

    const newRecette = {
      ...source,
      id: newId,
      nom: source.nom,
      version_label: label || `v${nextNum}`,
      parent_recette_id: baseId,
      archivee: false,
    }
    delete newRecette.created_at

    const { error } = await supabase.from('recettes_cibles').insert(newRecette)
    if (error) {
      alert(`Erreur : ${error.message}`)
      return
    }
    // Ouvrir directement la nouvelle version en édition
    fetch().then(() => openEdit(newRecette))
  }

  async function toggleArchive(rc) {
    await supabase.from('recettes_cibles').update({ archivee: !rc.archivee }).eq('id', rc.id)
    fetch()
  }

  async function handleSave() {
    if (!form.id || !form.nom) return
    const totalPlast = (form.pct_pp_cible ?? 0) + (form.pct_pe_cible ?? 0) + (form.pct_alu_cible ?? 0) + (form.pct_autres_cible ?? 0)
    const totalNonPlast = (form.pct_ecolithe_cible ?? 0) + (form.pct_charge_minerale_cible ?? 0)
    if (Math.abs(totalPlast - 100) > 0.5) {
      if (!confirm(`La somme PP+PE+Alu+Autres = ${totalPlast.toFixed(1)}% (devrait être 100% sur la fraction plastique). Continuer quand même ?`)) return
    }
    if (totalNonPlast > 100) {
      alert(`EcoLithe + Charge minérale = ${totalNonPlast}% — impossible (max 100%).`)
      return
    }
    const payload = { ...form }
    if (!payload.parent_recette_id) payload.parent_recette_id = null
    const { error } = editId
      ? await supabase.from('recettes_cibles').update(payload).eq('id', editId)
      : await supabase.from('recettes_cibles').insert(payload)
    if (error) {
      alert(`Erreur : la recette n'a pas pu être enregistrée.\n${error.message}`)
      return
    }
    setModalOpen(false)
    fetch()
  }

  const fNum = (field) => ({
    value: form[field] ?? 0,
    onChange: (e) => setForm(p => ({ ...p, [field]: parseFloat(e.target.value) || 0 })),
  })

  // Grouper les recettes par "famille" (id racine ou parent_recette_id)
  const recettesAffichees = showArchivees ? recettes : recettes.filter(r => !r.archivee)
  const familles = {}
  for (const r of recettesAffichees) {
    const familleId = r.parent_recette_id ?? r.id
    if (!familles[familleId]) familles[familleId] = []
    familles[familleId].push(r)
  }
  // Trier chaque famille : racine en premier, puis versions par ID
  for (const fid in familles) {
    familles[fid].sort((a, b) => {
      if (a.id === fid) return -1
      if (b.id === fid) return 1
      return a.id.localeCompare(b.id)
    })
  }

  const nbArchivees = recettes.filter(r => r.archivee).length

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Recettes cibles</h1>
          <p className="text-sm text-gray-500 mt-0.5">Compositions de référence pour la production</p>
        </div>
        <div className="flex gap-2">
          {nbArchivees > 0 && (
            <button
              onClick={() => setShowArchivees(s => !s)}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600"
            >
              {showArchivees ? 'Masquer' : 'Voir'} archivées ({nbArchivees})
            </button>
          )}
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
        <div className="space-y-6">
          {Object.entries(familles).map(([familleId, versions]) => (
            <div key={familleId} className="space-y-2">
              {versions.length > 1 && (
                <p className="text-xs font-medium text-gray-500 px-1">
                  Famille {familleId} — {versions.length} version{versions.length !== 1 ? 's' : ''}
                </p>
              )}
              <div className="grid gap-3">
                {versions.map(rc => (
                  <div key={rc.id} className={`bg-white rounded-xl border p-5 ${rc.archivee ? 'border-gray-100 opacity-60' : 'border-gray-200'}`}>
                    <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-mono text-gray-400">{rc.id}</span>
                          {rc.version_label && (
                            <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded">{rc.version_label}</span>
                          )}
                          {rc.archivee && (
                            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded">Archivée</span>
                          )}
                        </div>
                        <h2 className="font-medium text-gray-900 text-base mt-0.5">{rc.nom}</h2>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <button onClick={() => nouvelleVersion(rc)} className="text-xs px-3 py-1.5 border border-blue-200 text-blue-700 rounded-lg hover:bg-blue-50">
                          + Nouvelle version
                        </button>
                        <button onClick={() => toggleArchive(rc)} className="text-xs px-3 py-1.5 border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50">
                          {rc.archivee ? 'Désarchiver' : 'Archiver'}
                        </button>
                        <button onClick={() => openEdit(rc)} className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50">
                          Modifier
                        </button>
                      </div>
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
          <div className="grid grid-cols-2 gap-3">
            <Field label="Libellé version (optionnel)" value={form.version_label ?? ''} onChange={e => setForm(p => ({...p, version_label: e.target.value}))} placeholder="v2 — 2026" />
            <Field label="Code couleur (codif batch)" value={form.code_couleur ?? ''} onChange={e => setForm(p => ({...p, code_couleur: e.target.value.toUpperCase()}))} placeholder="S, N, G…" maxLength={3} />
          </div>
          <p className="text-xs font-medium text-gray-500 pt-2 border-t">Cibles plastiques (%)</p>
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
          <p className="text-xs font-medium text-gray-500 pt-2 border-t">Fraction non plastique (%)</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="% EcoLithe (sable)"  type="number" {...fNum('pct_ecolithe_cible')} />
            <Field label="% Charge minérale"   type="number" {...fNum('pct_charge_minerale_cible')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
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
