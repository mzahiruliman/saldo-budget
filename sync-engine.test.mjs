import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine } from './sync-engine.mjs';

const clone = value => structuredClone(value);
test('slow reload reschedules edits whose debounce elapsed before load completed', async () => {
  const api = memoryAPI();
  const engine = new SyncEngine({ api, initial: {} });
  await engine.start();
  const gate = deferred();
  api.load = () => gate.promise;
  const loading = engine.reloadRemote();
  engine.change({ pending: true });
  await pause(250);
  assert.equal(api.writes.length, 0);
  gate.resolve(null);
  await loading;
  await pause(250);
  assert.equal(api.writes.length, 1);
  assert.deepEqual(api.record.payload, { pending: true });
  engine.stop();
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function memoryAPI(record = null) {
  return {
    record: clone(record), writes: [], failLoad: false, failWrite: false,
    async load() {
      if (this.failLoad) throw new Error('network unavailable');
      return clone(this.record);
    },
    async write(payload, revision) {
      this.writes.push({ payload: clone(payload), revision });
      if (this.failWrite) throw new Error('network unavailable');
      if (revision !== (this.record?.revision ?? 0)) {
        throw Object.assign(new Error('SALDO_CONFLICT'), { code: 'SALDO_CONFLICT' });
      }
      this.record = { payload: clone(payload), revision: revision + 1, updated_at: 'fixture-time' };
      return clone(this.record);
    }
  };
}
function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value) };
}

test('change snapshots data and debounces first creation at revision zero', async () => {
  const api = memoryAPI();
  const states = [];
  const storage = memoryStorage();
  const engine = new SyncEngine({ api, initial: {}, storage, cacheKey: 'user-a', onState: s => states.push(s) });
  await engine.start();
  const draft = { value: 1 };
  engine.change(draft);
  draft.value = 99;
  assert.deepEqual(engine.payload, { value: 1 });
  assert.deepEqual(JSON.parse(storage.getItem('user-a')), { payload: { value: 1 }, revision: 0, dirty: true });
  await pause(80);
  assert.equal(api.writes.length, 0);
  await pause(180);
  assert.equal(api.writes.length, 1);
  assert.equal(api.writes[0].revision, 0);
  assert.equal(engine.revision, 1);
  assert.equal(engine.dirty, false);
  assert.equal(engine.status, 'saved');
  assert.ok(states.some(s => s.status === 'saving'));
  assert.equal(JSON.parse(storage.getItem('user-a')).dirty, false);
});

test('network write failure retains draft and manual flush retries', async () => {
  const api = memoryAPI();
  const storage = memoryStorage();
  const engine = new SyncEngine({ api, initial: {}, storage, cacheKey: 'a' });
  await engine.start();
  api.failWrite = true;
  engine.change({ draft: true });
  await engine.flush();
  assert.equal(engine.status, 'offline');
  assert.equal(engine.dirty, true);
  assert.equal(JSON.parse(storage.getItem('a')).dirty, true);
  api.failWrite = false;
  await engine.flush();
  assert.equal(engine.status, 'saved');
  assert.equal(engine.revision, 1);
});

