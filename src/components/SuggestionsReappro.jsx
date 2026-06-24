import { useState, useMemo } from 'react'
import { ajustementsPourCible } from '../lib/calculs.js'

const MAX_DEFAUT = 6500 // capacité mélangeur par défaut (kg)

// Panneau d'ajustements pour atteindre la recette cible, dans la limite du mélangeur.
// comp : composition actuelle (sortie de calcComposition) · recette : recette cible
export default function SuggestionsReappro({ comp, recette }) {
  const [maxKg, setMaxKg] = useState(MAX_DEFAUT)
  const [propIdx, setPropIdx] = useState(0)

  // Propositions = différentes masses totales visées (toutes ≤ capacité)
  const presets = useMemo(() => {
    if (!comp?.total) return []
    const cur = Math.round(comp.total)
    const max = Math.max(100, Math.round(maxKg))
    const keep = Math.min(cur, max)
    const list = [{ label: cur <= max ? 'Volume actuel (rééquilibrer)' : 'Plafonné au mélangeur', total: keep }]
    if (max > keep + 100) {
      list.push({ label: 'Mélangeur ~rempli à mi-chemin', total: Math.round((keep + max) / 2 / 50) * 50 })
      list.push({ label: 'Remplir le mélangeur', total: max })
    }
    // dédoublonnage par total
    const vus = new Set()
    return list.filter(p => (vus.has(p.total) ? false : vus.add(p.total)))
  }, [comp?.total, maxKg])

  if (!comp?.total || !recette) return null
  const preset = presets[propIdx % Math.max(1, presets.length)] ?? presets[0]
  const adj = ajustementsPourCible(comp, recette, preset?.total)
  if (!adj) return null

  const Ligne = ({ label, delta, suffixe }) => (
    <li className="text-sm flex items-center gap-2">
      {delta > 0 ? <span className="text-emerald-600 font-bold">+</span> : <span className="text-amber-600 font-bold">−</span>}
      <span className={delta > 0 ? 'text-gray-800' : 'text-gray-800'}>
        {delta > 0 ? 'ajouter' : 'retrancher'} ≈ <strong>{Math.abs(delta).toLocaleString('fr-FR')} kg</strong> {suffixe} <strong>{label}</strong>
      </span>
    </li>
  )

  const Bloc = ({ titre, deltas, suffixe }) => {
    if (!deltas || deltas.length === 0) return null
    return (
      <div>
        <p className="text-xs font-medium text-gray-600 mb-1">{titre}</p>
        <ul className="space-y-0.5">
          {deltas.map(d => <Ligne key={d.label} label={d.label} delta={d.delta} suffixe={suffixe} />)}
        </ul>
      </div>
    )
  }

  return (
    <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-medium text-blue-900">💡 Ajustements pour atteindre la cible</p>
          <p className="text-xs text-blue-700/80">
            Batch actuel {adj.totalActuel.toLocaleString('fr-FR')} kg → visé <strong>{adj.totalCible.toLocaleString('fr-FR')} kg</strong>
            {preset?.label ? ` · ${preset.label}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-blue-800">Max mélangeur</label>
          <input type="number" min="100" step="100" value={maxKg}
            onChange={e => { setMaxKg(parseFloat(e.target.value) || MAX_DEFAUT); setPropIdx(0) }}
            className="w-24 text-sm border border-blue-200 rounded-lg px-2 py-1 bg-white" />
          <span className="text-xs text-blue-800">kg</span>
        </div>
      </div>

      {adj.rien ? (
        <p className="text-sm text-emerald-700">✓ À cette masse, le batch atteint déjà les cibles — rien à ajuster.</p>
      ) : (
        <div className="grid sm:grid-cols-3 gap-4">
          <Bloc titre="Polymères" deltas={adj.polymeres} suffixe="de plastique riche en" />
          <Bloc titre="Couleurs" deltas={adj.couleurs} suffixe="de plastique" />
          <Bloc titre="Minéral" deltas={adj.minerals} suffixe="de" />
        </div>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-blue-100 pt-2 flex-wrap">
        <p className="text-xs text-blue-700/70">
          + = ajouter · − = retrancher. Polymères et couleurs décrivent le même plastique : un sac réel
          (ex: <em>PE blanc</em>) couvre une ligne de chaque axe.
        </p>
        {presets.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-blue-700 tabular-nums">{(propIdx % presets.length) + 1} / {presets.length}</span>
            <button onClick={() => setPropIdx(i => i + 1)} className="text-xs px-3 py-1.5 border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-100">
              Autre proposition →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
