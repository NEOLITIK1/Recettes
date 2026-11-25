import { supabase } from './supabase.js'
import { effectiveMp, calcCout, snapshotComposition } from './calculs.js'

// ─────────────────────────────────────────────────────────────────────────────
// Opérations batch ↔ stock partagées (Optimiseur, Manuel, BatchEnCours, Historique)
// Règle d'or : toute masse prélevée du stock est tracée dans sacs_consommes,
// ce qui permet une restauration fidèle (masse + statut) en cas d'annulation.
// ─────────────────────────────────────────────────────────────────────────────

// Construit la ligne batch pour un prélèvement sur un sac réel.
// sac : ligne de la table sacs · taken : masse prélevée (kg) · ordre : position
// mpEffectif : composition effective du sac (MP + override). Si fournie, la
//   composition COMPLÈTE est figée → l'historique reste juste même si la MP est
//   modifiée ou supprimée plus tard. Sinon, on fige au moins l'override du sac.
export function lignePourSac(sac, taken, ordre, mpEffectif = null) {
  return {
    mp_id: sac.mp_id,
    masse_totale_kg: taken,
    sacs_kg: [taken],
    ordre,
    sacs_consommes: [{
      sac_id: sac.id,
      masse_prise: taken,
      masse_avant_kg: sac.masse_kg ?? 0,
      statut_avant: sac.statut ?? 'disponible',
      // Snapshot identifiants pour l'impression (résiste à la suppression du sac)
      reference: sac.reference ?? null,
      fournisseur: sac.fournisseur ?? null,
      numero_lot_fournisseur: sac.numero_lot_fournisseur ?? null,
      emplacement: sac.emplacement ?? null,
      rangee: sac.rangee ?? null,
      place: sac.place ?? null,
      niveau: sac.niveau ?? null,
      taille: sac.taille ?? null,
      commentaire: sac.commentaire ?? null,
    }],
    // Fige la composition (complète si mpEffectif fourni, sinon l'override seul)
    composition_snapshot: mpEffectif
      ? snapshotComposition(mpEffectif)
      : (sac.composition_override ?? null),
  }
}

// Mise à jour stock correspondant au prélèvement : partiel ou consommé.
// masse_lue permet à la base de refuser si le sac a changé entre-temps.
export function sacUpdatePourPrise(sac, taken) {
  const masseRestante = Math.max(0, Math.round((sac.masse_kg ?? 0) - taken))
  return {
    id: sac.id,
    masse_lue: sac.masse_kg ?? 0,
    masse_kg: masseRestante,
    statut: masseRestante > 0 ? 'partiel' : 'consomme',
  }
}

// Toutes les écritures ci-dessous passent par des fonctions Postgres (migration v12) :
// tout ou rien, sous verrou.

// Crée un batch + lignes + met à jour le stock. Retourne l'erreur Supabase, ou null si OK.
export async function creerBatchAvecStock(batch, lignes, sacUpdates) {
  const { error } = await supabase.rpc('valider_batch', { p_batch: batch, p_lignes: lignes, p_sacs: sacUpdates })
  return error
}

// Ajoute des sacs à un batch existant. Retourne l'erreur Supabase, ou null si OK.
export async function ajouterSacsAuBatchAvecStock(batchId, lignes, sacUpdates) {
  const { error } = await supabase.rpc('ajouter_sacs_batch', { p_batch_id: batchId, p_lignes: lignes, p_sacs: sacUpdates })
  return error
}

// Texte à afficher après une restitution qui n'a pas pu être complète (sinon '')
function avisRestitution(r) {
  const avis = []
  if (r?.manquants > 0) avis.push(`${r.manquants} sac(s) n'existent plus en stock et n'ont pas pu être restitués.`)
  if (r?.hors_plan > 0) avis.push(`${r.hors_plan} sac(s) restitués sans place : leur rangée est pleine. Rangez-les depuis la page Stock.`)
  return avis.join('\n')
}

// Remet en stock les sacs de lignes de batch (masse, statut, place en rangée).
// Retourne { error, avis } — avis : texte à montrer à l'utilisateur, ou ''.
export async function restaurerSacsConsommes(lignes) {
  const { data, error } = await supabase.rpc('restituer_lignes', { p_lignes: lignes.map(l => l.id) })
  return { error, avis: avisRestitution(data) }
}

// Remplace le sac d'une ligne : restitue l'ancien et prélève le nouveau en une seule fois
export async function substituerSacLigne(ligneId, nouvelleLigne, sacId, masse) {
  const { data, error } = await supabase.rpc('substituer_sac', { p_ligne: ligneId, p_nouvelle: nouvelleLigne, p_sac: sacId, p_masse: masse })
  return { error, avis: avisRestitution(data) }
}

// Corrige la masse d'une ligne et répercute l'écart sur son sac
export async function ajusterMasseLigne(ligneId, masse, mode = null) {
  const { data, error } = await supabase.rpc('ajuster_masse_ligne', { p_ligne: ligneId, p_masse: masse, p_mode: mode })
  return { error, avis: data?.hors_plan ? 'Le sac a été remis en stock sans place : sa rangée est pleine. Rangez-le depuis la page Stock.' : '' }
}

// Confirme que les sacs d'un batch sont physiquement sortis : libère leurs places
export async function sortirSacsBatch(batchId) {
  const { data, error } = await supabase.rpc('sortir_sacs_batch', { p_batch_id: batchId })
  return { error, sortis: data?.sortis ?? 0, rangees: data?.rangees ?? [] }
}

// Recalcule le coût enregistré d'un batch après modification de ses lignes
export async function recalculerCoutBatch(batchId, mpsMap) {
  const { data: lignes, error } = await supabase.from('batch_lignes').select('*').eq('batch_id', batchId)
  if (error) return
  const enrichies = (lignes ?? []).map(l => ({ mp: effectiveMp(mpsMap[l.mp_id], l.composition_snapshot), masse_totale_kg: l.masse_totale_kg }))
  const masse = enrichies.reduce((s, l) => s + (l.masse_totale_kg ?? 0), 0)
  const cout = calcCout(enrichies)
  await supabase.from('batches').update({
    cout_total_eur: Math.round(cout),
    cout_par_tonne_eur: masse > 0 ? Math.round(cout / masse * 1000) : 0,
  }).eq('id', batchId)
}

// Une ligne (ou un batch) est restaurable si au moins une ligne trace ses sacs sources
export function lignesRestaurables(lignes) {
  return (lignes ?? []).some(l => Array.isArray(l.sacs_consommes) && l.sacs_consommes.length > 0)
}
