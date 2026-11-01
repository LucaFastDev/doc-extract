-- Milestone 14 (ARCHITECTURE.md sections 4.1 and 6.2, PRD US-18.2 AC-1, issue #61 ruling 7): a
-- document whose uploader deleted their account has uploaded_by null, and whatever a member can do
-- to a document must still work on it. reserve_pages raised 'the document has no uploader', which
-- stopped retry_document and change_document_type on such a document.

-- reserve_pages ---------------------------------------------------------------------------------

-- As milestone 5, except that a document with no uploader counts against the workspace's month
-- only: there is no account left for its pages to count against, and no account row is created.
-- Security invoker, search path empty, service role only, as before.
create or replace function public.reserve_pages(document_id uuid)
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
  cap int := public.account_page_cap();
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

  select l.pages_per_period into ws_limit
  from public.workspaces w join public.plan_limits l on l.plan = w.plan
  where w.id = doc.workspace_id;

  insert into public.page_usage (workspace_id, period_start) values (doc.workspace_id, period)
  on conflict do nothing;
  select u.pages_used into ws_used from public.page_usage u
  where u.workspace_id = doc.workspace_id and u.period_start = period for update;

  if doc.uploaded_by is not null then
    insert into public.account_page_usage (user_id) values (doc.uploaded_by)
    on conflict do nothing;
    select a.pages_used into account_used from public.account_page_usage a
    where a.user_id = doc.uploaded_by for update;
  end if;

  if ws_used + doc.page_count > ws_limit
     or (doc.uploaded_by is not null and cap is not null and account_used + doc.page_count > cap) then
    return false;
  end if;

  update public.page_usage u set pages_used = u.pages_used + doc.page_count
  where u.workspace_id = doc.workspace_id and u.period_start = period;
  if doc.uploaded_by is not null then
    update public.account_page_usage a set pages_used = a.pages_used + doc.page_count
    where a.user_id = doc.uploaded_by;
  end if;
  update public.documents d set pages_reserved = true, pages_period_start = period where d.id = doc.id;
  return true;
end;
$$;

revoke execute on function public.reserve_pages(uuid) from public, anon, authenticated, service_role;
grant execute on function public.reserve_pages(uuid) to service_role;
