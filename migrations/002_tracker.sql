-- Additive Saldo ledger. Execute as postgres; no credentials or user data.
BEGIN;
CREATE SCHEMA IF NOT EXISTS saldo_private AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA saldo_private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.transactions (
 id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 type text NOT NULL CHECK (type IN ('income','expense','transfer')),
 amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 10000000000),
 currency text NOT NULL DEFAULT 'MYR' CHECK (currency = 'MYR'),
 occurred_at timestamptz NOT NULL,
 time_zone text NOT NULL,
 entry_date date GENERATED ALWAYS AS ((occurred_at AT TIME ZONE time_zone)::date) STORED,
 from_account_id text,
 to_account_id text,
 from_account_name text,
 to_account_name text,
 external_party text CHECK (pg_catalog.length(external_party) <= 160),
 category text CHECK (category IS NULL OR (type = 'expense' AND category IN ('commitment','entertainment','savings'))),
 note text CHECK (pg_catalog.length(note) <= 500),
 source text NOT NULL CHECK (source IN ('app','shortcut')),
 created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
 voided_at timestamptz,
 canonical_entry jsonb NOT NULL,
 UNIQUE(user_id, request_id),
 CHECK ((type = 'income' AND from_account_id IS NULL) OR
        (type = 'expense' AND to_account_id IS NULL) OR
        (type = 'transfer' AND from_account_id IS NOT NULL AND to_account_id IS NOT NULL AND from_account_id <> to_account_id))
);
CREATE INDEX IF NOT EXISTS transactions_owner_date ON public.transactions(user_id, entry_date);
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.transactions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.transactions TO authenticated;
DROP POLICY IF EXISTS tracker_owner_select ON public.transactions;
CREATE POLICY tracker_owner_select ON public.transactions FOR SELECT TO authenticated
 USING (user_id = (SELECT auth.uid()));

CREATE OR REPLACE FUNCTION saldo_private.require_owner() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := auth.uid();
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'SALDO_UNAUTHENTICATED' USING ERRCODE='28000'; END IF;
 RETURN u;
END $$;

CREATE OR REPLACE FUNCTION saldo_private.metadata(p_owner uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT pg_catalog.jsonb_build_object('accounts', COALESCE((
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', a->>'id','name',a->>'name','type',a->>'type') ORDER BY ordinal)
  FROM public.budget_documents d,
  LATERAL pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(d.payload->'accounts')='array' THEN d.payload->'accounts' ELSE '[]'::jsonb END) WITH ORDINALITY AS x(a,ordinal)
  WHERE d.user_id=p_owner AND a->>'type' IN ('bank','wallet','cash','card','investment')
 ), '[]'::jsonb), 'categories', pg_catalog.jsonb_build_array('commitment','entertainment','savings'))
$$;
CREATE OR REPLACE FUNCTION public.tracker_metadata() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
 SELECT saldo_private.metadata(saldo_private.require_owner())
$$;

