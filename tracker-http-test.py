#!/usr/bin/env python3
"""Run only local, synthetic SDK/Edge -> real PostgREST -> disposable PostgreSQL.
Requires Linux root sandbox, PostgreSQL 17, psycopg2, node_modules, postgrest.
Run: /usr/bin/python3 tracker-http-test.py
--red-transport proves the first real SDK save assertion fails without a server.
No secrets are fixed, printed, written to files, or sent outside loopback.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

import psycopg2

HERE = Path(__file__).resolve().parent
A = '11111111-1111-4111-8111-111111111111'
B = '22222222-2222-4222-8222-222222222222'


def signed_jwt(secret, uid):
    def part(value):
        return base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).rstrip(b'=')
    now = int(time.time())
    message = part({'alg': 'HS256', 'typ': 'JWT'}) + b'.' + part({
        'role': 'authenticated', 'sub': uid, 'iat': now, 'exp': now + 600})
    signature = base64.urlsafe_b64encode(hmac.new(secret.encode(), message, hashlib.sha256).digest()).rstrip(b'=')
    return (message + b'.' + signature).decode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--red-transport', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Run only as root in a disposable Linux sandbox.')
    for command in ['node', 'postgrest', 'pg_config', 'runuser']:
        if not shutil.which(command):
            raise SystemExit(f'Missing required real executable: {command}; no mock fallback.')
    pg_bin = subprocess.check_output(['pg_config', '--bindir'], text=True).strip()
    print(subprocess.check_output(['postgrest', '--version'], text=True).strip(), flush=True)
    print(subprocess.check_output([pg_bin + '/postgres', '--version'], text=True).strip(), flush=True)
    print(subprocess.check_output(['node', '--version'], text=True).strip(), flush=True)
    tmp = Path(tempfile.mkdtemp(prefix='saldo-http-', dir='/tmp'))
    account = pwd.getpwnam('postgres')
    os.chown(tmp, account.pw_uid, account.pw_gid)
    started = False
    postgrest = None
    conn = None
    log = None

    def pg(*arguments):
        return subprocess.run(['runuser', '-u', 'postgres', '--', *arguments], check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    try:
        pg(pg_bin + '/initdb', '-D', str(tmp / 'data'), '-A', 'trust', '--no-locale', '-E', 'UTF8')
        pg(pg_bin + '/pg_ctl', '-D', str(tmp / 'data'), '-l', str(tmp / 'postgres.log'),
           '-o', f"-F -k {tmp} -p 55437 -c listen_addresses=''", '-w', 'start')
        started = True
        dsn = f'host={tmp} port=55437 dbname=postgres user=postgres'
        conn = psycopg2.connect(dsn)
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; '
                        'CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); '
                        "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ "
                        "SELECT COALESCE(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub', "
                        "nullif(current_setting('request.jwt.claim.sub',true),''))::uuid $$; "
                        'GRANT USAGE ON SCHEMA auth TO authenticated; '
                        'GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated; '
                        'INSERT INTO auth.users VALUES (%s),(%s)', (A, B))
            cur.execute((HERE / 'database.sql').read_text())
            cur.execute((HERE / 'migrations/002_tracker.sql').read_text())
            cur.execute("SELECT to_regprocedure('public.assign_transaction(uuid,text,text)') IS NOT NULL")
            assert cur.fetchone()[0], 'Assignment SQL must be ready; do not skip missing RPC'
            cur.execute('SHOW listen_addresses')
            assert cur.fetchone()[0] == '', 'PostgreSQL must be socket-only'
            cur.execute("SHOW server_version_num")
            assert 170000 <= int(cur.fetchone()[0]) < 180000, 'Requires real PostgreSQL 17'
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        rest = f'http://127.0.0.1:{port}'
        secret = secrets.token_urlsafe(48)
        env = {k: v for k, v in os.environ.items() if not k.startswith('PGRST_')}
        # These are runtime-only synthetic test credentials; no Supabase project.
        env.update(PGRST_DB_URI=f'postgresql://postgres@/postgres?host={tmp}&port=55437',
                   PGRST_DB_SCHEMAS='public', PGRST_DB_ANON_ROLE='anon', PGRST_JWT_SECRET=secret,
                   PGRST_SERVER_HOST='127.0.0.1', PGRST_SERVER_PORT=str(port),
                   PGRST_DB_MAX_ROWS='5', PGRST_LOG_LEVEL='crit')
        if not args.red_transport:
            log = (tmp / 'postgrest.log').open('w+')
            postgrest = subprocess.Popen(['postgrest'], env=env, stdout=log, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if postgrest.poll() is not None:
                    log.seek(0)
                    raise RuntimeError('Real PostgREST startup failed: ' + log.read())
                try:
                    with urllib.request.urlopen(rest + '/', timeout=0.5) as response:
                        if response.status == 200:
                            break
                except (urllib.error.URLError, TimeoutError):
                    time.sleep(0.1)
            else:
                raise RuntimeError('Real PostgREST health check exceeded 20 seconds')
        node_env = os.environ.copy()
        node_env.update(LOCAL_REST_URL=rest, JWT_A=signed_jwt(secret, A), JWT_B=signed_jwt(secret, B),
                        API_PUB='sb_publishable_SYNTHETIC_LOCAL_ONLY', LOCAL_PG_DSN=dsn)
        print('Synthetic identities only; socket-only PG; HTTP loopback; REST row cap 5.', flush=True)
        result = subprocess.run(['node', str(HERE / 'tracker-http-probe.mjs')], cwd=HERE,
                                env=node_env, timeout=90, capture_output=args.red_transport, text=True)
        if args.red_transport:
            print(result.stdout, end='')
            print(result.stderr, end='')
            assert result.returncode != 0, 'Negative control must fail the real SDK save assertion'
            assert 'FAIL real signed-JWT SDK saves independent revision-1 owner documents' in result.stderr
            assert 'fetch failed' in result.stderr and 'ECONNREFUSED' in result.stderr
            assert 'PASS ' not in result.stdout, 'Negative control must fail before any success'
            print('EXPECTED RED: first revision-1 SDK save assertion failed with transport absent.', flush=True)
            return 0
        assert result.returncode == 0, f'Real protocol probe failed: exit {result.returncode}'
        with conn.cursor() as cur:
            cur.execute('SELECT user_id::text,count(*) FROM public.transactions GROUP BY user_id ORDER BY user_id')
            assert cur.fetchall() == [(A, 6)], 'Independent final SQL count must match SDK/Edge assertions'
            cur.execute('SELECT user_id::text,revision FROM public.budget_documents ORDER BY user_id')
            assert cur.fetchall() == [(A, 1), (B, 1)]
        print('PASS independent SQL verification: A=6 rows, B=0; both plan revisions=1.', flush=True)
        return 0
    finally:
        if conn:
            conn.close()
        if postgrest:
            if postgrest.poll() is None:
                postgrest.terminate()
            try:
                postgrest.wait(timeout=10)
            except subprocess.TimeoutExpired:
                postgrest.kill()
                postgrest.wait(timeout=5)
            assert postgrest.poll() is not None, 'PostgREST process leaked'
        if log:
            log.close()
        if started:
            pg(pg_bin + '/pg_ctl', '-D', str(tmp / 'data'), '-m', 'immediate', '-w', 'stop')
            assert not (tmp / 'data/postmaster.pid').exists(), 'PostgreSQL process leaked'
        shutil.rmtree(tmp)
        assert not tmp.exists(), 'Disposable cluster directory leaked'
        print('CLEANUP verified: PostgREST stopped, PostgreSQL stopped, temp cluster removed.', flush=True)


if __name__ == '__main__':
    raise SystemExit(main())
