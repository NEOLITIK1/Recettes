import { suggestionsAjout } from '../lib/calculs.js'

// Panneau de suggestions d'ajout pour atteindre la recette cible (réappro)
// comp : composition actuelle (sortie de calcComposition) · recette : recette cible
export default function SuggestionsReappro({ comp, recette }) {
  const sug = suggestionsAjout(comp, recette)
  if (!sug) return null

  const Bloc = ({ titre, ajouts, exces }) => {
    if ((!ajouts || ajouts.length === 0) && (!exces || exces.length === 0)) return null
    return (
      <div>
        <p className="text-xs font-medium text-gray-600 mb-1">{titre}</p>
        {ajouts?.length > 0 && (
          <ul className="space-y-0.5">
            {ajouts.map(a => (
              <li key={a.label} className="text-sm text-gray-800 flex items-center gap-2">
                <span className="text-emerald-600">+</span>
                <span>≈ <strong>{a.kg.toLocaleString('fr-FR')} kg</strong> de plastique riche en <strong>{a.label}</strong></span>
              </li>
            ))}
          </ul>
        )}
        {exces?.length > 0 && (
          <p className="text-xs text-amber-700 mt-1">
            {exces.join(', ')} en excès (pas de cible) — ne peut être corrigé qu'en diluant avec d'autres matières.
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 space-y-3">
      <div>
        <p className="text-sm font-medium text-blue-900">💡 Pour atteindre la cible — à ajouter / réapprovisionner</p>
        <p className="text-xs text-blue-700/80">Estimations pour le batch actuel ({sug.masseActuelle.toLocaleString('fr-FR')} kg). On ne peut qu'ajouter de la matière.</p>
      </div>

      {sug.rien ? (
        <p className="text-sm text-emerald-700">✓ Le batch atteint déjà les cibles — rien à ajouter.</p>
      ) : (
        <div className="grid sm:grid-cols-3 gap-4">
          <Bloc titre="Polymères" ajouts={sug.polymeres.ajouts} exces={sug.polymeres.exces} />
          <Bloc titre="Couleurs" ajouts={sug.couleurs.ajouts} exces={sug.couleurs.exces} />
          {sug.minerals.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-600 mb-1">Minéral</p>
              <ul className="space-y-0.5">
                {sug.minerals.map(a => (
                  <li key={a.label} className="text-sm text-gray-800 flex items-center gap-2">
                    <span className="text-emerald-600">+</span>
                    <span>≈ <strong>{a.kg.toLocaleString('fr-FR')} kg</strong> de <strong>{a.label}</strong></span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {!sug.rien && (
        <p className="text-xs text-blue-700/70 border-t border-blue-100 pt-2">
          Estimations indépendantes par axe : un même sac acheté (ex: <em>PE blanc</em>) peut couvrir
          plusieurs lignes à la fois. À affiner selon les matières réellement disponibles chez vos fournisseurs.
        </p>
      )}
    </div>
  )
}
