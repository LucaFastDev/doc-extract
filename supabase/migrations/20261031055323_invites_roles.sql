-- Milestone 3 (ARCHITECTURE.md sections 4.1 and 4.2): copy-link invitations and roles. An owner
-- invites an email address as owner or member and copies the link once; the invited person accepts
-- it signed in with that address, within 7 days, once (OQ-18, OQ-19). Owners revoke invitations,
-- remove members and change roles, and a workspace always keeps one owner (OQ-20).

-- gen_random_bytes() for the tokens. Supabase installs it in extensions already.
create extension if not exists pgcrypto with schema extensions;

-- Table -----------------------------------------------------------------------------------------

create table public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces (id) on delete cascade,
  email text not null check (email = lower(email)),
  role text check (role in ('owner', 'member')),
  token_hash text not null unique,
  invited_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz
);

create index workspace_invites_workspace_id_idx on public.workspace_invites (workspace_id);

alter table public.workspace_invites enable row level security;

revoke all on table public.workspace_invites from anon, authenticated;

-- An owner reads their workspace's invitations and revokes a pending one, which sets revoked_at and
-- nothing else (column grant). Once revoked or accepted, a row cannot be changed back. Rows are
-- inserted only by create_invite(); the invitee reads nothing here, and accepts through
-- accept_invite().
create policy workspace_invites_select on public.workspace_invites
  for select to authenticated
  using (public.is_owner(workspace_id));

create policy workspace_invites_update on public.workspace_invites
  for update to authenticated
  using (public.is_owner(workspace_id) and accepted_at is null and revoked_at is null)
  with check (public.is_owner(workspace_id) and revoked_at is not null);

grant select on table public.workspace_invites to authenticated;
grant update (revoked_at) on table public.workspace_invites to authenticated;

-- create_invite ---------------------------------------------------------------------------------

-- Security definer, because clients cannot insert into workspace_invites. Only an owner invites.
-- The token is 32 random bytes, returned once for the copy-link; only its SHA-256 is stored.
create function public.create_invite(ws uuid, email text, role text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  invited text := lower(btrim(create_invite.email));
  token text;
begin
  if (select auth.uid()) is null or not public.is_owner(create_invite.ws) then
    raise exception 'only an owner of this workspace can invite' using errcode = '42501';
  end if;
  if create_invite.role is null or create_invite.role not in ('owner', 'member') then
    raise exception 'the role must be owner or member' using errcode = '22023';
  end if;
  if invited is null or invited !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'enter an email address' using errcode = '22023';
  end if;

  token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.workspace_invites (workspace_id, email, role, token_hash, invited_by, expires_at)
  values (
    create_invite.ws,
    invited,
    create_invite.role,
    encode(sha256(convert_to(token, 'UTF8')), 'hex'),
    (select auth.uid()),
    now() + interval '7 days'
  );
  return token;
end;
$$;

revoke execute on function public.create_invite(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.create_invite(uuid, text, text) to authenticated;

-- accept_invite ---------------------------------------------------------------------------------

-- Security definer, because the invitee can neither read workspace_invites nor insert into
-- workspace_members. The invitation must match the caller's verified email, and be neither
-- accepted, revoked nor expired; the row is locked, so it is accepted only once. Someone who is
-- already a member is refused, so an invitation never changes an existing role.
create function public.accept_invite(token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_email text := lower((select auth.jwt()) ->> 'email');
  invite public.workspace_invites;
begin
  if caller is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select * into invite from public.workspace_invites i
  where i.token_hash = encode(sha256(convert_to(coalesce(accept_invite.token, ''), 'UTF8')), 'hex')
  for update;
  if not found then
    raise exception 'this invitation is not valid' using errcode = 'P0002';
  end if;
  if caller_email is null or invite.email <> caller_email then
    raise exception 'this invitation is for another email address' using errcode = '42501';
  end if;
  if invite.accepted_at is not null or invite.revoked_at is not null or invite.expires_at <= now() then
    raise exception 'this invitation is no longer valid' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.workspace_members m where m.workspace_id = invite.workspace_id and m.user_id = caller
  ) then
    raise exception 'already a member of this workspace' using errcode = '23505';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (invite.workspace_id, caller, invite.role);
  update public.workspace_invites set accepted_at = now() where id = invite.id;
  return invite.workspace_id;
end;
$$;

revoke execute on function public.accept_invite(text) from public, anon, authenticated, service_role;
grant execute on function public.accept_invite(text) to authenticated;

-- remove_member and set_member_role -------------------------------------------------------------

-- Security definer, because workspace_members has no client delete or update. Only an owner calls
-- them. Each first locks the workspace row, so changes to one workspace's members run one at a time
-- and two owners cannot remove or demote each other at once and leave it without an owner.

create function public.remove_member(ws uuid, member uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_role text;
begin
  perform 1 from public.workspaces w where w.id = remove_member.ws for update;
  if (select auth.uid()) is null or not public.is_owner(remove_member.ws) then
    raise exception 'only an owner of this workspace can remove members' using errcode = '42501';
  end if;

  select m.role into target_role from public.workspace_members m
  where m.workspace_id = remove_member.ws and m.user_id = remove_member.member;
  if not found then
    raise exception 'not a member of this workspace' using errcode = 'P0002';
  end if;
  if target_role = 'owner' and (
    select count(*) from public.workspace_members m where m.workspace_id = remove_member.ws and m.role = 'owner'
  ) = 1 then
    raise exception 'a workspace needs at least one owner' using errcode = '23514';
  end if;

  delete from public.workspace_members m
  where m.workspace_id = remove_member.ws and m.user_id = remove_member.member;
end;
$$;

revoke execute on function public.remove_member(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.remove_member(uuid, uuid) to authenticated;

create function public.set_member_role(ws uuid, member uuid, role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_role text;
begin
  perform 1 from public.workspaces w where w.id = set_member_role.ws for update;
  if (select auth.uid()) is null or not public.is_owner(set_member_role.ws) then
    raise exception 'only an owner of this workspace can change roles' using errcode = '42501';
  end if;
  if set_member_role.role is null or set_member_role.role not in ('owner', 'member') then
    raise exception 'the role must be owner or member' using errcode = '22023';
  end if;

  select m.role into target_role from public.workspace_members m
  where m.workspace_id = set_member_role.ws and m.user_id = set_member_role.member;
  if not found then
    raise exception 'not a member of this workspace' using errcode = 'P0002';
  end if;
  if target_role = 'owner' and set_member_role.role = 'member' and (
    select count(*) from public.workspace_members m where m.workspace_id = set_member_role.ws and m.role = 'owner'
  ) = 1 then
    raise exception 'a workspace needs at least one owner' using errcode = '23514';
  end if;

  update public.workspace_members m set role = set_member_role.role
  where m.workspace_id = set_member_role.ws and m.user_id = set_member_role.member;
end;
$$;

revoke execute on function public.set_member_role(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;
