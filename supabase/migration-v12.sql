-- NEOLITIK — Migration v12 : plan de stockage + sécurisation des prélèvements
-- À coller dans : Supabase > SQL Editor > New query > Run
-- Cumulative : safe à exécuter plusieurs fois

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. COLONNES
-- ═══════════════════════════════════════════════════════════════════════════
-- Position d'un sac : rangée (A à O), place (1 = fond contre le mur), niveau dans
-- la pile (1 = en bas). Tout à null = sac hors plan (emplacement en texte libre).
alter table sacs add column if not exists taille text not null default 'grand';
alter table sacs add column if not exists rangee text;
alter table sacs add column if not exists place  integer;
alter table sacs add column if not exists niveau integer;

-- Moment où les sacs d'une ligne ont été physiquement sortis. Null = encore en rangée.
-- Les lignes antérieures au plan sont considérées comme déjà sorties (une seule fois).
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'batch_lignes' and column_name = 'sortie_at') then
    alter table batch_lignes add column sortie_at timestamptz;
    update batch_lignes set sortie_at = now();
  end if;
end $$;

-- Nombre de places par rangée (doit rester identique à RANGEES dans src/lib/plan.js)
create or replace function capacite_rangee(r text) returns integer
language sql immutable as $$
  select case
    when r in ('A','B','C','D','E','F','G','H','I','J','K') then 6
    when r in ('L','M') then 5
    when r in ('N','O') then 4
    else 0 end
