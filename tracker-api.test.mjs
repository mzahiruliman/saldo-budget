import test from "node:test";
import assert from "node:assert/strict";
test("an unassigned entry can be resolved only after an owned-row acknowledgment", async () => {
  const { createTrackerApi } = await import("./tracker-api.mjs");
  let args;
  const row = {
    id: "id",
    user_id: "owner",
    type: "income",
    amount_cents: 10,
    currency: "MYR",
    entry_date: "2026-01-01",
    to_account_id: "bank",
  };
  const api = createTrackerApi(
    {
      rpc: async (name, a) => {
        assert.equal(name, "assign_transaction");
        args = a;
        return { data: row, error: null };
      },
    },
    "owner",
  );
  assert.equal(
    (await api.assign("id", { accountId: "bank", category: null }))
      .to_account_id,
    "bank",
  );
  assert.deepEqual(args, {
    p_transaction_id: "id",
    p_account_id: "bank",
    p_category: null,
  });
  row.user_id = "other";
  await assert.rejects(
    api.assign("id", { accountId: "bank", category: null }),
    /owner/,
  );
});
test("tracker metadata errors are honest and expired controllers cannot return data", async () => {
  const { createTrackerApi } = await import("./tracker-api.mjs");
  let resolve;
  const api = createTrackerApi(
    {
      rpc: async (name) => ({
        data: { accounts: [], categories: [] },
        error: null,
      }),
    },
    "owner",
  );
  assert.deepEqual(await api.metadata(), { accounts: [], categories: [] });
  api.destroy();
  await assert.rejects(api.metadata(), /Session ended/);
  const bad = createTrackerApi(
    { rpc: async () => ({ error: { message: "DB unavailable" } }) },
    "owner",
  );
  await assert.rejects(bad.metadata(), /DB unavailable/);
});
test("history uses owner/month filters, bounded pages and full database summaries", async () => {
  const { createTrackerApi } = await import("./tracker-api.mjs");
  let calls = [];
  let rows = Array.from({ length: 51 }, (_, i) => ({
    id: '11111111-1111-4111-8111-'+String(i).padStart(12,'0'),
    occurred_at: '2026-12-10T12:00:00+00:00',
    user_id: "owner",
    type: "expense",
    amount_cents: 123,
    currency: "MYR",
    entry_date: "2026-12-10",
  }));
  const q = {
    select() {
      return q;
    },
    eq(k, v) {
      calls.push([k, v]);
      return q;
    },
    gte(k, v) {
      calls.push([k, v]);
      return q;
    },
    lt(k, v) {
      calls.push([k, v]);
      return q;
    },
    order() {
      return q;
    },
    async range(a, b) {
      calls.push([a, b]);
      return { data: rows, error: null };
    },
  };
  const api = createTrackerApi(
    {
      from: (name) => {
        assert.equal(name, "transactions");
        return q;
      },
      rpc: async (name, args) => {
        assert.equal(name, "tracker_summary");
        assert.equal(args.p_month, "2026-12");
        return {
          data: {
            income_cents: 0,
            expense_cents: 123,
            transfer_cents: 0,
            movements: {},
          },
          error: null,
        };
      },
    },
    "owner",
  );
  const page = await api.list("2026-12");
  assert.equal(page.entries.length, 50);
  assert.equal(page.hasMore, true);
  assert.ok(calls.some((x) => x[0] === "user_id" && x[1] === "owner"));
  assert.ok(calls.some((x) => x[0] === "entry_date" && x[1] === "2027-01-01"));
  assert.equal((await api.summary("2026-12")).expense_cents, 123);
  rows[0].user_id = "other";
  await assert.rejects(api.list("2026-12"), /owner/);
});

test("create and void require acknowledgement for the signed-in owner without touching budget saves", async () => {
  const { createTrackerApi } = await import("./tracker-api.mjs");
  const row = {
    id: "id",
    user_id: "owner",
    type: "income",
    amount_cents: 10,
    currency: "MYR",
    entry_date: "2026-01-01",
  };
  let calls = [];
  const api = createTrackerApi(
    {
      rpc: async (name, args) => {
        calls.push(name);
        return {
          data:
            name === "record_transaction"
              ? { transaction: row, duplicate: false }
              : { ...row, voided_at: "2026-01-02T00:00:00Z" },
          error: null,
        };
      },
    },
    "owner",
  );
  const entry = { request_id: "req", type: "income", amount_cents: 10 };
  assert.equal((await api.create(entry)).transaction.amount_cents, 10);
  assert.ok((await api.void("id")).voided_at);
  assert.deepEqual(calls, ["record_transaction", "void_transaction"]);
  row.user_id = "other";
  await assert.rejects(api.create(entry), /owner/);
});

