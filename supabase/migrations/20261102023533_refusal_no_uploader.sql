-- Issue #83: a document whose uploader deleted their account has uploaded_by null, and since
-- 20261101150000_reserve_pages_no_uploader.sql no account cap applies to it. The refusal of
-- retry_document and change_document_type still named the uploader's cap, and its number came from
-- a left join on a null user: the full cap, so a workspace with more pages left than the cap
-- reported the cap. With no uploader the refusal now gives the workspace's pages left and names
-- only them. With an uploader it does not change, nor does anything else in either function.

-- retry_document --------------------------------------------------------------------------------

create or replace function public.retry_document(document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  doc public.documents;
  ws_left int;
  account_left int;
  pages_left int;
begin
  select * into doc from public.documents d where d.id = retry_document.document_id for update;
  if caller is null or doc.id is null or not public.is_member(doc.workspace_id) then
    raise exception 'not a member of this document''s workspace' using errcode = '42501';
  end if;
  if doc.status is distinct from 'failed' then
    raise exception 'Only a failed document can be retried.' using errcode = '22023';
  end if;
  if doc.file_deleted_at is not null then
    raise exception '% cannot be retried: its file has been deleted.', doc.file_name using errcode = '22023';
  end if;

  if not public.reserve_pages(doc.id) then
    select l.pages_per_period - coalesce(u.pages_used, 0) into ws_left
    from public.workspaces w
    join public.plan_limits l on l.plan = w.plan
    left join public.page_usage u
      on u.workspace_id = w.id and u.period_start = date_trunc('month', now() at time zone 'utc')::date
    where w.id = doc.workspace_id;
    if doc.uploaded_by is null then
      pages_left := greatest(0, ws_left);
      raise exception '% has % %, but only % % of the workspace’s pages this month.',
        doc.file_name, doc.page_count, case when doc.page_count = 1 then 'page' else 'pages' end,
        pages_left, case when pages_left = 1 then 'page remains' else 'pages remain' end
        using errcode = '22023';
    end if;
    select public.account_page_cap() - coalesce(a.pages_used, 0) into account_left
    from (select 1) one left join public.account_page_usage a on a.user_id = doc.uploaded_by;
    pages_left := greatest(0, least(ws_left, coalesce(account_left, ws_left)));
    raise exception '% has % %, but only % % of the page allowance (the workspace’s pages this month and the uploader’s lifetime cap).',
      doc.file_name, doc.page_count, case when doc.page_count = 1 then 'page' else 'pages' end,
      pages_left, case when pages_left = 1 then 'page remains' else 'pages remain' end
      using errcode = '22023';
  end if;

  update public.documents d
  set status = 'queued', status_reason = null, attempts = 0, processing_started_at = null, processed_at = null
  where d.id = doc.id;
  insert into public.document_events (document_id, workspace_id, kind, actor)
  values (doc.id, doc.workspace_id, 'retried', caller);
  perform public.extract_send(doc.id);
end;
$$;

revoke execute on function public.retry_document(uuid) from public, anon, authenticated, service_role;
grant execute on function public.retry_document(uuid) to authenticated;

-- change_document_type ----------------------------------------------------------------------------

create or replace function public.change_document_type(document_id uuid, doc_type text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  doc public.documents;
  ws_left int;
  account_left int;
  pages_left int;
begin
  doc := public.lock_document_for_review(change_document_type.document_id, array['needs_review', 'unsupported'],
    'Only a document that needs review or is not supported can change type.');
  if doc.file_deleted_at is not null then
    raise exception '% cannot change type: its file has been deleted.', doc.file_name using errcode = '22023';
  end if;
  if change_document_type.doc_type is null or change_document_type.doc_type not in (
    'invoice', 'receipt', 'bank_statement', 'purchase_order', 'delivery_note', 'quote'
  ) then
    raise exception 'Choose one of the six document types.' using errcode = '22023';
  end if;

  -- As retry_document: the pages a not supported document gave back are held again.
  if doc.status = 'unsupported' and not public.reserve_pages(doc.id) then
    select l.pages_per_period - coalesce(u.pages_used, 0) into ws_left
    from public.workspaces w
    join public.plan_limits l on l.plan = w.plan
    left join public.page_usage u
      on u.workspace_id = w.id and u.period_start = date_trunc('month', now() at time zone 'utc')::date
    where w.id = doc.workspace_id;
    if doc.uploaded_by is null then
      pages_left := greatest(0, ws_left);
      raise exception '% has % %, but only % % of the workspace’s pages this month.',
        doc.file_name, doc.page_count, case when doc.page_count = 1 then 'page' else 'pages' end,
        pages_left, case when pages_left = 1 then 'page remains' else 'pages remain' end
        using errcode = '22023';
    end if;
    select public.account_page_cap() - coalesce(a.pages_used, 0) into account_left
    from (select 1) one left join public.account_page_usage a on a.user_id = doc.uploaded_by;
    pages_left := greatest(0, least(ws_left, coalesce(account_left, ws_left)));
    raise exception '% has % %, but only % % of the page allowance (the workspace’s pages this month and the uploader’s lifetime cap).',
      doc.file_name, doc.page_count, case when doc.page_count = 1 then 'page' else 'pages' end,
      pages_left, case when pages_left = 1 then 'page remains' else 'pages remain' end
      using errcode = '22023';
  end if;

  delete from public.extraction_fields f where f.document_id = doc.id;
  delete from public.check_results c where c.document_id = doc.id;
  delete from public.check_ticks t where t.document_id = doc.id;
  update public.documents d
  set doc_type = change_document_type.doc_type, doc_type_source = 'user', status = 'queued', status_reason = null,
      attempts = 0, processing_started_at = null, processed_at = null, duplicate_key = null, duplicate_of = null,
      approved_by = null, approved_at = null
  where d.id = doc.id;
  insert into public.document_events (document_id, workspace_id, kind, actor)
  values (doc.id, doc.workspace_id, 'type_changed', caller);
  perform public.extract_send(doc.id);
end;
$$;

revoke execute on function public.change_document_type(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.change_document_type(uuid, text) to authenticated;
