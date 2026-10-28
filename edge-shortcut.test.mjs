import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('committed rate-limit bookkeeping errors never count as a saved transaction',async()=>{const createHandler=await load();for(const [code,status] of [['SALDO_INVALID_ENTRY',400],['SALDO_ACCOUNT_CHANGED',409],['SALDO_DUPLICATE_CONFLICT',409],['SALDO_TRACKER_ERROR',502]]){const handler=createHandler({url,key,fetch:async()=>Response.json({error_code:code})});const response=await handler(request('POST',{headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({type:'expense',amount_cents:1})}));assert.equal(response.status,status);assert.equal((await response.json()).transaction,undefined);}});
test('Deno entrypoint selects only public environment keys and serves the local factory', async () => {
  let source = '';
  try { source = await readFile(new URL('./supabase/functions/shortcut-entry/index.ts', import.meta.url), 'utf8'); } catch {}
  assert.match(source, /import \{ createHandler \} from ['"]\.\/handler\.mjs['"]/);
  for (const [env, expected] of [
    [{ SUPABASE_PUBLISHABLE_KEYS: '{"other":"public-other","default":"public-default"}' }, 'public-default'],
    [{ SUPABASE_PUBLISHABLE_KEYS: '{"number":1,"other":"public-first"}' }, 'public-first'],
    [{ SUPABASE_PUBLISHABLE_KEYS: '["public-array"]' }, 'public-array'],
    [{ SUPABASE_PUBLISHABLE_KEYS: 'invalid', SUPABASE_ANON_KEY: 'legacy-public' }, 'legacy-public'],
    [{ SUPABASE_ANON_KEY: 'legacy-public', SB_PUBLISHABLE_KEY: 'local-public' }, 'local-public'],
    [{ SUPABASE_PUBLISHABLE_KEY: 'public-single' }, 'public-single'],
    [{}, undefined],
  ]) {
    let config;
    let served;
    vm.runInNewContext(source.replace(/^import .*;\s*/m, ''), {
      Deno: { env: { get(name) { assert.ok(['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_PUBLISHABLE_KEY', 'SB_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY'].includes(name)); return name === 'SUPABASE_URL' ? url : env[name]; } }, serve(handler) { served = handler; } },
      createHandler(value) { config = value; return 'handler-marker'; },
    });
    assert.equal(config.url, url);
    assert.equal(config.key, expected);
    assert.equal(served, 'handler-marker');
  }
});

const moduleURL = './supabase/functions/shortcut-entry/handler.mjs';
const token = `sld_${'a'.repeat(43)}`;
const url = 'https://example.supabase.co';
const key = 'sb_publishable_TEST_ONLY';
const endpoint = 'https://edge.example/shortcut-entry';
const metadata = { accounts: [], categories: [], time_zone: 'Asia/Kuala_Lumpur' };
const request = (method = 'GET', opts = {}) => new Request(endpoint, { method, headers: { Authorization: `Bearer ${token}`, ...opts.headers }, ...opts });
const load = async () => (await import(moduleURL).catch(() => ({}))).createHandler;

// Additional boundary verification of already-green behavior (not live DB tests).
test('a hanging fetch is aborted at ten seconds with no positive acknowledgment', { timeout: 12_000 }, async () => {
  const createHandler = await load();
  const keepAlive = setTimeout(() => {}, 11_000);
  const started = performance.now();
  try {
    const response = await createHandler({ url, key, fetch: (_target, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) })(request());
    assert.equal(response.status, 503);
    assert.ok(performance.now() - started >= 9_900);
    assert.deepEqual(await response.json(), { error: 'service_unavailable' });
  } finally { clearTimeout(keepAlive); }
});

test('exactly 8192 streamed bytes pass; lying length and invalid UTF-8 fail safely', async () => {
  const createHandler = await load();
  const body = JSON.stringify({ note: 'x'.repeat(8181) });
  assert.equal(new TextEncoder().encode(body).byteLength, 8192);
  let calls = 0;
  const handler = createHandler({ url, key, fetch: async () => { calls++; return Response.json({ transaction: { id: 'test-id' }, duplicate: false }); } });
  const stream = (bytes) => new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 17) c.enqueue(bytes.slice(i, i + 17)); c.close(); } });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': '1' };
  const ok = await handler(request('POST', { body: stream(new TextEncoder().encode(body)), duplex: 'half', headers }));
  assert.equal(ok.status, 200);
  const large = await handler(request('POST', { body: stream(new TextEncoder().encode(body + ' ')), duplex: 'half', headers }));
  assert.equal(large.status, 413);
  const invalid = await handler(request('POST', { body: stream(new Uint8Array([0xff])), duplex: 'half', headers }));
  assert.equal(invalid.status, 400);
  assert.equal(calls, 1);
});

