#!/usr/bin/env python3
"""Socket-only disposable PostgreSQL tracker contracts. Synthetic users/data only."""
import importlib.util
from pathlib import Path
import unittest
import uuid
import concurrent.futures
import threading
import hashlib
import secrets
import sys
# Reusing the cluster harness must not create untracked bytecode artifacts.
sys.dont_write_bytecode = True
import psycopg2
from psycopg2.extras import Json

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('budget_tests', HERE / 'database-test.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
def q(sql, params=None, **kwargs):
    # psycopg2 must not interpret SQL LIKE '%' as parameter placeholders.
    return base.query(sql, params, **kwargs)
A, B = base.A, base.B
MIGRATION = HERE / 'migrations/002_tracker.sql'

class TrackerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if MIGRATION.exists():
            q(MIGRATION.read_text(), role=None)

    def setUp(self):
        q('TRUNCATE public.transactions, public.budget_documents', role=None)
        for table in ('shortcut_devices','owner_rate','device_rate'):
            if q('SELECT to_regclass(%s)',('saldo_private.'+table,),role=None)[0][0]:
                q('TRUNCATE saldo_private.'+table+' CASCADE',role=None)
        self.payload = {'accounts': [
            {'id':'bank','name':'Synthetic Bank','type':'bank'},
            {'id':'cash','name':'Synthetic Cash','type':'cash'},
            {'id':'wallet','name':'Wallet','type':'wallet'},
            {'id':'card','name':'Card','type':'card'},
            {'id':'invest','name':'Invest','type':'investment'},
            {'id':'recipient','name':'Recipient','type':'recipient'},
            {'id':'external','name':'External','type':'external'}],
            'salary':123, 'items':[{'paid':True}], 'transfers':[]}
        base.save(self.payload, 0)
        base.save({'accounts':[{'id':'foreign','name':'Other','type':'bank'}]}, 0, uid=B)

    def rpc(self, name, *args, uid=A, role='authenticated'):
        return q('SELECT public.' + name + '(' + ','.join(['%s']*len(args)) + ')',
            tuple(Json(x) if isinstance(x,dict) else x for x in args),uid=uid,role=role)[0][0]

    def entry(self, **changes):
        result = dict(request_id=str(uuid.uuid4()), type='expense', amount_cents=100,
            occurred_at='2026-10-31T18:00:00Z', time_zone='Asia/Kuala_Lumpur',
            from_account_id='bank', category='commitment')
        result.update(changes)
        return result

    def test_17_assign_unassigned_and_replay(self):
        before = q('SELECT * FROM public.budget_documents ORDER BY user_id',role=None)
        for kind in ('expense','income'):
            entry = self.entry(type=kind,from_account_id=None,category=None)
            original = self.rpc('record_transaction',entry)['transaction']
            pending = self.rpc('tracker_summary','2026-11')
            self.assertEqual(pending['unassigned_'+kind+'_cents'],100)
            updated = self.rpc('assign_transaction',original['id'],'bank','savings' if kind=='expense' else None)
            assigned = self.rpc('tracker_summary','2026-11')
            self.assertEqual(assigned['unassigned_'+kind+'_cents'],0)
            self.assertEqual(assigned['movements']['bank'],-100 if kind=='expense' else 0)
            self.assertEqual(updated['id'],original['id'])
            self.assertEqual(updated['from_account_id' if kind=='expense' else 'to_account_id'],'bank')
            self.assertEqual(updated['from_account_name' if kind=='expense' else 'to_account_name'],'Synthetic Bank')
            self.assertEqual(updated['canonical_entry'],original['canonical_entry'])
            replay = self.rpc('record_transaction',entry)
            self.assertTrue(replay['duplicate'])
            self.assertEqual(replay['transaction'],updated)
        summary = self.rpc('tracker_summary','2026-11')
        self.assertEqual(summary['unassigned_income_cents'],0)
        self.assertEqual(summary['unassigned_expense_cents'],0)
        self.assertEqual(summary['movements'],{'bank':0})
        self.assertEqual(q('SELECT count(*) FROM public.transactions')[0][0],2)
        rows=self.rpc('export_transactions')
        q(MIGRATION.read_text(),role=None)
        self.assertEqual(self.rpc('export_transactions'),rows)
        self.assertEqual(q('SELECT * FROM public.budget_documents ORDER BY user_id',role=None),before)

    def test_18_assign_guards_and_concurrent_once(self):
        row = self.rpc('record_transaction',self.entry(from_account_id=None))['transaction']
        for account in (None,'','missing','foreign','recipient','external'):
            with self.subTest(account=account), self.assertRaisesRegex(psycopg2.Error,'SALDO_ACCOUNT_CHANGED'):
                self.rpc('assign_transaction',row['id'],account,None)
        for category in ('bad',''):
            with self.assertRaisesRegex(psycopg2.Error,'SALDO_INVALID_ENTRY'):
                self.rpc('assign_transaction',row['id'],'bank',category)
        with self.assertRaisesRegex(psycopg2.Error,'SALDO_TRANSACTION_NOT_FOUND'):
            self.rpc('assign_transaction',row['id'],'foreign',None,uid=B)
        for kind in ('income','transfer','expense','void'):
            entry = self.entry(type='expense' if kind=='void' else kind)
            if kind=='income': entry.update(from_account_id=None,category=None)
            if kind=='transfer': entry.update(to_account_id='cash',category=None)
            if kind=='void': entry.update(from_account_id=None)
            target = self.rpc('record_transaction',entry)['transaction']
            if kind=='void': self.rpc('void_transaction',target['id'])
            with self.subTest(kind=kind), self.assertRaisesRegex(psycopg2.Error,'SALDO_INVALID_ENTRY'):
                self.rpc('assign_transaction',target['id'],'bank','savings' if kind=='income' else None)
        self.payload['accounts'][0]['name']='Current Bank'
        base.save(self.payload,1)
        before = q('SELECT * FROM public.budget_documents ORDER BY user_id',role=None)
        barrier = threading.Barrier(2)
        def assign(account):
            barrier.wait(timeout=10)
            try: return self.rpc('assign_transaction',row['id'],account,'entertainment')
            except psycopg2.Error as exc:
                self.assertIn('SALDO_INVALID_ENTRY',str(exc))
                return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(assign,('bank','cash')))
        winners=[r for r in results if r is not None]
        self.assertEqual(len(winners),1)
        self.assertEqual(winners[0]['from_account_name'], 'Current Bank' if winners[0]['from_account_id']=='bank' else 'Synthetic Cash')
        self.assertEqual(q('SELECT * FROM public.budget_documents ORDER BY user_id',role=None),before)

    def test_19_currency_validation(self):
        for value in ('USD',{},1,True,None):
            with self.subTest(currency=value), self.assertRaisesRegex(psycopg2.Error,'SALDO_INVALID_ENTRY'):
                self.rpc('record_transaction',self.entry(currency=value))
        self.assertEqual(self.rpc('record_transaction',self.entry(currency='MYR'))['transaction']['currency'],'MYR')
        self.assertEqual(q('SELECT count(*) FROM public.transactions')[0][0],1)

    def test_20_reserved_identity_fields_rejected(self):
        for field in ('owner','owner_id','user_id','source'):
            with self.subTest(field=field), self.assertRaisesRegex(psycopg2.Error,'SALDO_INVALID_ENTRY'):
                self.rpc('record_transaction',self.entry(**{field:B}))
        token,_ = self.device()
        self.assertEqual(self.rpc('shortcut_record',token,self.entry(user_id=B),role='anon'),{'error_code':'SALDO_INVALID_ENTRY'})
        self.assertEqual(q('SELECT count(*) FROM public.transactions')[0][0],0)

    def test_21_payload_byte_bound(self):
        entry=self.entry(ignored='界'*3000)
        self.assertGreater(q('SELECT pg_column_size(%s::jsonb)',(Json(entry),))[0][0],8192)
        with self.assertRaisesRegex(psycopg2.Error,'SALDO_INVALID_ENTRY'):
            self.rpc('record_transaction',entry)
        self.assertEqual(q('SELECT count(*) FROM public.transactions')[0][0],0)
        boundary=self.entry(ignored='')
        overhead=q('SELECT pg_column_size(%s::jsonb)',(Json(boundary),))[0][0]
        boundary['ignored']='x'*(8192-overhead)
        self.assertEqual(q('SELECT pg_column_size(%s::jsonb)',(Json(boundary),))[0][0],8192)
        self.assertFalse(self.rpc('record_transaction',boundary)['duplicate'])
        # JSONB alignment may absorb a byte; exceed a full alignment unit.
        boundary['ignored']+='xxxx'
        self.assertGreater(q('SELECT pg_column_size(%s::jsonb)',(Json(boundary),))[0][0],8192)
        with self.assertRaisesRegex(psycopg2.Error,'SALDO_INVALID_ENTRY'):
            self.rpc('record_transaction',boundary)

    def test_22_failed_shortcut_records_consume_quota(self):
        q("SELECT pg_sleep(CASE WHEN extract(second FROM clock_timestamp())>50 THEN 61-extract(second FROM clock_timestamp()) ELSE 0 END)",role=None)
        token,device=self.device()
        for _ in range(60):
            result=self.rpc('shortcut_record',token,{},role='anon')
            self.assertEqual(result,{'error_code':'SALDO_INVALID_ENTRY'})
        self.assertEqual(q('SELECT requests FROM saldo_private.device_rate WHERE device_id=%s',(device['id'],),role=None),[(60,)])
        self.assertEqual(q('SELECT requests FROM saldo_private.owner_rate',role=None),[(60,)])
        for name,args in [('shortcut_metadata',(token,)),('shortcut_record',(token,{}))]:
            with self.assertRaisesRegex(psycopg2.Error,'SALDO_RATE_LIMIT'):
                self.rpc(name,*args,role='anon')
        self.assertEqual(q('SELECT count(*) FROM public.transactions')[0][0],0)

    def test_23_failed_records_concurrent_quota(self):
        q("SELECT pg_sleep(CASE WHEN extract(second FROM clock_timestamp())>50 THEN 61-extract(second FROM clock_timestamp()) ELSE 0 END)",role=None)
        token,_=self.device()
        for _ in range(55):
            self.assertEqual(self.rpc('shortcut_record',token,{},role='anon'),{'error_code':'SALDO_INVALID_ENTRY'})
        barrier=threading.Barrier(16)
        def attempt(_):
            barrier.wait(timeout=10)
            try:
                self.assertEqual(self.rpc('shortcut_record',token,{},role='anon'),{'error_code':'SALDO_INVALID_ENTRY'})
                return 'counted'
            except psycopg2.Error as exc:
                self.assertIn('SALDO_RATE_LIMIT',str(exc))
                return 'limited'
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results=list(pool.map(attempt,range(16)))
        self.assertEqual(results.count('counted'),5)
        self.assertEqual(results.count('limited'),11)
        self.assertEqual(q('SELECT requests FROM saldo_private.device_rate',role=None),[(60,)])
        self.assertEqual(q('SELECT requests FROM saldo_private.owner_rate',role=None),[(60,)])
        self.assertEqual(q('SELECT count(*) FROM public.transactions')[0][0],0)

    def test_24_shortcut_error_envelope_and_replay(self):
        token,_=self.device()
        invalid_entries=(None, [], self.entry(currency='USD'),self.entry(currency={}),
            self.entry(ignored='x'*9000),self.entry(owner=A),self.entry(source='app'))
        for entry in invalid_entries:
            result=q('SELECT public.shortcut_record(%s,%s::jsonb)',(token,Json(entry)),role='anon')[0][0]
            self.assertEqual(result,{'error_code':'SALDO_INVALID_ENTRY'})
        self.assertEqual(self.rpc('shortcut_record',token,self.entry(from_account_id='missing'),role='anon'),{'error_code':'SALDO_ACCOUNT_CHANGED'})
        entry=self.entry(from_account_id=None)
        first=self.rpc('shortcut_record',token,entry,role='anon')['transaction']
        self.assertEqual(self.rpc('shortcut_record',token,dict(entry,amount_cents=101),role='anon'),{'error_code':'SALDO_DUPLICATE_CONFLICT'})
        assigned=self.rpc('assign_transaction',first['id'],'cash','entertainment')
        replay=self.rpc('shortcut_record',token,entry,role='anon')
        self.assertTrue(replay['duplicate'])
        self.assertEqual(replay['transaction'],assigned)
        self.assertEqual(q('SELECT count(*) FROM public.transactions')[0][0],1)
        self.assertEqual(q('SELECT requests FROM saldo_private.owner_rate',role=None),[(len(invalid_entries)+4,)])

    def test_25_shortcut_generic_error_sanitized_and_rolled_back(self):
        token,_=self.device()
        before=q('SELECT * FROM public.budget_documents ORDER BY user_id',role=None)
        # A genuine post-insert SQL failure proves the inner savepoint rolls back
        # both the ledger row and other side effects, but not authorization quota.
        q("CREATE FUNCTION public.tracker_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ "
          "BEGIN UPDATE public.budget_documents SET payload='{}'::jsonb; "
          "RAISE EXCEPTION 'secret SQL/token detail'; END $$; "
          "CREATE TRIGGER tracker_test_failure AFTER INSERT ON public.transactions "
          "FOR EACH ROW EXECUTE FUNCTION public.tracker_test_failure()",role=None)
        try:
            self.assertEqual(self.rpc('shortcut_record',token,self.entry(),role='anon'),{'error_code':'SALDO_TRACKER_ERROR'})
            self.assertEqual(q('SELECT count(*) FROM public.transactions')[0][0],0)
            self.assertEqual(q('SELECT * FROM public.budget_documents ORDER BY user_id',role=None),before)
            self.assertEqual(q('SELECT requests FROM saldo_private.owner_rate',role=None),[(1,)])
            self.assertEqual(q('SELECT requests FROM saldo_private.device_rate',role=None),[(1,)])
        finally:
            q('DROP TRIGGER tracker_test_failure ON public.transactions; DROP FUNCTION public.tracker_test_failure()',role=None)

    def test_02_record_metadata_canonical_and_preserve_budget(self):
        before = q('SELECT * FROM public.budget_documents ORDER BY user_id',role=None)
        metadata = self.rpc('tracker_metadata')
        self.assertEqual([x['id'] for x in metadata['accounts']], ['bank','cash','wallet','card','invest'])
        self.assertEqual(metadata['categories'], ['commitment','entertainment','savings'])
        entry = self.entry()
        ack = self.rpc('record_transaction',entry)
        self.assertFalse(ack['duplicate'])
        row = ack['transaction']
        self.assertEqual(row['user_id'], A)
        self.assertEqual(row['entry_date'], '2026-11-01')
        self.assertEqual(row['from_account_name'], 'Synthetic Bank')
        self.assertEqual(row['currency'], 'MYR')
        self.assertEqual(row['source'], 'app')
        replay = dict(entry, occurred_at='2026-11-01T02:00:00+08:00', note=None)
        self.assertTrue(self.rpc('record_transaction',replay)['duplicate'])
        with self.assertRaisesRegex(psycopg2.Error, 'SALDO_DUPLICATE_CONFLICT'):
            self.rpc('record_transaction',dict(entry,amount_cents=101))
        self.assertEqual(q('SELECT * FROM public.transactions',uid=B), [])
        self.assertEqual(q('SELECT * FROM public.transactions',uid=None), [])
        self.assertEqual(q('SELECT * FROM public.budget_documents ORDER BY user_id',role=None),before)

    def test_03_summary_unassigned_transfer_void(self):
        expense = self.rpc('record_transaction',self.entry())['transaction']
        self.rpc('record_transaction',self.entry(type='income',from_account_id=None,to_account_id='bank',category=None,amount_cents=1000))
        self.rpc('record_transaction',self.entry(type='transfer',to_account_id='cash',category=None,amount_cents=250))
        self.rpc('record_transaction',self.entry(from_account_id=None,amount_cents=70))
        self.rpc('record_transaction',self.entry(type='income',from_account_id=None,category=None,amount_cents=90))
        expected = dict(income_cents=1090,expense_cents=170,transfer_cents=250,
            unassigned_income_cents=90,unassigned_expense_cents=70,movements={'bank':650,'cash':250})
        self.assertEqual(self.rpc('tracker_summary','2026-11'), expected)
        zero = dict(income_cents=0,expense_cents=0,transfer_cents=0,
            unassigned_income_cents=0,unassigned_expense_cents=0,movements={})
        self.assertEqual(self.rpc('tracker_summary','2026-10'), zero)
        self.assertEqual(self.rpc('tracker_summary','2026-11',uid=B), zero)
        with self.assertRaisesRegex(psycopg2.Error,'SALDO_TRANSACTION_NOT_FOUND'):
            self.rpc('void_transaction',expense['id'],uid=B)
        voided = self.rpc('void_transaction',expense['id'])
        self.assertIsNotNone(voided['voided_at'])
        self.assertEqual(self.rpc('void_transaction',expense['id']),voided)
        expected.update(expense_cents=70,movements={'bank':750,'cash':250})
        self.assertEqual(self.rpc('tracker_summary','2026-11'),expected)
        for month in ('2026-1','2026-13','2026-00','bad',None):
            with self.subTest(month=month), self.assertRaisesRegex(psycopg2.Error,'SALDO_INVALID_ENTRY'):
                self.rpc('tracker_summary',month)

    def device(self, **changes):
        token = 'sld_' + secrets.token_urlsafe(32)
        args = dict(name='Synthetic Phone', token_hash=hashlib.sha256(token.encode()).hexdigest(),
            time_zone='Asia/Kuala_Lumpur', days=90)
        args.update(changes)
        return token, self.rpc('create_shortcut_device',args['name'],args['token_hash'],args['time_zone'],args['days'])

    def test_04_devices_hash_only_idempotent_and_capability(self):
        token, device = self.device()
        digest = hashlib.sha256(token.encode()).hexdigest()
        again = self.rpc('create_shortcut_device','Retry Name',digest,'UTC',365)
        self.assertEqual(again,device)
        self.assertEqual(self.rpc('list_shortcut_devices'),[device])
        self.assertEqual(self.rpc('list_shortcut_devices',uid=B),[])
        self.assertNotIn('token_hash',device)
        self.assertNotIn('token',device)
        self.assertEqual(q('SELECT token_hash FROM saldo_private.shortcut_devices',role=None),[(digest,)])
        for role in ('anon','authenticated'):
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                q('SELECT * FROM saldo_private.shortcut_devices',role=role)
        meta = self.rpc('shortcut_metadata',token,role='anon',uid=B)
        self.assertEqual(meta,dict(self.rpc('tracker_metadata'),time_zone='Asia/Kuala_Lumpur'))
        ack = self.rpc('shortcut_record',token,self.entry(time_zone='UTC'),role='anon',uid=B)
        self.assertEqual(ack['transaction']['user_id'],A)
        self.assertEqual(ack['transaction']['source'],'shortcut')
        self.assertEqual(ack['transaction']['entry_date'],'2026-11-01')
        self.assertFalse(self.rpc('revoke_shortcut_device',device['id'],uid=B))
        self.assertTrue(self.rpc('revoke_shortcut_device',device['id']))
        self.assertTrue(self.rpc('revoke_shortcut_device',device['id']))
        for rpc,args in [('shortcut_metadata',(token,)),('shortcut_record',(token,self.entry()))]:
            with self.assertRaisesRegex(psycopg2.Error,'SALDO_DEVICE_UNAUTHORIZED'):
                self.rpc(rpc,*args,role='anon')
        expired, device = self.device()
        q("UPDATE saldo_private.shortcut_devices SET expires_at=now()-interval '1 second' WHERE id=%s",(device['id'],),role=None)
        with self.assertRaisesRegex(psycopg2.Error,'SALDO_DEVICE_UNAUTHORIZED'):
            self.rpc('shortcut_metadata',expired,role='anon')
        for bad in (None,'',token+'x','sld_'+'!'*43):
            with self.assertRaisesRegex(psycopg2.Error,'SALDO_DEVICE_UNAUTHORIZED'):
                self.rpc('shortcut_metadata',bad,role='anon')

    def test_05_rate_device_concurrent_owner_shared(self):
        # Avoid a fixed-window boundary during the real concurrency assertion.
        q("SELECT pg_sleep(CASE WHEN extract(second FROM clock_timestamp())>50 THEN 61-extract(second FROM clock_timestamp()) ELSE 0 END)",role=None)
        token, device = self.device()
        for _ in range(55):
            self.rpc('shortcut_metadata',token,role='anon')
        barrier = threading.Barrier(16)
        def attempt(_):
            barrier.wait(timeout=10)
            try:
                self.rpc('shortcut_metadata',token,role='anon')
                return 'ok'
            except psycopg2.Error as exc:
                if 'SALDO_RATE_LIMIT' in str(exc): return 'limited'
                raise
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(attempt,range(16)))
        self.assertEqual(results.count('ok'),5)
        self.assertEqual(results.count('limited'),11)
        token2, _ = self.device()
        for _ in range(60): self.rpc('shortcut_metadata',token2,role='anon')
        token3, _ = self.device()
        with self.assertRaisesRegex(psycopg2.Error,'SALDO_RATE_LIMIT'):
            self.rpc('shortcut_record',token3,self.entry(),role='anon')
        self.assertEqual(q('SELECT count(*) FROM public.transactions')[0][0],0)
        self.assertEqual(q('SELECT requests FROM saldo_private.owner_rate',role=None),[(120,)])
        # The next server-side window resets both bounded rows, not history growth.
        q("UPDATE saldo_private.owner_rate SET window_start=window_start-interval '1 minute'; UPDATE saldo_private.device_rate SET window_start=window_start-interval '1 minute'",role=None)
        self.rpc('shortcut_record',token3,self.entry(),role='anon')
        self.assertEqual(q('SELECT requests FROM saldo_private.owner_rate',role=None),[(1,)])

    def test_06_redeploy_data_devices_and_publication(self):
        ack = self.rpc('record_transaction',self.entry())
        token, device = self.device()
        original = q('SELECT * FROM public.budget_documents ORDER BY user_id',role=None)
        q(MIGRATION.read_text(),role=None)
        self.assertEqual(q("SELECT count(*) FROM pg_publication WHERE pubname='supabase_realtime'",role=None)[0][0],0)
        q('CREATE PUBLICATION supabase_realtime',role=None)
        try:
            q(MIGRATION.read_text(),role=None)
            q(MIGRATION.read_text(),role=None)
            self.assertEqual(q("SELECT count(*) FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='transactions'",role=None)[0][0],1)
            self.assertEqual(self.rpc('list_shortcut_devices'),[device])
            self.assertEqual(q('SELECT to_jsonb(t) FROM public.transactions t')[0][0],ack['transaction'])
            self.assertEqual(q('SELECT * FROM public.budget_documents ORDER BY user_id',role=None),original)
            self.rpc('shortcut_metadata',token,role='anon')
        finally:
            q('DROP PUBLICATION supabase_realtime',role=None)

    def test_07_invalid_entry_matrix(self):
        cases = [None, [], 'text', 3, True]
        for field, values in {
            'amount_cents':[None,0,-1,10000000001,1.1,'100',True,{},10**60],
            'request_id':[None,'not-a-uuid',42],
            'type':[None,'payment',True],
            'occurred_at':[None,'now','infinity','2026-10-01','2026-10-01T12:00:00','2026-13-01T00:00:00Z',"2026-01-01T00:00:00Z';DROP TABLE x;--"],
            'time_zone':['Not/AZone',"UTC'; SELECT 1;--",'+08:00',True],
            'from_account_id':['',True,{}],
            'external_party':['x'*161,True],
            'note':['x'*501,42],
            'category':['other',True],
            'to_account_id':['cash']
        }.items():
            cases.extend(self.entry(**{field:value}) for value in values)
        cases += [self.entry(type='income'),self.entry(type='transfer',category=None),
            self.entry(type='transfer',to_account_id='bank',category=None),
            self.entry(type='income',from_account_id=None,category='savings')]
        for entry in cases:
            with self.subTest(entry=entry), self.assertRaisesRegex(psycopg2.Error,'SALDO_INVALID_ENTRY'):
                q('SELECT public.record_transaction(%s::jsonb)',(Json(entry),))
        self.assertEqual(q('SELECT count(*) FROM public.transactions')[0][0],0)
        valid = self.entry(amount_cents=10000000000,external_party='x'*160,note='x'*500)
        valid.pop('time_zone')
        self.assertEqual(self.rpc('record_transaction',valid)['transaction']['time_zone'],'UTC')

    def test_08_foreign_nonfinancial_account_rejected_snapshots_stable(self):
        for account in ('foreign','missing','recipient','external'):
            for entry in (self.entry(from_account_id=account),
                self.entry(type='income',from_account_id=None,to_account_id=account,category=None),
                self.entry(type='transfer',to_account_id=account,category=None)):
                with self.subTest(account=account), self.assertRaisesRegex(psycopg2.Error,'SALDO_ACCOUNT_CHANGED'):
                    self.rpc('record_transaction',entry)
        entry = self.entry()
        ack = self.rpc('record_transaction',entry)
        self.payload['accounts'][0]['name']='Renamed'
        base.save(self.payload,1)
        self.assertEqual(self.rpc('record_transaction',entry)['transaction'],ack['transaction'])
        self.payload['accounts']=[]
        base.save(self.payload,2)
        self.assertTrue(self.rpc('record_transaction',entry)['duplicate'])
        with self.assertRaisesRegex(psycopg2.Error,'SALDO_ACCOUNT_CHANGED'):
            self.rpc('record_transaction',self.entry())

    def test_09_duplicate_concurrent_once_and_conflict(self):
        entry = self.entry()
        barrier = threading.Barrier(8)
        def attempt(_):
            barrier.wait(timeout=10)
            return self.rpc('record_transaction',entry)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results=list(pool.map(attempt,range(8)))
        self.assertEqual(sum(not x['duplicate'] for x in results),1)
        self.assertEqual(len({x['transaction']['id'] for x in results}),1)
        self.assertEqual(self.rpc('tracker_summary','2026-11')['expense_cents'],100)
        for field,value in dict(amount_cents=101,note='changed',time_zone='UTC',category='savings',external_party='new',from_account_id='cash').items():
            with self.subTest(field=field), self.assertRaisesRegex(psycopg2.Error,'SALDO_DUPLICATE_CONFLICT'):
                self.rpc('record_transaction',dict(entry,**{field:value}))
        # Idempotency is scoped to owner, not global request IDs.
        own_other=dict(entry,from_account_id='foreign')
        self.assertFalse(self.rpc('record_transaction',own_other,uid=B)['duplicate'])
        self.assertEqual(q('SELECT count(*) FROM public.transactions',role=None)[0][0],2)

    def test_10_rpc_security_acl_and_no_auth(self):
        auth_rpcs = [('tracker_metadata',()),('record_transaction',(self.entry(),)),
            ('export_transactions',()),('tracker_summary',('2026-11',)),('list_shortcut_devices',()),
            ('create_shortcut_device',('Phone','a'*64,'UTC',90)),
            ('revoke_shortcut_device',(str(uuid.uuid4()),)),('void_transaction',(str(uuid.uuid4()),)),
            ('assign_transaction',(str(uuid.uuid4()),'bank',None))]
        for name,args in auth_rpcs:
            with self.subTest(name=name):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.rpc(name,*args,role='anon')
                with self.assertRaisesRegex(psycopg2.Error,'SALDO_UNAUTHENTICATED'):
                    self.rpc(name,*args,uid=None)
        rows=q("SELECT p.proname,p.prosecdef,p.proconfig,r.rolname, n.nspname, "
            "has_function_privilege('anon',p.oid,'EXECUTE'),has_function_privilege('authenticated',p.oid,'EXECUTE') "
            "FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner "
            "WHERE n.nspname='saldo_private' OR (n.nspname='public' AND p.proname IN "
            "('tracker_metadata','record_transaction','tracker_summary','list_shortcut_devices','create_shortcut_device','revoke_shortcut_device','void_transaction','shortcut_metadata','shortcut_record','export_transactions','assign_transaction'))",role=None)
        self.assertEqual(len(rows),16)
        for name,definer,config,owner,schema,anon,authenticated in rows:
            with self.subTest(function=name):
                self.assertTrue(definer)
                self.assertEqual(config,['search_path=""'])
                self.assertEqual(owner,'postgres')
                self.assertEqual(anon,name in ('shortcut_metadata','shortcut_record'))
                self.assertEqual(authenticated,schema=='public')
        self.assertEqual(q("SELECT provolatile FROM pg_proc WHERE oid='saldo_private.device_metadata(saldo_private.shortcut_devices)'::regprocedure",role=None)[0][0],'s')
        self.assertTrue(q("SELECT relrowsecurity FROM pg_class WHERE oid='public.transactions'::regclass",role=None)[0][0])
        for role in ('anon','authenticated'):
            self.assertFalse(q("SELECT has_schema_privilege(%s,'saldo_private','USAGE')",(role,),role=None)[0][0])
            for table in ('shortcut_devices','owner_rate','device_rate'):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    q('SELECT * FROM saldo_private.'+table,role=role)
        for sql in ("UPDATE public.transactions SET amount_cents=999",'DELETE FROM public.transactions',
            'TRUNCATE public.transactions',"INSERT INTO public.transactions DEFAULT VALUES"):
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege): q(sql)
        with self.assertRaises(psycopg2.errors.ForeignKeyViolation):
            self.rpc('record_transaction',self.entry(from_account_id=None),uid='00000000-0000-4000-8000-000000000099')

    def test_11_device_validation_and_default_expiry(self):
        for changes in ({'name':None},{'name':''},{'name':'x'*81},{'token_hash':'x'*64},
            {'time_zone':'No/Zone'},{'time_zone':None},{'days':None},{'days':0},{'days':366}):
            with self.subTest(changes=changes), self.assertRaisesRegex(psycopg2.Error,'SALDO_INVALID_ENTRY'):
                self.device(**changes)
        token='sld_'+secrets.token_urlsafe(32)
        digest=hashlib.sha256(token.encode()).hexdigest()
        device=self.rpc('create_shortcut_device','x'*80,digest,'UTC')
        self.assertEqual(q('SELECT extract(epoch FROM expires_at-created_at) FROM saldo_private.shortcut_devices',role=None)[0][0],90*24*60*60)
        with self.assertRaisesRegex(psycopg2.Error,'SALDO_INVALID_ENTRY'):
            self.rpc('create_shortcut_device','Other',digest,'UTC',90,uid=B)
        self.assertEqual(q('SELECT count(*) FROM saldo_private.shortcut_devices',role=None)[0][0],1)
        self.assertEqual(self.rpc('shortcut_metadata',token,role='authenticated',uid=B)['time_zone'],'UTC')
        self.assertNotIn('salary',str(self.rpc('shortcut_metadata',token,role='anon')))

    def test_12_device_registration_concurrent_retries(self):
        digest=hashlib.sha256(secrets.token_bytes(32)).hexdigest()
        barrier=threading.Barrier(8)
        def attempt(_):
            barrier.wait(timeout=10)
            return self.rpc('create_shortcut_device','Retry',digest,'UTC',90)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results=list(pool.map(attempt,range(8)))
        self.assertTrue(all(x==results[0] for x in results))
        self.assertEqual(q('SELECT count(*) FROM saldo_private.shortcut_devices',role=None)[0][0],1)

    def test_13_export_all_snapshot_including_voids(self):
        first=self.rpc('record_transaction',self.entry())['transaction']
        self.rpc('void_transaction',first['id'])
        # Seed synthetic history as the migration owner, not a bypass API.
        q("INSERT INTO public.transactions(user_id,request_id,type,amount_cents,occurred_at,time_zone,source,canonical_entry) "
            "SELECT %s, gen_random_uuid(),'income',1,'2026-10-01T00:00:00Z'::timestamptz + n*interval '1 second','UTC','app','{}'::jsonb "
            "FROM generate_series(1,1005) n",(A,),role=None)
        own=self.rpc('export_transactions')
        self.assertEqual(len(own),1006)
        self.assertEqual({r['user_id'] for r in own},{A})
        self.assertEqual(own,sorted(own,key=lambda r:(r['occurred_at'],r['id'])))
        self.assertIsNotNone(next(r for r in own if r['id']==first['id'])['voided_at'])
        self.assertEqual(self.rpc('export_transactions',uid=B),[])
        self.assertFalse(any('token' in key for r in own for key in r))
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.rpc('export_transactions',role='anon')
        with self.assertRaisesRegex(psycopg2.Error,'SALDO_UNAUTHENTICATED'):
            self.rpc('export_transactions',uid=None)

    def test_14_owner_limit_atomic_across_devices(self):
        q("SELECT pg_sleep(CASE WHEN extract(second FROM clock_timestamp())>50 THEN 61-extract(second FROM clock_timestamp()) ELSE 0 END)",role=None)
        first,_=self.device()
        second,_=self.device()
        for _ in range(60): self.rpc('shortcut_metadata',first,role='anon')
        for _ in range(55): self.rpc('shortcut_metadata',second,role='anon')
        tokens=[self.device()[0] for _ in range(16)]
        barrier=threading.Barrier(16)
        def attempt(token):
            barrier.wait(timeout=10)
            try:
                self.rpc('shortcut_metadata',token,role='anon')
                return 'ok'
            except psycopg2.Error as exc:
                if 'SALDO_RATE_LIMIT' in str(exc): return 'limited'
                raise
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results=list(pool.map(attempt,tokens))
        self.assertEqual(results.count('ok'),5)
        self.assertEqual(results.count('limited'),11)
        self.assertEqual(q('SELECT requests FROM saldo_private.owner_rate',role=None),[(120,)])
        # A different owner has a different budget and quota.
        other='sld_'+secrets.token_urlsafe(32)
        self.rpc('create_shortcut_device','Other',hashlib.sha256(other.encode()).hexdigest(),'UTC',90,uid=B)
        self.assertEqual(self.rpc('shortcut_metadata',other,role='anon')['accounts'],[{'id':'foreign','name':'Other','type':'bank'}])

    def test_15_time_zone_date_independent_of_session_and_dst(self):
        cases=[
            ('2026-11-01T03:30:00Z','America/New_York','2026-10-31'),
            ('2026-11-01T05:30:00Z','America/New_York','2026-11-01'),
            ('2026-11-01T06:30:00Z','America/New_York','2026-11-01'),
            ('2026-10-31T18:00:00Z','Asia/Kuala_Lumpur','2026-11-01')]
        for instant,zone,date in cases:
            entry=self.entry(occurred_at=instant,time_zone=zone)
            conn=base.connect('authenticated',A)
            try:
                with conn.cursor() as cur:
                    cur.execute("SET TIME ZONE 'Pacific/Honolulu'")
                    cur.execute('SELECT public.record_transaction(%s::jsonb)',(Json(entry),))
                    row=cur.fetchone()[0]['transaction']
                    self.assertEqual(row['entry_date'],date)
                self.assertTrue(self.rpc('record_transaction',entry)['duplicate'])
            finally: conn.close()
        self.assertEqual(self.rpc('tracker_summary','2026-10')['expense_cents'],100)
        self.assertEqual(self.rpc('tracker_summary','2026-11')['expense_cents'],300)

    def test_16_void_replay_does_not_resurrect_or_mutate_budget(self):
        before=q('SELECT * FROM public.budget_documents ORDER BY user_id',role=None)
        token,device=self.device()
        entry=self.entry()
        first=self.rpc('shortcut_record',token,entry,role='anon')['transaction']
        voided=self.rpc('void_transaction',first['id'])
        replay=self.rpc('shortcut_record',token,entry,role='anon')
        self.assertTrue(replay['duplicate'])
        self.assertEqual(replay['transaction'],voided)
        self.assertEqual(self.rpc('tracker_summary','2026-11')['expense_cents'],0)
        self.rpc('revoke_shortcut_device',device['id'])
        self.assertEqual(q('SELECT * FROM public.budget_documents ORDER BY user_id',role=None),before)
        unknown='sld_'+secrets.token_urlsafe(32)
        for name,args in [('shortcut_metadata',(unknown,)),('shortcut_record',(unknown,entry))]:
            with self.assertRaisesRegex(psycopg2.Error,'SALDO_DEVICE_UNAUTHORIZED'):
                self.rpc(name,*args,role='anon')
        expired,device=self.device(days=365)
        q("UPDATE saldo_private.shortcut_devices SET expires_at=clock_timestamp()-interval '1 second' WHERE id=%s",(device['id'],),role=None)
        with self.assertRaisesRegex(psycopg2.Error,'SALDO_DEVICE_UNAUTHORIZED'):
            self.rpc('shortcut_record',expired,entry,role='anon')

    def test_01_schema_owner_read_only(self):
        self.assertIsNotNone(q("SELECT to_regclass('public.transactions')", role=None)[0][0])
        columns=q("SELECT column_name,data_type,is_generated FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name='transactions' ORDER BY ordinal_position",role=None)
        self.assertEqual([(name,kind) for name,kind,_ in columns], [
            ('id','uuid'),('user_id','uuid'),('request_id','uuid'),('type','text'),
            ('amount_cents','bigint'),('currency','text'),('occurred_at','timestamp with time zone'),
            ('time_zone','text'),('entry_date','date'),('from_account_id','text'),('to_account_id','text'),
            ('from_account_name','text'),('to_account_name','text'),('external_party','text'),
            ('category','text'),('note','text'),('source','text'),('created_at','timestamp with time zone'),
            ('voided_at','timestamp with time zone'),('canonical_entry','jsonb')])
        self.assertEqual(next(generated for name,_,generated in columns if name=='entry_date'),'ALWAYS')
        for role in ('anon', 'authenticated'):
            for privilege in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'):
                self.assertFalse(q('SELECT has_table_privilege(%s,%s,%s)',
                    (role,'public.transactions',privilege),role=None)[0][0])
        self.assertEqual(q('SELECT * FROM public.transactions'), [])
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            q('SELECT * FROM public.transactions', role='anon')

if __name__ == '__main__':
    raise SystemExit(base.main())
