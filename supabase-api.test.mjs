import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "./model.mjs";
test('delayed SDK token lookup cannot send an A snapshot with a B token', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { budgetApi } = await import('./supabase-api.mjs');
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  let session = { user: { id: 'A' }, access_token: 'token-A' };
  let holdTokenLookup = false;
  const auth = { async getSession() { if (holdTokenLookup) { entered(); await gate; } return { data: { session } }; } };
  const requests = [];
  const fetch = async (url, options) => {
    requests.push(options.headers.get('Authorization'));
    return new Response(JSON.stringify([{user_id:'B',payload:initialState(),revision:1}]), {status:200,headers:{'Content-Type':'application/json'}});
  };
  const url = 'https://synthetic.invalid', key = 'synthetic-key';
  const primary = createClient(url, key, { accessToken: async () => (await auth.getSession()).data.session.access_token, global:{fetch} });
  Object.defineProperty(primary, 'auth', {value:auth});
  const api = budgetApi(primary, 'A', {url,key,fetch});
  await new Promise(resolve => setImmediate(resolve));
  holdTokenLookup = true;
  const writing = api.write(initialState(),0);
  await started;
  session = {user:{id:'B'},access_token:'token-B'};
  release();
  await assert.rejects(writing);
  assert.deepEqual(requests, [], 'owner mismatch must be rejected before any HTTP write');
});
test("cloud adapter uses authenticated owner reads and the revision-checked RPC", async () => {
  const { budgetApi } = await import("./supabase-api.mjs");
  let calls = [],
    payload = initialState(),
    row = { user_id: "user-a", payload, revision: 1 };
  const client = {
    from(table) {
      calls.push(table);
      return {
        select() {
          return {
            eq(k, v) {
              calls.push([k, v]);
              return {
                async maybeSingle() {
                  return { data: row, error: null };
                },
              };
            },
          };
        },
      };
    },
    async rpc(name, args) {
      calls.push([name, args]);
      return { data: [{ ...row, revision: 2 }], error: null };
    },
  };
  let api = budgetApi(client, "user-a");
  assert.equal((await api.load()).revision, 1);
  assert.equal((await api.write(payload, 1)).revision, 2);
  assert.deepEqual(calls[1], ["user_id", "user-a"]);
  assert.equal(calls[2][0], "save_budget");
  assert.equal(calls[2][1].p_expected_revision, 1);
  row.user_id = "user-b";
  await assert.rejects(api.load(), /owner/);
});
