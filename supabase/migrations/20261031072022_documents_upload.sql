-- Milestone 4 (ARCHITECTURE.md sections 4.1, 4.2, 4.3, 5 and 7): documents, the page allowances
-- and the plans, the private documents bucket, and the functions upload uses. A document is
-- created by create_document(), uploaded by the browser to the path it returns, and submitted to
-- the submit-document Edge Function, which counts its pages and calls reserve_pages() with the
-- service role (OQ-2, OQ-3, OQ-4).

-- Tables ----------------------------------------------------------------------------------------

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces (id) on delete cascade,
  uploaded_by uuid references public.profiles (id) on delete set null,
  doc_type text check (
    doc_type in ('invoice', 'receipt', 'bank_statement', 'purchase_order', 'delivery_note', 'quote')
  ),
  doc_type_source text check (doc_type_source in ('detected', 'user')),
  status text check (
    status in (
      'uploading', 'queued', 'waiting_budget', 'processing', 'needs_review', 'approved', 'failed',
      'unsupported', 'rejected'
    )
  ),
  status_reason text,
  file_name text,
  mime_type text,
  byte_size bigint,
  page_count int,
  sha256 text,
  storage_path text,
  attempts int default 0,
  pages_reserved boolean default false,
  processing_started_at timestamptz,
  duplicate_of uuid references public.documents (id) on delete set null,
  created_at timestamptz default now(),
  processed_at timestamptz,
  approved_at timestamptz,
  file_deleted_at timestamptz,
  approved_by uuid references public.profiles (id) on delete set null
);

create index documents_workspace_id_created_at_idx on public.documents (workspace_id, created_at desc);
create index documents_workspace_id_sha256_idx on public.documents (workspace_id, sha256);

-- Pages per workspace per calendar month (UTC), and per account for its lifetime (OQ-2, OQ-3).
create table public.page_usage (
  workspace_id uuid references public.workspaces (id) on delete cascade,
  period_start date,
  pages_used int not null default 0,
  primary key (workspace_id, period_start)
);

create table public.account_page_usage (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  pages_used int not null default 0
);

create table public.plan_limits (
  plan text primary key check (plan in ('free', 'pro')),
  pages_per_period int,
  monthly_price_usd numeric(6, 2)
);

insert into public.plan_limits (plan, pages_per_period, monthly_price_usd)
values ('free', 20, 0), ('pro', 500, 19.00);

alter table public.documents enable row level security;
alter table public.page_usage enable row level security;
alter table public.account_page_usage enable row level security;
alter table public.plan_limits enable row level security;

revoke all on table public.documents from anon, authenticated;
revoke all on table public.page_usage from anon, authenticated;
revoke all on table public.account_page_usage from anon, authenticated;
revoke all on table public.plan_limits from anon, authenticated;

-- Policies and grants ---------------------------------------------------------------------------

-- documents: members read. Rows are inserted only by create_document(); every later change is made
-- by Edge Functions with the service role, or by the RPCs of later milestones.
create policy documents_select on public.documents
  for select to authenticated
  using (public.is_member(workspace_id));

grant select on table public.documents to authenticated;

-- page_usage and account_page_usage: read by the workspace's members and by the account itself;
-- written only by reserve_pages() (and release_pages(), milestone 5).
create policy page_usage_select on public.page_usage
  for select to authenticated
  using (public.is_member(workspace_id));

create policy account_page_usage_select on public.account_page_usage
  for select to authenticated
  using (user_id = (select auth.uid()));

grant select on table public.page_usage to authenticated;
grant select on table public.account_page_usage to authenticated;

-- plan_limits: no policies and no client grants; clients read it through get_plan_limits().

-- Realtime (section 4.3): the document list follows status changes; Realtime applies the select
-- policy above, so a client receives only its workspaces' rows.
alter publication supabase_realtime add table public.documents;

-- account_page_cap ------------------------------------------------------------------------------

-- The account lifetime cap (OQ-2). It stands in for app_config.account_page_cap, which arrives with
-- milestone 5; that milestone replaces this body with a read of app_config. Security invoker:
-- reserve_pages() calls it as the service role, get_page_allowance() as its owner.
create function public.account_page_cap()
returns int
language sql
stable
security invoker
set search_path = ''
as $$
  select 10;
$$;

revoke execute on function public.account_page_cap() from public, anon, authenticated, service_role;
grant execute on function public.account_page_cap() to service_role;

-- get_plan_limits -------------------------------------------------------------------------------

