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

const COMPO_KEYS = [
  ['pct_pp', '% PP'], ['pct_pe', '% PE'], ['pct_alu', '% Alu'],
  ['pct_autres_plastiques', '% Autres plast.'],
  ['pct_blanc', '% Blanc'], ['pct_transparent', '% Transp.'], ['pct_noir', '% Noir'],
  ['pct_autres_couleurs', '% Autres coul.'],
  ['pct_sable', '% Sable (EcoLithe)'],
  ['pct_charge_minerale', '% Charge minérale'],
]

const EMPTY_FORM = {
  id: null,
  mp_id: '',
  masse_kg: '',
  reference: '',
  statut: 'disponible',
  fournisseur: '',
  numero_lot_fournisseur: '',
  date_reception: '',
  composition_override: null,
}

export default function Stock() {
  const [sacs, setSacs] = useState([])
  const [mps, setMps] = useState([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [editId, setEditId] = useState(null)
  const [filtre, setFiltre] = useState('disponible')
  const [showCompoOverride, setShowCompoOverride] = useState(false)

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

  const mpById = Object.fromEntries(mps.map(m => [m.id, m]))
  function getMpNom(id) { return mpById[id]?.nom ?? id }

  // Stock par MP (dispo + partiel)
  const stockParMp = sacs
    .filter(s => s.statut !== 'consomme')
    .reduce((acc, s) => {
      acc[s.mp_id] = (acc[s.mp_id] ?? 0) + (s.masse_kg ?? 0)
      return acc
    }, {})

  // Alertes stock bas
  const alertesStock = mps
    .filter(mp => (mp.stock_mini_kg ?? 0) > 0)
    .map(mp => ({ mp, stock: stockParMp[mp.id] ?? 0 }))
    .filter(({ mp, stock }) => stock < mp.stock_mini_kg)

  const mpsEnAlerteIds = new Set(alertesStock.map(a => a.mp.id))

  function openNew() {
    setForm(EMPTY_FORM)
    setEditId(null)
    setShowCompoOverride(false)
    setModalOpen(true)
  }

  function openEdit(sac) {
    setForm({
      id: sac.id,
      mp_id: sac.mp_id ?? '',
      masse_kg: sac.masse_kg ?? '',
      reference: sac.reference ?? '',
      statut: sac.statut ?? 'disponible',
      fournisseur: sac.fournisseur ?? '',
      numero_lot_fournisseur: sac.numero_lot_fournisseur ?? '',
      date_reception: sac.date_reception ?? '',
      composition_override: sac.composition_override ?? null,
    })
    setEditId(sac.id)
    setShowCompoOverride(!!sac.composition_override)
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.mp_id || !form.masse_kg) return
    const payload = {
      mp_id: form.mp_id,
      masse_kg: parseFloat(form.masse_kg),
      reference: form.reference || null,
      statut: form.statut,
      fournisseur: form.fournisseur || null,
      numero_lot_fournisseur: form.numero_lot_fournisseur || null,
      date_reception: form.date_reception || null,
      composition_override: showCompoOverride ? form.composition_override : null,
    }
    if (editId) {
      await supabase.from('sacs').update(payload).eq('id', editId)
    } else {
      await supabase.from('sacs').insert(payload)
    }
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

  function activerCompoOverride() {
    if (!form.mp_id) return
    const mp = mpById[form.mp_id]
    if (!mp) return
    // Pré-remplir avec les valeurs de la MP comme point de départ
    const override = {}
    for (const [key] of COMPO_KEYS) override[key] = mp[key] ?? 0
    setForm(p => ({ ...p, composition_override: override }))
    setShowCompoOverride(true)
  }

  function desactiverCompoOverride() {
    setForm(p => ({ ...p, composition_override: null }))
    setShowCompoOverride(false)
  }

  function majCompo(key, val) {
    setForm(p => ({
      ...p,
      composition_override: { ...(p.composition_override ?? {}), [key]: parseFloat(val) || 0 }
    }))
  }

  const sacsAffiches = sacs.filter(s => {
    if (filtre === 'tous') return true
    if (filtre === 'alertes') return mpsEnAlerteIds.has(s.mp_id) && s.statut !== 'consomme'
    return s.statut === filtre
  })
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
        <button onClick={openNew} className="px-3 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
          + Ajouter un sac
        </button>
      </div>

      {/* Bannière alertes */}
      {alertesStock.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
          <p className="text-sm font-medium text-amber-900 mb-2">⚠ Stock bas — {alertesStock.length} matière{alertesStock.length !== 1 ? 's' : ''}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {alertesStock.map(({ mp, stock }) => (
              <div key={mp.id} className="flex justify-between text-sm">
                <span className="text-amber-900">{mp.nom}</span>
                <span className="font-medium tabular-nums text-amber-900">
                  {Math.round(stock)} kg <span className="text-amber-600">/ mini {Math.round(mp.stock_mini_kg)} kg</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

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
      <div className="flex gap-2 mb-4 flex-wrap">
        {[
          { key: 'disponible', label: 'Disponibles' },
          { key: 'partiel',    label: 'Partiels' },
          { key: 'consomme',   label: 'Consommés' },
          { key: 'tous',       label: 'Tous' },
          { key: 'alertes',    label: `Alertes${alertesStock.length > 0 ? ` (${alertesStock.length})` : ''}`, danger: alertesStock.length > 0 },
        ].map(({ key, label, danger }) => (
          <button
            key={key}
            onClick={() => setFiltre(key)}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
              filtre === key
                ? (danger ? 'bg-amber-600 text-white' : 'bg-gray-900 text-white')
                : (danger ? 'border border-amber-200 text-amber-700 hover:bg-amber-50' : 'border border-gray-200 text-gray-600 hover:bg-gray-50')
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <p className="text-sm text-gray-400 text-center p-8">Chargement…</p>
        ) : sacsAffiches.length === 0 ? (
          <p className="text-sm text-gray-400 text-center p-8">Aucun sac dans cette catégorie.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Référence</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Matière</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Fournisseur / lot</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500">Masse</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Statut</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {sacsAffiches.map(sac => {
                const enAlerte = mpsEnAlerteIds.has(sac.mp_id) && sac.statut !== 'consomme'
                return (
                  <tr key={sac.id} className={`hover:bg-gray-50 ${enAlerte ? 'bg-amber-50/40' : ''}`}>
                    <td className="px-4 py-3 font-mono text-xs text-gray-400">{sac.reference || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <TooltipMp mp={mpById[sac.mp_id]}>
                          <span className="text-gray-900 cursor-default">{getMpNom(sac.mp_id)}</span>
                        </TooltipMp>
                        {sac.composition_override && (
                          <span title="Composition spécifique au sac" className="text-xs bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded">spéc.</span>
                        )}
                        {enAlerte && (
                          <span className="text-xs text-amber-700">⚠</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {sac.fournisseur || sac.numero_lot_fournisseur ? (
                        <>
                          {sac.fournisseur && <span>{sac.fournisseur}</span>}
                          {sac.numero_lot_fournisseur && <span className="text-gray-400"> · {sac.numero_lot_fournisseur}</span>}
                          {sac.date_reception && <div className="text-gray-400">{new Date(sac.date_reception).toLocaleDateString('fr-FR')}</div>}
                        </>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">{Math.round(sac.masse_kg).toLocaleString('fr-FR')} kg</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUT_STYLES[sac.statut]}`}>
                        {STATUT_LABELS[sac.statut]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => openEdit(sac)} className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50">
                          Modifier
                        </button>
                        {sac.statut === 'disponible' && (
                          <button onClick={() => handleStatut(sac.id, 'partiel')} className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50">
                            Partiel
                          </button>
                        )}
                        <button onClick={() => handleDelete(sac.id)} className="text-xs px-2 py-1 border border-red-100 text-red-600 rounded hover:bg-red-50">
                          Supprimer
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editId ? 'Modifier le sac' : 'Ajouter un sac'}
        footer={
          <>
            <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Annuler</button>
            <button onClick={handleSave} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">Enregistrer</button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Matière première *</label>
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
              <label className="block text-xs text-gray-500 mb-1">Masse (kg) *</label>
              <input
                type="number" min="1"
                value={form.masse_kg}
                onChange={e => setForm(p => ({...p, masse_kg: e.target.value}))}
                placeholder="500"
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Référence interne</label>
              <input
                value={form.reference}
                onChange={e => setForm(p => ({...p, reference: e.target.value}))}
                placeholder="SAC-2026-001"
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-400"
              />
            </div>
          </div>

          <div className="pt-3 border-t border-gray-100">
            <p className="text-xs font-medium text-gray-700 mb-2">Traçabilité fournisseur (optionnel)</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Fournisseur</label>
                <input value={form.fournisseur} onChange={e => setForm(p => ({...p, fournisseur: e.target.value}))}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">N° lot fournisseur</label>
                <input value={form.numero_lot_fournisseur} onChange={e => setForm(p => ({...p, numero_lot_fournisseur: e.target.value}))}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Date de réception</label>
                <input type="date" value={form.date_reception} onChange={e => setForm(p => ({...p, date_reception: e.target.value}))}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2" />
              </div>
            </div>
          </div>

          {/* Composition override */}
          <div className="pt-3 border-t border-gray-100">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-gray-700">
                Composition spécifique de ce sac
                <span className="text-gray-400 font-normal ml-1">(si différente de la MP par défaut)</span>
              </p>
              {showCompoOverride ? (
                <button onClick={desactiverCompoOverride} className="text-xs text-red-500 hover:text-red-700">
                  Supprimer
                </button>
              ) : (
                <button onClick={activerCompoOverride} disabled={!form.mp_id} className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40">
                  + Spécifier
                </button>
              )}
            </div>
            {!showCompoOverride && (
              <p className="text-xs text-gray-400 italic">
                Utiliser la composition de la matière première sélectionnée.
              </p>
            )}
            {showCompoOverride && form.composition_override && (
              <div className="bg-purple-50 border border-purple-100 rounded-lg p-3">
                <p className="text-xs text-purple-700 mb-2">
                  Ces % seront utilisés à la place de la MP pour ce sac précis (analyse fournisseur, lot atypique, etc.)
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {COMPO_KEYS.map(([key, label]) => (
                    <div key={key}>
                      <label className="block text-xs text-gray-500 mb-0.5">{label}</label>
                      <input
                        type="number" step="0.1"
                        value={form.composition_override[key] ?? 0}
                        onChange={e => majCompo(key, e.target.value)}
                        className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  )
}
