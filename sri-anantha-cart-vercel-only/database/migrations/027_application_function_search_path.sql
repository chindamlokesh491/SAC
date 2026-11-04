-- Pin the name-resolution path for application-owned routines.
-- Keep pg_temp last so temporary objects cannot shadow trusted application objects.
-- Resolve routines in current_schema(): production uses public, while integration tests
-- apply the same migrations inside an isolated schema.
-- Extension-owned C functions (pg_trgm) are intentionally not altered here.
BEGIN;

DO $migration$
DECLARE
  target_schema name := current_schema();
  routine record;
  altered_count integer := 0;
BEGIN
  IF target_schema IS NULL THEN
    RAISE EXCEPTION 'Cannot determine the current schema for application function hardening';
  END IF;

  FOR routine IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS identity_arguments
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = target_schema
       AND p.prokind = 'f'
       AND p.proname = ANY (ARRAY[
         'apply_order_sales',
         'enable_backend_rls',
         'enforce_featured_limit',
         'protect_audit_log',
         'protect_order_amounts',
         'protect_order_items',
         'rebuild_product_sales',
         'record_order_status_history',
         'record_order_status_history_insert',
         'refresh_product_sales_summary',
         'sale_status_counts',
         'track_order_item_sales',
         'track_order_sales'
       ])
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = %I, pg_temp',
      target_schema,
      routine.proname,
      routine.identity_arguments,
      target_schema
    );
    altered_count := altered_count + 1;
  END LOOP;

  IF altered_count <> 13 THEN
    RAISE EXCEPTION 'Expected to harden 13 application functions in schema %, but found %',
      target_schema, altered_count;
  END IF;
END
$migration$;

COMMIT;