$$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sacs_taille_valide') then
    alter table sacs add constraint sacs_taille_valide check (taille in ('grand','petit'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sacs_plan_coherent') then
    alter table sacs add constraint sacs_plan_coherent check (
      (rangee is null and place is null and niveau is null)
      or (rangee is not null and place is not null and niveau is not null
          and place between 1 and capacite_rangee(rangee)
          and niveau between 1 and (case when taille = 'petit' then 3 else 1 end))
    );
  end if;
  -- Deux sacs ne peuvent pas occuper la même position (vérifié en fin de transaction,
  -- pour permettre le décalage d'une rangée)
  if not exists (select 1 from pg_constraint where conname = 'sacs_position_unique') then
    alter table sacs add constraint sacs_position_unique unique (rangee, place, niveau)
      deferrable initially deferred;
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. PLAN DE STOCKAGE
-- ═══════════════════════════════════════════════════════════════════════════
-- Verrou unique : toutes les opérations stock/plan passent l'une après l'autre
create or replace function _verrou_stock() returns void
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('neolitik_stock'));
end $$;

-- Resserre une rangée vers le fond (les sacs devant prennent la place libérée)
create or replace function _compacter_rangee(r text) returns void
language sql as $$
  with rang as (
    select id,
           dense_rank() over (order by place) as np,
           row_number() over (partition by place order by niveau) as nn
    from sacs where rangee = r
  )
  update sacs s set place = rang.np, niveau = rang.nn
  from rang
  where s.id = rang.id and (s.place <> rang.np or s.niveau <> rang.nn)
$$;

create or replace function _retirer(p_sac uuid) returns void
language plpgsql as $$
declare r text;
begin
  select rangee into r from sacs where id = p_sac;
  if r is null then return; end if;
  update sacs set rangee = null, place = null, niveau = null where id = p_sac;
  perform _compacter_rangee(r);
end $$;

create or replace function retirer_du_plan(p_sac uuid) returns void
language plpgsql as $$
begin
  perform _verrou_stock();
  perform _retirer(p_sac);
end $$;

-- Place un sac dans une rangée : première place libre côté allée, ou au-dessus d'un
-- autre petit sac (p_sur_sac). Sans effet si le sac est déjà au bon endroit.
create or replace function placer_sac(p_sac uuid, p_rangee text, p_taille text default null, p_sur_sac uuid default null)
returns text
language plpgsql as $$
declare
  s sacs%rowtype;
  cible sacs%rowtype;
  t text;
  n integer;
  pl integer;
begin
  perform _verrou_stock();
  select * into s from sacs where id = p_sac;
  if not found then raise exception 'Sac introuvable.'; end if;
  if coalesce(s.masse_kg, 0) <= 0 then raise exception 'Ce sac est vide : impossible de le placer.'; end if;
  t := coalesce(p_taille, s.taille);

  if p_sur_sac is not null then
    if t <> 'petit' then raise exception 'Seul un petit big bag peut compléter une pile.'; end if;
    select * into cible from sacs where id = p_sur_sac;
    if not found or cible.rangee is null or cible.taille <> 'petit' then
      raise exception 'Cette pile n''existe plus. Rechargez la page.';
    end if;
    if s.taille = t and s.rangee = cible.rangee and s.place = cible.place then
      return s.rangee || s.place;
    end if;
    perform _retirer(p_sac);
    select * into cible from sacs where id = p_sur_sac; -- sa place a pu se décaler
    select count(*) into n from sacs where rangee = cible.rangee and place = cible.place;
    if n >= 3 then raise exception 'La pile % est déjà complète (3 petits big bags).', cible.rangee || cible.place; end if;
    update sacs set taille = t, rangee = cible.rangee, place = cible.place, niveau = n + 1, updated_at = now() where id = p_sac;
    return cible.rangee || cible.place;
  end if;

  if capacite_rangee(p_rangee) = 0 then raise exception 'Rangée inconnue : %', p_rangee; end if;
  if s.taille = t and s.rangee = p_rangee then
    return s.rangee || s.place;
  end if;
  perform _retirer(p_sac);
  -- Petit sac : compléter la pile côté allée si elle n'est pas pleine
  if t = 'petit' then
    select place, count(*) into pl, n from sacs
      where rangee = p_rangee and place = (select max(place) from sacs where rangee = p_rangee) and taille = 'petit'
      group by place having count(*) < 3;
    if found then
      update sacs set taille = t, rangee = p_rangee, place = pl, niveau = n + 1, updated_at = now() where id = p_sac;
      return p_rangee || pl;
    end if;
  end if;
  select coalesce(max(place), 0) into n from sacs where rangee = p_rangee;
  if n >= capacite_rangee(p_rangee) then raise exception 'La rangée % est pleine.', p_rangee; end if;
  update sacs set taille = t, rangee = p_rangee, place = n + 1, niveau = 1, updated_at = now() where id = p_sac;
  return p_rangee || (n + 1);
end $$;

-- Retour d'un sac dans sa rangée d'origine (annulation) : pile incomplète pour un petit,
-- sinon première place côté allée. Retourne false si la rangée est pleine.
create or replace function _replacer(p_sac uuid, p_rangee text) returns boolean
language plpgsql as $$
declare
  t text;
  pl integer;
  n integer;
begin
  select taille into t from sacs where id = p_sac;
  if t = 'petit' then
    select place, count(*) into pl, n from sacs
      where rangee = p_rangee and taille = 'petit'
      group by place having count(*) < 3 order by place desc limit 1;
    if found then
      update sacs set rangee = p_rangee, place = pl, niveau = n + 1 where id = p_sac;
      return true;
    end if;
  end if;
  select coalesce(max(place), 0) into pl from sacs where rangee = p_rangee;
  if pl >= capacite_rangee(p_rangee) then return false; end if;
  update sacs set rangee = p_rangee, place = pl + 1, niveau = 1 where id = p_sac;
  return true;
end $$;

-- "Sacs sortis" : libère les places des sacs entièrement consommés par le batch et
-- décale les rangées. Un sac entamé garde sa place, de même qu'un sac vide encore
-- attendu par un autre batch en cours.
create or replace function sortir_sacs_batch(p_batch_id text) returns jsonb
language plpgsql as $$
declare
  ids uuid[];
  rangees text[] := '{}';
  x uuid;
  s sacs%rowtype;
  nb integer := 0;
begin
  perform _verrou_stock();

  select coalesce(array_agg(distinct (e->>'sac_id')::uuid), '{}') into ids
  from batch_lignes l, jsonb_array_elements(coalesce(l.sacs_consommes, '[]'::jsonb)) e
  where l.batch_id = p_batch_id and l.sortie_at is null and e->>'sac_id' is not null;

  -- Mémoriser la position réelle de sortie (réimpression, retour éventuel en rangée)
  update batch_lignes l set
    sortie_at = now(),
    sacs_consommes = coalesce((
      select jsonb_agg(
        case when sx.rangee is not null
          then e || jsonb_build_object('rangee', sx.rangee, 'place', sx.place, 'niveau', sx.niveau, 'taille', sx.taille)
          else e end order by ord)
      from jsonb_array_elements(coalesce(l.sacs_consommes, '[]'::jsonb)) with ordinality as t(e, ord)
      left join sacs sx on sx.id::text = e->>'sac_id'
    ), '[]'::jsonb)
  where l.batch_id = p_batch_id and l.sortie_at is null;

  foreach x in array ids loop
    select * into s from sacs where id = x;
    if not found or s.rangee is null or coalesce(s.masse_kg, 0) > 0 then continue; end if;
    if exists (
      select 1 from batch_lignes l
      join batches b on b.id = l.batch_id and b.statut = 'en_cours'
      cross join jsonb_array_elements(coalesce(l.sacs_consommes, '[]'::jsonb)) e
      where l.batch_id <> p_batch_id and l.sortie_at is null and e->>'sac_id' = x::text
    ) then continue; end if;
    if not (s.rangee = any(rangees)) then rangees := rangees || s.rangee; end if;
    perform _retirer(x);
    nb := nb + 1;
  end loop;

  return jsonb_build_object('sortis', nb, 'rangees', to_jsonb(rangees));
end $$;

-- Supprimer un sac de la base libère aussi sa place
create or replace function _sacs_apres_suppression() returns trigger
language plpgsql as $$
begin
  if old.rangee is not null then
    perform _verrou_stock();
    perform _compacter_rangee(old.rangee);
  end if;
  return old;
end $$;
drop trigger if exists sacs_apres_suppression on sacs;
create trigger sacs_apres_suppression after delete on sacs
  for each row execute function _sacs_apres_suppression();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. PRÉLÈVEMENTS SÉCURISÉS (un sac ne peut plus être pris deux fois)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function _inserer_lignes(p_batch_id text, p_lignes jsonb) returns void
language plpgsql as $$
declare l jsonb;
begin
  for l in select * from jsonb_array_elements(p_lignes) loop
    insert into batch_lignes (batch_id, mp_id, masse_totale_kg, sacs_kg, ordre, sacs_consommes, composition_snapshot)
    values (
      p_batch_id,
      l->>'mp_id',
      (l->>'masse_totale_kg')::numeric,
      coalesce((select array_agg(value::numeric) from jsonb_array_elements_text(l->'sacs_kg')), '{}'),
      coalesce((l->>'ordre')::int, 0),
      coalesce(l->'sacs_consommes', '[]'::jsonb),
      case when (l ? 'composition_snapshot') and (l->'composition_snapshot') <> 'null'::jsonb
           then l->'composition_snapshot' else null end
    );
  end loop;
end $$;

-- masse_lue = masse affichée à l'écran au moment du choix. Si le sac a changé depuis
-- (pris ou modifié par quelqu'un d'autre), tout est annulé.
create or replace function _prelever_sacs(p_sacs jsonb) returns void
language plpgsql as $$
declare
  x jsonb;
  s sacs%rowtype;
begin
  for x in select * from jsonb_array_elements(p_sacs) loop
    select * into s from sacs where id = (x->>'id')::uuid for update;
    if not found then raise exception 'Un des sacs choisis n''existe plus. Rechargez la page.'; end if;
    if x->>'masse_lue' is not null and abs(coalesce(s.masse_kg, 0) - (x->>'masse_lue')::numeric) > 0.01 then
      raise exception 'Le sac "%" a été utilisé ou modifié entre-temps (% kg restants au lieu de % kg). Rechargez la page et recommencez.',
        coalesce(s.reference, s.numero_lot_fournisseur, s.mp_id), round(coalesce(s.masse_kg, 0)), round((x->>'masse_lue')::numeric);
    end if;
    update sacs set masse_kg = (x->>'masse_kg')::numeric, statut = x->>'statut', updated_at = now() where id = s.id;
  end loop;
end $$;

create or replace function valider_batch(p_batch jsonb, p_lignes jsonb, p_sacs jsonb) returns void
language plpgsql as $$
begin
  perform _verrou_stock();
  insert into batches (id, nom, recette_id, date_creation, statut, cout_total_eur, cout_par_tonne_eur, optimiseur_params)
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
  perform _inserer_lignes(p_batch->>'id', p_lignes);
  perform _prelever_sacs(p_sacs);
end $$;

create or replace function ajouter_sacs_batch(p_batch_id text, p_lignes jsonb, p_sacs jsonb) returns void
language plpgsql as $$
begin
  perform _verrou_stock();
  perform _inserer_lignes(p_batch_id, p_lignes);
  perform _prelever_sacs(p_sacs);
end $$;

-- Remet en stock les sacs de lignes de batch (masse + statut) et les replace dans leur
-- rangée s'ils en étaient sortis. Une ligne restituée est vidée de son suivi : elle ne
-- peut pas être restituée deux fois.
create or replace function restituer_lignes(p_lignes uuid[]) returns jsonb
language plpgsql as $$
declare
  lg record;
  e jsonb;
  s sacs%rowtype;
  m numeric;
  avant numeric;
  nb integer := 0;
  manquants integer := 0;
  hors_plan integer := 0;
begin
  perform _verrou_stock();
  for lg in select id, sacs_consommes from batch_lignes where id = any(p_lignes) for update loop
    for e in select * from jsonb_array_elements(coalesce(lg.sacs_consommes, '[]'::jsonb)) loop
      if e->>'sac_id' is null then continue; end if;
      select * into s from sacs where id = (e->>'sac_id')::uuid for update;
      if not found then manquants := manquants + 1; continue; end if;
      m := round(coalesce(s.masse_kg, 0) + coalesce((e->>'masse_prise')::numeric, 0));
      avant := coalesce((e->>'masse_avant_kg')::numeric, m);
      update sacs set
        masse_kg = m,
        statut = case when m >= avant - 0.5 then coalesce(nullif(e->>'statut_avant', ''), 'disponible') else 'partiel' end,
        updated_at = now()
      where id = s.id;
      nb := nb + 1;
      if s.rangee is null and e->>'rangee' is not null then
        if not _replacer(s.id, e->>'rangee') then hors_plan := hors_plan + 1; end if;
      end if;
    end loop;
    update batch_lignes set sacs_consommes = '[]'::jsonb where id = lg.id;
  end loop;
  return jsonb_build_object('restaures', nb, 'manquants', manquants, 'hors_plan', hors_plan);
end $$;

-- Remplace le sac d'une ligne : restitue l'ancien, prélève le nouveau, en une seule fois
create or replace function substituer_sac(p_ligne uuid, p_nouvelle jsonb, p_sac uuid, p_masse numeric) returns jsonb
language plpgsql as $$
declare
  s sacs%rowtype;
  reste numeric;
  res jsonb;
begin
  perform _verrou_stock();
  res := restituer_lignes(array[p_ligne]);
  select * into s from sacs where id = p_sac for update; -- après restitution (même sac possible)
  if not found then raise exception 'Sac de remplacement introuvable.'; end if;
  if p_masse > coalesce(s.masse_kg, 0) + 0.5 then
    raise exception 'Le sac de remplacement ne contient que % kg.', round(coalesce(s.masse_kg, 0));
  end if;
  reste := greatest(0, round(s.masse_kg - p_masse));
  update batch_lignes set
    mp_id = p_nouvelle->>'mp_id',
    masse_totale_kg = p_masse,
    sacs_kg = array[p_masse],
    sacs_consommes = jsonb_build_array(
      (p_nouvelle->'sacs_consommes'->0) || jsonb_build_object(
        'masse_prise', p_masse, 'masse_avant_kg', s.masse_kg, 'statut_avant', s.statut,
        'rangee', s.rangee, 'place', s.place, 'niveau', s.niveau, 'taille', s.taille)),
    composition_snapshot = case when (p_nouvelle->'composition_snapshot') <> 'null'::jsonb then p_nouvelle->'composition_snapshot' else null end,
    sortie_at = null
  where id = p_ligne;
  update sacs set masse_kg = reste, statut = case when reste > 0 then 'partiel' else 'consomme' end, updated_at = now() where id = s.id;
  return res;
end $$;

-- Corrige la masse d'une ligne et répercute l'écart sur son sac.
--   mode 'ecart' = écart de pesée : rien n'est restitué, le poids réel du sac est corrigé
create or replace function ajuster_masse_ligne(p_ligne uuid, p_masse numeric, p_mode text default null) returns jsonb
language plpgsql as $$
declare
  lg record;
  e jsonb;
  s sacs%rowtype;
  delta numeric;
  avant numeric;
  m numeric;
  hors_plan boolean := false;
begin
  perform _verrou_stock();
  if p_masse is null or p_masse <= 0 then raise exception 'Masse invalide.'; end if;
  select * into lg from batch_lignes where id = p_ligne for update;
  if not found then raise exception 'Ligne introuvable. Rechargez la page.'; end if;
  delta := p_masse - lg.masse_totale_kg;

  if jsonb_array_length(coalesce(lg.sacs_consommes, '[]'::jsonb)) = 1 and lg.sacs_consommes->0->>'sac_id' is not null then
    e := lg.sacs_consommes->0;
    select * into s from sacs where id = (e->>'sac_id')::uuid for update;
    if found then
      avant := coalesce((e->>'masse_avant_kg')::numeric, p_masse);
      if delta > 0 then
        if s.masse_kg - delta < -0.5 then
          raise exception 'Impossible : il faudrait prélever % kg de plus, mais le sac ne contient que % kg disponibles.', round(delta), round(s.masse_kg);
        end if;
        m := greatest(0, round(s.masse_kg - delta));
      elsif p_mode = 'ecart' then
        m := greatest(0, round(s.masse_kg));
        avant := greatest(0, round(coalesce((e->>'masse_avant_kg')::numeric, lg.masse_totale_kg) + delta));
        e := e || jsonb_build_object('masse_avant_kg', avant);
      else
        m := greatest(0, round(s.masse_kg - delta));
      end if;
      update sacs set masse_kg = m,
        statut = case when m <= 0 then 'consomme'
                      when m >= avant - 0.5 then coalesce(nullif(e->>'statut_avant', ''), 'disponible')
                      else 'partiel' end,
        updated_at = now()
      where id = s.id;
      if m > 0 and s.rangee is null and e->>'rangee' is not null and lg.sortie_at is not null then
        hors_plan := not _replacer(s.id, e->>'rangee');      -- le sac n'était pas vide : il revient en rangée
      elsif m <= 0 and s.rangee is not null then
        update batch_lignes set sortie_at = null where id = p_ligne; -- sac fini : sortie à confirmer
      end if;
    end if;
    e := e || jsonb_build_object('masse_prise', p_masse);
    update batch_lignes set masse_totale_kg = p_masse, sacs_kg = array[p_masse], sacs_consommes = jsonb_build_array(e) where id = p_ligne;
  else
    update batch_lignes set masse_totale_kg = p_masse, sacs_kg = array[p_masse] where id = p_ligne;
  end if;
  return jsonb_build_object('hors_plan', hors_plan);
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. CORRECTION DES RESTES DE BATCH DÉJÀ CRÉÉS
-- ═══════════════════════════════════════════════════════════════════════════
-- Les restes/récupérations de batchs contenant du sable avaient des polymères
-- surévalués (total > 100%). On les ramène à la part plastique, sur la fiche MP, les
-- sacs à composition spécifique et les lignes de batch qui les ont utilisés.
-- Les valeurs d'origine sont conservées dans correction_restes_v12.
create table if not exists correction_restes_v12 (
  id bigint generated always as identity primary key,
  origine text, ref_id text, avant jsonb, apres jsonb, corrige_le timestamptz default now()
);
alter table correction_restes_v12 enable row level security;

create or replace function _normaliser_reste(c jsonb) returns jsonb
language plpgsql immutable as $$
declare
  k text;
  poly numeric := 0;
  np numeric;
  f numeric;
  r jsonb := c;
begin
  foreach k in array array['pct_pp','pct_pe','pct_alu','pct_autres','pct_autres_plastiques'] loop
    poly := poly + coalesce((c->>k)::numeric, 0);
  end loop;
  np := coalesce((c->>'pct_sable')::numeric, 0) + coalesce((c->>'pct_charge_minerale')::numeric, 0);
  -- Signature exacte de l'erreur : polymères à 100% alors qu'il y a du sable/minéral
  if np <= 0 or np >= 100 or poly < 99 or poly + np <= 100.5 then return c; end if;
  f := (100 - np) / poly;
  foreach k in array array['pct_pp','pct_pe','pct_alu','pct_autres','pct_autres_plastiques'] loop
    if c ? k then r := r || jsonb_build_object(k, round(coalesce((c->>k)::numeric, 0) * f, 2)); end if;
  end loop;
  return r;
end $$;

with cible as (
  select id, to_jsonb(m) as avant, _normaliser_reste(to_jsonb(m)) as apres
  from matieres_premieres m where id like 'MP\_%'
), maj as (
  update matieres_premieres m set
    pct_pp = (c.apres->>'pct_pp')::numeric,
    pct_pe = (c.apres->>'pct_pe')::numeric,
    pct_alu = (c.apres->>'pct_alu')::numeric,
    pct_autres = (c.apres->>'pct_autres')::numeric,
    pct_autres_plastiques = (c.apres->>'pct_autres_plastiques')::numeric
  from cible c where m.id = c.id and c.avant <> c.apres
  returning m.id, c.avant, c.apres
)
insert into correction_restes_v12 (origine, ref_id, avant, apres) select 'matieres_premieres', id, avant, apres from maj;

with cible as (
  select id, composition_override as avant, _normaliser_reste(composition_override) as apres
  from sacs where mp_id like 'MP\_%' and composition_override is not null
), maj as (
  update sacs s set composition_override = c.apres from cible c
  where s.id = c.id and c.avant <> c.apres returning s.id, c.avant, c.apres
)
insert into correction_restes_v12 (origine, ref_id, avant, apres) select 'sacs', id::text, avant, apres from maj;

with cible as (
  select id, composition_snapshot as avant, _normaliser_reste(composition_snapshot) as apres
  from batch_lignes where mp_id like 'MP\_%' and composition_snapshot is not null
), maj as (
  update batch_lignes l set composition_snapshot = c.apres from cible c
  where l.id = c.id and c.avant <> c.apres returning l.id, c.avant, c.apres
)
insert into correction_restes_v12 (origine, ref_id, avant, apres) select 'batch_lignes', id::text, avant, apres from maj;

notify pgrst, 'reload schema';

-- Contrôle : attendu 4 colonnes, 1 colonne, 9 fonctions, puis le nombre de restes corrigés
select
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'sacs' and column_name in ('taille','rangee','place','niveau')) as colonnes_sacs,
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'batch_lignes' and column_name = 'sortie_at') as colonne_lignes,
  (select count(distinct proname) from pg_proc where proname in ('capacite_rangee','placer_sac','retirer_du_plan','sortir_sacs_batch','valider_batch','ajouter_sacs_batch','restituer_lignes','substituer_sac','ajuster_masse_ligne')) as fonctions,
  (select count(*) from correction_restes_v12 where origine = 'matieres_premieres') as fiches_mp_corrigees,
  (select count(*) from correction_restes_v12) as total_corrections;
