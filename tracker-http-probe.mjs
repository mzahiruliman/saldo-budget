// Real protocol assertions; no mocked RPC results. Run via tracker-http-test.py.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {budgetApi, ownerClient} from './supabase-api.mjs';
import {createTrackerApi} from './tracker-api.mjs';
import {initialState} from './model.mjs';
import {createHandler} from './supabase/functions/shortcut-entry/handler.mjs';

const {LOCAL_REST_URL: rest, JWT_A: jwtA, JWT_B: jwtB, API_PUB: key, LOCAL_PG_DSN: dsn} = process.env;
assert.ok(rest && jwtA && jwtB && key && dsn, 'Run the disposable-cluster Python harness');
assert.equal(new URL(rest).hostname, '127.0.0.1');
assert.match(dsn, /^host=\/tmp\/saldo-http-/);
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let checks = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${++checks} ${name}`); }
  catch(error) { console.error(`FAIL ${name}`); throw error; }
}
// Admin SQL is restricted to disposable fixture inspection/expiry/quota controls.
function sql(query, params = []) {
  return JSON.parse(execFileSync('/usr/bin/python3', ['-c',
    'import json,os,sys,psycopg2; c=psycopg2.connect(os.environ["LOCAL_PG_DSN"]); c.autocommit=True; q=c.cursor(); q.execute(sys.argv[1],json.loads(sys.argv[2])); print(json.dumps(q.fetchall() if q.description else [],default=str)); c.close()',
    query, JSON.stringify(params)], {encoding:'utf8'}));
}
const requests = [];
async function transport(target, init) {
  const url = new URL(typeof target === 'string' || target instanceof URL ? target : target.url);
  assert.ok(url.origin === rest || url.origin === 'https://local.synthetic', 'No external transport');
  assert.ok(url.pathname.startsWith('/rest/v1/'), 'Only REST traffic allowed');
  const headers = new Headers(init?.headers ?? (target instanceof Request ? target.headers : {}));
  requests.push({path:url.pathname, auth:headers.get('authorization'), body:init?.body});
  const rewritten = new URL(url.pathname.slice('/rest/v1'.length) + url.search, rest);
  return fetch(rewritten, {...init, signal:init?.signal ?? AbortSignal.timeout(10_000)});
}
function primary(id, jwt) { return {auth:{async getSession() { return {data:{session:{user:{id},access_token:jwt}},error:null}; }}}; }
const connection = {url:rest, key, fetch:transport};
const authA = primary(A,jwtA), authB = primary(B,jwtB);
const budgetA = budgetApi(authA,A,connection), budgetB = budgetApi(authB,B,connection);
const api = createTrackerApi(authA,A,connection), apiB = createTrackerApi(authB,B,connection);
const sdkB = ownerClient(authB,B,connection);
const state = initialState();
state.accounts.push({id:'cash',name:'Synthetic cash',type:'cash',balance:null});
const month = state.selected;
const entry = (type, amount, extra={}) => ({request_id:randomUUID(),type,amount_cents:amount,
  occurred_at:month+'-12T12:00:00Z',time_zone:'UTC',...extra});
const handler = createHandler({url:'https://local.synthetic',key,fetch:transport});
async function edge(token, body) {
  const response = await handler(new Request('https://edge.local.synthetic/shortcut-entry', {
    method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return {status:response.status,body:await response.json()};
}
let originalA, originalB, expense, device, shortcut;
try {
  await check('real signed-JWT SDK saves independent revision-1 owner documents', async()=>{
    originalA = await budgetA.write(state,0);
    const stateB=structuredClone(state); stateB.accounts[0].name='Synthetic B bank';
    originalB = await budgetB.write(stateB,0);
    assert.equal(originalA.revision,1); assert.equal(originalB.revision,1);
    assert.equal(originalA.user_id,A); assert.equal(originalB.user_id,B);
    assert.deepEqual(await budgetA.load(),originalA); assert.deepEqual(await budgetB.load(),originalB);
  });
  await check('PostgREST verifies JWT signature instead of trusting decoded owner claims',async()=>{
    const parts=jwtA.split('.'); const signature=Buffer.from(parts[2],'base64url'); signature[0]^=1; parts[2]=signature.toString('base64url');
    const bad=await fetch(rest+'/transactions',{headers:{Authorization:'Bearer '+parts.join('.')}});
    assert.equal(bad.status,401); assert.equal((await bad.json()).code,'PGRST301');
  });
  await check('authenticated income expense transfer have owner rows and separate summary totals',async()=>{
    const income=await api.create(entry('income',10000,{to_account_id:'bank'}));
    expense=await api.create(entry('expense',1250,{from_account_id:'bank',category:'commitment'}));
    const transfer=await api.create(entry('transfer',2000,{from_account_id:'bank',to_account_id:'cash'}));
    for(const r of [income,expense,transfer]) {assert.equal(r.duplicate,false);assert.equal(r.transaction.user_id,A);assert.equal(r.transaction.source,'app');}
    const page=await api.list(month); assert.equal(page.entries.length,3); assert.equal(page.hasMore,false);
    const s=await api.summary(month); assert.equal(s.income_cents,10000);assert.equal(s.expense_cents,1250);assert.equal(s.transfer_cents,2000);
    assert.deepEqual(s.movements,{bank:6750,cash:2000});
  });
  await check('SDK B cannot select A ledger or document even with explicit A filters',async()=>{
    for(const table of ['transactions','budget_documents']) {
      const r=await sdkB.from(table).select('*').eq('user_id',A); assert.equal(r.error,null);assert.deepEqual(r.data,[]);
    }
    assert.deepEqual((await apiB.list(month)).entries,[]);assert.deepEqual(await apiB.exportAll(),[]);
    await assert.rejects(apiB.void(expense.transaction.id),/SALDO_TRANSACTION_NOT_FOUND/);
  });
  await check('anonymous REST cannot read ledger or invoke authenticated record RPC',async()=>{
    const read=await fetch(rest+'/transactions'); assert.equal(read.status,401);assert.equal((await read.json()).code,'42501');
    const write=await fetch(rest+'/rpc/record_transaction',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_entry:entry('income',1)})});
    assert.equal(write.status,401);assert.equal((await write.json()).code,'42501');
  });
  await check('pairing stores only private SHA256 hash; owner device lists never disclose it',async()=>{
    const start=requests.length; device=await api.mint({name:'Synthetic phone',timeZone:'UTC',days:1});
    assert.match(device.token,/^sld_[A-Za-z0-9_-]{43}$/);
    const digest=createHash('sha256').update(device.token).digest('hex');
    const rows=sql('SELECT user_id,token_hash,to_jsonb(d) FROM saldo_private.shortcut_devices d WHERE id=%s',[device.device.id]);
    assert.equal(rows[0][0],A);assert.equal(rows[0][1],digest);assert.ok(!JSON.stringify(rows).includes(device.token));
    const posted=requests.slice(start).find(r=>r.path.endsWith('/create_shortcut_device'));
    assert.equal(JSON.parse(posted.body).p_token_hash,digest);assert.ok(!posted.body.includes(device.token));
    assert.equal(device.device.token_hash,undefined);assert.equal((await api.devices())[0].token_hash,undefined);
    assert.deepEqual(await apiB.devices(),[]);
    const privateRead=await sdkB.from('shortcut_devices').select('*');assert.ok(privateRead.error);
  });
  await check('Edge GET reads current SQL choices through anonymous capability RPC',async()=>{
    const result=await edge(device.token);assert.equal(result.status,200);
    assert.deepEqual(result.body.accounts,[{id:'bank',name:'Main bank',type:'bank'},{id:'cash',name:'Synthetic cash',type:'cash'}]);
    assert.deepEqual(result.body.categories,['commitment','entertainment','savings']);assert.equal(result.body.time_zone,'UTC');
    assert.deepEqual((await api.metadata()).accounts,result.body.accounts);
    const request=requests.at(-2);assert.ok(request.path.endsWith('/shortcut_metadata'));assert.equal(request.auth,null);
  });
  const shortcutEntry=entry('expense',250,{from_account_id:'cash',category:'entertainment'});
  await check('Edge POST acknowledges actual commit once; identical retry returns duplicate',async()=>{
    shortcut=await edge(device.token,shortcutEntry);assert.equal(shortcut.status,200);assert.equal(shortcut.body.duplicate,false);
    const retry=await edge(device.token,shortcutEntry);assert.equal(retry.status,200);assert.equal(retry.body.duplicate,true);
    assert.equal(retry.body.transaction.id,shortcut.body.transaction.id);assert.equal(shortcut.body.transaction.user_id,A);assert.equal(shortcut.body.transaction.source,'shortcut');
    assert.equal(sql('SELECT count(*) FROM public.transactions WHERE user_id=%s AND request_id=%s',[A,shortcutEntry.request_id])[0][0],1);
    assert.equal(requests.at(-1).auth,null);
  });
  await check('real SQL error_code JSON maps conflict and malformed input to Edge 409/400',async()=>{
    for(const [body,code,status] of [
      [{...shortcutEntry,amount_cents:251},'SALDO_DUPLICATE_CONFLICT',409],
      [entry('expense',1,{from_account_id:'unknown'}),'SALDO_ACCOUNT_CHANGED',409],
      [entry('expense','1',{from_account_id:'bank'}),'SALDO_INVALID_ENTRY',400],
    ]) {
      const raw=await fetch(rest+'/rpc/shortcut_record',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_token:device.token,p_entry:body})});
      assert.equal(raw.status,200);assert.deepEqual(await raw.json(),{error_code:code});
      assert.deepEqual(await edge(device.token,body),{status,body:{error:code}});
    }
    assert.equal(sql('SELECT count(*) FROM public.transactions WHERE user_id=%s',[A])[0][0],4);
  });
  await check('real unassigned row can be assigned once through owner SDK RPC',async()=>{
    const unassigned=await api.create(entry('expense',100));
    const before=await api.summary(month);assert.equal(before.unassigned_expense_cents,100);
    await assert.rejects(apiB.assign(unassigned.transaction.id,{accountId:'bank'}),/SALDO_TRANSACTION_NOT_FOUND/);
    const assigned=await api.assign(unassigned.transaction.id,{accountId:'cash',category:'commitment'});
    assert.equal(assigned.from_account_id,'cash');assert.equal(assigned.category,'commitment');
    assert.equal((await api.summary(month)).unassigned_expense_cents,0);
    await assert.rejects(api.assign(assigned.id,{accountId:'bank'}),/SALDO_INVALID_ENTRY/);
  });
  await check('scalar JSON export exceeds configured REST row page without truncation',async()=>{
    await api.create(entry('income',500,{to_account_id:'bank'}));
    const exported=await api.exportAll();assert.equal(exported.length,6);assert.ok(exported.every(r=>r.user_id===A));
    const firstPage=await api.list(month);
    assert.equal(firstPage.entries.length,5); // PGRST_DB_MAX_ROWS=5, intentionally low.
    assert.equal(firstPage.hasMore,true);
    const secondPage=await api.list(month,firstPage.nextCursor);
    assert.equal(secondPage.hasMore,false);
    const history=[...firstPage.entries,...secondPage.entries];
    assert.equal(history.length,6);assert.equal(new Set(history.map(r=>r.id)).size,6);
    assert.deepEqual(history.map(r=>r.id).sort(),exported.map(r=>r.id).sort());
    assert.equal(sql('SELECT count(*) FROM public.transactions WHERE user_id=%s',[A])[0][0],6);
  });
  await check('void removes actual expense from summary but retains auditable history',async()=>{
    assert.equal((await api.summary(month)).expense_cents,1600);
    assert.ok((await api.void(expense.transaction.id)).voided_at);
    const s=await api.summary(month);assert.equal(s.expense_cents,350);assert.equal(s.transfer_cents,2000);assert.equal(s.income_cents,10500);
    assert.equal((await api.exportAll()).length,6);
  });
  await check('device expiry and owner revocation block GET and POST with 401',async()=>{
    const expired=await api.mint({name:'Expiry fixture',timeZone:'UTC',days:1});
    sql("UPDATE saldo_private.shortcut_devices SET expires_at=clock_timestamp()-interval '1 second' WHERE id=%s",[expired.device.id]);
    assert.equal(sql('SELECT expires_at<clock_timestamp() FROM saldo_private.shortcut_devices WHERE id=%s',[expired.device.id])[0][0],true);
    for(const body of [undefined,entry('income',1)])assert.deepEqual(await edge(expired.token,body),{status:401,body:{error:'SALDO_DEVICE_UNAUTHORIZED'}});
    assert.equal(await apiB.revoke(device.device.id),false);assert.equal((await edge(device.token)).status,200);
    assert.equal(await api.revoke(device.device.id),true);
    assert.ok((await api.devices()).find(d=>d.id===device.device.id).revoked_at);
    for(const body of [undefined,entry('income',1)])assert.deepEqual(await edge(device.token,body),{status:401,body:{error:'SALDO_DEVICE_UNAUTHORIZED'}});
  });
  await check('all actuals pairing assignment void leave whole budget payload and revision unchanged',async()=>{
    assert.deepEqual(await budgetA.load(),originalA);assert.deepEqual(await budgetB.load(),originalB);
    assert.equal(sql('SELECT count(*) FROM public.transactions WHERE user_id=%s',[A])[0][0],6);
    assert.equal(sql('SELECT count(*) FROM public.transactions WHERE user_id=%s',[B])[0][0],0);
    for(const request of requests.filter(r=>/\/shortcut_(record|metadata)$/.test(r.path))) assert.equal(request.auth,null);
  });
  console.log(JSON.stringify({result:'PASS',checks,ownerA_rows:6,ownerB_rows:0,rest_row_cap:5,export_rows:6,protocol_requests:requests.length}));
} finally { api.destroy(); apiB.destroy(); }
