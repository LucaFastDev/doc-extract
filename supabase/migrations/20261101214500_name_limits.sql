-- Issue #69 (ARCHITECTURE.md section 4.2): a workspace name and a display name are at most 100
-- characters. No production database has data yet, so plain checks, with no backfill.

alter table public.workspaces
  add constraint workspaces_name_length check (char_length(name) <= 100);

-- A null display name passes the check, so the column stays nullable.
alter table public.profiles
  add constraint profiles_display_name_length check (char_length(display_name) <= 100);

-- create_workspace ----------------------------------------------------------------------------

-- As milestone 2, except that a name over 100 characters after the trim gets its own message, not
-- the check's. Security definer, search path empty, signed-in users only, as before.
create or replace function public.create_workspace(name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  trimmed text := btrim(create_workspace.name);
  ws uuid;
begin
  if caller is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if trimmed is null or trimmed = '' then
    raise exception 'a workspace needs a name' using errcode = '22023';
  end if;
  if char_length(trimmed) > 100 then
    raise exception 'a workspace name can have at most 100 characters' using errcode = '22023';
  end if;

  insert into public.workspaces (name, created_by) values (trimmed, caller) returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, caller, 'owner');
  return ws;
end;
$$;

revoke execute on function public.create_workspace(text) from public, anon, authenticated, service_role;
grant execute on function public.create_workspace(text) to authenticated;

-- handle_new_user -----------------------------------------------------------------------------

-- As milestone 2, except that the display name is trimmed and cut to its first 100 characters, so
-- the check above can never fail a sign-up. Security definer, search path empty, no grant, as
-- before; create or replace keeps the trigger on auth.users.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid;
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    left(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')), 100)
  );

  insert into public.workspaces (name, created_by) values ('Personal', new.id) returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, new.id, 'owner');
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated, service_role;