CREATE OR REPLACE FUNCTION saldo_private.record(p_owner uuid, p_entry jsonb, p_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
 r public.transactions%ROWTYPE;
 v_request uuid;
 v_type text; v_amount bigint; v_time timestamptz; v_zone text;
 v_from text; v_to text; v_external text; v_category text; v_note text;
 v_from_name text; v_to_name text; v_canonical jsonb; a jsonb; k text;
BEGIN
 -- Never accept SQL coercions of JSON strings, booleans, or fractional amounts.
 IF p_entry IS NULL OR pg_catalog.jsonb_typeof(p_entry) <> 'object' OR pg_catalog.pg_column_size(p_entry)>8192 THEN
  RAISE EXCEPTION 'SALDO_INVALID_ENTRY';
 END IF;
 BEGIN
  IF p_entry ?| ARRAY['owner','owner_id','user_id','source'] THEN RAISE EXCEPTION 'SALDO_INVALID_ENTRY'; END IF;
  IF p_entry ? 'currency' AND (pg_catalog.jsonb_typeof(p_entry->'currency') <> 'string' OR p_entry->>'currency' <> 'MYR') THEN
   RAISE EXCEPTION 'SALDO_INVALID_ENTRY';
  END IF;
  FOREACH k IN ARRAY ARRAY['request_id','type','occurred_at','time_zone','from_account_id','to_account_id','external_party','category','note'] LOOP
   IF p_entry ? k AND pg_catalog.jsonb_typeof(p_entry->k) NOT IN ('string','null') THEN
    RAISE EXCEPTION 'SALDO_INVALID_ENTRY';
   END IF;
  END LOOP;
  IF pg_catalog.jsonb_typeof(p_entry->'amount_cents') IS DISTINCT FROM 'number'
   OR (p_entry->>'amount_cents')::numeric <> pg_catalog.trunc((p_entry->>'amount_cents')::numeric)
   OR (p_entry->>'amount_cents')::numeric NOT BETWEEN 1 AND 10000000000 THEN
   RAISE EXCEPTION 'SALDO_INVALID_ENTRY';
  END IF;
  v_request := (p_entry->>'request_id')::uuid;
  v_type := p_entry->>'type'; v_amount := (p_entry->>'amount_cents')::numeric::bigint;
  v_zone := COALESCE(p_entry->>'time_zone','UTC');
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=v_zone)
   OR v_zone LIKE 'posix/%' OR v_zone LIKE 'right/%' THEN RAISE EXCEPTION 'SALDO_INVALID_ENTRY'; END IF;
  -- Require an explicit ISO date/time and offset, never session-dependent local time.
  IF COALESCE(p_entry->>'occurred_at','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' THEN
   RAISE EXCEPTION 'SALDO_INVALID_ENTRY';
  END IF;
  v_time := (p_entry->>'occurred_at')::timestamptz;
  v_from := p_entry->>'from_account_id'; v_to := p_entry->>'to_account_id';
  v_external := p_entry->>'external_party'; v_category := p_entry->>'category'; v_note := p_entry->>'note';
  IF v_request IS NULL OR v_type IS NULL OR v_type NOT IN ('income','expense','transfer')
   OR pg_catalog.length(v_external)>160 OR pg_catalog.length(v_note)>500
   OR v_from='' OR v_to=''
   OR (v_type='income' AND v_from IS NOT NULL)
   OR (v_type='expense' AND v_to IS NOT NULL)
   OR (v_type='transfer' AND (v_from IS NULL OR v_to IS NULL OR v_from=v_to))
   OR (v_category IS NOT NULL AND (v_type<>'expense' OR v_category NOT IN ('commitment','entertainment','savings')))
   THEN RAISE EXCEPTION 'SALDO_INVALID_ENTRY'; END IF;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'SALDO_INVALID_ENTRY' USING ERRCODE='22023';
 END;
 v_canonical := pg_catalog.jsonb_build_object('request_id',v_request,'type',v_type,'amount_cents',v_amount,
  'occurred_at_epoch',extract(epoch FROM v_time),'time_zone',v_zone,'from_account_id',v_from,
  'to_account_id',v_to,'external_party',v_external,'category',v_category,'note',v_note);
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text, 7401));
 SELECT * INTO r FROM public.transactions WHERE user_id=p_owner AND request_id=v_request;
 IF FOUND THEN
  IF r.canonical_entry <> v_canonical THEN RAISE EXCEPTION 'SALDO_DUPLICATE_CONFLICT'; END IF;
  RETURN pg_catalog.jsonb_build_object('transaction',pg_catalog.to_jsonb(r),'duplicate',true);
 END IF;
 FOR a IN SELECT value FROM pg_catalog.jsonb_array_elements(saldo_private.metadata(p_owner)->'accounts') LOOP
  IF a->>'id'=v_from THEN v_from_name := a->>'name'; END IF;
  IF a->>'id'=v_to THEN v_to_name := a->>'name'; END IF;
 END LOOP;
 IF (v_from IS NOT NULL AND v_from_name IS NULL) OR (v_to IS NOT NULL AND v_to_name IS NULL) THEN
  RAISE EXCEPTION 'SALDO_ACCOUNT_CHANGED';
 END IF;
 INSERT INTO public.transactions(user_id,request_id,type,amount_cents,occurred_at,time_zone,
  from_account_id,to_account_id,from_account_name,to_account_name,external_party,category,note,source,canonical_entry)
 VALUES(p_owner,v_request,v_type,v_amount,v_time,v_zone,v_from,v_to,v_from_name,v_to_name,v_external,v_category,v_note,p_source,v_canonical)
 RETURNING * INTO r;
 RETURN pg_catalog.jsonb_build_object('transaction',pg_catalog.to_jsonb(r),'duplicate',false);
