-- The image upload limit (issue #28): the API takes an image of at most 10 MB base64-encoded
-- (ARCHITECTURE.md, "Input"), so create_document now also refuses a JPEG, PNG or WebP over
-- 7,500,000 bytes, which base64-encode to exactly 10,000,000 (shared/limits.ts MAX_IMAGE_BYTES).
-- A PDF keeps the 10 MB limit, and so does the documents bucket's file_size_limit.

-- create_document -------------------------------------------------------------------------------

-- Security definer, because documents has no client insert. A member creates a document of an
-- accepted type and size (OQ-4); it starts uploading, at the storage path the bucket's insert
-- policy expects.
create or replace function public.create_document(ws uuid, file_name text, mime_type text, byte_size bigint)
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
  if create_document.byte_size is null or create_document.byte_size < 1 then
    raise exception 'a file must be at most 10 MB' using errcode = '22023';
  end if;
  if create_document.mime_type in ('image/jpeg', 'image/png', 'image/webp')
    and create_document.byte_size > 7500000 then
    raise exception 'an image must be at most 7.5 MB' using errcode = '22023';
  end if;
  if create_document.byte_size > 10 * 1024 * 1024 then
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
