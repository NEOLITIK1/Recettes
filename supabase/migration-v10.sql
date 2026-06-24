-- NEOLITIK — Migration v10
-- À coller dans : Supabase > SQL Editor > New query > Run
-- Cumulative : safe à exécuter plusieurs fois

-- 1. Emplacement physique d'un sac (travée, coin d'atelier…) — imprimé sur la fiche opérateur
alter table sacs add column if not exists emplacement text;

-- 2. Catégories de stock paramétrables (vue "par matière" du stock)
--    conditions : tableau de { champ, min, max } appliqué à la composition
--    effective du sac (override ou MP). Un sac est compté dans la catégorie si
--    TOUTES les conditions sont vraies (min ≤ valeur ≤ max).
--    Exemples :
--      "PP"        → [{champ:'pct_pp', min:50, max:100}]
--      "PP/PE mix" → [{champ:'pct_pp', min:20, max:80},{champ:'pct_pe', min:20, max:80}]
--      "Noir"      → [{champ:'pct_noir', min:50, max:100}]
create table if not exists stock_categories (
  id uuid primary key default gen_random_uuid(),
  nom text not null,
  ordre integer default 0,
  conditions jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);

alter table stock_categories enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'stock_categories' and policyname = 'public_all') then
    create policy "public_all" on stock_categories for all using (true) with check (true);
  end if;
end $$;