test('stale revision freezes writes until explicit remote reload', async () => {
  const api = memoryAPI({ payload: { value: 'old' }, revision: 1 });
  const seen = [];
  const storage = memoryStorage();
  const engine = new SyncEngine({ api, initial: {}, storage, cacheKey: 'a', onData: p => seen.push(p) });
  await engine.start();
  api.record = { payload: { value: 'other device' }, revision: 2 };
  engine.change({ value: 'local' });
  await engine.flush();
  assert.equal(engine.status, 'conflict');
  assert.equal(engine.dirty, true);
  engine.change({ value: 'new local' });
  await engine.flush();
  await pause(230);
  assert.equal(api.writes.length, 1);
  assert.deepEqual(engine.payload, { value: 'new local' });
  await engine.reloadRemote();
  assert.equal(engine.status, 'ready');
  assert.equal(engine.dirty, false);
  assert.equal(engine.revision, 2);
  assert.deepEqual(seen.at(-1), { value: 'other device' });
  assert.deepEqual(JSON.parse(storage.getItem('a')), { payload: { value: 'other device' }, revision: 2, dirty: false });
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('inflight edits serialize with acknowledged revision without clobbering latest', async () => {
  const api = memoryAPI();
  const gate = deferred();
  const entered = deferred();
  const write = api.write.bind(api);
  api.write = async (...args) => { entered.resolve(); await gate.promise; return write(...args); };
  const engine = new SyncEngine({ api, initial: {} });
  await engine.start();
  engine.change({ value: 1 });
  const first = engine.flush();
  await entered.promise;
  engine.change({ value: 2 });
  const second = engine.flush();
  assert.equal(engine.status, 'saving');
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(api.writes, [
    { payload: { value: 1 }, revision: 0 },
    { payload: { value: 2 }, revision: 1 }
  ]);
  assert.deepEqual(engine.payload, { value: 2 });
  assert.equal(engine.revision, 2);
  assert.equal(engine.dirty, false);
});

test('recovered drafts compare their base revision before any retry', async () => {
  for (const base of [0, 3, 4]) {
    const storage = memoryStorage();
    storage.setItem('a', JSON.stringify({ payload: { local: true }, revision: base, dirty: true }));
    storage.setItem('b', JSON.stringify({ payload: { secret: true }, revision: 3, dirty: true }));
    const api = memoryAPI({ payload: { remote: true }, revision: 3 });
    const seen = [];
    const engine = new SyncEngine({ api, initial: {}, storage, cacheKey: 'a', onData: p => seen.push(p) });
    await engine.start();
    assert.deepEqual(seen.at(-1), { local: true });
    assert.equal(engine.dirty, true);
    assert.equal(engine.revision, base);
    assert.equal(engine.status, base === 3 ? 'ready' : 'conflict');
    await engine.flush();
    assert.equal(api.writes.length, base === 3 ? 1 : 0);
  }
});

test('failed startup exposes recovered draft but blocks writes until a successful load', async () => {
  const api = memoryAPI({ payload: { server: true }, revision: 5 });
  api.failLoad = true;
  const storage = memoryStorage();
  storage.setItem('a', JSON.stringify({ payload: { draft: 1 }, revision: 5, dirty: true }));
  const seen = [];
  const engine = new SyncEngine({ api, initial: {}, storage, cacheKey: 'a', onData: p => seen.push(p) });
  await engine.start();
  assert.equal(engine.status, 'offline');
  assert.deepEqual(seen.at(-1), { draft: 1 });
  engine.change({ draft: 2 });
  await engine.flush();
  assert.equal(api.writes.length, 0);
  api.failLoad = false;
  await engine.start();
  await engine.flush();
  assert.deepEqual(api.record.payload, { draft: 2 });
});

test('stop prevents late load, save, reload callbacks and scheduled writes', async () => {
  for (const operation of ['start', 'flush', 'reloadRemote']) {
    const api = memoryAPI();
    const storage = memoryStorage();
    const callbacks = [];
    const engine = new SyncEngine({ api, initial: {}, storage, cacheKey: 'a',
      onData: p => callbacks.push(p), onState: s => callbacks.push(s) });
    if (operation !== 'start') await engine.start();
    const gate = deferred();
    if (operation === 'flush') {
      engine.change({ draft: true });
      api.write = () => gate.promise;
    } else api.load = () => gate.promise;
    const pending = engine[operation]();
    engine.stop();
    const count = callbacks.length;
    const before = storage.getItem('a');
    gate.resolve({ payload: { late: true }, revision: 10 });
    await pending;
    engine.change({ afterStop: true });
    await engine.flush();
    await engine.start();
    await pause(220);
    assert.equal(callbacks.length, count);
    assert.equal(storage.getItem('a'), before);
    assert.notDeepEqual(engine.payload, { late: true });
  }
  const api = memoryAPI();
  const engine = new SyncEngine({ api, initial: {} });
  await engine.start();
  engine.change({ pending: true });
  engine.stop();
  await pause(230);
  assert.equal(api.writes.length, 0);
});

test('cache write failures report honest local error while cloud can still acknowledge', async () => {
  const api = memoryAPI();
  const states = [];
  const storage = { getItem: () => null, setItem: () => { throw new Error('quota exceeded'); } };
  const engine = new SyncEngine({ api, initial: {}, storage, cacheKey: 'a', onState: s => states.push(s) });
  await engine.start();
  assert.doesNotThrow(() => engine.change({ value: 1 }));
  assert.equal(engine.status, 'error');
  assert.match(states.at(-1).error, /cache.*quota exceeded/i);
  await engine.flush();
  assert.equal(engine.revision, 1);
  assert.equal(engine.dirty, false);
  assert.deepEqual(api.record.payload, { value: 1 });
  assert.equal(engine.status, 'saved');
  assert.match(states.at(-1).error, /cache/i);
});

test('cache read errors and malformed entries cannot block remote load or leak another key', async () => {
  const cases = [
    { getItem: () => { throw new Error('storage blocked'); } },
    { getItem: () => '{broken' },
    { getItem: () => JSON.stringify({ payload: {}, dirty: true, revision: 'invalid' }) },
    { getItem: () => JSON.stringify({ revision: 0, dirty: true }) }
  ];
  for (const bad of cases) {
    const api = memoryAPI({ payload: { server: true }, revision: 7 });
    const states = [];
    const engine = new SyncEngine({ api, initial: {}, storage: bad, cacheKey: 'a', onState: s => states.push(s) });
    await engine.start();
    assert.deepEqual(engine.payload, { server: true });
    assert.equal(engine.revision, 7);
    assert.match(states.at(-1).error, /cache/i);
  }
  const storage = memoryStorage();
  storage.setItem('other-user', JSON.stringify({ payload: { secret: true }, revision: 1, dirty: true }));
  const engine = new SyncEngine({ api: memoryAPI(), initial: { blank: true }, storage, cacheKey: 'new-user' });
  await engine.start();
  assert.deepEqual(engine.payload, { blank: true });
});

test('invalid write acknowledgments never mark a draft saved', async () => {
  for (const response of [null, { payload: {}, revision: 0 }, { payload: {}, revision: '1' }, { revision: 1 }]) {
    const api = memoryAPI();
    api.write = async () => response;
    const states = [];
    const engine = new SyncEngine({ api, initial: {}, onState: s => states.push(s) });
    await engine.start();
    engine.change({ draft: true });
    await engine.flush();
    assert.equal(engine.dirty, true);
    assert.equal(engine.revision, 0);
    assert.equal(engine.status, 'error');
    assert.equal(states.some(s => s.status === 'saved'), false);
  }
});

test('failed explicit reload preserves exportable draft and cache without resuming writes', async () => {
  const api = memoryAPI({ payload: { remote: true }, revision: 2 });
  const storage = memoryStorage();
  const engine = new SyncEngine({ api, initial: {}, storage, cacheKey: 'a' });
  await engine.start();
  engine.change({ draft: true });
  api.failLoad = true;
  await engine.reloadRemote();
  assert.equal(engine.status, 'offline');
  assert.equal(engine.dirty, true);
  assert.deepEqual(engine.payload, { draft: true });
  assert.equal(JSON.parse(storage.getItem('a')).dirty, true);
  await engine.flush();
  assert.equal(api.writes.length, 0);
});

test('invalid remote envelopes cannot authorize writes', async () => {
  for (const response of [{ payload: {}, revision: '1' }, { payload: {}, revision: -1 }, { revision: 3 }]) {
    const api = memoryAPI();
    api.load = async () => response;
    const engine = new SyncEngine({ api, initial: {} });
    await engine.start();
    assert.equal(engine.status, 'error');
    engine.change({ local: true });
    await engine.flush();
    assert.equal(api.writes.length, 0);
  }
});

test('loaded flag identifies whether revision is known for explicit retry routing', async () => {
  const api = memoryAPI();
  api.failLoad = true;
  const engine = new SyncEngine({ api, initial: {} });
  assert.equal(engine.loaded, false);
  await engine.start();
  assert.equal(engine.loaded, false);
  engine.change({ local: true });
  await engine.flush();
  assert.equal(api.writes.length, 0);
  api.failLoad = false;
  await engine.start();
  assert.equal(engine.loaded, true);
  await engine.flush();
  assert.equal(engine.status, 'saved');
  engine.stop();
  assert.equal(engine.loaded, false);
});

test('a new change cannot keep the previous saved indicator', async () => {
  const engine = new SyncEngine({ api: memoryAPI(), initial: {} });
  await engine.start();
  engine.change({ value: 1 });
  await engine.flush();
  assert.equal(engine.status, 'saved');
  engine.change({ value: 2 });
  assert.equal(engine.dirty, true);
  assert.equal(engine.status, 'ready');
  engine.stop();
});

test('startup retry preserves newer memory draft if cache write failed', async () => {
  const api = memoryAPI();
  api.failLoad = true;
  const storage = memoryStorage();
  storage.setItem('a', JSON.stringify({ payload: { old: true }, revision: 0, dirty: true }));
  const engine = new SyncEngine({ api, initial: {}, storage, cacheKey: 'a' });
  await engine.start();
  storage.setItem = () => { throw new Error('quota'); };
  engine.change({ latest: true });
  api.failLoad = false;
  await engine.start();
  assert.deepEqual(engine.payload, { latest: true });
  await engine.flush();
  assert.deepEqual(api.record.payload, { latest: true });
});

test('newer load supersedes late old load without data regression', async () => {
  const api = memoryAPI();
  const older = deferred();
  const newer = deferred();
  let calls = 0;
  api.load = () => (++calls === 1 ? older.promise : newer.promise);
  const seen = [];
  const engine = new SyncEngine({ api, initial: {}, onData: p => seen.push(p) });
  const first = engine.start();
  const second = engine.reloadRemote();
  newer.resolve({ payload: { latest: true }, revision: 2 });
  await second;
  const count = seen.length;
  older.resolve({ payload: { old: true }, revision: 1 });
  await first;
  assert.equal(seen.length, count);
  assert.deepEqual(engine.payload, { latest: true });
  assert.equal(engine.revision, 2);
});

test('explicit reload waits for inflight write before reading remote and discards queued draft', async () => {
  const api = memoryAPI();
  const storage = memoryStorage();
  const gate = deferred();
  const entered = deferred();
  const write = api.write.bind(api);
  api.write = async (...args) => { entered.resolve(); await gate.promise; return write(...args); };
  let loads = 0;
  const load = api.load.bind(api);
  api.load = async () => { loads++; return load(); };
  const engine = new SyncEngine({ api, initial: {}, storage, cacheKey: 'a' });
  await engine.start();
  engine.change({ sent: true });
  const saving = engine.flush();
  await entered.promise;
  engine.change({ queued: true });
  const loading = engine.reloadRemote();
  await pause(10);
  assert.equal(loads, 1, 'no stale read while the write is unresolved');
  assert.equal(engine.loaded, false);
  gate.resolve();
  await Promise.all([saving, loading]);
  assert.equal(api.writes.length, 1, 'confirmed reload discards unsent queued edits');
  assert.deepEqual(engine.payload, { sent: true });
  assert.equal(engine.revision, 1);
  assert.equal(engine.status, 'ready');
  assert.equal(engine.dirty, false);
  assert.deepEqual(JSON.parse(storage.getItem('a')), { payload: { sent: true }, revision: 1, dirty: false });
});

test('edits arriving during confirmed reload remain exportable and base checked', async () => {
  for (const revision of [1, 2]) {
    const api = memoryAPI({ payload: { remote: true }, revision: 1 });
    const engine = new SyncEngine({ api, initial: {} });
    await engine.start();
    const gate = deferred();
    api.load = () => gate.promise;
    const loading = engine.reloadRemote();
    engine.change({ typedDuringLoad: true });
    await engine.flush();
    assert.equal(api.writes.length, 0);
    gate.resolve({ payload: { newestRemote: true }, revision });
    await loading;
    assert.deepEqual(engine.payload, { typedDuringLoad: true });
    assert.equal(engine.dirty, true);
    assert.equal(engine.status, revision === 1 ? 'ready' : 'conflict');
    engine.stop();
  }
});

test('successful startup retry automatically debounces a pending safe draft', async () => {
  const api = memoryAPI();
  api.failLoad = true;
  const engine = new SyncEngine({ api, initial: {} });
  await engine.start();
  engine.change({ pending: true });
  await pause(230);
  assert.equal(api.writes.length, 0);
  api.failLoad = false;
  await engine.start();
  assert.equal(engine.status, 'ready');
  await pause(230);
  assert.equal(engine.status, 'saved');
  assert.deepEqual(api.record.payload, { pending: true });
  engine.stop();
});

test('blank start adopts initial without creating a server record', async () => {
  const api = memoryAPI();
  const seen = [];
  const engine = new SyncEngine({ api, initial: { rows: [] }, onData: p => seen.push(p) });
  await engine.start();
  assert.equal(engine.status, 'ready');
  assert.equal(engine.revision, 0);
  assert.equal(engine.dirty, false);
  assert.deepEqual(seen, [{ rows: [] }]);
  await engine.flush();
  assert.equal(api.writes.length, 0);
});
