-- NEOLITIK — Migration v6
-- À coller dans : Supabase > SQL Editor > New query > Run
-- Cumulative : safe à exécuter même si certaines colonnes existent déjà

-- 1. Charge minérale (distincte du sable / béton concassé EcoLithe)
alter table matieres_premieres add column if not exists pct_charge_minerale numeric default 0;
alter table recettes_cibles    add column if not exists pct_charge_minerale_cible numeric default 0;

-- 2. Suivi consommation production
--   reste_declare_kg : masse déclarée comme "reste" (transformée en MP interne)
--   masse_consommee_kg : non utilisé en lecture (calculé depuis batch_consommations), conservé pour compat
alter table batches add column if not exists reste_declare_kg numeric default 0;
alter table batches add column if not exists masse_consommee_kg numeric default 0;

-- 3. Statut batches : ajout 'en_consommation' optionnel (compat avec en_cours existant)
--   On garde 'en_cours' comme état générique. Ajout 'cloture' déjà géré.
alter table batches add column if not exists statut text default 'en_cours';
alter table batches add column if not exists notes text;
alter table batches add column if not exists cout_total_eur numeric;
alter table batches add column if not exists cout_par_tonne_eur numeric;

-- 4. Historique des consommations journalières d'un batch en production
create table if not exists batch_consommations (
  id uuid primary key default gen_random_uuid(),
  batch_id text references batches(id) on delete cascade,
  date_consommation date default current_date,
  masse_kg numeric not null,
  notes text,
  operateur text,
  created_at timestamptz default now()
);

create index if not exists idx_batch_conso_batch_id on batch_consommations(batch_id);
create index if not exists idx_batch_conso_date on batch_consommations(date_consommation);

alter table batch_consommations enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'batch_consommations' and policyname = 'public_all') then
    create policy "public_all" on batch_consommations for all using (true) with check (true);
  end if;
end $$;

-- 5. Snapshot des sacs consommés pour permettre la restauration propre à la suppression
--   Stocké en jsonb : [{ sac_id, masse_prise, masse_avant_kg, statut_avant }]
--   Les batchs anciens (legacy) auront ce champ vide → l'option "annulation erreur" sera désactivée pour eux
alter table batch_lignes add column if not exists sacs_consommes jsonb default '[]'::jsonb;

-- 6. Seuils de stock (alerte stock bas par MP, future feature)
alter table matieres_premieres add column if not exists stock_mini_kg numeric default 0;
