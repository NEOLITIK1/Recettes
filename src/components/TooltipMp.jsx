import { useState } from 'react'

// Fenêtre informative au survol d'une MP — affiche la composition complète
export default function TooltipMp({ mp, children }) {
  const [visible, setVisible] = useState(false)

  if (!mp) return children

  const params = [
    { label: 'PP',                val: mp.pct_pp,                 color: 'bg-blue-400' },
    { label: 'PE',                val: mp.pct_pe,                 color: 'bg-emerald-400' },
    { label: 'Alu',               val: mp.pct_alu,                color: 'bg-amber-400' },
    { label: 'Autres plastiques', val: mp.pct_autres_plastiques,  color: 'bg-purple-400' },
    { label: 'Blanc',             val: mp.pct_blanc,              color: 'bg-gray-200 border border-gray-300' },
    { label: 'Transparent',       val: mp.pct_transparent,        color: 'bg-sky-300' },
    { label: 'Noir',              val: mp.pct_noir,               color: 'bg-gray-700' },
    { label: 'Sable (EcoLithe)',  val: mp.pct_sable,              color: 'bg-stone-300' },
    { label: 'Charge minérale',   val: mp.pct_charge_minerale,    color: 'bg-stone-600' },
  ].filter(p => (p.val ?? 0) > 0)

  return (
    <div
      className="relative inline-block"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible && (
        <div className="absolute z-50 left-0 top-full mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg p-3 pointer-events-none">
          <p className="text-xs font-semibold text-gray-700 mb-1">{mp.nom}</p>
          {mp.type_appro && (
            <p className="text-xs text-gray-400 mb-2">{mp.type_appro}{mp.cout_par_tonne > 0 ? ` · ${mp.cout_par_tonne} €/t` : ' · gratuit'}</p>
          )}
          <div className="space-y-1">
            {params.map(p => (
              <div key={p.label} className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-sm flex-shrink-0 ${p.color}`} />
                <span className="text-xs text-gray-500 flex-1">{p.label}</span>
                <span className="text-xs font-medium text-gray-800 tabular-nums">{p.val}%</span>
              </div>
            ))}
          </div>
          {params.length === 0 && (
            <p className="text-xs text-gray-400">Aucune composition renseignée</p>
          )}
          {(mp.recettes_autorisees ?? []).length > 0 && (
            <div className="mt-2 pt-2 border-t border-gray-100">
              <p className="text-xs text-gray-400 mb-1">Recettes autorisées</p>
              <div className="flex flex-wrap gap-1">
                {(mp.recettes_autorisees ?? []).map(rid => (
                  <span key={rid} className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">{rid}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
