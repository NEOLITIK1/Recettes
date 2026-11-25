import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { mpDuSac } from '../lib/calculs.js'
import Modal from '../components/Modal.jsx'
import TooltipMp from '../components/TooltipMp.jsx'
import VueParMatiere from '../components/VueParMatiere.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import BarreRecherche from '../components/BarreRecherche.jsx'
import PlanStock from '../components/PlanStock.jsx'
import { correspond } from '../lib/recherche.js'
import { MAX_PILE, lieuSac, optionsRangement, idsASortir, fusionnerSacs, correspondLieu } from '../lib/plan.js'

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

// Un sac du lot. rangement : '' = hors plan (emplacement libre), 'R:A' = rangée A,
// 'S:<id>' = sur la pile d'un sac existant
function newLigne() {
  return { masse_kg: '', reference: '', taille: 'grand', rangement: '', emplacement: '', commentaire: '', prix_tonne: '' }
}

// Champs communs à un lot + une liste de sacs (masse/réf/emplacement/commentaire par sac)
function newForm() {
  return {
    id: null,
    mp_id: '',
    statut: 'disponible',
    fournisseur: '',
    numero_lot_fournisseur: '',
    date_reception: '',
    composition_override: null,
    lignes: [newLigne()],
  }
}

export default function Stock() {
  const [sacs, setSacs] = useState([])
  const [mps, setMps] = useState([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState(newForm())
  const [editId, setEditId] = useState(null)
  const [filtre, setFiltre] = useState('stock')
  const [recherche, setRecherche] = useState('')
  const [rechercheLieu, setRechercheLieu] = useState('')
  const [showCompoOverride, setShowCompoOverride] = useState(false)

  // Scindage d'un sac en plusieurs sacs réels (ex: batch récupéré puis pesé)
  const [modalSplit, setModalSplit] = useState(null) // sac
  const [splitPoids, setSplitPoids] = useState([''])

  // Plan de stockage
  const [aSortir, setASortir] = useState(new Set()) // sacs réservés par un batch, pas encore sortis
  const [caseOuverte, setCaseOuverte] = useState(null) // { rangee, place|null }
  const [placement, setPlacement] = useState({ sacId: '', taille: 'grand' })
  const [saving, setSaving] = useState(false)

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    const [{ data: sacsData }, { data: mpsData }, { data: lignesData }, { data: ranges }] = await Promise.all([
      supabase.from('sacs').select('*').order('created_at', { ascending: false }),
      supabase.from('matieres_premieres').select('*').order('id'),
      supabase.from('batch_lignes').select('sacs_consommes, sortie_at, batches!inner(statut)').is('sortie_at', null).eq('batches.statut', 'en_cours'),
      supabase.from('sacs').select('*').not('rangee', 'is', null),
    ])
    setSacs(fusionnerSacs(sacsData, ranges))
    setMps(mpsData ?? [])
    setASortir(idsASortir(lignesData))
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
    setForm(newForm())
    setEditId(null)
    setShowCompoOverride(false)
    setModalOpen(true)
  }

  function openEdit(sac) {
    setForm({
      id: sac.id,
      mp_id: sac.mp_id ?? '',
      statut: sac.statut ?? 'disponible',
      fournisseur: sac.fournisseur ?? '',
      numero_lot_fournisseur: sac.numero_lot_fournisseur ?? '',
      date_reception: sac.date_reception ?? '',
      composition_override: sac.composition_override ?? null,
      lignes: [{
        masse_kg: sac.masse_kg ?? '',
        reference: sac.reference ?? '',
        taille: sac.taille ?? 'grand',
        rangement: sac.rangee ? `R:${sac.rangee}` : '',
        emplacement: sac.emplacement ?? '',
        commentaire: sac.commentaire ?? '',
        prix_tonne: sac.prix_tonne ?? '',
      }],
    })
    setEditId(sac.id)
    setShowCompoOverride(!!sac.composition_override)
    setModalOpen(true)
  }

  function majLigneSac(i, field, val) {
    setForm(p => ({ ...p, lignes: p.lignes.map((l, idx) => {
      if (idx !== i) return l
      // Une pile ne se complète qu'avec un petit sac
      if (field === 'taille' && val === 'grand' && l.rangement.startsWith('S:')) return { ...l, taille: val, rangement: '' }
      return { ...l, [field]: val }
    }) }))
  }
  // Choix de rangement d'un sac du formulaire (+ sa rangée actuelle en modification)
  function choixRangement(l) {
    const avant = editId ? sacs.find(s => s.id === editId) : null
    const options = optionsRangement(sacs, l.taille).filter(o => o.value !== `S:${editId}`)
    const actuel = avant?.rangee
      ? [{ value: `R:${avant.rangee}`, label: l.taille === avant.taille ? `${lieuSac(avant)} (place actuelle)` : `Rangée ${avant.rangee} (sera replacé côté allée)` }]
      : []
    return [
      { value: '', label: 'Hors plan (saisie libre)' },
      ...actuel,
      ...options.filter(o => !actuel.some(a => a.value === o.value)),
    ]
  }
  function ajouterLigneSac() {
    // Reprend taille, rangée et prix du sac précédent
    setForm(p => {
      const prec = p.lignes[p.lignes.length - 1] ?? newLigne()
      return { ...p, lignes: [...p.lignes, {
        ...newLigne(),
        taille: prec.taille,
        rangement: prec.rangement.startsWith('R:') ? prec.rangement : '',
        prix_tonne: prec.prix_tonne,
      }] }
    })
  }
  function supprimerLigneSac(i) {
    setForm(p => ({ ...p, lignes: p.lignes.filter((_, idx) => idx !== i) }))
  }

  async function handleSave() {
    if (!form.mp_id) { alert('Sélectionnez une matière première.'); return }
    const lignesValides = form.lignes.filter(l => parseFloat(l.masse_kg) > 0)
    if (lignesValides.length === 0) { alert('Renseignez au moins un sac avec une masse.'); return }

    if (lignesValides.some(l => l.prix_tonne !== '' && !(parseFloat(l.prix_tonne) >= 0))) { alert('Prix invalide.'); return }

    const commun = {
      mp_id: form.mp_id,
      statut: form.statut,
      fournisseur: form.fournisseur || null,
      numero_lot_fournisseur: form.numero_lot_fournisseur || null,
      date_reception: form.date_reception || null,
      composition_override: showCompoOverride ? form.composition_override : null,
    }
    const sacDepuisLigne = l => ({
      ...commun,
      masse_kg: parseFloat(l.masse_kg),
      reference: l.reference || null,
      emplacement: l.rangement ? null : (l.emplacement || null),
      commentaire: l.commentaire || null,
      prix_tonne: l.prix_tonne === '' ? null : parseFloat(l.prix_tonne),
    })

    setSaving(true)
    const erreur = editId
      ? await modifierSac(sacs.find(s => s.id === editId), lignesValides[0], sacDepuisLigne(lignesValides[0]))
      : await creerSacs(lignesValides, sacDepuisLigne)
    setSaving(false)
    if (erreur) alert(erreur)
    if (!erreur || !erreur.startsWith('Erreur')) setModalOpen(false)
    fetchAll()
  }

  // Range un sac selon le choix 'R:A' ou 'S:<id>'. Retourne le message d'erreur, ou null.
  async function rangerSac(sacId, rangement, taille) {
    const [type, cible] = [rangement.slice(0, 1), rangement.slice(2)]
    const { error } = await supabase.rpc('placer_sac', {
      p_sac: sacId,
      p_rangee: type === 'R' ? cible : null,
      p_taille: taille,
      p_sur_sac: type === 'S' ? cible : null,
    })
    return error ? error.message : null
  }

  async function creerSacs(lignes, sacDepuisLigne) {
    const nonRanges = []
    // Un par un : l'ordre de la liste est l'ordre de rangement (le premier va au fond)
    for (let i = 0; i < lignes.length; i++) {
      const l = lignes[i]
      const { data, error } = await supabase.from('sacs').insert({ ...sacDepuisLigne(l), taille: l.taille }).select('id').single()
      if (error) {
        setForm(p => ({ ...p, lignes: lignes.slice(i) })) // ne garder que ce qui reste à enregistrer
        return `Erreur : ${i} sac(s) enregistré(s), les suivants restent dans la fenêtre.\n${error.message}`
      }
      if (l.rangement) {
        const err = await rangerSac(data.id, l.rangement, l.taille)
        if (err) nonRanges.push(`• ${l.reference || Math.round(l.masse_kg) + ' kg'} : ${err}`)
      }
    }
    return nonRanges.length ? `Sacs enregistrés, mais ${nonRanges.length} n'ont pas pu être rangés sur le plan :\n${nonRanges.join('\n')}` : null
  }

  async function modifierSac(avant, l, champs) {
    if (!avant) return 'Erreur : ce sac n\'existe plus. Rechargez la page.'
    if (avant.rangee && !l.rangement) {
      const { error } = await supabase.rpc('retirer_du_plan', { p_sac: avant.id })
      if (error) return `Erreur : le sac n'a pas pu être retiré du plan.\n${error.message}`
    }
    // La taille d'un sac rangé se change avec son rangement (elle modifie la place occupée)
    const { error } = await supabase.from('sacs').update(l.rangement ? champs : { ...champs, taille: l.taille }).eq('id', avant.id)
    if (error) return `Erreur : le sac n'a pas pu être enregistré.\n${error.message}`
    if (l.rangement) {
      const err = await rangerSac(avant.id, l.rangement, l.taille)
      if (err) return `Sac enregistré, mais pas rangé sur le plan : ${err}`
    }
    return null
  }

  // ── Plan : placer un sac existant depuis la carte ────────────────────────────
  function ouvrirCase(rangee, c) {
    setCaseOuverte({ rangee, place: c?.place ?? null })
    setPlacement({ sacId: '', taille: 'grand' })
  }
  async function placerDepuisCarte(rangement) {
    if (!placement.sacId) { alert('Choisissez un sac.'); return }
    setSaving(true)
    const err = await rangerSac(placement.sacId, rangement, placement.taille)
    setSaving(false)
    if (err) alert(`Le sac n'a pas été placé.\n${err}`)
    else setPlacement(p => ({ ...p, sacId: '' })) // la fenêtre reste ouverte pour enchaîner
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

  // ── Scinder un sac en plusieurs sacs (mêmes MP/compo/traçabilité) ────────────
  function ouvrirSplit(sac) {
    setModalSplit(sac)
    setSplitPoids([''])
  }
  async function confirmerSplit() {
    const sac = modalSplit
    if (!sac) return
    const poids = splitPoids.map(p => parseFloat(p) || 0).filter(p => p > 0)
    if (poids.length === 0) { alert('Saisissez au moins un poids.'); return }
    const somme = poids.reduce((a, b) => a + b, 0)
    if (somme > (sac.masse_kg ?? 0) + 0.5) {
      alert(`La somme des sacs (${Math.round(somme)} kg) dépasse la masse du sac d'origine (${Math.round(sac.masse_kg ?? 0)} kg).`)
      return
    }
    const nouveaux = poids.map((p, i) => ({
      mp_id: sac.mp_id,
      masse_kg: Math.round(p),
      reference: `${sac.reference || 'Sac'}-${i + 1}`,
      statut: 'disponible',
      fournisseur: sac.fournisseur ?? null,
      numero_lot_fournisseur: sac.numero_lot_fournisseur ?? null,
      date_reception: sac.date_reception ?? null,
      taille: sac.taille ?? 'grand',
      emplacement: sac.emplacement ?? null,
      composition_override: sac.composition_override ?? null,
      prix_tonne: sac.prix_tonne ?? null,
    }))
    const { error } = await supabase.from('sacs').insert(nouveaux)
    if (error) { alert(`Erreur lors de la création des sacs.\n${error.message}`); return }
    // Sac d'origine : reste éventuel sinon suppression
    const reste = Math.round((sac.masse_kg ?? 0) - somme)
    if (reste > 0.5) {
      await supabase.from('sacs').update({ masse_kg: reste, statut: 'partiel', updated_at: new Date().toISOString() }).eq('id', sac.id)
    } else {
      await supabase.from('sacs').delete().eq('id', sac.id)
    }
    setModalSplit(null)
    setSplitPoids([''])
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
    const okFiltre =
      filtre === 'tous' ? true
      : filtre === 'alertes' ? (mpsEnAlerteIds.has(s.mp_id) && s.statut !== 'consomme')
      : filtre === 'stock' ? (
          s.statut !== 'consomme' // disponibles + partiels ensemble
          || (rechercheLieu.trim() && s.rangee) // vidé mais encore à sa place (à sortir)
        )
      : s.statut === filtre
    if (rechercheLieu.trim() && !correspondLieu(rechercheLieu, s)) return false
    return okFiltre && correspond(recherche,
      getMpNom(s.mp_id), s.mp_id, s.reference, s.fournisseur,
      s.numero_lot_fournisseur, lieuSac(s), s.commentaire)
  })

  // Totaux des sacs affichés, détaillés par matière (ex: "PP Blanc Berry : 3 sacs, 2,4 t")
  const libelleRecherche = [recherche.trim(), rechercheLieu.trim() && `📍 ${rechercheLieu.trim()}`].filter(Boolean).join(' + ')
  const totalAffichesKg = sacsAffiches.reduce((a, s) => a + (s.masse_kg ?? 0), 0)
  const parMatiere = Object.values(sacsAffiches.reduce((acc, s) => {
    const e = acc[s.mp_id] ?? (acc[s.mp_id] = { mpId: s.mp_id, nom: getMpNom(s.mp_id), nb: 0, kg: 0 })
    e.nb++
    e.kg += s.masse_kg ?? 0
    return acc
  }, {})).sort((a, b) => b.kg - a.kg)
  const fmtKg = kg => kg >= 1000 ? (kg / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + ' t' : Math.round(kg).toLocaleString('fr-FR') + ' kg'
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

      <PlanStock sacs={sacs} mpById={mpById} aSortir={aSortir} onCase={ouvrirCase} />

      {/* Vue par matière (catégories paramétrables) */}
      <VueParMatiere sacs={sacs} mpsById={mpById} />

      {/* Filtre */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {[
          { key: 'stock',      label: 'En stock' },
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
        <BarreRecherche
          value={recherche}
          onChange={setRecherche}
          placeholder="Matière, référence, fournisseur, lot…"
          className="flex-1 min-w-[240px] sm:ml-auto sm:max-w-md"
        />
        <BarreRecherche
          value={rechercheLieu}
          onChange={setRechercheLieu}
          icone="📍"
          placeholder="Place : A, A4, atelier…"
          className="w-full sm:w-60"
        />
      </div>

      {/* Totaux des résultats (nombre de sacs + tonnage, par matière) */}
      {!loading && libelleRecherche && sacsAffiches.length > 0 && (
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-4">
          <p className="text-sm text-blue-900">
            <strong>{sacsAffiches.length} sac{sacsAffiches.length !== 1 ? 's' : ''}</strong> · <strong>{fmtKg(totalAffichesKg)}</strong>
            <span className="text-blue-700/80"> pour « {libelleRecherche} »</span>
          </p>
          {parMatiere.length > 1 && (
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
              {parMatiere.map(m => (
                <div key={m.mpId} className="flex justify-between text-xs text-blue-900">
                  <span className="truncate">{m.nom}</span>
                  <span className="tabular-nums whitespace-nowrap ml-2">{m.nb} sac{m.nb !== 1 ? 's' : ''} · {fmtKg(m.kg)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <p className="text-sm text-gray-400 text-center p-8">Chargement…</p>
        ) : sacsAffiches.length === 0 ? (
          <p className="text-sm text-gray-400 text-center p-8">{libelleRecherche ? `Aucun sac ne correspond à « ${libelleRecherche} ».` : 'Aucun sac dans cette catégorie.'}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Référence</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Matière</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Fournisseur / lot</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">Emplacement</th>
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
                        <TooltipMp mp={mpDuSac(mpById[sac.mp_id], sac)}>
                          <span className="text-gray-900 cursor-default">{getMpNom(sac.mp_id)}</span>
                        </TooltipMp>
                        {sac.composition_override && (
                          <span title="Composition spécifique au sac" className="text-xs bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded">spéc.</span>
                        )}
                        {sac.prix_tonne != null && (
                          <span title="Prix spécifique au sac" className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded whitespace-nowrap">{sac.prix_tonne} €/t</span>
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
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {lieuSac(sac) ? <span>📍 {lieuSac(sac)}</span> : '—'}
                      {sac.commentaire && <span title={sac.commentaire} className="ml-1 text-blue-500 cursor-help">💬</span>}
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
                        {sac.statut !== 'consomme' && (
                          <button onClick={() => ouvrirSplit(sac)} title="Décomposer ce sac en plusieurs sacs réels (une fois pesés)" className="text-xs px-2 py-1 border border-indigo-200 text-indigo-700 rounded hover:bg-indigo-50">
                            Scinder
                          </button>
                        )}
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

      {/* Modal case du plan */}
      <Modal
        open={!!caseOuverte}
        onClose={() => setCaseOuverte(null)}
        title={caseOuverte ? (caseOuverte.place ? `Emplacement ${caseOuverte.rangee}${caseOuverte.place}` : `Rangée ${caseOuverte.rangee}`) : ''}
        footer={<button onClick={() => setCaseOuverte(null)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Fermer</button>}
      >
        {caseOuverte && (() => {
          const { rangee, place } = caseOuverte
          const contenu = place
            ? sacs.filter(s => s.rangee === rangee && s.place === place).sort((a, b) => b.niveau - a.niveau)
            : []
          const pileIncomplete = contenu.length > 0 && contenu[0].taille === 'petit' && contenu.length < MAX_PILE
          const sacsHorsPlan = sacs.filter(s => !s.rangee && s.statut !== 'consomme' && (s.masse_kg ?? 0) > 0)
          const peutPlacer = !place || pileIncomplete
          const taille = pileIncomplete ? 'petit' : placement.taille
          const option = pileIncomplete
            ? { value: `S:${contenu[0].id}`, label: `Compléter la pile ${rangee}${place} (${contenu.length + 1}/${MAX_PILE})` }
            : optionsRangement(sacs, taille).find(o => o.value === `R:${rangee}`)
          return (
            <div className={`space-y-4 ${peutPlacer ? 'min-h-[22rem]' : ''}`}>
              {contenu.length > 0 && (
                <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
                  {contenu.map(s => (
                    <div key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="text-sm">
                        <TooltipMp mp={mpDuSac(mpById[s.mp_id], s)}>
                          <span className="text-gray-900 cursor-default">{getMpNom(s.mp_id)}</span>
                        </TooltipMp>
                        <p className="text-xs text-gray-500">
                          {[s.taille === 'petit' && contenu.length > 1 ? `niveau ${s.niveau}` : null, s.reference, s.numero_lot_fournisseur && `lot ${s.numero_lot_fournisseur}`, s.fournisseur].filter(Boolean).join(' · ') || '—'}
                        </p>
                        {aSortir.has(s.id) && <p className="text-xs font-medium text-gray-700">À sortir pour un batch</p>}
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-semibold tabular-nums whitespace-nowrap">{(s.masse_kg ?? 0) > 0 ? `${Math.round(s.masse_kg).toLocaleString('fr-FR')} kg` : 'vidé'}</span>
                        {(s.masse_kg ?? 0) > 0 && (
                          <button onClick={() => { setCaseOuverte(null); openEdit(s) }} className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50">Modifier</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {peutPlacer && (
                <div className="space-y-3">
                  <p className="text-xs font-medium text-gray-700">{pileIncomplete ? 'Ajouter un petit big bag sur cette pile' : 'Placer un sac déjà en stock'}</p>
                  {sacsHorsPlan.length === 0 ? (
                    <p className="text-xs text-gray-400 italic">Tous les sacs en stock sont déjà sur le plan. Pour un nouveau sac, utilisez « + Ajouter un sac ».</p>
                  ) : (
                    <>
                      <SearchableSelect
                        value={placement.sacId}
                        onChange={v => setPlacement(p => ({ ...p, sacId: v, taille: sacsHorsPlan.find(s => s.id === v)?.taille === 'petit' ? 'petit' : p.taille }))}
                        placeholder="Rechercher un sac hors plan…"
                        tooltipMp={(() => { const s = sacsHorsPlan.find(x => x.id === placement.sacId); return s ? mpDuSac(mpById[s.mp_id], s) : null })()}
                        options={sacsHorsPlan.map(s => ({
                          value: s.id,
                          label: [getMpNom(s.mp_id), s.reference || (s.numero_lot_fournisseur && `N°${s.numero_lot_fournisseur}`), `${Math.round(s.masse_kg)} kg`, s.fournisseur, s.emplacement && `📍${s.emplacement}`].filter(Boolean).join(' · '),
                        }))}
                      />
                      {!pileIncomplete && (
                        <div className="flex gap-2">
                          {[['grand', 'Grand'], ['petit', 'Petit']].map(([v, label]) => (
                            <button key={v} type="button" onClick={() => setPlacement(p => ({ ...p, taille: v }))}
                              className={`px-3 py-1.5 text-sm rounded-lg border ${placement.taille === v ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                              {label}
                            </button>
                          ))}
                        </div>
                      )}
                      {option ? (
                        <button onClick={() => placerDepuisCarte(option.value)} disabled={saving || !placement.sacId}
                          className="w-full py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-40">
                          {saving ? 'Placement…' : option.label}
                        </button>
                      ) : <p className="text-xs text-amber-700">Cette rangée est pleine.</p>}
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })()}
      </Modal>

      {/* Modal scindage */}
      <Modal
        open={!!modalSplit}
        onClose={() => setModalSplit(null)}
        title={modalSplit ? `Scinder le sac — ${getMpNom(modalSplit.mp_id)}` : ''}
        footer={
          <>
            <button onClick={() => setModalSplit(null)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Annuler</button>
            <button onClick={confirmerSplit} className="px-4 py-2 text-sm bg-indigo-700 text-white rounded-lg hover:bg-indigo-800">Créer les sacs</button>
          </>
        }
      >
        {modalSplit && (() => {
          const somme = splitPoids.reduce((a, p) => a + (parseFloat(p) || 0), 0)
          const masse = modalSplit.masse_kg ?? 0
          const reste = Math.round(masse - somme)
          const depasse = somme > masse + 0.5
          return (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">
                Décompose ce sac de <strong>{Math.round(masse).toLocaleString('fr-FR')} kg</strong> en
                plusieurs sacs réels (même matière, composition et traçabilité). Idéal après avoir
                récupéré un batch puis pesé les big bags un par un.
              </p>
              <div className="space-y-2">
                {splitPoids.map((p, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <span className="text-xs text-gray-400 w-12">Sac {i + 1}</span>
                    <input type="number" min="1" value={p}
                      onChange={e => setSplitPoids(prev => prev.map((v, idx) => idx === i ? e.target.value : v))}
                      placeholder="kg" className="w-32 text-sm border border-gray-200 rounded-lg px-3 py-2" />
                    <span className="text-xs text-gray-400">kg</span>
                    {splitPoids.length > 1 && (
                      <button onClick={() => setSplitPoids(prev => prev.filter((_, idx) => idx !== i))} className="text-red-400 hover:text-red-600">×</button>
                    )}
                  </div>
                ))}
                <button onClick={() => setSplitPoids(prev => [...prev, ''])} className="text-xs text-indigo-600 border border-indigo-200 rounded px-2 py-1">+ sac</button>
              </div>
              <div className={`text-xs rounded-lg p-2 ${depasse ? 'bg-red-50 text-red-700' : 'bg-gray-50 text-gray-600'}`}>
                Total réparti : <strong>{Math.round(somme).toLocaleString('fr-FR')} kg</strong> / {Math.round(masse).toLocaleString('fr-FR')} kg
                {depasse
                  ? ' — dépasse la masse du sac !'
                  : reste > 0
                    ? ` — il restera ${reste.toLocaleString('fr-FR')} kg dans le sac d'origine (statut partiel).`
                    : ' — le sac d\'origine sera entièrement réparti (supprimé).'}
              </div>
            </div>
          )
        })()}
      </Modal>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editId ? 'Modifier le sac' : 'Ajouter un sac'}
        footer={
          <>
            <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Annuler</button>
            <button onClick={handleSave} disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-40">{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Matière première *</label>
            <SearchableSelect
              value={form.mp_id}
              onChange={v => setForm(p => ({ ...p, mp_id: v }))}
              placeholder="Rechercher une matière…"
              options={mps.filter(m => !m.archivee || m.id === form.mp_id).map(m => ({ value: m.id, label: `${m.id} — ${m.nom}` }))}
            />
          </div>

          <div className="pt-3 border-t border-gray-100">
            <p className="text-xs font-medium text-gray-700 mb-2">Traçabilité fournisseur <span className="text-gray-400 font-normal">(commune au lot, optionnel)</span></p>
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

          {/* Sacs du lot : masse/référence/emplacement/commentaire par sac */}
          <div className="pt-3 border-t border-gray-100">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-gray-700">
                {editId ? 'Sac' : 'Sacs'} <span className="text-gray-400 font-normal">(masse, réf., emplacement, prix et commentaire par sac)</span>
              </p>
              {!editId && (
                <button onClick={ajouterLigneSac} className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50">+ Sac (même matière)</button>
              )}
            </div>
            <div className="space-y-3">
              {form.lignes.map((l, i) => (
                <div key={i} className="border border-gray-100 rounded-lg p-2 bg-gray-50 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-gray-500 mb-0.5">Masse (kg) *</label>
                      <input type="number" min="1" value={l.masse_kg} onChange={e => majLigneSac(i, 'masse_kg', e.target.value)}
                        placeholder="500" className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-0.5">Référence interne</label>
                      <input value={l.reference} onChange={e => majLigneSac(i, 'reference', e.target.value)}
                        placeholder="SAC-2026-001" className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-gray-500 mb-0.5">Taille</label>
                      <select value={l.taille} onChange={e => majLigneSac(i, 'taille', e.target.value)}
                        className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white">
                        <option value="grand">Grand big bag</option>
                        <option value="petit">Petit big bag (empilable par {MAX_PILE})</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-0.5">Emplacement</label>
                      <SearchableSelect value={l.rangement} onChange={v => majLigneSac(i, 'rangement', v)} options={choixRangement(l)} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-gray-500 mb-0.5">Prix (€/t)</label>
                      <input type="number" min="0" step="any" value={l.prix_tonne} onChange={e => majLigneSac(i, 'prix_tonne', e.target.value)}
                        placeholder={mpById[form.mp_id] ? `${mpById[form.mp_id].cout_par_tonne ?? 0} (prix matière)` : 'prix de la matière'}
                        className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white" />
                    </div>
                    {!l.rangement && (
                      <div>
                        <label className="block text-xs text-gray-500 mb-0.5">Emplacement libre</label>
                        <input value={l.emplacement} onChange={e => majLigneSac(i, 'emplacement', e.target.value)}
                          placeholder="ex: atelier, extérieur…" className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white" />
                      </div>
                    )}
                    <div className={l.rangement ? '' : 'col-span-2'}>
                      <label className="block text-xs text-gray-500 mb-0.5">Commentaire</label>
                      <input value={l.commentaire} onChange={e => majLigneSac(i, 'commentaire', e.target.value)}
                        placeholder="ex: humide, à contrôler…" className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white" />
                    </div>
                  </div>
                  {!editId && form.lignes.length > 1 && (
                    <div className="text-right">
                      <button onClick={() => supprimerLigneSac(i)} className="text-xs text-red-400 hover:text-red-600">Retirer ce sac</button>
                    </div>
                  )}
                </div>
              ))}
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
