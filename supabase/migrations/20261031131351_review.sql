-- Milestone 7 (ARCHITECTURE.md sections 4.1, 4.2, 6.1 and 6.2): the review screen's corrections,
-- line items and check ticks, approval, reopening, type change, the document's history, and
-- single-document delete (PRD F5, US-1.2 AC-4 to AC-6, US-4.1 AC-7, F19; OQ-1, OQ-11, OQ-12,
-- OQ-20, OQ-44). Lead rulings on #32: a type change clears duplicate_key and duplicate_of (1);
-- approval re-runs U1 against the database with the corrected key fields (2).

-- History -----------------------------------------------------------------------------------------

-- record_extraction now writes an extracted event each time a document reaches needs_review, so a
-- document extracted again after a type change shows both. The upload itself is the document row
-- (created_at, uploaded_by).
alter table public.document_events drop constraint document_events_kind_check;
alter table public.document_events add constraint document_events_kind_check
  check (kind in ('extracted', 'approved', 'reopened', 'type_changed', 'retried'));

-- Documents extracted before this migration get the event of their last extraction.
insert into public.document_events (document_id, workspace_id, kind, actor, created_at)
select d.id, d.workspace_id, 'extracted', null, d.processed_at
from public.documents d
where d.status in ('needs_review', 'approved') and d.processed_at is not null;

-- check_ticks -------------------------------------------------------------------------------------

-- A member's tick on a failed check (OQ-11). Written only through set_check_ticked, deleted by
-- change_document_type; approve-document refuses while a stored fail has none.
create table public.check_ticks (
  document_id uuid references public.documents (id) on delete cascade,
  workspace_id uuid,
  check_id text,
  ticked_by uuid references public.profiles (id) on delete set null,
  ticked_at timestamptz default now(),
  primary key (document_id, check_id)
);

alter table public.check_ticks enable row level security;
revoke all on table public.check_ticks from anon, authenticated;

create policy check_ticks_select on public.check_ticks
  for select to authenticated
  using (public.is_member(workspace_id));

grant select on table public.check_ticks to authenticated;

-- Corrections (OQ-44) -----------------------------------------------------------------------------

-- A member corrects a field or line-item cell of a document that needs review: corrected_value
-- only, through this column grant. The extracted value is never changed by a client.
create policy extraction_fields_update on public.extraction_fields
  for update to authenticated
  using (
    public.is_member(workspace_id)
    and exists (select 1 from public.documents d where d.id = extraction_fields.document_id and d.status = 'needs_review')
  )
  with check (
    public.is_member(workspace_id)
    and exists (select 1 from public.documents d where d.id = extraction_fields.document_id and d.status = 'needs_review')
  );

grant update (corrected_value) on table public.extraction_fields to authenticated;

-- Security invoker: it only sets the audit columns of the row being updated. A card, account or
-- IBAN number keeps only its last four characters here too (OQ-29).
create function public.set_correction_audit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.corrected_value is not null
    and new.path in ('card_last4', 'account_number_last4', 'iban_last4') then
    new.corrected_value := right(regexp_replace(new.corrected_value, '\s', '', 'g'), 4);
  end if;
  new.corrected_by := (select auth.uid());
  new.corrected_at := now();
  return new;
end;
$$;

revoke execute on function public.set_correction_audit() from public, anon, authenticated, service_role;

create trigger extraction_fields_correction_audit
  before update of corrected_value on public.extraction_fields
  for each row
  when (old.corrected_value is distinct from new.corrected_value)
  execute function public.set_correction_audit();

-- line_item_fields --------------------------------------------------------------------------------

