-- NEOLITIK — Migration v11
-- À coller dans : Supabase > SQL Editor > New query > Run
-- Cumulative : safe à exécuter plusieurs fois

-- 1. Archivage des matières premières (épurer la liste sans casser les batchs historiques)
alter table matieres_premieres add column if not exists archivee boolean default false;

-- 2. Commentaire libre sur un sac (imprimé sur la fiche opérateur)
alter table sacs add column if not exists commentaire text;

-- 3. Code couleur de la recette pour la codification des batchs (S = sable, N = noir, G = gris…)
alter table recettes_cibles add column if not exists code_couleur text;
