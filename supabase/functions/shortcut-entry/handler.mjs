/** Thin capability RPC adapter; no user session or privileged credential. */
const origins = new Set(['https://mzahiruliman.github.io', 'http://localhost:5174', 'http://127.0.0.1:5174']);
const methods = 'GET, POST, OPTIONS';
function isPublicKey(key) {
  if (typeof key !== 'string') return false;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  try {
    const parts = key.split('.');
    if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return false;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload)).role === 'anon';
  } catch { return false; }
}
export function createHandler({ url, key, fetch: fetcher = globalThis.fetch }) {
  let base;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
        parsed.pathname === '/' && !parsed.search && !parsed.hash &&
        isPublicKey(key)) base = parsed.origin;
  } catch { /* Missing/invalid configuration fails closed. */ }
  return async (request) => {
    const origin = request.headers.get('origin');
    const headers = { 'Cache-Control': 'no-store', Vary: 'Origin' };
    if (origin && origins.has(origin)) Object.assign(headers, {
      'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers': 'authorization, content-type',
    });
    const json = (body, init = {}) => Response.json(body, { ...init, headers: { ...headers, ...init.headers } });
    if (origin && !origins.has(origin)) return json({ error: 'origin_forbidden' }, { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'method_not_allowed' }, { status: 405, headers: { Allow: methods } });
    if (!base) return json({ error: 'service_unavailable' }, { status: 503 });
    const parsed = new URL(request.url);
    if ([...parsed.searchParams.keys()].some((name) => name !== 'action') ||
        (parsed.searchParams.has('action') && (request.method !== 'GET' || parsed.searchParams.getAll('action').length !== 1 || parsed.searchParams.get('action') !== 'metadata'))) {
      return json({ error: 'invalid_query' }, { status: 400 });
    }
    const auth = request.headers.get('authorization');
    if (!/^Bearer /i.test(auth ?? '') || !/^sld_[A-Za-z0-9_-]{43}$/.test(auth?.slice(7) ?? '')) {
      return json({ error: 'unauthorized' }, { status: 401 });
    }
    const token = auth.slice(7);
    const post = request.method === 'POST';
    let entry;
    if (post) {
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return json({ error: 'json_required' }, { status: 415 });
      }
      if (Number(request.headers.get('content-length')) > 8192) {
        return json({ error: 'body_too_large' }, { status: 413 });
      }
      const reader = request.body?.getReader();
      let size = 0;
      const chunks = [];
      try {
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 8192) {
              await reader.cancel().catch(() => {});
              return json({ error: 'body_too_large' }, { status: 413 });
            }
            chunks.push(value);
          }
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        return json({ error: 'invalid_entry' }, { status: 400 });
      } finally { reader?.releaseLock(); }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          ['user_id', 'owner', 'owner_id', 'source'].some((field) => Object.hasOwn(entry, field))) {
        return json({ error: 'invalid_entry' }, { status: 400 });
      }
    }
    const payload = post ? { p_token: token, p_entry: entry } : { p_token: token };
    let response;
    try {
      response = await fetcher(`${base}/rest/v1/rpc/${post ? 'shortcut_record' : 'shortcut_metadata'}`, {
        method: 'POST', redirect: 'error', headers: { apikey: key, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return json({ error: 'service_unavailable' }, { status: 503 });
    }
    let result;
    try { result = await response.json(); } catch (error) {
      return error instanceof SyntaxError
        ? json({ error: 'upstream_error' }, { status: 502 })
        : json({ error: 'service_unavailable' }, { status: 503 });
    }
    if (!response.ok || (result && typeof result === 'object' && 'error_code' in result)) {
      const statuses = { SALDO_DEVICE_UNAUTHORIZED: 401, SALDO_RATE_LIMIT: 429,
        SALDO_ACCOUNT_CHANGED: 409, SALDO_DUPLICATE_CONFLICT: 409,
        SALDO_INVALID_ENTRY: 400, SALDO_INVALID_PAYLOAD: 400 };
      const code = [result?.error_code, result?.message, result?.code].find((value) => Object.hasOwn(statuses, value));
      const status = statuses[code] ?? 502;
      return json({ error: code ?? 'upstream_error' }, {
        status, headers: status === 429 ? { 'Retry-After': '60' } : {},
      });
    }
    const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!object(result) || (post
      ? !object(result.transaction) || typeof result.transaction.id !== 'string' || !result.transaction.id || typeof result.duplicate !== 'boolean'
      : !Array.isArray(result.accounts) || !Array.isArray(result.categories) || typeof result.time_zone !== 'string')) {
      return json({ error: 'upstream_error' }, { status: 502 });
    }
    return json(post
      ? { transaction: result.transaction, duplicate: result.duplicate }
      : { accounts: result.accounts, categories: result.categories, time_zone: result.time_zone });
  };
}
