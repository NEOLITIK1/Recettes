-- NEOLITIK — Migration v13 : prix spécifique par sac
-- À coller dans : Supabase > SQL Editor > New query > Run
-- Cumulative : safe à exécuter plusieurs fois

-- Prix du sac en €/t. Null = prix générique de la matière première.
alter table sacs add column if not exists prix_tonne numeric;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sacs_prix_positif') then
    alter table sacs add constraint sacs_prix_positif check (prix_tonne >= 0);
  end if;
end $$;

notify pgrst, 'reload schema';

-- Contrôle : attendu 1
select count(*) as colonne_prix from information_schema.columns
where table_schema = 'public' and table_name = 'sacs' and column_name = 'prix_tonne';
