-- NEOLITIK — Schéma Supabase
-- Coller dans : Supabase > SQL Editor > New query > Run

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
  pct_blanc numeric default 0,
  pct_transparent numeric default 0,
  pct_noir numeric default 0,
  pct_autres_couleurs numeric default 0,
  pct_sable numeric default 0,
  created_at timestamptz default now()
);

-- 2. Recettes cibles
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
  created_at timestamptz default now()
);

-- 3. Sacs en stock
create table if not exists sacs (
  id uuid primary key default gen_random_uuid(),
  reference text,
  mp_id text references matieres_premieres(id),
  masse_kg numeric not null,
  statut text default 'disponible' check (statut in ('disponible', 'partiel', 'consomme')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 4. Batchs
create table if not exists batches (
  id text primary key,
  nom text not null,
  recette_id text references recettes_cibles(id),
  notes text,
  date_creation date default current_date,
  created_at timestamptz default now()
);

-- 5. Lignes de batch (une ligne = une MP + masse + sacs)
create table if not exists batch_lignes (
  id uuid primary key default gen_random_uuid(),
  batch_id text references batches(id) on delete cascade,
  mp_id text references matieres_premieres(id),
  masse_totale_kg numeric not null,
  sacs_kg numeric[] default '{}',
  ordre integer default 0
);

-- Index utiles
create index if not exists idx_sacs_statut on sacs(statut);
create index if not exists idx_sacs_mp_id on sacs(mp_id);
create index if not exists idx_batch_lignes_batch_id on batch_lignes(batch_id);
create index if not exists idx_batches_recette_id on batches(recette_id);

-- Row Level Security (désactivé pour usage interne sans auth)
-- À activer si vous ajoutez de l'authentification
alter table matieres_premieres enable row level security;
alter table recettes_cibles enable row level security;
alter table sacs enable row level security;
alter table batches enable row level security;
alter table batch_lignes enable row level security;

-- Policies permissives pour accès public (à restreindre avec auth plus tard)
create policy "public_all" on matieres_premieres for all using (true) with check (true);
create policy "public_all" on recettes_cibles for all using (true) with check (true);
create policy "public_all" on sacs for all using (true) with check (true);
create policy "public_all" on batches for all using (true) with check (true);
create policy "public_all" on batch_lignes for all using (true) with check (true);
