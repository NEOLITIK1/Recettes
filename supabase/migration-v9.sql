-- NEOLITIK — Migration v9
-- À coller dans : Supabase > SQL Editor > New query > Run
-- Cumulative : safe à exécuter plusieurs fois

-- 1. Paramètres de l'optimiseur mémorisés sur le batch
--    (MP imposées + restrictions, pour les retrouver lors d'un "Repasser en optimiseur")
alter table batches add column if not exists optimiseur_params jsonb;

-- 2. Création de batch ATOMIQUE : batch + lignes + mise à jour du stock
--    dans une seule transaction. Si une étape échoue, rien n'est écrit
--    (plus de stock à moitié décrémenté en cas de coupure réseau).
--    p_batch  : objet batch (id, nom, recette_id, date_creation, statut,
--               cout_total_eur, cout_par_tonne_eur, optimiseur_params)
--    p_lignes : tableau de lignes (mp_id, masse_totale_kg, sacs_kg, ordre,
--               sacs_consommes, composition_snapshot)
--    p_sacs   : tableau de mises à jour stock ({id, masse_kg, statut})
create or replace function valider_batch(p_batch jsonb, p_lignes jsonb, p_sacs jsonb)
returns void
language plpgsql
as $$
declare
  l jsonb;
  s jsonb;
begin
  insert into batches (id, nom, recette_id, date_creation, statut,
                       cout_total_eur, cout_par_tonne_eur, optimiseur_params)
  values (
    p_batch->>'id',
    p_batch->>'nom',
    p_batch->>'recette_id',
    coalesce((p_batch->>'date_creation')::date, current_date),
    coalesce(p_batch->>'statut', 'en_cours'),
    (p_batch->>'cout_total_eur')::numeric,
    (p_batch->>'cout_par_tonne_eur')::numeric,
    case when p_batch ? 'optimiseur_params' then p_batch->'optimiseur_params' else null end
  );

  for l in select * from jsonb_array_elements(p_lignes) loop
    insert into batch_lignes (batch_id, mp_id, masse_totale_kg, sacs_kg, ordre,
                              sacs_consommes, composition_snapshot)
    values (
      p_batch->>'id',
      l->>'mp_id',
      (l->>'masse_totale_kg')::numeric,
      coalesce((select array_agg(value::numeric) from jsonb_array_elements_text(l->'sacs_kg')), '{}'),
      coalesce((l->>'ordre')::int, 0),
      coalesce(l->'sacs_consommes', '[]'::jsonb),
      case when (l ? 'composition_snapshot') and (l->'composition_snapshot') <> 'null'::jsonb
           then l->'composition_snapshot' else null end
    );
  end loop;

  for s in select * from jsonb_array_elements(p_sacs) loop
    update sacs set
      masse_kg = (s->>'masse_kg')::numeric,
      statut = s->>'statut',
      updated_at = now()
    where id = (s->>'id')::uuid;
  end loop;
end;
$$;
