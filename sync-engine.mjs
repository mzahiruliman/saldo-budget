const copy = value => structuredClone(value);
const validRecord = value => value !== null && typeof value === 'object' &&
  Object.hasOwn(value, 'payload') && Number.isSafeInteger(value.revision) && value.revision >= 0;

/** JSON snapshot synchronization; transport and user-scoped storage are supplied by the caller. */
export class SyncEngine {
  constructor({ api, initial, onData = () => {}, onState = () => {}, storage = null, cacheKey = '', validatePayload = () => true }) {
    Object.assign(this, { api, onData, onState, storage, cacheKey, validatePayload });
    this.initial = copy(initial);
    this.payload = copy(initial);
    this.revision = 0;
    this.dirty = false;
    this.status = 'ready';
    this.known = false;
    this.version = 0;
    this.epoch = 0;
  }

  /** False until a successful remote load; false again after stop or a failed reload. */
  get loaded() { return this.known; }

  state(status, error = '') {
    if (this.stopped) return;
    this.status = status;
    this.onState({ status, error: [error, this.cacheError].filter(Boolean).join('; ') });
  }

  async start() {
    if (this.stopped) return;
    const epoch = ++this.epoch;
    this.state('loading');
    let cached = null;
    try {
      cached = this.storage && this.cacheKey
        ? JSON.parse(this.storage.getItem(this.cacheKey) || 'null') : null;
      if (cached && (!Object.hasOwn(cached, 'payload') ||
          !Number.isSafeInteger(cached.revision) || cached.revision < 0 || typeof cached.dirty !== 'boolean' ||
          !this.validatePayload(cached.payload))) {
        throw new Error('Invalid draft envelope');
      }
    } catch (error) {
      cached = null;
      this.cacheError = `Local cache unavailable: ${error.message ?? error}`;
      this.state('error');
    }
    this.known = false;
    if (cached && !this.dirty) {
      this.payload = copy(cached.payload);
      this.revision = cached.revision;
      this.dirty = cached.dirty === true;
      this.onData(copy(this.payload));
    }
    let remote;
    try { remote = await this.api.load(); }
    catch (error) {
      if (this.stopped || epoch !== this.epoch) return;
      this.onData(copy(this.payload));
      this.state('offline', String(error.message ?? error));
      return;
    }
    if (this.stopped || epoch !== this.epoch) return;
    const pending = this.dirty;
    if (remote !== null && !validRecord(remote)) {
      this.onData(copy(this.payload));
      this.state('error', 'Invalid remote revision or payload');
      return;
    }
    this.payload = copy(pending ? this.payload : remote ? remote.payload : this.initial);
    this.revision = pending ? this.revision : remote?.revision ?? 0;
    this.dirty = pending;
    this.known = true;
    this.conflict = pending && this.revision !== (remote?.revision ?? 0) ? { remote: copy(remote) } : null;
    this.onData(copy(this.payload));
    this.state(this.conflict ? 'conflict' : 'ready');
    if (this.dirty && !this.conflict) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { void this.flush(); }, 200);
    }
  }

  cache() {
    try {
      if (this.storage && this.cacheKey) this.storage.setItem(this.cacheKey, JSON.stringify({
        payload: this.payload, revision: this.revision, dirty: this.dirty
      }));
      this.cacheError = '';
    } catch (error) {
      this.cacheError = `Local cache unavailable: ${error.message ?? error}`;
      this.state(this.conflict ? 'conflict' : 'error');
    }
  }

  change(payload) {
    if (this.stopped) return;
    this.version++;
    this.payload = copy(payload);
    this.dirty = true;
    if (this.status === 'saved' || this.status === 'ready') this.state('ready');
    this.cache();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, 200);
  }

  async flush() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    if (this.inflight) return this.inflight;
    if (!this.known || !this.dirty || this.conflict) return;
    this.inflight = this.drain();
    try { await this.inflight; } finally { this.inflight = null; }
  }

  async drain() {
    const epoch = this.epoch;
    while (this.dirty && !this.conflict && !this.stopped && this.known && epoch === this.epoch) {
      const version = this.version;
      this.state('saving');
      try {
        const result = await this.api.write(copy(this.payload), this.revision);
        if (this.stopped || epoch !== this.epoch) return;
        if (!validRecord(result) || result.revision <= this.revision) {
          this.state('error', 'Invalid write acknowledgment revision or payload');
          return;
        }
        this.revision = result.revision;
        this.dirty = this.version !== version;
        this.cache();
        if (!this.dirty) this.state('saved');
      } catch (error) {
        if (this.stopped || epoch !== this.epoch) return;
        const message = String(error.message ?? error);
        if (error.code === 'SALDO_CONFLICT' || message.includes('SALDO_CONFLICT')) {
          this.conflict = { revision: this.revision };
          this.state('conflict', message);
        } else this.state('offline', message);
        return;
      }
    }
  }

  async reloadRemote() {
    if (this.stopped) return;
    const epoch = ++this.epoch;
    const version = this.version;
    clearTimeout(this.timer);
    this.known = false;
    this.state('loading');
    if (this.inflight) await this.inflight;
    if (this.stopped || epoch !== this.epoch) return;
    let remote;
    try { remote = await this.api.load(); }
    catch (error) {
      if (!this.stopped && epoch === this.epoch) this.state('offline', String(error.message ?? error));
      return;
    }
    if (this.stopped || epoch !== this.epoch) return;
    if (remote !== null && !validRecord(remote)) {
      this.state('error', 'Invalid remote revision or payload');
      return;
    }
    const editedDuringLoad = this.version !== version;
    if (!editedDuringLoad) {
      this.payload = copy(remote ? remote.payload : this.initial);
      this.revision = remote?.revision ?? 0;
      this.dirty = false;
    }
    this.conflict = editedDuringLoad && this.revision !== (remote?.revision ?? 0)
      ? { remote: copy(remote) } : null;
    this.known = true;
    this.cache();
    this.onData(copy(this.payload));
    this.state(this.conflict ? 'conflict' : 'ready');
    if (this.dirty && !this.conflict) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { void this.flush(); }, 200);
    }
  }

  stop() {
    this.stopped = true;
    this.known = false;
    clearTimeout(this.timer);
  }
}
