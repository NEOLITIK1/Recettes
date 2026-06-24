import { supabase } from './supabase.js'
import { effectiveMp, snapshotComposition } from './calculs.js'

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
    }],
    // Fige la composition (complète si mpEffectif fourni, sinon l'override seul)
    composition_snapshot: mpEffectif
      ? snapshotComposition(mpEffectif)
      : (sac.composition_override ?? null),
  }
}

// Mise à jour stock correspondant au prélèvement : partiel ou consommé
export function sacUpdatePourPrise(sac, taken) {
  const masseRestante = Math.max(0, Math.round((sac.masse_kg ?? 0) - taken))
  return masseRestante > 0
    ? { id: sac.id, masse_kg: masseRestante, statut: 'partiel' }
    : { id: sac.id, masse_kg: 0, statut: 'consomme' }
}

// Crée un batch + lignes + met à jour le stock.
// Utilise la fonction Postgres valider_batch (transaction atomique, migration v9).
// Si la migration n'est pas encore appliquée, retombe sur des écritures
// séquentielles avec annulation de l'en-tête en cas d'échec des lignes.
// Retourne null si OK, sinon l'erreur Supabase.
export async function creerBatchAvecStock(batch, lignes, sacUpdates) {
  const { error: rpcErr } = await supabase.rpc('valider_batch', {
    p_batch: batch,
    p_lignes: lignes,
    p_sacs: sacUpdates,
  })
  if (!rpcErr) return null
  // PGRST202 = fonction inexistante (migration v9 pas encore exécutée)
  const fnAbsente = rpcErr.code === 'PGRST202' || /valider_batch/i.test(rpcErr.message ?? '')
  if (!fnAbsente) return rpcErr

  // ── Fallback séquentiel ──
  let batchInsert = { ...batch }
  let { error: bErr } = await supabase.from('batches').insert(batchInsert)
  if (bErr && /optimiseur_params/i.test(bErr.message ?? '')) {
    // Colonne v9 absente : on réessaie sans (les params seront juste perdus)
    delete batchInsert.optimiseur_params
    ;({ error: bErr } = await supabase.from('batches').insert(batchInsert))
  }
  if (bErr) return bErr

  const { error: lErr } = await supabase.from('batch_lignes')
    .insert(lignes.map(l => ({ ...l, batch_id: batch.id })))
  if (lErr) {
    // Ne pas laisser un en-tête de batch orphelin (le stock n'a pas été touché)
    await supabase.from('batches').delete().eq('id', batch.id)
    return lErr
  }

  for (const s of sacUpdates) {
    const { error: sErr } = await supabase.from('sacs')
      .update({ masse_kg: s.masse_kg, statut: s.statut, updated_at: new Date().toISOString() })
      .eq('id', s.id)
    if (sErr) return sErr
  }
  return null
}

// Restaure les sacs sources de lignes batch depuis leur snapshot sacs_consommes :
// ré-ajoute la masse prélevée et rétablit le statut d'origine.
// Robuste si d'autres batchs ont touché le sac entretemps (addition simple).
// Retourne le nombre de sacs restaurés.
export async function restaurerSacsConsommes(lignes) {
  let restaures = 0
  for (const ligne of lignes) {
    const sc = Array.isArray(ligne.sacs_consommes) ? ligne.sacs_consommes : []
    for (const entry of sc) {
      if (!entry?.sac_id) continue
      const { data: sacActuel } = await supabase
        .from('sacs')
        .select('id, masse_kg, statut')
        .eq('id', entry.sac_id)
        .maybeSingle()
      if (!sacActuel) continue // sac supprimé entretemps : rien à restaurer
      const masseRestauree = (sacActuel.masse_kg ?? 0) + (entry.masse_prise ?? 0)
      const masseAvant = entry.masse_avant_kg ?? masseRestauree
      const statutFinal = masseRestauree >= masseAvant - 0.5
        ? (entry.statut_avant ?? 'disponible')
        : 'partiel'
      const { error } = await supabase.from('sacs').update({
        masse_kg: Math.round(masseRestauree),
        statut: statutFinal,
        updated_at: new Date().toISOString(),
      }).eq('id', entry.sac_id)
      if (!error) restaures++
    }
  }
  return restaures
}

// Une ligne (ou un batch) est restaurable si au moins une ligne trace ses sacs sources
export function lignesRestaurables(lignes) {
  return (lignes ?? []).some(l => Array.isArray(l.sacs_consommes) && l.sacs_consommes.length > 0)
}