-- Each type's line-item cells, in the order of lineFields in shared/doctypes/<type>.ts, which
-- tests/access/review.test.ts compares them with. add_line_item reads it as its owner; no grant.
create function public.line_item_fields(doc_type text)
returns table (name text, kind text, ord int)
language sql
immutable
security invoker
set search_path = ''
as $$
  select e.cell ->> 0, e.cell ->> 1, e.ord::int
  from jsonb_array_elements(
    case line_item_fields.doc_type
      when 'invoice' then '[["description","text"],["item_code","text"],["quantity","number"],["unit","text"],["unit_price","amount"],["tax_rate","percent"],["amount","amount"]]'::jsonb
      when 'receipt' then '[["description","text"],["quantity","number"],["unit_price","amount"],["amount","amount"]]'::jsonb
      when 'bank_statement' then '[["date","date"],["description","text"],["reference","text"],["amount","amount"],["balance","amount"]]'::jsonb
      when 'purchase_order' then '[["item_code","text"],["description","text"],["quantity","number"],["unit","text"],["unit_price","amount"],["amount","amount"]]'::jsonb
      when 'delivery_note' then '[["item_code","text"],["description","text"],["quantity_ordered","number"],["quantity_delivered","number"],["unit","text"]]'::jsonb
      when 'quote' then '[["description","text"],["item_code","text"],["quantity","number"],["unit","text"],["unit_price","amount"],["amount","amount"]]'::jsonb
      else '[]'::jsonb
    end
  ) with ordinality as e(cell, ord);
$$;

revoke execute on function public.line_item_fields(text) from public, anon, authenticated, service_role;

-- The number of line items a document has: one more than its highest line_items[i].
create function public.line_item_count(document_id uuid)
returns int
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(max(substring(f.path from '^line_items\[(\d+)\]')::int) + 1, 0)
  from public.extraction_fields f
  where f.document_id = line_item_count.document_id and f.path like 'line_items[%';
$$;

revoke execute on function public.line_item_count(uuid) from public, anon, authenticated, service_role;

-- Moves every line after `after` by `delta` (1 or -1). Paths are unique per document, so the cells
-- move out of the way first, under a prefix no path has, then to their new index.
create function public.shift_line_items(document_id uuid, after int, delta int)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.extraction_fields f set path = '~' || f.path
  where f.document_id = shift_line_items.document_id
    and f.path like 'line_items[%'
    and substring(f.path from '^line_items\[(\d+)\]')::int > shift_line_items.after;
  update public.extraction_fields f
  set path = format(
    'line_items[%s]%s',
    substring(f.path from '^~line_items\[(\d+)\]')::int + shift_line_items.delta,
    substring(f.path from '^~line_items\[\d+\](.*)$')
  )
  where f.document_id = shift_line_items.document_id and f.path like '~line_items[%';
end;
$$;

revoke execute on function public.shift_line_items(uuid, int, int) from public, anon, authenticated, service_role;

-- The document a review RPC acts on, locked, once the caller is found to be a member and the
-- status one of `statuses`; refuses otherwise.
create function public.lock_document_for_review(document_id uuid, statuses text[], refusal text)
returns public.documents
language plpgsql
security invoker
set search_path = ''
as $$
declare
  doc public.documents;
begin
  select * into doc from public.documents d where d.id = lock_document_for_review.document_id for update;
  if (select auth.uid()) is null or doc.id is null or not public.is_member(doc.workspace_id) then
    raise exception 'not a member of this document''s workspace' using errcode = '42501';
  end if;
  if not (doc.status = any(lock_document_for_review.statuses)) then
    raise exception '%', lock_document_for_review.refusal using errcode = '22023';
  end if;
  return doc;
end;
$$;

revoke execute on function public.lock_document_for_review(uuid, text[], text) from public, anon, authenticated, service_role;

-- add_line_item -----------------------------------------------------------------------------------

