-- NEOLITIK — Migration v7
-- À coller dans : Supabase > SQL Editor > New query > Run
-- Cumulative : safe à exécuter même si certaines colonnes existent déjà

-- 1. Versioning des recettes
--   parent_recette_id : si non null, cette recette est une version dérivée d'une autre
--   version_label     : libellé libre ("v2 — 02/2026", "Hiver", etc.)
--   archivee          : true pour cacher dans les sélecteurs Optimiseur/Manuel sans la supprimer
alter table recettes_cibles add column if not exists parent_recette_id text;
alter table recettes_cibles add column if not exists version_label text;
alter table recettes_cibles add column if not exists archivee boolean default false;

-- 2. Composition spécifique d'un sac (surcharge la composition par défaut de sa MP)
--   composition_override : jsonb {pct_pp, pct_pe, pct_alu, pct_blanc, pct_transparent, pct_noir,
--                                  pct_autres_plastiques, pct_autres_couleurs, pct_sable,
--                                  pct_charge_minerale}
--                          null = utiliser les valeurs de la MP
alter table sacs add column if not exists composition_override jsonb;

-- 3. Traçabilité réception
alter table sacs add column if not exists fournisseur text;
alter table sacs add column if not exists numero_lot_fournisseur text;
alter table sacs add column if not exists date_reception date;

-- 4. Snapshot de la composition effective d'un sac au moment où il a été consommé
--   composition_snapshot : jsonb avec les mêmes clés que composition_override
--                          Si présent, prime sur la composition actuelle de la MP pour le batch
alter table batch_lignes add column if not exists composition_snapshot jsonb;

-- 5. Opérateur sur le batch (qui a créé / clôturé)
alter table batches add column if not exists operateur_creation text;
alter table batches add column if not exists operateur_cloture text;
alter table batches add column if not exists cloture_at timestamptz;
