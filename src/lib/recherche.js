// Recherche texte tolérante : insensible à la casse et aux accents, multi-mots.
// "pp blanc berry" trouve "PP Blanc Berry" ; "eclatant" trouve "Éclatant".

export function normaliser(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// Vrai si TOUS les mots de la requête apparaissent dans l'un des champs fournis
export function correspond(query, ...champs) {
  const q = normaliser(query).trim()
  if (!q) return true
  const texte = champs.map(normaliser).join(' ')
  return q.split(/\s+/).every(mot => texte.includes(mot))
}
