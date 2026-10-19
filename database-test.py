#!/usr/bin/env python3
"""Real, disposable PostgreSQL integration tests; synthetic identities only.
Run as root in a Linux sandbox: /usr/bin/python3 database-test.py
Requires postgresql, python3-psycopg2. Never connects to Supabase.
"""
import concurrent.futures
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import tempfile
import threading
import unittest

import psycopg2
from psycopg2.extras import Json

HERE = Path(__file__).resolve().parent
A = '00000000-0000-4000-8000-000000000001'
B = '00000000-0000-4000-8000-000000000002'
DSN = None


def connect(role=None, uid=None):
    conn = psycopg2.connect(DSN)
    conn.autocommit = True
    if role:
        with conn.cursor() as cur:
            # Roles are fixed test constants, not external input.
            assert role in ('anon', 'authenticated')
            cur.execute('SET ROLE ' + role)
            cur.execute("SELECT set_config('request.jwt.claim.sub', %s, false)", (uid or '',))
    return conn


def query(sql, params=(), role='authenticated', uid=A):
    conn = connect(role, uid)
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall() if cur.description else []
    finally:
        conn.close()


def save(payload, revision, uid=A):
    return query('SELECT * FROM public.save_budget(%s::jsonb, %s::bigint)',
                 (Json(payload), revision), uid=uid)


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        query("DO $$ BEGIN IF to_regclass('public.budget_documents') IS NOT NULL THEN "
              "TRUNCATE public.budget_documents; END IF; END $$", role=None)

    def test_01_schema_contract(self):
        rows = query("SELECT to_regclass('public.budget_documents')", role=None)
        self.assertIsNotNone(rows[0][0], 'budget_documents must exist after deployment')
        columns = query("SELECT column_name, data_type, is_nullable FROM information_schema.columns "
                        "WHERE table_schema='public' AND table_name='budget_documents' "
                        "ORDER BY ordinal_position", role=None)
        self.assertEqual(columns, [('user_id', 'uuid', 'NO'), ('payload', 'jsonb', 'NO'),
                                   ('revision', 'bigint', 'NO'), ('updated_at', 'timestamp with time zone', 'NO')])

    def test_02_owner_save_read_and_revision_contract(self):
        rows = save({'synthetic': 'first'}, 0)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][:3], (A, {'synthetic': 'first'}, 1))
        self.assertIsNotNone(rows[0][3])
        self.assertEqual(query('SELECT * FROM public.budget_documents'), rows)
        self.assertEqual(query('SELECT * FROM public.budget_documents', uid=B), [])
        with self.assertRaisesRegex(psycopg2.Error, 'SALDO_CONFLICT'):
            save({'synthetic': 'foreign'}, 1, uid=B)
        self.assertEqual(query('SELECT * FROM public.budget_documents'), rows)
        # An owner field inside JSON is inert data, never the document owner.
        forged = save({'user_id': A, 'synthetic': 'B'}, 0, uid=B)
        self.assertEqual(forged[0][0], B)
        with self.assertRaisesRegex(psycopg2.Error, 'SALDO_CONFLICT'):
            save({'synthetic': 'duplicate'}, 0)
        with self.assertRaisesRegex(psycopg2.Error, 'SALDO_CONFLICT'):
            save({'synthetic': 'stale'}, 9)
        self.assertEqual(query('SELECT * FROM public.budget_documents'), rows)
        fresh = save({'synthetic': 'fresh'}, 1)
        self.assertEqual(fresh[0][:3], (A, {'synthetic': 'fresh'}, 2))
        self.assertGreaterEqual(fresh[0][3], rows[0][3])
        with self.assertRaisesRegex(psycopg2.Error, 'SALDO_CONFLICT'):
            save({'synthetic': 'stale'}, 1)
        self.assertEqual(query('SELECT * FROM public.budget_documents'), fresh)

    def test_03_validation_rejects_without_changing_document(self):
        original = save({'synthetic': 'preserve'}, 0)
        for payload in [None, [], 'text', 1, True]:
            with self.subTest(payload=payload):
                with self.assertRaisesRegex(psycopg2.Error, 'SALDO_INVALID_PAYLOAD'):
                    save(payload, 1)
        with self.assertRaisesRegex(psycopg2.Error, 'SALDO_INVALID_PAYLOAD'):
            query('SELECT * FROM public.save_budget(NULL, 1)')
        for revision in [None, -1]:
            with self.subTest(revision=revision):
                with self.assertRaisesRegex(psycopg2.Error, 'SALDO_INVALID_REVISION'):
                    save({}, revision)
        with self.assertRaisesRegex(psycopg2.Error, 'SALDO_UNAUTHENTICATED'):
            save({}, 0, uid=None)
        self.assertEqual(query('SELECT * FROM public.budget_documents'), original)

    def test_04_payload_size_limit_in_bytes(self):
        # jsonb::text for this object has 9 bytes of framing: {"x": "..."}.
        boundary = {'x': 'a' * (2 * 1024 * 1024 - 9)}
        self.assertEqual(query('SELECT octet_length(%s::jsonb::text)', (Json(boundary),))[0][0],
                         2 * 1024 * 1024)
        saved = save(boundary, 0)
        with self.assertRaisesRegex(psycopg2.Error, 'SALDO_PAYLOAD_TOO_LARGE'):
            save({'x': boundary['x'] + 'a'}, 1)
        # Multibyte text must count bytes, not characters.
        with self.assertRaisesRegex(psycopg2.Error, 'SALDO_PAYLOAD_TOO_LARGE'):
            save({'x': '界' * 800000}, 1)
        self.assertEqual(query('SELECT * FROM public.budget_documents'), saved)

    def test_05_anonymous_and_direct_writes_denied(self):
        original = save({'synthetic': 'protected'}, 0)
        for sql in ['SELECT * FROM public.budget_documents',
                    "SELECT * FROM public.save_budget('{}'::jsonb, 0)"]:
            with self.subTest(sql=sql):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    query(sql, role='anon', uid=A)
        for sql in ["UPDATE public.budget_documents SET revision=999",
                    "INSERT INTO public.budget_documents VALUES ('" + B + "', '{}', 999, now())",
                    'DELETE FROM public.budget_documents',
                    'TRUNCATE public.budget_documents']:
            with self.subTest(sql=sql):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    query(sql)
        self.assertEqual(query('SELECT * FROM public.budget_documents'), original)
        self.assertEqual(query('SELECT * FROM public.budget_documents', uid=None), [])
        with self.assertRaises(psycopg2.errors.UndefinedFunction):
            query("SELECT * FROM public.save_budget('{}'::jsonb, 0, %s::uuid)", (B,))

    def test_06_security_metadata_and_foreign_key(self):
        metadata = query("SELECT p.prosecdef, p.proretset, p.proconfig, r.rolname, "
                         "pg_get_function_result(p.oid) FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner "
                         "WHERE p.oid='public.save_budget(jsonb,bigint)'::regprocedure", role=None)[0]
        self.assertEqual(metadata, (True, True, ['search_path=""'], 'postgres', 'SETOF budget_documents'))
        self.assertTrue(query("SELECT relrowsecurity FROM pg_class "
                              "WHERE oid='public.budget_documents'::regclass", role=None)[0][0])
        for role in ['anon', 'authenticated']:
            for privilege in ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']:
                self.assertFalse(query('SELECT has_table_privilege(%s, %s, %s)',
                                       (role, 'public.budget_documents', privilege), role=None)[0][0])
        with self.assertRaises(psycopg2.errors.ForeignKeyViolation):
            save({}, 0, uid='00000000-0000-4000-8000-000000000099')

    def test_07_redeploy_preserves_data_and_permissions(self):
        original = save({'synthetic': 'redeploy'}, 0)
        query((HERE / 'database.sql').read_text(), role=None)
        query((HERE / 'database.sql').read_text(), role=None)
        self.assertEqual(query('SELECT * FROM public.budget_documents'), original)
        self.assertEqual(query('SELECT * FROM public.budget_documents', uid=B), [])
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            query('UPDATE public.budget_documents SET revision=999')
        self.assertEqual(save({'synthetic': 'after-redeploy'}, 1)[0][2], 2)

    def race(self, expected_revision):
        barrier = threading.Barrier(8)
        def attempt(index):
            conn = connect('authenticated', A)
            conn.autocommit = False
            try:
                with conn.cursor() as cur:
                    cur.execute("SET statement_timeout='10s'")
                    barrier.wait(timeout=10)
                    cur.execute('SELECT * FROM public.save_budget(%s::jsonb, %s::bigint)',
                                (Json({'synthetic_winner': index}), expected_revision))
                    rows = cur.fetchall()
                    # Hold winning row lock so other connections contend before commit.
                    cur.execute('SELECT pg_sleep(0.05)')
                    conn.commit()
                    return ('saved', rows)
            except psycopg2.Error as exc:
                conn.rollback()
                if exc.pgcode == 'P0001' and exc.diag.message_primary == 'SALDO_CONFLICT':
                    return ('conflict', None)
                raise
            finally:
                conn.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            outcomes = list(pool.map(attempt, range(8)))
        self.assertEqual(sum(status == 'saved' for status, _ in outcomes), 1)
        self.assertEqual(sum(status == 'conflict' for status, _ in outcomes), 7)
        winner = next(rows for status, rows in outcomes if status == 'saved')
        self.assertEqual(query('SELECT * FROM public.budget_documents'), winner)
        self.assertEqual(winner[0][2], expected_revision + 1)

    def test_08_concurrent_initial_creates_one_document(self):
        self.race(0)

    def test_09_concurrent_updates_commit_once(self):
        save({'synthetic': 'initial'}, 0)
        self.race(1)