-- Security definer: extraction_fields has no client insert (OQ-44). Inserts an empty line of the
-- document's type after line `after_position` (-1 for the first line), moving the later lines
-- down. Its cells have no extracted value and no confidence; corrected_by records who added it.
create function public.add_line_item(document_id uuid, after_position int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  doc public.documents;
  lines int;
begin
  doc := public.lock_document_for_review(add_line_item.document_id, array['needs_review'],
    'Line items can be added only while the document needs review.');
  lines := public.line_item_count(doc.id);
  if add_line_item.after_position is null or add_line_item.after_position < -1 or add_line_item.after_position >= lines then
    raise exception 'There is no line % to add a line after.', add_line_item.after_position + 1 using errcode = '22023';
  end if;
  if not exists (select 1 from public.line_item_fields(doc.doc_type)) then
    raise exception 'The document has no type, so it has no line items.' using errcode = '22023';
  end if;

  perform public.shift_line_items(doc.id, add_line_item.after_position, 1);
  insert into public.extraction_fields (document_id, workspace_id, path, kind, extracted_value, confidence, corrected_by, corrected_at, flags)
  select doc.id, doc.workspace_id, format('line_items[%s].%s', add_line_item.after_position + 1, l.name), l.kind, null, null,
         caller, now(), '{}'
  from public.line_item_fields(doc.doc_type) l
  order by l.ord;
end;
$$;

revoke execute on function public.add_line_item(uuid, int) from public, anon, authenticated, service_role;
grant execute on function public.add_line_item(uuid, int) to authenticated;

-- delete_line_item --------------------------------------------------------------------------------

-- Security definer: extraction_fields has no client delete (OQ-44). Deletes every cell of line
-- `line_position` (from 0) and moves the later lines up. (`position` is a reserved word.)
create function public.delete_line_item(document_id uuid, line_position int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  doc public.documents;
begin
  doc := public.lock_document_for_review(delete_line_item.document_id, array['needs_review'],
    'Line items can be deleted only while the document needs review.');
  if delete_line_item.line_position is null or delete_line_item.line_position < 0
    or delete_line_item.line_position >= public.line_item_count(doc.id) then
    raise exception 'There is no line % to delete.', delete_line_item.line_position + 1 using errcode = '22023';
  end if;

  delete from public.extraction_fields f
  where f.document_id = doc.id and f.path like format('line_items[%s].%%', delete_line_item.line_position);
  perform public.shift_line_items(doc.id, delete_line_item.line_position, -1);
end;
$$;

revoke execute on function public.delete_line_item(uuid, int) from public, anon, authenticated, service_role;
grant execute on function public.delete_line_item(uuid, int) to authenticated;

-- set_check_ticked --------------------------------------------------------------------------------

-- Security definer: check_ticks has no client writes (OQ-11). A member ticks, or unticks, one of
-- the document's checks while it needs review. Any stored check may be ticked, not only a stored
-- fail: the browser re-runs the checks on corrections (US-4.1 AC-7), and approve-document then
-- stores the failures it finds.
create function public.set_check_ticked(document_id uuid, check_id text, ticked boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  doc public.documents;
begin
  doc := public.lock_document_for_review(set_check_ticked.document_id, array['needs_review'],
    'Checks can be ticked only while the document needs review.');
  if not exists (
    select 1 from public.check_results c where c.document_id = doc.id and c.check_id = set_check_ticked.check_id
  ) then
    raise exception 'The document has no check %.', set_check_ticked.check_id using errcode = '22023';
  end if;

  if coalesce(set_check_ticked.ticked, false) then
    insert into public.check_ticks (document_id, workspace_id, check_id, ticked_by, ticked_at)
    values (doc.id, doc.workspace_id, set_check_ticked.check_id, caller, now())
    on conflict on constraint check_ticks_pkey do update set ticked_by = excluded.ticked_by, ticked_at = excluded.ticked_at;
  else
    delete from public.check_ticks t where t.document_id = doc.id and t.check_id = set_check_ticked.check_id;
  end if;
end;
$$;

revoke execute on function public.set_check_ticked(uuid, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_check_ticked(uuid, text, boolean) to authenticated;

-- reopen_document ---------------------------------------------------------------------------------

-- Security definer: clients may neither update documents nor write document_events (OQ-12). Any
-- member reopens an approved document: back to needs_review, the approval cleared, the reopen
-- logged. Its ticks are kept.
create function public.reopen_document(document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  doc public.documents;
begin
  doc := public.lock_document_for_review(reopen_document.document_id, array['approved'],
    'Only an approved document can be reopened.');
  update public.documents d set status = 'needs_review', approved_by = null, approved_at = null where d.id = doc.id;
  insert into public.document_events (document_id, workspace_id, kind, actor)
  values (doc.id, doc.workspace_id, 'reopened', (select auth.uid()));
end;
$$;

revoke execute on function public.reopen_document(uuid) from public, anon, authenticated, service_role;
grant execute on function public.reopen_document(uuid) to authenticated;

-- change_document_type ----------------------------------------------------------------------------

-- Security definer: it updates documents, deletes the results, writes document_events, reserves
-- pages and sends to the queue, none of which clients may do (OQ-1, PRD US-1.2 AC-4 to AC-6).
-- A member picks one of the six types for a document that needs review or is not supported and
-- whose file is still there. Its fields, corrections, check results and ticks are deleted, its
-- duplicate key and link cleared (Lead ruling 1 on #32; record_extraction computes them again),
-- and it is queued to be extracted as that type, with only that type's tool. A needs_review
-- document's pages are already counted; a not supported one's are reserved again, refused like an
-- upload when they no longer fit.
create function public.change_document_type(document_id uuid, doc_type text)
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

-- get_amount_tolerance ----------------------------------------------------------------------------

-- Security definer: app_config has no client grants. The review screen's live re-check uses the
-- same tolerance as the server's checks (OQ-7, US-4.1 AC-7). Signed-in users only.
create function public.get_amount_tolerance()
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select c.amount_tolerance from public.app_config c where c.id;
$$;

revoke execute on function public.get_amount_tolerance() from public, anon, authenticated, service_role;
grant execute on function public.get_amount_tolerance() to authenticated;

-- approve_document --------------------------------------------------------------------------------

-- Security invoker, service role only: approve-document calls it with the caller as actor, after
-- re-running the type's checks on the corrected values (section 6.1, OQ-11). result is:
--   values {path: value}: every row's corrected or extracted value, as the checks read them;
--   checks [{check_id, status, field_paths, message}], U1 as it stands with no earlier document;
--   flags {path: [flag]}, without duplicate; duplicate {key, label, flag_paths}.
-- In one transaction, under the workspace's duplicate lock (as record_extraction): refuses when
-- the values changed meanwhile; runs U1 against the database with the corrected key fields and
-- stores duplicate_key and duplicate_of (Lead ruling 2 on #32); upserts the checks and the flags;
-- then approves, unless a stored fail has no tick. Returns {outcome}: approved (with approved_at),
-- unticked (with checks), changed, wrong_status (with status) or not_found.
create function public.approve_document(document_id uuid, actor uuid, result jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  ws uuid;
  doc public.documents;
  current_values jsonb;
  dup_key text := nullif(approve_document.result -> 'duplicate' ->> 'key', '');
  key_label text := coalesce(approve_document.result -> 'duplicate' ->> 'label', 'key');
  dup_paths text[] := array(
    select jsonb_array_elements_text(coalesce(approve_document.result -> 'duplicate' -> 'flag_paths', '[]'::jsonb))
  );
  earlier record;
  unticked text[];
  approved timestamptz;
begin
  select d.workspace_id into ws from public.documents d where d.id = approve_document.document_id;
  if ws is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('duplicates:' || ws::text, 0));
  select * into doc from public.documents d where d.id = approve_document.document_id for update;
  if not found or not exists (
    select 1 from public.workspace_members m where m.workspace_id = doc.workspace_id and m.user_id = approve_document.actor
  ) then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if doc.status <> 'needs_review' then
    return jsonb_build_object('outcome', 'wrong_status', 'status', doc.status);
  end if;

  select coalesce(jsonb_object_agg(f.path, coalesce(f.corrected_value, f.extracted_value)), '{}'::jsonb) into current_values
  from public.extraction_fields f where f.document_id = doc.id;
  if current_values is distinct from coalesce(approve_document.result -> 'values', '{}'::jsonb) then
    return jsonb_build_object('outcome', 'changed');
  end if;

  -- U1 (OQ-9), as record_extraction finds the earliest earlier match.
  select e.id, e.file_name, coalesce(doc.sha256 is not null and e.sha256 = doc.sha256, false) as by_file into earlier
  from public.documents e
  where e.workspace_id = doc.workspace_id
    and e.id <> doc.id
    and e.status in ('queued', 'waiting_budget', 'processing', 'needs_review', 'approved')
    and (e.created_at, e.id) < (doc.created_at, doc.id)
    and ((doc.sha256 is not null and e.sha256 = doc.sha256) or (dup_key is not null and e.duplicate_key = dup_key))
  order by e.created_at, e.id
  limit 1;
  update public.documents d set duplicate_key = dup_key, duplicate_of = earlier.id where d.id = doc.id;

  insert into public.check_results (document_id, workspace_id, check_id, status, field_paths, message, evaluated_at)
  select doc.id, doc.workspace_id, c ->> 'check_id', c ->> 'status',
         array(select jsonb_array_elements_text(coalesce(c -> 'field_paths', '[]'::jsonb))), c ->> 'message', now()
  from jsonb_array_elements(coalesce(approve_document.result -> 'checks', '[]'::jsonb)) c
  where earlier.id is null or c ->> 'check_id' <> 'U1'
  union all
  select doc.id, doc.workspace_id, 'U1', 'fail', dup_paths,
         format(
           'Duplicate of "%s": %s.', earlier.file_name,
           case when earlier.by_file then 'the same file was uploaded before' else 'the same ' || key_label end
         ),
         now()
  where earlier.id is not null
  on conflict on constraint check_results_document_id_check_id_key do update
  set status = excluded.status, field_paths = excluded.field_paths, message = excluded.message,
      evaluated_at = excluded.evaluated_at;

  update public.extraction_fields f
  set flags = array(
    select jsonb_array_elements_text(coalesce(approve_document.result -> 'flags' -> f.path, '[]'::jsonb))
  ) || case when earlier.id is not null and f.path = any(dup_paths) then array['duplicate'] else '{}'::text[] end
  where f.document_id = doc.id;

  unticked := array(
    select c.check_id from public.check_results c
    where c.document_id = doc.id and c.status = 'fail'
      and not exists (select 1 from public.check_ticks t where t.document_id = doc.id and t.check_id = c.check_id)
    order by c.check_id
  );
  if cardinality(unticked) > 0 then
    return jsonb_build_object('outcome', 'unticked', 'checks', to_jsonb(unticked));
  end if;

  approved := now();
  update public.documents d set status = 'approved', approved_by = approve_document.actor, approved_at = approved
  where d.id = doc.id;
  insert into public.document_events (document_id, workspace_id, kind, actor, created_at)
  values (doc.id, doc.workspace_id, 'approved', approve_document.actor, approved);
  return jsonb_build_object('outcome', 'approved', 'approved_at', approved);
end;
$$;

revoke execute on function public.approve_document(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.approve_document(uuid, uuid, jsonb) to service_role;

-- delete_document ---------------------------------------------------------------------------------

-- Security invoker, service role only: DELETE /api/documents/[id] checks is_member and removes the
-- file first (section 6.2, OQ-20). Locks the row, gives back the pages a queued, waiting or
-- processing document holds (PRD US-19.1 AC-5), and deletes it, which cascades to its fields,
-- check results, ticks, history and extractions. Pages already counted stay counted (AC-4); a
-- later document's duplicate_of and a spend reservation's document_id become null. A document
-- that is already gone is nothing to do.
create function public.delete_document(document_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  doc public.documents;
begin
  select * into doc from public.documents d where d.id = delete_document.document_id for update;
  if not found then
    return;
  end if;
  if doc.status in ('queued', 'waiting_budget', 'processing') then
    perform public.release_pages(doc.id);
  end if;
  delete from public.documents d where d.id = doc.id;
end;
$$;

revoke execute on function public.delete_document(uuid) from public, anon, authenticated, service_role;
grant execute on function public.delete_document(uuid) to service_role;

-- record_extraction -------------------------------------------------------------------------------

-- As milestone 6, and a document that reaches needs_review now gets an extracted event.
create or replace function public.record_extraction(document_id uuid, reservation uuid, result jsonb)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  doc public.documents;
  ws uuid;
  new_status text := record_extraction.result ->> 'status';
  attempt_outcome text := record_extraction.result ->> 'outcome';
  dup_key text := nullif(record_extraction.result -> 'duplicate' ->> 'key', '');
  key_label text := coalesce(record_extraction.result -> 'duplicate' ->> 'label', 'key');
  target record;
  u1_paths text[];
  flag_paths text[];
begin
  if new_status is null or new_status not in ('needs_review', 'unsupported', 'queued', 'failed') then
    raise exception 'an extraction ends in needs_review, unsupported, queued or failed' using errcode = '22023';
  end if;
  if attempt_outcome is null
    or attempt_outcome not in ('ok', 'unsupported', 'retryable_error', 'fatal_error', 'invalid_output')
    or (new_status = 'needs_review') <> (attempt_outcome = 'ok') then
    raise exception 'the outcome does not match the status' using errcode = '22023';
  end if;

  if record_extraction.reservation is not null then
    perform public.settle_spend(record_extraction.reservation, coalesce((record_extraction.result ->> 'cost_usd')::numeric, 0));
  end if;

  if new_status = 'needs_review' then
    select d.workspace_id into ws from public.documents d where d.id = record_extraction.document_id;
    if ws is not null then
      perform pg_advisory_xact_lock(hashtextextended('duplicates:' || ws::text, 0));
    end if;
  end if;

  select * into doc from public.documents d where d.id = record_extraction.document_id for update;
  if not found then
    return 'deleted';
  end if;

  insert into public.extractions (
    document_id, workspace_id, model, prompt_version, tool_name, outcome, error, raw_output, input_tokens,
    output_tokens, cost_usd
  ) values (
    doc.id, doc.workspace_id, result ->> 'model', result ->> 'prompt_version', result ->> 'tool_name', attempt_outcome,
    result ->> 'error', result -> 'raw_output', (result ->> 'input_tokens')::int, (result ->> 'output_tokens')::int,
    coalesce((result ->> 'cost_usd')::numeric, 0)
  );

  if doc.status <> 'processing' then
    return 'stale';
  end if;

  if new_status = 'needs_review' then
    delete from public.extraction_fields f where f.document_id = doc.id;
    delete from public.check_results c where c.document_id = doc.id;
    insert into public.extraction_fields (document_id, workspace_id, path, kind, extracted_value, confidence, flags)
    select doc.id, doc.workspace_id, e ->> 'path', e ->> 'kind', e ->> 'extracted_value', (e ->> 'confidence')::numeric,
           array(select jsonb_array_elements_text(coalesce(e -> 'flags', '[]'::jsonb)))
    from jsonb_array_elements(coalesce(result -> 'fields', '[]'::jsonb)) e;
    insert into public.check_results (document_id, workspace_id, check_id, status, field_paths, message, evaluated_at)
    select doc.id, doc.workspace_id, e ->> 'check_id', e ->> 'status',
           array(select jsonb_array_elements_text(coalesce(e -> 'field_paths', '[]'::jsonb))), e ->> 'message', now()
    from jsonb_array_elements(coalesce(result -> 'checks', '[]'::jsonb)) e;
    update public.documents d
    set status = 'needs_review', status_reason = null, doc_type = coalesce(result ->> 'doc_type', doc.doc_type),
        doc_type_source = case when doc.doc_type_source = 'user' then 'user' else 'detected' end,
        processed_at = now(), processing_started_at = null, duplicate_key = dup_key, duplicate_of = null
    where d.id = doc.id;
    insert into public.document_events (document_id, workspace_id, kind, actor)
    values (doc.id, doc.workspace_id, 'extracted', null);

    -- Duplicates (OQ-9): this document against the earliest earlier match, then each later
    -- document in needs_review against this one.
    for target in
      (
        select doc.id as id, e.id as earlier_id, e.file_name as earlier_file,
               coalesce(doc.sha256 is not null and e.sha256 = doc.sha256, false) as by_file
        from public.documents e
        where e.workspace_id = doc.workspace_id
          and e.id <> doc.id
          and e.status in ('queued', 'waiting_budget', 'processing', 'needs_review', 'approved')
          and (e.created_at, e.id) < (doc.created_at, doc.id)
          and ((doc.sha256 is not null and e.sha256 = doc.sha256) or (dup_key is not null and e.duplicate_key = dup_key))
        order by e.created_at, e.id
        limit 1
      )
      union all
      (
        select l.id, doc.id, doc.file_name, coalesce(doc.sha256 is not null and l.sha256 = doc.sha256, false)
        from public.documents l
        where l.workspace_id = doc.workspace_id
          and l.id <> doc.id
          and l.status = 'needs_review'
          and (l.created_at, l.id) > (doc.created_at, doc.id)
          and ((doc.sha256 is not null and l.sha256 = doc.sha256) or (dup_key is not null and l.duplicate_key = dup_key))
          and (
            l.duplicate_of is null
            or exists (
              select 1 from public.documents p
              where p.id = l.duplicate_of and (p.created_at, p.id) > (doc.created_at, doc.id)
            )
          )
      )
    loop
      update public.documents d set duplicate_of = target.earlier_id where d.id = target.id;
      select c.field_paths into u1_paths from public.check_results c where c.document_id = target.id and c.check_id = 'U1';
      flag_paths := array(
        select p from unnest(coalesce(u1_paths, '{}'::text[])) with ordinality as k(p, n)
        where exists (
          select 1 from public.extraction_fields f
          where f.document_id = target.id and f.path = k.p and f.extracted_value is not null
        )
        order by k.n
      );
      insert into public.check_results (document_id, workspace_id, check_id, status, field_paths, message, evaluated_at)
      values (
        target.id, doc.workspace_id, 'U1', 'fail', flag_paths,
        format(
          'Duplicate of "%s": %s.', target.earlier_file,
          case when target.by_file then 'the same file was uploaded before' else 'the same ' || key_label end
        ),
        now()
      )
      on conflict on constraint check_results_document_id_check_id_key do update
      set status = excluded.status, field_paths = excluded.field_paths, message = excluded.message,
          evaluated_at = excluded.evaluated_at;
      update public.extraction_fields f
      set flags = f.flags || array['duplicate']
      where f.document_id = target.id and f.path = any(flag_paths) and not ('duplicate' = any(f.flags));
    end loop;
  elsif new_status in ('unsupported', 'failed') then
    update public.documents d
    set status = new_status, status_reason = result ->> 'status_reason', processed_at = now(), processing_started_at = null
    where d.id = doc.id;
    perform public.release_pages(doc.id);
  else
    update public.documents d
    set status = 'queued', status_reason = result ->> 'status_reason', processing_started_at = null
    where d.id = doc.id;
  end if;
  return 'recorded';
end;
$$;

revoke execute on function public.record_extraction(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.record_extraction(uuid, uuid, jsonb) to service_role;