END $$;
CREATE OR REPLACE FUNCTION public.record_transaction(p_entry jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
 SELECT saldo_private.record(saldo_private.require_owner(),p_entry,'app')
$$;

ALTER FUNCTION saldo_private.require_owner() OWNER TO postgres;
ALTER FUNCTION saldo_private.metadata(uuid) OWNER TO postgres;
ALTER FUNCTION saldo_private.record(uuid,jsonb,text) OWNER TO postgres;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA saldo_private FROM PUBLIC, anon, authenticated;
ALTER FUNCTION public.tracker_metadata() OWNER TO postgres;
ALTER FUNCTION public.record_transaction(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.tracker_metadata(), public.record_transaction(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tracker_metadata(), public.record_transaction(jsonb) TO authenticated;
CREATE OR REPLACE FUNCTION public.tracker_summary(p_month text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := saldo_private.require_owner(); first_day date; result jsonb;
BEGIN
 IF p_month IS NULL OR p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'SALDO_INVALID_ENTRY'; END IF;
 BEGIN first_day := (p_month || '-01')::date;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'SALDO_INVALID_ENTRY'; END;
 WITH entries AS (
  SELECT * FROM public.transactions WHERE user_id=u AND voided_at IS NULL
   AND entry_date >= first_day AND entry_date < first_day + interval '1 month'
 ), movement AS (
  SELECT from_account_id AS account_id, -amount_cents AS amount FROM entries WHERE from_account_id IS NOT NULL
  UNION ALL
  SELECT to_account_id, amount_cents FROM entries WHERE to_account_id IS NOT NULL
 ), totals AS (SELECT account_id, sum(amount) AS amount FROM movement GROUP BY account_id)
 SELECT pg_catalog.jsonb_build_object(
  'income_cents',COALESCE(sum(amount_cents) FILTER(WHERE type='income'),0),
  'expense_cents',COALESCE(sum(amount_cents) FILTER(WHERE type='expense'),0),
  'transfer_cents',COALESCE(sum(amount_cents) FILTER(WHERE type='transfer'),0),
  'unassigned_income_cents',COALESCE(sum(amount_cents) FILTER(WHERE type='income' AND to_account_id IS NULL),0),
  'unassigned_expense_cents',COALESCE(sum(amount_cents) FILTER(WHERE type='expense' AND from_account_id IS NULL),0),
  'movements',COALESCE((SELECT pg_catalog.jsonb_object_agg(account_id,amount) FROM totals),'{}'::jsonb))
 INTO result FROM entries;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.assign_transaction(p_transaction_id uuid,p_account_id text,p_category text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := saldo_private.require_owner(); r public.transactions%ROWTYPE; account_name text;
BEGIN
 SELECT * INTO r FROM public.transactions WHERE id=p_transaction_id AND user_id=u FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SALDO_TRANSACTION_NOT_FOUND'; END IF;
 IF r.voided_at IS NOT NULL OR r.type='transfer'
  OR (r.type='income' AND r.to_account_id IS NOT NULL)
  OR (r.type='expense' AND r.from_account_id IS NOT NULL)
  OR (p_category IS NOT NULL AND (r.type<>'expense' OR p_category NOT IN ('commitment','entertainment','savings'))) THEN
  RAISE EXCEPTION 'SALDO_INVALID_ENTRY';
 END IF;
 SELECT a->>'name' INTO account_name
 FROM pg_catalog.jsonb_array_elements(saldo_private.metadata(u)->'accounts') a
 WHERE a->>'id'=p_account_id;
 IF account_name IS NULL THEN RAISE EXCEPTION 'SALDO_ACCOUNT_CHANGED'; END IF;
 -- canonical_entry is the immutable original request, not the assigned route.
 UPDATE public.transactions SET
  from_account_id=CASE WHEN r.type='expense' THEN p_account_id ELSE from_account_id END,
  from_account_name=CASE WHEN r.type='expense' THEN account_name ELSE from_account_name END,
  to_account_id=CASE WHEN r.type='income' THEN p_account_id ELSE to_account_id END,
  to_account_name=CASE WHEN r.type='income' THEN account_name ELSE to_account_name END,
  category=p_category
 WHERE id=r.id RETURNING * INTO r;
 RETURN pg_catalog.to_jsonb(r);
END $$;
ALTER FUNCTION public.assign_transaction(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assign_transaction(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_transaction(uuid,text,text) TO authenticated;
CREATE OR REPLACE FUNCTION public.void_transaction(p_transaction_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := saldo_private.require_owner(); r public.transactions%ROWTYPE;
BEGIN
 UPDATE public.transactions SET voided_at=COALESCE(voided_at,pg_catalog.clock_timestamp())
 WHERE id=p_transaction_id AND user_id=u RETURNING * INTO r;
 IF NOT FOUND THEN RAISE EXCEPTION 'SALDO_TRANSACTION_NOT_FOUND'; END IF;
 RETURN pg_catalog.to_jsonb(r);
END $$;
ALTER FUNCTION public.tracker_summary(text) OWNER TO postgres;
ALTER FUNCTION public.void_transaction(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.tracker_summary(text), public.void_transaction(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tracker_summary(text), public.void_transaction(uuid) TO authenticated;
CREATE TABLE IF NOT EXISTS saldo_private.shortcut_devices (
 id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
 name text NOT NULL CHECK (pg_catalog.length(name) BETWEEN 1 AND 80),
 time_zone text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS saldo_private.owner_rate (
 user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 window_start timestamptz NOT NULL,
 requests integer NOT NULL CHECK (requests BETWEEN 1 AND 120)
);
CREATE TABLE IF NOT EXISTS saldo_private.device_rate (
 device_id uuid PRIMARY KEY REFERENCES saldo_private.shortcut_devices(id) ON DELETE CASCADE,
 window_start timestamptz NOT NULL,
 requests integer NOT NULL CHECK (requests BETWEEN 1 AND 60)
);
REVOKE ALL ON ALL TABLES IN SCHEMA saldo_private FROM PUBLIC, anon, authenticated;

-- to_jsonb(timestamptz) follows the caller session time zone: STABLE, not IMMUTABLE.
CREATE OR REPLACE FUNCTION saldo_private.device_metadata(d saldo_private.shortcut_devices) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT pg_catalog.to_jsonb(d) - 'token_hash' - 'user_id'
$$;
CREATE OR REPLACE FUNCTION public.list_shortcut_devices() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := saldo_private.require_owner(); result jsonb;
BEGIN
 SELECT COALESCE(pg_catalog.jsonb_agg(saldo_private.device_metadata(d) ORDER BY d.created_at,d.id),'[]'::jsonb)
 INTO result FROM saldo_private.shortcut_devices d WHERE d.user_id=u;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.create_shortcut_device(p_name text,p_token_hash text,p_time_zone text,p_expires_in_days integer DEFAULT 90) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := saldo_private.require_owner(); d saldo_private.shortcut_devices%ROWTYPE;
BEGIN
 IF p_name IS NULL OR pg_catalog.length(p_name) NOT BETWEEN 1 AND 80
  OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
  OR p_time_zone IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=p_time_zone)
  OR p_time_zone LIKE 'posix/%' OR p_time_zone LIKE 'right/%'
  OR p_expires_in_days IS NULL OR p_expires_in_days NOT BETWEEN 1 AND 365 THEN
  RAISE EXCEPTION 'SALDO_INVALID_ENTRY';
 END IF;
 -- Retried POSTs return the original registration without extending its expiry.
 INSERT INTO saldo_private.shortcut_devices(user_id,token_hash,name,time_zone,expires_at)
 VALUES(u,p_token_hash,p_name,p_time_zone,pg_catalog.now()+pg_catalog.make_interval(days=>p_expires_in_days))
 ON CONFLICT(token_hash) DO NOTHING RETURNING * INTO d;
 IF NOT FOUND THEN
  SELECT * INTO d FROM saldo_private.shortcut_devices WHERE user_id=u AND token_hash=p_token_hash;
  IF NOT FOUND THEN RAISE EXCEPTION 'SALDO_INVALID_ENTRY'; END IF;
 END IF;
 RETURN saldo_private.device_metadata(d);
END $$;
CREATE OR REPLACE FUNCTION public.revoke_shortcut_device(p_device_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := saldo_private.require_owner();
BEGIN
 UPDATE saldo_private.shortcut_devices SET revoked_at=COALESCE(revoked_at,pg_catalog.clock_timestamp())
 WHERE id=p_device_id AND user_id=u;
 RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION saldo_private.authorize_device(p_token text) RETURNS saldo_private.shortcut_devices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d saldo_private.shortcut_devices%ROWTYPE; bucket timestamptz; counter integer;
BEGIN
 IF p_token IS NULL OR p_token !~ '^sld_[A-Za-z0-9_-]{43}$' THEN RAISE EXCEPTION 'SALDO_DEVICE_UNAUTHORIZED'; END IF;
 SELECT * INTO d FROM saldo_private.shortcut_devices
 WHERE token_hash=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8')),'hex')
  AND revoked_at IS NULL AND expires_at>pg_catalog.clock_timestamp() FOR UPDATE;
 IF NOT FOUND OR d.revoked_at IS NOT NULL OR d.expires_at<=pg_catalog.clock_timestamp() THEN
  RAISE EXCEPTION 'SALDO_DEVICE_UNAUTHORIZED';
 END IF;
 bucket := pg_catalog.date_trunc('minute',pg_catalog.clock_timestamp());
 -- Row-locked conditional UPSERTs make both limits atomic across connections.
 INSERT INTO saldo_private.owner_rate AS c(user_id,window_start,requests) VALUES(d.user_id,bucket,1)
 ON CONFLICT(user_id) DO UPDATE SET window_start=excluded.window_start,
  requests=CASE WHEN c.window_start=excluded.window_start THEN c.requests+1 ELSE 1 END
 WHERE c.window_start<>excluded.window_start OR c.requests<120 RETURNING requests INTO counter;
 IF NOT FOUND THEN RAISE EXCEPTION 'SALDO_RATE_LIMIT'; END IF;
 INSERT INTO saldo_private.device_rate AS c(device_id,window_start,requests) VALUES(d.id,bucket,1)
 ON CONFLICT(device_id) DO UPDATE SET window_start=excluded.window_start,
  requests=CASE WHEN c.window_start=excluded.window_start THEN c.requests+1 ELSE 1 END
 WHERE c.window_start<>excluded.window_start OR c.requests<60 RETURNING requests INTO counter;
 IF NOT FOUND THEN RAISE EXCEPTION 'SALDO_RATE_LIMIT'; END IF;
 RETURN d;
END $$;
CREATE OR REPLACE FUNCTION public.shortcut_metadata(p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d saldo_private.shortcut_devices%ROWTYPE;
BEGIN
 d := saldo_private.authorize_device(p_token);
 RETURN saldo_private.metadata(d.user_id) || pg_catalog.jsonb_build_object('time_zone',d.time_zone);
END $$;
CREATE OR REPLACE FUNCTION public.shortcut_record(p_token text,p_entry jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d saldo_private.shortcut_devices%ROWTYPE;
BEGIN
 -- Authorization and quota increments must survive record subtransaction failure.
 d := saldo_private.authorize_device(p_token);
 BEGIN
  IF p_entry IS NULL OR pg_catalog.jsonb_typeof(p_entry)<>'object' OR pg_catalog.pg_column_size(p_entry)>8192 THEN
   RAISE EXCEPTION 'SALDO_INVALID_ENTRY';
  END IF;
  RETURN saldo_private.record(d.user_id,p_entry || pg_catalog.jsonb_build_object('time_zone',d.time_zone),'shortcut');
 EXCEPTION WHEN OTHERS THEN
  -- Allowlisted codes only: never expose SQL details, input data or credentials.
  RETURN pg_catalog.jsonb_build_object('error_code',CASE
   WHEN SQLERRM IN ('SALDO_INVALID_ENTRY','SALDO_DUPLICATE_CONFLICT','SALDO_ACCOUNT_CHANGED') THEN SQLERRM
   ELSE 'SALDO_TRACKER_ERROR' END);
 END;
END $$;
ALTER FUNCTION saldo_private.device_metadata(saldo_private.shortcut_devices) OWNER TO postgres;
ALTER FUNCTION saldo_private.authorize_device(text) OWNER TO postgres;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA saldo_private FROM PUBLIC, anon, authenticated;
ALTER FUNCTION public.list_shortcut_devices() OWNER TO postgres;
ALTER FUNCTION public.create_shortcut_device(text,text,text,integer) OWNER TO postgres;
ALTER FUNCTION public.revoke_shortcut_device(uuid) OWNER TO postgres;
ALTER FUNCTION public.shortcut_metadata(text) OWNER TO postgres;
ALTER FUNCTION public.shortcut_record(text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_shortcut_devices(), public.create_shortcut_device(text,text,text,integer), public.revoke_shortcut_device(uuid), public.shortcut_metadata(text), public.shortcut_record(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_shortcut_devices(), public.create_shortcut_device(text,text,text,integer), public.revoke_shortcut_device(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shortcut_metadata(text), public.shortcut_record(text,jsonb) TO anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
-- Publication is managed by Supabase; do not create or replace it here.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_publication WHERE pubname='supabase_realtime')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_publication_tables
  WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='transactions') THEN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.transactions;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.export_transactions() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid := saldo_private.require_owner(); result jsonb;
BEGIN
 -- One aggregate statement/read snapshot; scalar JSON is not a REST row page.
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.occurred_at,t.id),'[]'::jsonb)
 INTO result FROM public.transactions t WHERE t.user_id=u;
 RETURN result;
END $$;
ALTER FUNCTION public.export_transactions() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.export_transactions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.export_transactions() TO authenticated;
COMMIT;