def main():
    global DSN
    if os.geteuid() != 0:
        raise SystemExit('Run as root inside a disposable Linux sandbox (not on a production host).')
    pg_bin = subprocess.check_output(['pg_config', '--bindir'], text=True).strip()
    tmp = Path(tempfile.mkdtemp(prefix='saldo-pg-test-'))
    account = pwd.getpwnam('postgres')
    os.chown(tmp, account.pw_uid, account.pw_gid)
    def pg(*args):
        subprocess.run(['runuser', '-u', 'postgres', '--', *args], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    started = False
    try:
        pg(pg_bin + '/initdb', '-D', str(tmp / 'data'), '-A', 'trust', '--no-locale', '-E', 'UTF8')
        pg(pg_bin + '/pg_ctl', '-D', str(tmp / 'data'), '-l', str(tmp / 'server.log'),
           '-o', f"-F -k {tmp} -p 55439 -c listen_addresses=''", '-w', 'start')
        started = True
        DSN = f'host={tmp} port=55439 dbname=postgres user=postgres'
        query('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE SCHEMA auth; '
              'CREATE TABLE auth.users (id uuid PRIMARY KEY); '
              'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated; '
              "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ "
              "SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$; "
              'GRANT USAGE ON SCHEMA auth TO authenticated; '
              'GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated; '
              'INSERT INTO auth.users VALUES (%s), (%s)', (A, B), role=None)
        schema = HERE / 'database.sql'
        if schema.exists():
            query(schema.read_text(), role=None)
        print('PostgreSQL:', query('SHOW server_version', role=None)[0][0], flush=True)
        print('Isolated socket-only cluster; synthetic auth users; no external connection.', flush=True)
        result = unittest.main(exit=False).result
        return 0 if result.wasSuccessful() else 1
    finally:
        if started:
            pg(pg_bin + '/pg_ctl', '-D', str(tmp / 'data'), '-m', 'immediate', '-w', 'stop')
        shutil.rmtree(tmp)


if __name__ == '__main__':
    raise SystemExit(main())
