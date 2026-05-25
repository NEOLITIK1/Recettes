// Affiche l'écart entre valeur réelle et cible avec couleur sémantique
export function ecartClass(ecart) {
  const a = Math.abs(ecart)
  if (a <= 2) return 'text-emerald-700 bg-emerald-50'
  if (a <= 5) return 'text-amber-700 bg-amber-50'
  return 'text-red-700 bg-red-50'
}

export function ecartIcon(ecart) {
  const a = Math.abs(ecart)
  if (a <= 2) return '✓'
  if (a <= 5) return '△'
  return '✗'
}

export default function EcartBadge({ valeur, cible }) {
  const ecart = valeur - cible
  const sign = ecart >= 0 ? '+' : ''
  const cls = ecartClass(ecart)
  const icon = ecartIcon(ecart)
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {icon} {sign}{ecart.toFixed(1)}%
    </span>
  )
}
