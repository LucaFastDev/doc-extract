-- Milestone 2 (ARCHITECTURE.md sections 4.1 and 4.2): profiles, workspaces and their members, the
-- membership helpers RLS uses, create_workspace(), and the sign-up trigger that gives every new
-- user a profile and a personal workspace they own (OQ-17).

-- Tables --------------------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text,
  created_at timestamptz default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  stripe_customer_id text unique,
  stripe_subscription_id text,
  plan_period_end timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz default now()
);

create table public.workspace_members (
  workspace_id uuid references public.workspaces (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  created_at timestamptz default now(),
  primary key (workspace_id, user_id)
);

-- The primary key serves lookups by workspace; this one serves "my workspaces".
create index workspace_members_user_id_idx on public.workspace_members (user_id);

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.workspaces from anon, authenticated;
revoke all on table public.workspace_members from anon, authenticated;

-- Membership helpers --------------------------------------------------------------------------

-- Security definer, so a policy on workspace_members can call it without recursing into that
-- table's own policy. It answers only for the caller.
create function public.is_member(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid())
  );
$$;

create function public.is_owner(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.role = 'owner'
  );
$$;

revoke execute on function public.is_member(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.is_owner(uuid) from public, anon, authenticated, service_role;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.is_owner(uuid) to authenticated;

-- Policies and grants -------------------------------------------------------------------------

-- profiles: a user reads their own row and those of people they share a workspace with, and
-- changes only their own display_name.
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1 from public.workspace_members m
      where m.user_id = profiles.id and public.is_member(m.workspace_id)
    )
  );

create policy profiles_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

grant select on table public.profiles to authenticated;
grant update (display_name) on table public.profiles to authenticated;

-- workspaces: members read; only an owner renames (OQ-17). The plan and Stripe columns are written
-- only with the service role (milestone 9); creation is create_workspace() or the sign-up trigger.
create policy workspaces_select on public.workspaces
  for select to authenticated
  using (public.is_member(id));

create policy workspaces_update on public.workspaces
  for update to authenticated
  using (public.is_owner(id))
  with check (public.is_owner(id));

grant select on table public.workspaces to authenticated;
grant update (name) on table public.workspaces to authenticated;

-- workspace_members: members read; every change goes through an RPC (milestone 3).
create policy workspace_members_select on public.workspace_members
  for select to authenticated
  using (public.is_member(workspace_id));

grant select on table public.workspace_members to authenticated;

-- create_workspace ----------------------------------------------------------------------------

-- Security definer, because clients cannot insert into workspaces or workspace_members. The
-- caller becomes the only member, as owner.
create function public.create_workspace(name text)
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

  insert into public.workspaces (name, created_by) values (trimmed, caller) returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, caller, 'owner');
  return ws;
end;
$$;

revoke execute on function public.create_workspace(text) from public, anon, authenticated, service_role;
grant execute on function public.create_workspace(text) to authenticated;

-- handle_new_user -----------------------------------------------------------------------------

-- Runs as Auth's own role, which has no grant on these tables, so it is security definer. The
-- display name is the one Google sends (full_name, or name); the personal workspace is the user's
-- first, and they own it (OQ-17).
create function public.handle_new_user()
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
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  );

  insert into public.workspaces (name, created_by) values ('Personal', new.id) returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, new.id, 'owner');
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated, service_role;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
