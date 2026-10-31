-- Milestone 6 (ARCHITECTURE.md sections 4.1, 4.2 and 6.3): duplicate detection (PRD section 4.3,
-- OQ-9). Lead rulings on #27: each document stores its normalised U1 key, indexed with its
-- workspace, and record_extraction runs the duplicate query in the transaction that stores the
-- result (1); earlier means created earlier (2); the duplicate flag goes on the U1 key fields that
-- have a value (3); a duplicate keeps its status (4). Rulings on the worker's questions: a
-- document that records also flags the later documents in needs_review that match it, and
-- rejected, failed and unsupported documents do not count.

-- The type name and the U1 key fields, normalised in shared/doctypes/duplicate.ts; null when any
-- key field is empty. Existing rows keep null: their key is computed when they are next extracted.
alter table public.documents add column duplicate_key text;

create index documents_workspace_id_duplicate_key_idx on public.documents (workspace_id, duplicate_key);

-- record_extraction -----------------------------------------------------------------------------

-- As milestone 5, and in needs_review it now also stores result -> 'duplicate' ->> 'key' as
-- duplicate_key and runs the duplicate query. result -> 'duplicate' is {key, label}: label names
-- the key in messages ("vendor and invoice number"). A document counts as earlier when it was
-- created before this one (then by id) in the same workspace, matches its sha256 or its
-- duplicate_key, and is queued, waiting_budget, processing, needs_review or approved, whether or
-- not its file was deleted. The earliest such document becomes duplicate_of, and U1 fails. Then
-- every later document in needs_review that matches this one, and points to no document or to one
-- created after this one, is pointed to this one in the same way; an approved one is left as it
-- is. A failed U1 names the earlier file and whether the file or the key matched, as checkU1 in
-- shared/doctypes/duplicate.ts does, and the duplicate flag goes on the fields of its U1 row that
-- have a value. A transaction-scoped advisory lock per workspace, taken before the document row,
-- makes two documents of one workspace record one after the other, so neither misses the other.
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
