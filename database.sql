-- Saldo private cloud document storage. Deploy as postgres in Supabase SQL editor.
-- No keys, users, personal budgets, or test fixtures belong in this deployment.
BEGIN;

CREATE TABLE IF NOT EXISTS public.budget_documents (
    user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    payload jsonb NOT NULL,
    revision bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.budget_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.budget_documents FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT ON TABLE public.budget_documents TO authenticated;

DROP POLICY IF EXISTS saldo_owner_select ON public.budget_documents;
CREATE POLICY saldo_owner_select ON public.budget_documents
    FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()));

-- SECURITY DEFINER is intentional: authenticated has no direct write privileges.
-- The trusted postgres owner bypasses RLS, so every write explicitly binds auth.uid().
CREATE OR REPLACE FUNCTION public.save_budget(p_payload jsonb, p_expected_revision bigint)
RETURNS SETOF public.budget_documents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_user_id uuid := auth.uid();
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'SALDO_UNAUTHENTICATED' USING ERRCODE = '28000';
    END IF;
    IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'SALDO_INVALID_PAYLOAD' USING ERRCODE = '22023';
    END IF;
    IF pg_catalog.octet_length(p_payload::text) > 2097152 THEN
        RAISE EXCEPTION 'SALDO_PAYLOAD_TOO_LARGE' USING ERRCODE = '22023';
    END IF;
    IF p_expected_revision IS NULL OR p_expected_revision < 0 THEN
        RAISE EXCEPTION 'SALDO_INVALID_REVISION' USING ERRCODE = '22023';
    END IF;
    IF p_expected_revision = 0 THEN
        BEGIN
            RETURN QUERY INSERT INTO public.budget_documents (user_id, payload, revision)
                VALUES (v_user_id, p_payload, 1)
                RETURNING *;
        EXCEPTION WHEN unique_violation THEN
            RAISE EXCEPTION 'SALDO_CONFLICT' USING ERRCODE = 'P0001';
        END;
    ELSE
        RETURN QUERY UPDATE public.budget_documents AS document
            SET payload = p_payload,
                revision = document.revision + 1,
                updated_at = pg_catalog.clock_timestamp()
            WHERE document.user_id = v_user_id
              AND document.revision = p_expected_revision
            RETURNING document.*;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'SALDO_CONFLICT' USING ERRCODE = 'P0001';
        END IF;
    END IF;
END;
$function$;
ALTER FUNCTION public.save_budget(jsonb, bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.save_budget(jsonb, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_budget(jsonb, bigint) TO authenticated;

COMMIT;