test("device pairing sends only a SHA256 hash and exposes the private token only to the caller", async () => {
  const { createTrackerApi } = await import("./tracker-api.mjs");
  let posted;
  const api = createTrackerApi(
    {
      rpc: async (name, args) => {
        posted = { name, args };
        return {
          data:
            name === "create_shortcut_device"
              ? { id: "device", name: args.p_name }
              : name === "list_shortcut_devices"
                ? [
                    {
                      id: "device",
                      name: "Phone",
                      token_hash: "must-not-expose",
                    },
                  ]
                : true,
          error: null,
        };
      },
    },
    "owner",
  );
  const { device, token } = await api.mint({
    name: " Phone ",
    timeZone: "UTC",
    days: 90,
  });
  assert.equal(device.id, "device");
  assert.match(token, /^sld_[A-Za-z0-9_-]{43}$/);
  assert.equal(posted.name, "create_shortcut_device");
  assert.equal(posted.args.p_name, "Phone");
  assert.equal(JSON.stringify(posted.args).includes(token), false);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  assert.equal(
    posted.args.p_token_hash,
    Array.from(new Uint8Array(digest), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join(""),
  );
  assert.equal((await api.devices())[0].token_hash, undefined);
  assert.equal(await api.revoke("device"), true);
  await assert.rejects(api.mint({ name: "x", timeZone: "UTC", days: 0 }));
});

test("transaction export validates every owner and is not restricted to one history page", async () => {
  const { createTrackerApi } = await import("./tracker-api.mjs");
  const rows = Array.from({ length: 1201 }, (_, i) => ({
    id: "entry-" + i,
    user_id: "owner",
    type: "expense",
    amount_cents: 1,
    currency: "MYR",
    entry_date: "2026-01-01",
  }));
  const api = createTrackerApi(
    {
      rpc: async (name) => {
        assert.equal(name, "export_transactions");
        return { data: rows, error: null };
      },
    },
    "owner",
  );
  assert.equal((await api.exportAll()).length, 1201);
  rows[1200].user_id = "other";
  await assert.rejects(api.exportAll(), /owner/);
});

test("Realtime subscriptions filter the owner, refresh on reconnect and stop late callbacks", async () => {
  const { createTrackerApi } = await import("./tracker-api.mjs");
  let change,
    status,
    removed = 0,
    options,
    calls = 0;
  const channel = {
    on(_e, opts, cb) {
      options = opts;
      change = cb;
      return channel;
    },
    subscribe(cb) {
      status = cb;
      return channel;
    },
  };
  const api = createTrackerApi(
    {
      channel: () => channel,
      removeChannel: async () => {
        removed++;
      },
    },
    "owner",
  );
  let states = [];
  const stop = api.subscribe(
    () => calls++,
    (s) => states.push(s),
  );
  assert.equal(options.filter, "user_id=eq.owner");
  change({});
  status("SUBSCRIBED");
  assert.equal(calls, 2);
  assert.deepEqual(states, ["SUBSCRIBED"]);
  stop();
  change({});
  status("SUBSCRIBED");
  assert.equal(calls, 2);
  assert.equal(removed, 1);
  api.destroy();
});

test("real SDK rejects a delayed credential lookup after the signed-in owner changes", async () => {
  const { createTrackerApi } = await import("./tracker-api.mjs");
  let session = { user: { id: "A" }, access_token: "synthetic-A" },
    hold = false,
    release,
    enter;
  const gate = new Promise((r) => (release = r)),
    started = new Promise((r) => (enter = r)),
    requests = [];
  const authClient = {
    auth: {
      async getSession() {
        if (hold) {
          enter();
          await gate;
        }
        return { data: { session } };
      },
    },
  };
  const api = createTrackerApi(authClient, "A", {
    url: "https://synthetic.invalid",
    key: "synthetic-public",
    fetch: async (...args) => {
      requests.push(args);
      return new Response("{}");
    },
  });
  await new Promise((r) => setImmediate(r));
  hold = true;
  const writing = api.create({
    type: "expense",
    amount_cents: 1,
    request_id: "synthetic",
  });
  await started;
  session = { user: { id: "B" }, access_token: "synthetic-B" };
  release();
  await assert.rejects(writing);
  assert.deepEqual(requests, []);
  api.destroy();
});
test("a late tracker acknowledgement cannot reappear after teardown", async () => {
  const { createTrackerApi } = await import("./tracker-api.mjs");
  let release;
  const api = createTrackerApi(
    { rpc: () => new Promise((r) => (release = r)) },
    "owner",
  );
  const waiting = api.metadata();
  api.destroy();
  release({ data: { accounts: [] }, error: null });
  await assert.rejects(waiting, /Session ended/);
});

test('history cursor stays stable across concurrent inserts and timestamp ties',async()=>{
 const {createTrackerApi}=await import('./tracker-api.mjs');
 const id=n=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
 const stamp='2026-10-10T12:00:00.123456+00:00';
 const rows=Array.from({length:60},(_,n)=>({id:id(60-n),user_id:'owner',type:'expense',currency:'MYR',amount_cents:1,entry_date:'2026-10-10',occurred_at:stamp}));
 const filters=[];
 const client={from(){let filter;const q={select(){return q},eq(){return q},gte(){return q},lt(){return q},order(){return q},or(value){filter=value;filters.push(value);return q},async range(start,end){assert.equal(start,0);let chosen=rows;if(filter){const boundary=filter.match(/id\.lt\.([a-f0-9-]+)/)[1];chosen=rows.filter(r=>r.occurred_at<stamp||(r.occurred_at===stamp&&r.id<boundary))}return {data:chosen.slice(start,end+1),error:null}}};return q}};
 const api=createTrackerApi(client,'owner');const first=await api.list('2026-10');
 assert.equal(first.entries.length,50);assert.equal(first.nextCursor.occurred_at,stamp);
 rows.unshift({...rows[0],id:id(61),occurred_at:'2026-10-11T00:00:00+00:00'});
 const second=await api.list('2026-10',first.nextCursor);
 const all=[...first.entries,...second.entries];assert.equal(all.length,60);assert.equal(new Set(all.map(r=>r.id)).size,60);assert.equal(second.hasMore,false);
 assert.ok(filters[0].includes('occurred_at.lt.'+stamp));assert.ok(filters[0].includes('id.lt.'+first.entries.at(-1).id));
 assert.equal((await api.list('2026-10')).entries[0].id,id(61));
 await assert.rejects(api.list('2026-10',{id:'bad),user_id.eq.other',occurred_at:stamp}),/cursor/);
});
