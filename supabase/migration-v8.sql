-- NEOLITIK — Migration v8
-- À coller dans : Supabase > SQL Editor > New query > Run
-- Cumulative : safe à exécuter même si certaines colonnes existent déjà

-- 1. Colonnes utilisées par l'application mais absentes des migrations précédentes
--    (si elles existent déjà dans votre base, ce script ne change rien)

--   recettes_autorisees : liste des recettes dans lesquelles une MP peut être utilisée.
--   Tableau vide = aucune restriction (MP utilisable partout).
alter table matieres_premieres add column if not exists recettes_autorisees text[] default '{}';

--   pct_autres_plastiques : fraction "autres plastiques" de la composition
--   (distincte de pct_autres, conservée pour compatibilité avec les données seed)
alter table matieres_premieres add column if not exists pct_autres_plastiques numeric default 0;
