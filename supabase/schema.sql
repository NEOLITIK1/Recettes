-- NEOLITIK — Schéma Supabase complet (consolidé : inclut migrations v6, v7 et v8)
-- Installation neuve : coller ce seul fichier dans Supabase > SQL Editor > New query > Run
-- Base existante : exécuter uniquement les migration-vX.sql manquants

-- 1. Matières premières
create table if not exists matieres_premieres (
  id text primary key,
  nom text not null,
  type_appro text,
  description text,
  cout_par_tonne numeric default 0,
  pct_pp numeric default 0,
  pct_pe numeric default 0,
  pct_alu numeric default 0,
  pct_autres numeric default 0,
  pct_autres_plastiques numeric default 0,
  pct_blanc numeric default 0,
  pct_transparent numeric default 0,
  pct_noir numeric default 0,
  pct_autres_couleurs numeric default 0,
  pct_sable numeric default 0,
  pct_charge_minerale numeric default 0,
  stock_mini_kg numeric default 0,
  recettes_autorisees text[] default '{}',
  created_at timestamptz default now()
);

-- 2. Recettes cibles (avec versionnage)
create table if not exists recettes_cibles (
  id text primary key,
  nom text not null,
  pct_pp_cible numeric default 0,
  pct_pe_cible numeric default 0,
  pct_alu_cible numeric default 0,
  pct_autres_cible numeric default 0,
  pct_blanc_cible numeric default 0,
  pct_transparent_cible numeric default 0,
  pct_noir_cible numeric default 0,
  pct_autres_coul_cible numeric default 0,
  pct_ecolithe_cible numeric default 0,
  pct_charge_minerale_cible numeric default 0,
  parent_recette_id text,
  version_label text,
  archivee boolean default false,
  created_at timestamptz default now()
);

-- 3. Sacs en stock (avec traçabilité fournisseur et composition spécifique)
create table if not exists sacs (
  id uuid primary key default gen_random_uuid(),
  reference text,
  mp_id text references matieres_premieres(id),
  masse_kg numeric not null,
  statut text default 'disponible' check (statut in ('disponible', 'partiel', 'consomme')),
  composition_override jsonb,
  fournisseur text,
  numero_lot_fournisseur text,
  date_reception date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 4. Batchs
create table if not exists batches (
  id text primary key,
  nom text not null,
  recette_id text references recettes_cibles(id),
  notes text,
  statut text default 'en_cours',
  date_creation date default current_date,
  reste_declare_kg numeric default 0,
  masse_consommee_kg numeric default 0,
  cout_total_eur numeric,
  cout_par_tonne_eur numeric,
  operateur_creation text,
  operateur_cloture text,
  cloture_at timestamptz,
  created_at timestamptz default now()
);

-- 5. Lignes de batch (une ligne = une MP + masse + sacs)
create table if not exists batch_lignes (
  id uuid primary key default gen_random_uuid(),
  batch_id text references batches(id) on delete cascade,
  mp_id text references matieres_premieres(id),
  masse_totale_kg numeric not null,
  sacs_kg numeric[] default '{}',
  sacs_consommes jsonb default '[]'::jsonb,
  composition_snapshot jsonb,
  ordre integer default 0
);

-- 6. Consommations journalières d'un batch en production
create table if not exists batch_consommations (
  id uuid primary key default gen_random_uuid(),
  batch_id text references batches(id) on delete cascade,
  date_consommation date default current_date,
  masse_kg numeric not null,
  notes text,
  operateur text,
  created_at timestamptz default now()
);

-- Index utiles
create index if not exists idx_sacs_statut on sacs(statut);
create index if not exists idx_sacs_mp_id on sacs(mp_id);
create index if not exists idx_batch_lignes_batch_id on batch_lignes(batch_id);
create index if not exists idx_batches_recette_id on batches(recette_id);
create index if not exists idx_batches_statut on batches(statut);
create index if not exists idx_batch_conso_batch_id on batch_consommations(batch_id);
create index if not exists idx_batch_conso_date on batch_consommations(date_consommation);

-- Row Level Security (policies permissives — usage interne sans auth)
alter table matieres_premieres enable row level security;
alter table recettes_cibles enable row level security;
alter table sacs enable row level security;
alter table batches enable row level security;
alter table batch_lignes enable row level security;
alter table batch_consommations enable row level security;

do $$
declare t text;
begin
  foreach t in array array['matieres_premieres','recettes_cibles','sacs','batches','batch_lignes','batch_consommations'] loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'public_all') then
      execute format('create policy "public_all" on %I for all using (true) with check (true)', t);
    end if;
  end loop;
end $$;
