create schema if not exists extensions;

create extension if not exists pgcrypto with schema extensions;

alter extension pgcrypto set schema extensions;

create schema if not exists api;

grant usage on schema api to anon, authenticated, service_role;

alter default privileges in schema api revoke execute on functions from public;
alter default privileges in schema api revoke execute on functions from anon, authenticated;

do $$
begin
  if to_regclass('public.rooms') is not null and to_regclass('api.rooms') is null then
    alter table public.rooms set schema api;
  end if;

  if to_regclass('public.yaml_entries') is not null and to_regclass('api.yaml_entries') is null then
    alter table public.yaml_entries set schema api;
  end if;

  if to_regclass('public.user_profiles') is not null and to_regclass('api.user_profiles') is null then
    alter table public.user_profiles set schema api;
  end if;
end $$;

create table if not exists api.rooms (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{4,64}$'),
  name text not null default '' check (char_length(name) <= 80),
  description text not null default '',
  closes_at timestamptz not null default timezone('utc', now()) + interval '30 days',
  yaml_limit integer,
  require_discord_username boolean not null default false,
  admin_token_hash text not null check (char_length(admin_token_hash) = 64),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists api.yaml_entries (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references api.rooms(id) on delete cascade,
  room_slug text not null references api.rooms(slug) on delete cascade,
  submission_id uuid not null default gen_random_uuid(),
  document_index integer not null default 1,
  player_name text,
  game_name text,
  discord_username text not null default '' check (
    char_length(discord_username) <= 64
    and discord_username !~ '[[:cntrl:]]'
  ),
  label text not null check (char_length(label) between 1 and 120),
  original_filename text,
  content text not null check (char_length(content) between 1 and 1000000),
  uploader_token_hash text not null check (char_length(uploader_token_hash) = 64),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists api.user_profiles (
  uploader_token_hash text primary key check (char_length(uploader_token_hash) = 64),
  discord_username text not null default '' check (
    char_length(discord_username) <= 64
    and discord_username !~ '[[:cntrl:]]'
  ),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table api.rooms
  add column if not exists description text;

alter table api.rooms
  add column if not exists closes_at timestamptz;

alter table api.rooms
  add column if not exists yaml_limit integer;

alter table api.rooms
  add column if not exists require_discord_username boolean;

update api.rooms
set require_discord_username = false
where require_discord_username is null;

alter table api.rooms
  alter column require_discord_username set default false;

alter table api.rooms
  alter column require_discord_username set not null;

update api.rooms
set description = coalesce(description, '')
where description is null;

alter table api.rooms
  alter column description set default '';

alter table api.rooms
  alter column description set not null;

update api.rooms
set closes_at = coalesce(closes_at, created_at, timezone('utc', now())) + interval '30 days'
where closes_at is null;

alter table api.rooms
  alter column closes_at set not null;

alter table api.rooms
  alter column closes_at set default timezone('utc', now()) + interval '30 days';

alter table api.rooms
  drop constraint if exists rooms_yaml_limit_check;

alter table api.rooms
  add constraint rooms_yaml_limit_check check (yaml_limit is null or yaml_limit > 0);

alter table api.yaml_entries
  add column if not exists player_name text;

alter table api.yaml_entries
  add column if not exists game_name text;

alter table api.yaml_entries
  add column if not exists discord_username text;

update api.yaml_entries
set discord_username = ''
where discord_username is null;

alter table api.yaml_entries
  alter column discord_username set default '';

alter table api.yaml_entries
  alter column discord_username set not null;

alter table api.yaml_entries
  drop constraint if exists yaml_entries_discord_username_check;

alter table api.yaml_entries
  add constraint yaml_entries_discord_username_check check (
    char_length(discord_username) <= 64
    and discord_username !~ '[[:cntrl:]]'
  );

alter table api.yaml_entries
  add column if not exists submission_id uuid;

alter table api.yaml_entries
  add column if not exists document_index integer;

alter table api.yaml_entries
  alter column submission_id set default gen_random_uuid();

alter table api.yaml_entries
  alter column document_index set default 1;

update api.yaml_entries
set submission_id = coalesce(submission_id, gen_random_uuid()),
    document_index = coalesce(document_index, 1)
where submission_id is null
   or document_index is null;

alter table api.yaml_entries
  alter column submission_id set not null;

alter table api.yaml_entries
  alter column document_index set not null;

alter table api.yaml_entries
  drop constraint if exists yaml_entries_document_index_check;

alter table api.yaml_entries
  add constraint yaml_entries_document_index_check check (document_index >= 1);

create index if not exists rooms_closes_at_idx
  on api.rooms (closes_at);

create index if not exists yaml_entries_room_slug_created_at_idx
  on api.yaml_entries (room_slug, created_at);

create index if not exists yaml_entries_room_slug_uploader_created_at_idx
  on api.yaml_entries (room_slug, uploader_token_hash, created_at, document_index);

create index if not exists user_profiles_discord_username_idx
  on api.user_profiles (discord_username)
  where discord_username <> '';

drop index if exists api.yaml_entries_room_player_name_unique_idx;

create unique index if not exists yaml_entries_room_player_name_unique_idx
  on api.yaml_entries (room_id, lower(player_name))
  where player_name is not null
    and player_name !~ '\{(player|PLAYER|number|NUMBER)\}';

alter table api.rooms enable row level security;
alter table api.yaml_entries enable row level security;
alter table api.user_profiles enable row level security;

drop policy if exists "rooms_public_select" on api.rooms;
create policy "rooms_public_select"
  on api.rooms
  for select
  to anon, authenticated
  using (true);

drop policy if exists "yaml_entries_public_select" on api.yaml_entries;
create policy "yaml_entries_public_select"
  on api.yaml_entries
  for select
  to anon, authenticated
  using (true);

drop policy if exists "user_profiles_public_select" on api.user_profiles;
create policy "user_profiles_public_select"
  on api.user_profiles
  for select
  to anon, authenticated
  using (true);

drop function if exists public.create_room(text, text, text);
drop function if exists public.upload_yaml(text, text, text, text, text);
drop function if exists public.upload_yaml(text, text, text, text, text, uuid, integer);
drop function if exists public.delete_yaml(uuid, text, text);
drop function if exists public.upsert_user_profile(text, text);

drop function if exists api.create_room(text, text, text);
drop function if exists api.create_room(text, text, text, timestamptz, integer, text);
drop function if exists api.create_room(text, text, text, timestamptz, integer, boolean, text);
drop function if exists api.upload_yaml(text, text, text, text, text, uuid, integer);
drop function if exists api.upload_yaml_batch(text, text, text, jsonb);
drop function if exists api.update_room_meta(text, text, timestamptz, text);
drop function if exists api.update_room_meta(text, text, timestamptz, boolean, text);
drop function if exists api.delete_room(text, text);
drop function if exists api.delete_yaml(uuid, text, text);
drop function if exists api.upsert_user_profile(text, text);

create or replace function api.extract_root_scalar(
  p_content text,
  p_key text
)
returns text
language sql
immutable
set search_path = ''
as $$
  with match_row as (
    select regexp_match(
      replace(coalesce(p_content, ''), E'\r\n', E'\n'),
      '(?m)^' || regexp_replace(p_key, '([][(){}.*+?^$|\\-])', '\\\1', 'g') || ':\s*(.+?)\s*$'
    ) as captures
  )
  select case
    when captures is null then null
    else nullif(
      btrim(
        regexp_replace(captures[1], '^["'']?(.*?)["'']?$', '\1'),
        ' '
      ),
      ''
    )
  end
  from match_row;
$$;

create or replace function api.has_root_game_section(
  p_content text,
  p_game_name text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with escaped as (
    select regexp_replace(coalesce(p_game_name, ''), '([][(){}.*+?^$|\\-])', '\\\1', 'g') as game_name
  )
  select replace(coalesce(p_content, ''), E'\r\n', E'\n') ~ (
    '(?m)^(?:' ||
    chr(39) || escaped.game_name || chr(39) ||
    '|"'
    || escaped.game_name ||
    '"|' || escaped.game_name || '):\s*(?:#.*)?$'
  )
  from escaped;
$$;

create or replace function api.player_name_uses_unique_placeholder(
  p_player_name text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_player_name, '') ~ '\{(player|PLAYER|number|NUMBER)\}';
$$;

create or replace function api.create_room(
  p_slug text,
  p_name text,
  p_description text,
  p_closes_at timestamptz,
  p_yaml_limit integer,
  p_require_discord_username boolean,
  p_admin_token_hash text
)
returns setof api.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text := lower(trim(p_slug));
  v_name text := left(coalesce(trim(p_name), ''), 80);
  v_description text := left(coalesce(trim(p_description), ''), 2000);
  v_room api.rooms%rowtype;
begin
  if v_slug is null or v_slug = '' or v_slug !~ '^[a-z0-9-]{4,64}$' then
    raise exception 'Invalid room code.';
  end if;

  if v_name = '' then
    raise exception 'Room name is required.';
  end if;

  if p_closes_at is null or p_closes_at <= timezone('utc', now()) then
    raise exception 'Closing date must be in the future.';
  end if;

  if p_yaml_limit is not null and p_yaml_limit <= 0 then
    raise exception 'YAML limit must be positive.';
  end if;

  if p_admin_token_hash is null or char_length(p_admin_token_hash) <> 64 then
    raise exception 'Invalid admin token hash.';
  end if;

  insert into api.rooms (
    slug,
    name,
    description,
    closes_at,
    yaml_limit,
    require_discord_username,
    admin_token_hash
  )
  values (
    v_slug,
    v_name,
    v_description,
    p_closes_at,
    p_yaml_limit,
    coalesce(p_require_discord_username, false),
    p_admin_token_hash
  )
  returning * into v_room;

  return next v_room;
end;
$$;

create or replace function api.update_room_meta(
  p_room_slug text,
  p_name text,
  p_closes_at timestamptz,
  p_require_discord_username boolean,
  p_room_admin_token_hash text
)
returns setof api.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room api.rooms%rowtype;
begin
  if p_name is null or trim(p_name) = '' then
    raise exception 'Room name is required.';
  end if;

  if p_closes_at is null then
    raise exception 'Closing date is required.';
  end if;

  if p_room_admin_token_hash is null or char_length(p_room_admin_token_hash) <> 64 then
    raise exception 'Invalid room admin token hash.';
  end if;

  update api.rooms
  set name = left(trim(p_name), 80),
      closes_at = p_closes_at,
      require_discord_username = coalesce(p_require_discord_username, false)
  where slug = lower(trim(p_room_slug))
    and admin_token_hash = p_room_admin_token_hash
  returning * into v_room;

  if not found then
    raise exception 'Room not found or not authorized.';
  end if;

  return next v_room;
end;
$$;

create or replace function api.delete_room(
  p_room_slug text,
  p_room_admin_token_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
begin
  delete from api.rooms
  where slug = lower(trim(p_room_slug))
    and admin_token_hash = p_room_admin_token_hash;

  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

create or replace function api.upload_yaml_batch(
  p_room_slug text,
  p_original_filename text,
  p_uploader_token_hash text,
  p_documents jsonb
)
returns setof api.yaml_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room api.rooms%rowtype;
  v_entry api.yaml_entries%rowtype;
  v_filename text := nullif(left(coalesce(trim(p_original_filename), ''), 240), '');
  v_existing_count integer := 0;
  v_new_count integer := 0;
  v_doc jsonb;
  v_label text;
  v_content text;
  v_document_index integer;
  v_player_name text;
  v_game_name text;
  v_discord_username text := '';
  v_submission_id uuid := gen_random_uuid();
begin
  if p_uploader_token_hash is null or char_length(p_uploader_token_hash) <> 64 then
    raise exception 'Invalid uploader token hash.';
  end if;

  if p_documents is null or jsonb_typeof(p_documents) <> 'array' then
    raise exception 'Documents payload must be an array.';
  end if;

  select *
  into v_room
  from api.rooms
  where slug = lower(trim(p_room_slug));

  if not found then
    raise exception 'Room not found.';
  end if;

  if timezone('utc', now()) >= v_room.closes_at then
    raise exception 'This room is closed.';
  end if;

  select count(*)
  into v_new_count
  from jsonb_array_elements(p_documents);

  if v_new_count = 0 then
    raise exception 'At least one YAML document is required.';
  end if;

  if v_room.yaml_limit is not null then
    select count(*)
    into v_existing_count
    from api.yaml_entries
    where room_id = v_room.id
      and uploader_token_hash = p_uploader_token_hash;

    if v_existing_count + v_new_count > v_room.yaml_limit then
      raise exception 'This room has reached the per-user YAML limit.';
    end if;
  end if;

  select coalesce(discord_username, '')
  into v_discord_username
  from api.user_profiles
  where uploader_token_hash = p_uploader_token_hash;

  v_discord_username := coalesce(v_discord_username, '');

  if v_room.require_discord_username and v_discord_username = '' then
    raise exception 'Discord username is required for this room.';
  end if;

  for v_doc in
    select value
    from jsonb_array_elements(p_documents)
  loop
    v_label := left(coalesce(trim(v_doc ->> 'label'), ''), 120);
    v_content := coalesce(v_doc ->> 'content', '');
    v_document_index := nullif(v_doc ->> 'document_index', '')::integer;
    v_player_name := api.extract_root_scalar(v_content, 'name');
    v_game_name := api.extract_root_scalar(v_content, 'game');

    if v_label = '' then
      raise exception 'Each YAML document needs a label.';
    end if;

    if v_content = '' then
      raise exception 'Each YAML document needs content.';
    end if;

    if char_length(v_content) > 1000000 then
      raise exception 'A YAML document exceeds the 1 MB limit.';
    end if;

    if v_document_index is null or v_document_index < 1 then
      raise exception 'Invalid document index.';
    end if;

    if v_player_name is null then
      raise exception 'YAML must include a root "name" field.';
    end if;

    if v_game_name is null then
      raise exception 'YAML for % must include a root "game" field.', v_player_name;
    end if;

    if not api.has_root_game_section(v_content, v_game_name) then
      raise exception 'YAML for % must include a root "%" section.', v_player_name, v_game_name;
    end if;

    if not api.player_name_uses_unique_placeholder(v_player_name) and exists (
      select 1
      from api.yaml_entries
      where room_id = v_room.id
        and not api.player_name_uses_unique_placeholder(
          coalesce(
            player_name,
            api.extract_root_scalar(content, 'name')
          )
        )
        and lower(
          coalesce(
            player_name,
            api.extract_root_scalar(content, 'name')
          )
        ) = lower(v_player_name)
    ) then
      raise exception '% is already present in this room.', v_player_name;
    end if;

    begin
      insert into api.yaml_entries (
        room_id,
        room_slug,
        submission_id,
        document_index,
        player_name,
        game_name,
        discord_username,
        label,
        original_filename,
        content,
        uploader_token_hash
      )
      values (
        v_room.id,
        v_room.slug,
        v_submission_id,
        v_document_index,
        v_player_name,
        v_game_name,
        v_discord_username,
        v_label,
        v_filename,
        v_content,
        p_uploader_token_hash
      )
      returning * into v_entry;
    exception
      when unique_violation then
        raise exception '% is already present in this room.', v_player_name;
    end;

    return next v_entry;
  end loop;
end;
$$;

create or replace function api.delete_yaml(
  p_entry_id uuid,
  p_requester_token_hash text default null,
  p_room_admin_token_hash text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
begin
  delete from api.yaml_entries as e
  using api.rooms as r
  where e.id = p_entry_id
    and r.id = e.room_id
    and timezone('utc', now()) < r.closes_at
    and (
      (p_room_admin_token_hash is not null and r.admin_token_hash = p_room_admin_token_hash)
      or
      (
        p_requester_token_hash is not null
        and e.uploader_token_hash = p_requester_token_hash
      )
    );

  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

create or replace function api.upsert_user_profile(
  p_uploader_token text,
  p_discord_username text
)
returns setof api.user_profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile api.user_profiles%rowtype;
  v_discord_username text := left(coalesce(trim(p_discord_username), ''), 64);
  v_uploader_token text := coalesce(trim(p_uploader_token), '');
  v_uploader_token_hash text;
begin
  if v_uploader_token !~ '^[a-f0-9]{48}$' then
    raise exception 'Invalid uploader token.';
  end if;

  if v_discord_username ~ '[[:cntrl:]]' then
    raise exception 'Discord username contains invalid characters.';
  end if;

  v_uploader_token_hash := encode(extensions.digest(v_uploader_token, 'sha256'), 'hex');

  insert into api.user_profiles (uploader_token_hash, discord_username, updated_at)
  values (v_uploader_token_hash, v_discord_username, timezone('utc', now()))
  on conflict (uploader_token_hash)
  do update
  set discord_username = excluded.discord_username,
      updated_at = excluded.updated_at
  returning * into v_profile;

  if v_discord_username <> '' then
    update api.yaml_entries as e
    set discord_username = v_discord_username
    from api.rooms as r
    where e.room_id = r.id
      and e.uploader_token_hash = v_uploader_token_hash
      and timezone('utc', now()) < r.closes_at;
  end if;

  return next v_profile;
end;
$$;

revoke all on all functions in schema api from public;
revoke all on all functions in schema api from anon, authenticated;

grant select on api.rooms to anon, authenticated;
grant select on api.yaml_entries to anon, authenticated;
grant select on api.user_profiles to anon, authenticated;
grant execute on function api.extract_root_scalar(text, text) to anon, authenticated;
grant execute on function api.has_root_game_section(text, text) to anon, authenticated;
grant execute on function api.player_name_uses_unique_placeholder(text) to anon, authenticated;
grant execute on function api.create_room(text, text, text, timestamptz, integer, boolean, text) to anon, authenticated;
grant execute on function api.update_room_meta(text, text, timestamptz, boolean, text) to anon, authenticated;
grant execute on function api.delete_room(text, text) to anon, authenticated;
grant execute on function api.upload_yaml_batch(text, text, text, jsonb) to anon, authenticated;
grant execute on function api.delete_yaml(uuid, text, text) to anon, authenticated;
grant execute on function api.upsert_user_profile(text, text) to anon, authenticated;
