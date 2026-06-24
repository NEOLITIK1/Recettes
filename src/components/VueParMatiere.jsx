import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { effectiveMp } from '../lib/calculs.js'
import Modal from './Modal.jsx'

// Champs de composition utilisables comme critère de catégorie
const CHAMPS = [
  ['pct_pp', 'PP'], ['pct_pe', 'PE'], ['pct_alu', 'Alu'], ['pct_autres_plastiques', 'Autres plast.'],
  ['pct_blanc', 'Blanc'], ['pct_transparent', 'Transparent'], ['pct_noir', 'Noir'], ['pct_autres_couleurs', 'Autres coul.'],
  ['pct_sable', 'Sable (EcoLithe)'], ['pct_charge_minerale', 'Charge min.'],
]
const LABEL_CHAMP = Object.fromEntries(CHAMPS)

// Catégories proposées par défaut (modifiables ensuite)
const DEFAUTS = [
  { nom: 'PP', conditions: [{ champ: 'pct_pp', min: 50, max: 100 }] },
  { nom: 'PE', conditions: [{ champ: 'pct_pe', min: 50, max: 100 }] },
  { nom: 'Mix PP/PE', conditions: [{ champ: 'pct_pp', min: 20, max: 80 }, { champ: 'pct_pe', min: 20, max: 80 }] },
  { nom: 'Blanc', conditions: [{ champ: 'pct_blanc', min: 50, max: 100 }] },
  { nom: 'Transparent', conditions: [{ champ: 'pct_transparent', min: 50, max: 100 }] },
  { nom: 'Mix Blanc/Transp', conditions: [{ champ: 'pct_blanc', min: 20, max: 80 }, { champ: 'pct_transparent', min: 20, max: 80 }] },
  { nom: 'Noir', conditions: [{ champ: 'pct_noir', min: 50, max: 100 }] },
]

function fmtCondition(c) {
  const label = LABEL_CHAMP[c.champ] ?? c.champ
  const min = c.min ?? 0, max = c.max ?? 100
  if (min <= 0) return `${label} ≤ ${max}%`
  if (max >= 100) return `${label} ≥ ${min}%`
  return `${label} ${min}–${max}%`
}