-- Security definer, because plan_limits has no client grants. anon too: the landing page shows the
-- plans to visitors who are not signed in (OQ-27).
create function public.get_plan_limits()
returns table (plan text, pages_per_period int, monthly_price_usd numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select l.plan, l.pages_per_period, l.monthly_price_usd from public.plan_limits l order by l.pages_per_period;
$$;

revoke execute on function public.get_plan_limits() from public, anon, authenticated, service_role;
grant execute on function public.get_plan_limits() to anon, authenticated;

-- get_page_allowance ----------------------------------------------------------------------------

-- Security definer, because it reads plan_limits and the cap, which clients cannot. Only a member
-- asks, and learns the workspace's pages this month and their own account's.
create function public.get_page_allowance(ws uuid)
returns table (workspace_used int, workspace_limit int, account_used int, account_cap int)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not public.is_member(get_page_allowance.ws) then
    raise exception 'not a member of this workspace' using errcode = '42501';
  end if;

  return query
  select
    coalesce((
      select u.pages_used from public.page_usage u
      where u.workspace_id = get_page_allowance.ws
        and u.period_start = date_trunc('month', now() at time zone 'utc')::date
    ), 0),
    (select l.pages_per_period from public.plan_limits l join public.workspaces w on w.plan = l.plan
     where w.id = get_page_allowance.ws),
    coalesce((select a.pages_used from public.account_page_usage a where a.user_id = caller), 0),
    public.account_page_cap();
end;
$$;

revoke execute on function public.get_page_allowance(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_page_allowance(uuid) to authenticated;

-- create_document -------------------------------------------------------------------------------

-- Security definer, because documents has no client insert. A member creates a document of an
-- accepted type and size (OQ-4); it starts uploading, at the storage path the bucket's insert
-- policy expects.
create function public.create_document(ws uuid, file_name text, mime_type text, byte_size bigint)
returns table (id uuid, storage_path text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  trimmed text := btrim(create_document.file_name);
  doc uuid := gen_random_uuid();
  path text := create_document.ws::text || '/' || doc::text || '/original';
begin
  if caller is null or not public.is_member(create_document.ws) then
    raise exception 'not a member of this workspace' using errcode = '42501';
  end if;
  if create_document.mime_type is null
    or create_document.mime_type not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') then
    raise exception 'only PDF, JPEG, PNG and WebP files are accepted' using errcode = '22023';
  end if;
  if create_document.byte_size is null or create_document.byte_size < 1
    or create_document.byte_size > 10 * 1024 * 1024 then
    raise exception 'a file must be at most 10 MB' using errcode = '22023';
  end if;
  if trimmed is null or trimmed = '' then
    raise exception 'a document needs a file name' using errcode = '22023';
  end if;

  insert into public.documents (id, workspace_id, uploaded_by, status, file_name, mime_type, byte_size, storage_path)
  values (doc, create_document.ws, caller, 'uploading', trimmed, create_document.mime_type, create_document.byte_size, path);
  return query select doc, path;
end;
$$;

revoke execute on function public.create_document(uuid, text, text, bigint) from public, anon, authenticated, service_role;
grant execute on function public.create_document(uuid, text, text, bigint) to authenticated;

-- reserve_pages ---------------------------------------------------------------------------------

-- Security invoker: only the service role calls it (submit-document), and it bypasses RLS. Locks
-- the document, then the workspace's row for this UTC month and the uploader's lifetime row, so
-- concurrent reservations cannot both pass a limit (section 7). Returns false, and counts nothing,
-- when the pages would take either over its limit. A document already reserved counts nothing
-- more.
create function public.reserve_pages(document_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  doc public.documents;
  period date := date_trunc('month', now() at time zone 'utc')::date;
  ws_limit int;
  ws_used int;
  account_used int;
begin
  select * into doc from public.documents d where d.id = reserve_pages.document_id for update;
  if not found then
    raise exception 'no such document' using errcode = 'P0002';
  end if;
  if doc.pages_reserved then
    return true;
  end if;
  if doc.page_count is null or doc.page_count < 1 then
    raise exception 'the document has no page count' using errcode = '22023';
  end if;
  if doc.uploaded_by is null then
    raise exception 'the document has no uploader' using errcode = '22023';
  end if;

  select l.pages_per_period into ws_limit
  from public.workspaces w join public.plan_limits l on l.plan = w.plan
  where w.id = doc.workspace_id;

  insert into public.page_usage (workspace_id, period_start) values (doc.workspace_id, period)
  on conflict do nothing;
  insert into public.account_page_usage (user_id) values (doc.uploaded_by)
  on conflict do nothing;

  select u.pages_used into ws_used from public.page_usage u
  where u.workspace_id = doc.workspace_id and u.period_start = period for update;
  select a.pages_used into account_used from public.account_page_usage a
  where a.user_id = doc.uploaded_by for update;

  if ws_used + doc.page_count > ws_limit or account_used + doc.page_count > public.account_page_cap() then
    return false;
  end if;

  update public.page_usage u set pages_used = u.pages_used + doc.page_count
  where u.workspace_id = doc.workspace_id and u.period_start = period;
  update public.account_page_usage a set pages_used = a.pages_used + doc.page_count
  where a.user_id = doc.uploaded_by;
  update public.documents d set pages_reserved = true where d.id = doc.id;
  return true;
end;
$$;

revoke execute on function public.reserve_pages(uuid) from public, anon, authenticated, service_role;
grant execute on function public.reserve_pages(uuid) to service_role;

-- Storage (section 5) ---------------------------------------------------------------------------

-- Private: every read goes through the select policy below or a signed URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 10 * 1024 * 1024,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

-- The first path segment is the workspace. The case guards the uuid cast, so an object in another
-- bucket, or a name that is not a workspace id, is simply not matched.
create policy documents_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and case
      when (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then public.is_member(((storage.foldername(name))[1])::uuid)
          and exists (
            select 1 from public.documents d
            where d.workspace_id = ((storage.foldername(name))[1])::uuid
              and d.storage_path = objects.name
              and d.status = 'uploading'
          )
      else false
    end
  );

create policy documents_objects_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and case
      when (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then public.is_member(((storage.foldername(name))[1])::uuid)
      else false
    end
  );

-- No update and no delete policy: objects are removed only through the Storage API with the
-- service role (sections 6.2 and 8).
