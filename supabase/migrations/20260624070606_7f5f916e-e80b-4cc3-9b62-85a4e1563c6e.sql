
-- Storage RLS for civiko-one-photos and civiko-one-docs
-- Path convention: {agency_id}/{case_id}/{filename}
-- First folder segment = agency_id (uuid)

CREATE POLICY "co_storage_select_members"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id IN ('civiko-one-photos','civiko-one-docs')
    AND public.is_agency_member( (storage.foldername(name))[1]::uuid )
  );

CREATE POLICY "co_storage_insert_members"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id IN ('civiko-one-photos','civiko-one-docs')
    AND public.is_agency_member( (storage.foldername(name))[1]::uuid )
  );

CREATE POLICY "co_storage_update_members"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id IN ('civiko-one-photos','civiko-one-docs')
    AND public.is_agency_member( (storage.foldername(name))[1]::uuid )
  );

CREATE POLICY "co_storage_delete_admins"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id IN ('civiko-one-photos','civiko-one-docs')
    AND public.is_agency_admin( (storage.foldername(name))[1]::uuid )
  );