export default function VueParMatiere({ sacs, mpsById }) {
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [edit, setEdit] = useState(null) // catégorie en cours d'édition
  const [config, setConfig] = useState(false) // mode configuration (affiche éditer/supprimer)

  useEffect(() => { fetchCats() }, [])
  async function fetchCats() {
    setLoading(true)
    const { data } = await supabase.from('stock_categories').select('*').order('ordre').order('nom')
    setCategories(data ?? [])
    setLoading(false)
  }

  // Un sac appartient à une catégorie si TOUTES ses conditions sont vraies
  // (sur la composition effective : override du sac, sinon valeurs de la MP)
  function sacMatch(sac, conditions) {
    if (!Array.isArray(conditions) || conditions.length === 0) return false
    const comp = effectiveMp(mpsById[sac.mp_id], sac.composition_override)
    if (!comp) return false
    return conditions.every(c => {
      const v = comp[c.champ] ?? 0
      return v >= (c.min ?? 0) - 1e-9 && v <= (c.max ?? 100) + 1e-9
    })
  }

  const sacsActifs = (sacs ?? []).filter(s => s.statut !== 'consomme')
  function totauxCat(cat) {
    let kg = 0, nb = 0
    for (const s of sacsActifs) {
      if (sacMatch(s, cat.conditions)) { kg += s.masse_kg ?? 0; nb++ }
    }
    return { kg, nb }
  }

  async function creerDefauts() {
    const rows = DEFAUTS.map((d, i) => ({ nom: d.nom, conditions: d.conditions, ordre: i }))
    const { error } = await supabase.from('stock_categories').insert(rows)
    if (error) { alert(`Erreur : ${error.message}`); return }
    fetchCats()
  }
  function ouvrirNew() {
    setEdit({ nom: '', conditions: [{ champ: 'pct_pp', min: 50, max: 100 }], ordre: categories.length })
    setModalOpen(true)
  }
  function ouvrirEdit(cat) {
    setEdit({ ...cat, conditions: Array.isArray(cat.conditions) ? cat.conditions.map(c => ({ ...c })) : [] })
    setModalOpen(true)
  }
  async function saveCat() {
    if (!edit.nom.trim()) { alert('Donnez un nom à la catégorie.'); return }
    if (!edit.conditions.length) { alert('Ajoutez au moins un critère.'); return }
    const payload = { nom: edit.nom.trim(), conditions: edit.conditions, ordre: edit.ordre ?? 0 }
    const { error } = edit.id
      ? await supabase.from('stock_categories').update(payload).eq('id', edit.id)
      : await supabase.from('stock_categories').insert(payload)
    if (error) { alert(`Erreur : ${error.message}`); return }
    setModalOpen(false); setEdit(null); fetchCats()
  }
  async function deleteCat(id) {
    if (!confirm('Supprimer cette catégorie ?')) return
    const { error } = await supabase.from('stock_categories').delete().eq('id', id)
    if (error) { alert(`Erreur : ${error.message}`); return }
    fetchCats()
  }
  function majCond(i, field, val) {
    setEdit(e => ({ ...e, conditions: e.conditions.map((c, idx) => idx === i ? { ...c, [field]: field === 'champ' ? val : (parseFloat(val) || 0) } : c) }))
  }
  function addCond() { setEdit(e => ({ ...e, conditions: [...e.conditions, { champ: 'pct_pp', min: 50, max: 100 }] })) }
  function rmCond(i) { setEdit(e => ({ ...e, conditions: e.conditions.filter((_, idx) => idx !== i) })) }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="font-medium text-gray-900">Vue par matière</h2>
          <p className="text-xs text-gray-400">Tonnage disponible par catégorie (un sac peut compter dans plusieurs catégories)</p>
        </div>
        <div className="flex gap-2">
          {categories.length > 0 && (
            <button onClick={() => setConfig(c => !c)} className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 text-gray-600">
              {config ? 'Terminé' : '⚙ Configurer'}
            </button>
          )}
          <button onClick={ouvrirNew} className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 text-gray-600">
            + Catégorie
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Chargement…</p>
      ) : categories.length === 0 ? (
        <div className="text-sm text-gray-500">
          <p className="mb-2">Aucune catégorie. Créez la vôtre, ou démarrez avec un jeu prêt à l'emploi.</p>
          <button onClick={creerDefauts} className="text-xs px-3 py-1.5 bg-gray-900 text-white rounded-lg hover:bg-gray-700">
            Créer les catégories par défaut (PP, PE, Mix, Blanc, Transparent, Noir…)
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {categories.map(cat => {
            const { kg, nb } = totauxCat(cat)
            return (
              <div key={cat.id} className="border border-gray-100 rounded-lg p-3 bg-gray-50">
                <div className="flex items-start justify-between gap-1">
                  <p className="text-sm font-medium text-gray-800">{cat.nom}</p>
                  {config && (
                    <div className="flex gap-1">
                      <button onClick={() => ouvrirEdit(cat)} title="Modifier" className="text-xs text-blue-500 hover:text-blue-700">✎</button>
                      <button onClick={() => deleteCat(cat.id)} title="Supprimer" className="text-xs text-red-400 hover:text-red-600">×</button>
                    </div>
                  )}
                </div>
                <p className="text-xl font-semibold text-gray-900 tabular-nums mt-1">
                  {kg >= 1000 ? (kg / 1000).toFixed(1) + ' t' : Math.round(kg) + ' kg'}
                </p>
                <p className="text-xs text-gray-400">{nb} sac{nb !== 1 ? 's' : ''}</p>
                <p className="text-xs text-gray-400 mt-1 leading-tight">{(cat.conditions ?? []).map(fmtCondition).join(' · ')}</p>
              </div>
            )
          })}
        </div>
      )}

      {/* Modal édition catégorie */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={edit?.id ? 'Modifier la catégorie' : 'Nouvelle catégorie'}
        footer={
          <>
            <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Annuler</button>
            <button onClick={saveCat} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">Enregistrer</button>
          </>
        }
      >
        {edit && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Nom de la catégorie</label>
              <input value={edit.nom} onChange={e => setEdit(x => ({ ...x, nom: e.target.value }))}
                placeholder="ex: PP Blanc" className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-gray-700">Critères <span className="text-gray-400 font-normal">(tous doivent être vrais)</span></p>
                <button onClick={addCond} className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50">+ Critère</button>
              </div>
              <div className="space-y-2">
                {edit.conditions.map((c, i) => (
                  <div key={i} className="flex gap-2 items-center flex-wrap">
                    <select value={c.champ} onChange={e => majCond(i, 'champ', e.target.value)}
                      className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 flex-1 min-w-[130px]">
                      {CHAMPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                    <span className="text-xs text-gray-400">entre</span>
                    <input type="number" min="0" max="100" value={c.min ?? 0} onChange={e => majCond(i, 'min', e.target.value)}
                      className="w-16 text-sm border border-gray-200 rounded-lg px-2 py-1.5" />
                    <span className="text-xs text-gray-400">et</span>
                    <input type="number" min="0" max="100" value={c.max ?? 100} onChange={e => majCond(i, 'max', e.target.value)}
                      className="w-16 text-sm border border-gray-200 rounded-lg px-2 py-1.5" />
                    <span className="text-xs text-gray-400">%</span>
                    {edit.conditions.length > 1 && (
                      <button onClick={() => rmCond(i)} className="text-red-400 hover:text-red-600">×</button>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-2">
                Exemple : « PP entre 50 et 100% » compte les sacs majoritairement PP.
                Ajoutez « Blanc entre 50 et 100% » pour ne garder que le PP blanc.
              </p>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