test('only public key classes are accepted; redirects cannot forward capability credentials', async () => {
  const createHandler = await load();
  let calls = 0;
  const jwt = (role) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.TEST_SIGNATURE`;
  for (const badKey of ['unrecognized-key', jwt('service_role'), jwt('authenticated')]) {
    const response = await createHandler({ url, key: badKey, fetch: async () => { calls++; return Response.json(metadata); } })(request());
    assert.equal(response.status, 503);
  }
  assert.equal(calls, 0);
  const response = await createHandler({ url, key: jwt('anon'), fetch: async (_target, init) => {
    assert.equal(init.redirect, 'error');
    return Response.json(metadata);
  } })(request());
  assert.equal(response.status, 200);
  const handler = createHandler({ url, key, fetch: async () => Response.json(metadata) });
  const upper = await handler(new Request(endpoint, { headers: { Authorization: `Bearer SLD_${'a'.repeat(43)}` } }));
  assert.equal(upper.status, 401);
});

test('CORS admits only exact app/development origins; preflight is credential-free', async () => {
  const createHandler = await load();
  let calls = 0;
  const handler = createHandler({ url, key, fetch: async () => { calls++; return Response.json(metadata); } });
  for (const origin of ['https://mzahiruliman.github.io', 'http://localhost:5174', 'http://127.0.0.1:5174']) {
    const response = await handler(new Request(endpoint, { method: 'OPTIONS', headers: { Origin: origin } }));
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
    assert.match(response.headers.get('access-control-allow-headers'), /authorization/i);
    assert.equal(response.headers.get('vary'), 'Origin');
    const rejected = await handler(new Request(endpoint, { headers: { Origin: origin } }));
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get('access-control-allow-origin'), origin);
  }
  for (const origin of ['https://evil.example', 'null', 'http://localhost:5173', 'https://mzahiruliman.github.io.evil.example']) {
    const response = await handler(request('GET', { headers: { Origin: origin, Authorization: `Bearer ${token}` } }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await handler(new Request(endpoint, { method: 'OPTIONS' }))).status, 204);
  assert.equal(calls, 0);
});

test('method/config/query guards fail closed and metadata action works', async () => {
  const createHandler = await load();
  let calls = 0;
  const fetch = async () => { calls++; return Response.json(metadata); };
  for (const config of [{}, { url }, { key }, { url: 'http://example.supabase.co', key }, { url, key: 'sb_secret_REJECT' }]) {
    assert.equal((await createHandler({ ...config, fetch })(request())).status, 503);
  }
  const handler = createHandler({ url, key, fetch });
  const method = await handler(request('PUT'));
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'GET, POST, OPTIONS');
  assert.equal((await handler(new Request(`${endpoint}?action=unknown`, { headers: { Authorization: `Bearer ${token}` } }))).status, 400);
  assert.equal(calls, 0);
  const response = await handler(new Request(`${endpoint}?action=metadata`, { headers: { Authorization: `Bearer ${token}` } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('rejects invalid RPC acknowledgments instead of claiming a save', async () => {
  const createHandler = await load();
  for (const body of [[], null, {}, { transaction: {}, duplicate: false }, { transaction: {}, duplicate: 'yes' }, { transaction: null, duplicate: false }]) {
    const response = await createHandler({ url, key, fetch: async () => Response.json(body) })(request('POST', { body: '{}', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }));
    assert.equal(response.status, 502, JSON.stringify(body));
  }
  for (const body of [[], null, {}, { accounts: [], categories: [] }]) {
    const response = await createHandler({ url, key, fetch: async () => Response.json(body) })(request());
    assert.equal(response.status, 502, JSON.stringify(body));
  }
  const response = await createHandler({ url, key, fetch: async () => new Response('not json') })(request());
  assert.equal(response.status, 502);
});

test('upstream response-body network failure is unavailable, not an acknowledgment', async () => {
  const createHandler = await load();
  const response = await createHandler({ url, key, fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError(`network ${token}`)); } })) })(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'service_unavailable' });
});

test('RPC errors use safe stable codes and never echo SQL, credentials or stacks', async () => {
  const createHandler = await load();
  const cases = [
    ['SALDO_DEVICE_UNAUTHORIZED', 401], ['SALDO_RATE_LIMIT', 429],
    ['SALDO_ACCOUNT_CHANGED', 409], ['SALDO_DUPLICATE_CONFLICT', 409],
    ['SALDO_INVALID_ENTRY', 400], ['SALDO_INVALID_PAYLOAD', 400], ['other', 502],
  ];
  for (const [code, status] of cases) {
    const handler = createHandler({ url, key, fetch: async () => Response.json({ code: 'P0001', message: code, details: `SQL secret ${token}`, hint: key }, { status: 400 }) });
    const response = await handler(request());
    assert.equal(response.status, status, code);
    assert.equal(response.headers.get('retry-after'), status === 429 ? '60' : null);
    const text = await response.text();
    assert.ok(!text.includes(token) && !text.includes(key) && !text.includes('SQL'));
  }
  for (const error of [new Error(`network ${token}`), new DOMException('timed out', 'TimeoutError')]) {
    const response = await createHandler({ url, key, fetch: async () => { throw error; } })(request());
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes(token));
  }
});

test('POST bounds streamed bytes and rejects malformed or caller-owned identity payloads', async () => {
  const createHandler = await load();
  let calls = 0;
  const handler = createHandler({ url, key, fetch: async () => { calls++; return Response.json({ transaction: {}, duplicate: false }); } });
  for (const body of ['[]', 'null', '1', '"text"', '{', '', '{"user_id":"x"}', '{"owner":"x"}', '{"owner_id":"x"}', '{"source":"app"}']) {
    const response = await handler(request('POST', { body, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }));
    assert.equal(response.status, 400, body);
  }
  const wrongType = await handler(request('POST', { body: '{}' }));
  assert.equal(wrongType.status, 415);
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"note":"' + 'é'.repeat(4096))); }, cancel() { cancelled = true; } });
  const response = await handler(request('POST', { body: stream, duplex: 'half', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }));
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  const declared = await handler(request('POST', { body: '{}', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': '8193' } }));
  assert.equal(declared.status, 413);
  assert.equal(calls, 0);
});

test('POST forwards an object entry and only acknowledges committed RPC response', async () => {
  const createHandler = await load();
  const entry = { type: 'expense', amount_cents: 125, request_id: 'test-request' };
  for (const duplicate of [false, true]) {
    const result = { transaction: { id: 'test-transaction', source: 'shortcut' }, duplicate };
    const handler = createHandler({ url, key, fetch: async (target, init) => {
      assert.equal(target, `${url}/rest/v1/rpc/shortcut_record`);
      assert.deepEqual(JSON.parse(init.body), { p_token: token, p_entry: entry });
      return Response.json(result);
    } });
    const response = await handler(request('POST', { body: JSON.stringify(entry), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
  }
});

test('rejects absent/malformed credentials and token queries before RPC', async () => {
  const createHandler = await load();
  let calls = 0;
  const handler = createHandler({ url, key, fetch: async () => { calls++; return Response.json(metadata); } });
  for (const auth of ['', 'Bearer x', `Bearer sld_${'a'.repeat(42)}`, `Bearer sld_${'+'.repeat(43)}`, `Basic ${token}`, `Bearer ${token} extra`]) {
    assert.equal((await handler(new Request(endpoint, { headers: { Authorization: auth } }))).status, 401);
  }
  for (const param of ['token', 'p_token', 'access_token', 'Authorization']) {
    assert.equal((await handler(new Request(`${endpoint}?${param}=ignored`, { headers: { Authorization: `Bearer ${token}` } }))).status, 400);
  }
  assert.equal(calls, 0);
});

test('GET metadata uses the public-key RPC boundary without Authorization upstream', async () => {
  const createHandler = await load();
  assert.equal(typeof createHandler, 'function');
  const handler = createHandler({ url, key, fetch: async (target, init) => {
    assert.equal(target, `${url}/rest/v1/rpc/shortcut_metadata`);
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('apikey'), key);
    assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
    assert.equal(new Headers(init.headers).get('authorization'), null);
    assert.deepEqual(JSON.parse(init.body), { p_token: token });
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json(metadata);
  } });
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), metadata);
});
