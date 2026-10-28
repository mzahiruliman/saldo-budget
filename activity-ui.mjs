import { parseAmount } from './tracker-model.mjs';
import { money } from './model.mjs';

// This view owns actual transactions only. It never mutates the budget document.
export function mountActivity({ root, api, getBudget, functionUrl = '', userId }) {
  let visible = false, destroyed = false, generation = 0, historyRequest = 0;
  let view, summaryBox, historyBox, form, pageEntries = [], hasMore = false, pageCursor = null, month;
  let metadata = { accounts: [], categories: [] };
  let pending = null, saving = false, connection = 'Connecting to transaction updates…';
  const assignmentDrafts = new Map();
  const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const beforeUnload = event => {
    if (pending) { event.preventDefault(); event.returnValue = ''; }
  };
  window.addEventListener('beforeunload', beforeUnload);
  const alive = owner => visible && !destroyed && owner === generation && root.contains(view);
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const accountList = () => (getBudget().accounts || []).filter(a => !['recipient', 'external'].includes(a.kind || a.type));
  const accountName = (id, snapshot) => id ? ([...accountList(), ...metadata.accounts].find(a => a.id === id)?.name || snapshot || id) : 'Unassigned';
  function error(target, prefix, exception) {
    target.replaceChildren(node('p', `${prefix}: ${exception?.message || 'Please try again.'}`, 'activity-error'));
  }
  function accountSelect(select, unassigned) {
    select.replaceChildren();
    if (unassigned) select.append(new Option('Unassigned', ''));
    for (const a of accountList()) select.append(new Option(a.name, a.id));
    select.required = !unassigned;
  }
  function renderSummary(summary) {
    summaryBox.replaceChildren();
    for (const [label, key] of [['Income', 'income_cents'], ['Expense', 'expense_cents'], ['Transfer', 'transfer_cents']]) {
      const card = node('div', undefined, 'activity-stat');
      card.append(node('span', label), node('strong', money(summary[key])));
      summaryBox.append(card);
    }
    const details = node('div', undefined, 'activity-movements');
    details.append(node('h3', 'Account net movement'), node('p', 'Recorded movement only — not a bank balance. No dated opening balance has been provided.'));
    const unassigned = (summary.unassigned_income_cents || 0) + (summary.unassigned_expense_cents || 0);
    if (unassigned) details.append(node('p', `Unassigned · income ${money(summary.unassigned_income_cents || 0)} · expense ${money(summary.unassigned_expense_cents || 0)}`, 'activity-badge'));
    const movements = summary.movements || {};
    for (const [id, delta] of Object.entries(movements)) details.append(node('p', `${accountName(id)} · ${money(delta)}`));
    if (!Object.keys(movements).length) details.append(node('p', 'No account movement recorded.'));
    summaryBox.append(details);
  }
  function renderAssignment(entry, owner) {
    const draft = assignmentDrafts.get(entry.id), row = node('tr', undefined, 'activity-assignment-row');
    const cell = node('td'); cell.colSpan = 8;
    const editor = node('form', undefined, 'activity-form');
    const accountLabel = node('label', 'Assign owned account'), select = node('select');
    select.setAttribute('aria-label', 'Assign owned account'); accountSelect(select, false);
    select.prepend(new Option('Choose an account', '')); select.value = draft.accountId;
    select.onchange = () => { if (alive(owner)) draft.accountId = select.value; };
    accountLabel.append(select); editor.append(accountLabel);
    let category;
    if (entry.type === 'expense') {
      const label = node('label', 'Assignment category'); category = node('select'); category.setAttribute('aria-label', 'Assignment category');
      for (const [id, name] of [['', 'No category'], ['commitment', 'Commitment'], ['entertainment', 'Entertainment'], ['savings', 'Savings']]) category.append(new Option(name, id));
      category.value = draft.category;
      category.onchange = () => { if (alive(owner)) draft.category = category.value; };
      label.append(category); editor.append(label);
    }
    const message = node('p', draft.error || 'Resolve the unknown owned side only. To correct an existing route, void the entry and record a new one.', draft.error ? 'activity-error activity-wide' : 'activity-wide');
    message.setAttribute('role', 'status');
    const submit = node('button', 'Confirm assignment'); submit.type = 'submit'; submit.className = 'primary';
    const cancel = node('button', 'Cancel assignment'); cancel.type = 'button';
    cancel.onclick = () => { if (alive(owner) && !draft.busy) { assignmentDrafts.delete(entry.id); renderHistory(); } };
    editor.append(message, submit, cancel);
    for (const control of editor.elements) control.disabled = draft.busy;
    editor.onsubmit = async event => {
      event.preventDefault();
      if (!alive(owner) || draft.busy || !editor.reportValidity()) return;
      if (!accountList().some(a => a.id === select.value)) { draft.error = 'Choose one of your current owned accounts.'; renderHistory(); return; }
      const details = {accountId:select.value,category:entry.type === 'expense' ? category.value || null : null};
      draft.busy = true; draft.error = ''; for (const control of editor.elements) control.disabled = true;
      message.textContent = 'Assigning recorded entry…';
      try {
        await api.assign(entry.id, details);
        if (!alive(owner)) return;
        assignmentDrafts.delete(entry.id); await refresh();
      } catch (exception) {
        if (!alive(owner)) return;
        draft.busy = false; draft.error = `Unable to assign account: ${exception?.message || 'Try again.'}`; renderHistory();
      }
    };
    cell.append(editor); row.append(cell); return row;
  }
  function renderHistory() {
    const owner = generation;
    historyBox.replaceChildren(node('h2', 'Transaction history'), node('p', 'Totals cover all recorded entries. Load more adds older rows; Refresh activity loads new entries.'));
    if (!pageEntries.length) historyBox.append(node('p', 'No recorded transactions for this month.'));
    else {
      const table = node('table');
      const head = node('thead'), row = node('tr');
      const columns = ['Date', 'Type', 'From → To', 'External party', 'Category', 'Amount', 'Status / source', 'Action'];
      for (const label of columns) row.append(node('th', label));
      head.append(row); table.append(head);
      const body = node('tbody');
      for (const entry of pageEntries) {
        const tr = node('tr'); tr.dataset.entry = entry.id;
        const from = entry.type === 'income' ? entry.external_party || 'External party' : accountName(entry.from_account_id, entry.from_account_name);
        const to = entry.type === 'expense' ? entry.external_party || 'External party' : accountName(entry.to_account_id, entry.to_account_name);
        const values = [new Date(entry.occurred_at).toLocaleString(), entry.type, `${from} → ${to}`, entry.external_party || '—', entry.category || '—', money(entry.amount_cents), `${entry.status || (entry.voided_at ? 'void' : 'active')} · ${entry.source || 'manual'}`];
        values.forEach((value, i) => { const td = node('td', value); td.dataset.label = columns[i]; tr.append(td); });
        const action = node('td'); action.dataset.label = 'Action';
        if (!entry.voided_at && !['void', 'voided'].includes(entry.status)) {
          const button = node('button', 'Void'); button.type = 'button'; button.dataset.void = entry.id;
          const owner = generation;
          button.onclick = async () => {
            if (!alive(owner) || button.disabled || !window.confirm('Void this recorded transaction? This removes its effect on actual totals only. Your plan and paid flags will not change.')) return;
            button.disabled = true;
            try { await api.void(entry.id); if (alive(owner)) await refresh(); }
            catch (exception) { if (alive(owner)) { button.disabled = false; action.append(node('p', `Unable to void: ${exception?.message || 'Try again.'}`, 'activity-error')); } }
          };
          button.disabled = assignmentDrafts.get(entry.id)?.busy || false;
          action.append(button);
          if ((entry.type === 'income' && !entry.to_account_id) || (entry.type === 'expense' && !entry.from_account_id)) {
            const assign = node('button', 'Assign account'); assign.type = 'button'; assign.disabled = assignmentDrafts.has(entry.id);
            assign.onclick = () => {
              if (!alive(owner) || assignmentDrafts.has(entry.id)) return;
              assignmentDrafts.set(entry.id, {accountId:'',category:entry.category || '',busy:false,error:''}); renderHistory();
            };
            action.append(assign);
          }
        }
        tr.append(action); body.append(tr);
        if (assignmentDrafts.has(entry.id) && !entry.voided_at && !['void', 'voided'].includes(entry.status)) body.append(renderAssignment(entry, owner));
      }
      table.append(body); historyBox.append(table);
    }
    if (hasMore) {
      const more = node('button', 'Load more'); more.type = 'button';
      more.onclick = () => { if (alive(owner)) void loadHistory(true); };
      historyBox.append(more);
    }
  }
  async function loadHistory(more = false) {
    if (!visible || destroyed) return;
    const owner = generation, request = ++historyRequest;
    if (more) historyBox.querySelectorAll('button').forEach(b => { b.disabled = true; });
    else { historyBox.replaceChildren(node('p', 'Loading transactions…')); summaryBox.replaceChildren(node('p', 'Loading actual totals…')); }
    try {
      const [page, summary] = await Promise.all([api.list(month, more ? pageCursor : null), api.summary(month)]);
      if (!alive(owner) || request !== historyRequest) return;
      pageEntries = more ? [...pageEntries, ...page.entries] : page.entries;
      hasMore = page.hasMore; pageCursor = page.nextCursor || null; renderSummary(summary); renderHistory();
    } catch (exception) {
      if (!alive(owner) || request !== historyRequest) return;
      if (more) {
        renderHistory();
        historyBox.append(node('p', `Unable to load more transactions: ${exception?.message || 'Try again.'}`, 'activity-error'));
      }
      else { error(historyBox, 'Unable to load transactions', exception); summaryBox.replaceChildren(node('p', 'Actual totals unavailable.')); }
      const retry = node('button', 'Retry history'); retry.onclick = () => { if (alive(owner)) void loadHistory(more); }; historyBox.append(retry);
    }
  }
  function lockEntry(locked) {
    for (const field of form.elements) field.disabled = locked;
  }
  function showPending(owner) {
    if (!alive(owner)) return;
    lockEntry(true);
    const message = form.querySelector('[data-save-message]');
    message.replaceChildren(node('p', 'Save result uncertain. Do not recreate this entry: retry sends the same request ID and unchanged details. Leaving this page before acknowledgement may cause a duplicate if you record it again.', 'activity-error'));
    const retry = node('button', 'Retry same entry'); retry.type = 'button'; retry.disabled = saving;
    retry.onclick = () => { if (alive(owner)) void savePending(owner); };
    const discard = node('button', 'Abandon uncertain entry'); discard.type = 'button'; discard.disabled = saving;
    discard.onclick = () => {
      if (!alive(owner) || saving) return;
      if (!window.confirm('This entry may already have been recorded. Abandoning it and recording again can cause a duplicate. Check transaction history first. Abandon the pending request?')) return;
      pending = null; lockEntry(false); message.replaceChildren(node('p', 'Pending request abandoned. Check history before recording again.'));
    };
    message.append(retry, discard);
  }
  async function savePending(owner) {
    if (!alive(owner) || !pending || saving) return;
    saving = true; lockEntry(true);
    const message = form.querySelector('[data-save-message]');
    message.replaceChildren(node('p', 'Saving recorded entry…'));
    const payload = pending;
    try {
      const result = await api.create(payload);
      if (!alive(owner)) return;
      pending = null; saving = false; lockEntry(false);
      message.replaceChildren(node('p', result.duplicate ? 'This entry was already recorded. Existing transaction acknowledged; no second entry was created.' : 'Entry recorded. Your planned budget and paid flags are unchanged.'));
      form.elements.amount.value = ''; form.elements.note.value = '';
      void refresh();
    } catch (exception) {
      if (!alive(owner)) return;
      saving = false; showPending(owner);
      message.append(node('p', exception?.message || 'Unable to confirm save.', 'activity-error'));
    }
  }
  function bindEntry(owner, updateType) {
    const currentForm = form, fields = currentForm.elements;
    if (pending) {
      fields.type.value = pending.type; updateType();
      fields.from.value = pending.from_account_id || ''; fields.to.value = pending.to_account_id || '';
      fields.external.value = pending.external_party; fields.amount.value = String(pending.amount_cents / 100);
      fields.category.value = pending.category || ''; fields.note.value = pending.note;
      const date = new Date(pending.occurred_at);
      fields.occurred.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      showPending(owner);
    }
    currentForm.onsubmit = event => {
      event.preventDefault();
      if (!alive(owner) || pending || saving || !currentForm.reportValidity()) return;
      const message = currentForm.querySelector('[data-save-message]');
      try {
        const type = fields.type.value;
        const from = type === 'income' ? null : fields.from.value || null;
        const to = type === 'expense' ? null : fields.to.value || null;
        const ids = new Set(accountList().map(a => a.id));
        if ((from && !ids.has(from)) || (to && !ids.has(to))) throw new Error('Choose one of your current accounts.');
        if (type === 'transfer' && (!from || !to || from === to)) throw new Error('A transfer needs two different owned accounts.');
        const amount = parseAmount(fields.amount.value);
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10000000000) throw new Error('Enter an amount between RM 0.01 and RM 100,000,000.');
        if (fields.note.value.length > 500) throw new Error('Keep the note within 500 characters.');
        const occurred = new Date(fields.occurred.value);
        if (!Number.isFinite(occurred.getTime())) throw new Error('Choose a valid date and time.');
        const payload = Object.freeze({request_id:crypto.randomUUID(),type,amount_cents:amount,currency:'MYR',occurred_at:occurred.toISOString(),time_zone:timeZone(),from_account_id:from,to_account_id:to,external_party:type === 'transfer' ? '' : fields.external.value.trim(),category:type === 'expense' ? fields.category.value || null : null,note:fields.note.value.trim()});
        if (!window.confirm(`Record ${type} of ${money(amount)}? This updates actual activity only, not your planned budget.`)) return;
        pending = payload; void savePending(owner);
      } catch (exception) { error(message, 'Entry not saved', exception); }
    };
  }
  function mountPair(owner) {
    const panel = node('section', undefined, 'activity-panel'); panel.dataset.pair = '';
    panel.innerHTML = `<h2>Pair Shortcuts</h2><p>A private device credential authorizes recording transactions for your account. It is not a project publishable key. Never share it, commit it, or put it in a budget backup.</p><p class="activity-endpoint" data-endpoint></p><ol><li>Generate a private token for this device and copy it now. It will not be shown again.</li><li>In Apple Shortcuts, add Get Contents of URL with method POST to the endpoint below.</li><li>Send the token in the Authorization header as Bearer TOKEN. Use a JSON body containing request_id (UUID), type, amount_cents (integer cents, so RM 1.23 is 123), currency (MYR), occurred_at (ISO timestamp), time_zone (IANA zone), from_account_id, to_account_id, external_party, category and note. Use null for an unknown owned account. Income has an external sender; expense has an external recipient; transfer needs two different owned IDs. Reuse the same request_id when retrying.</li><li>Test a small transaction, then check Activity. Revoke this credential if your device is lost.</li></ol><form class="activity-form"><label>Device name<input name="deviceName" maxlength="80" required value="My Shortcut"></label><label>Device time zone<input name="deviceZone" maxlength="100" required></label><label>Expires in days<input name="days" type="number" min="1" max="365" step="1" value="90" required></label><button type="submit">Generate private token</button></form><div data-pair-message aria-live="polite"></div><div data-token></div><h3>Paired devices</h3><div data-devices aria-live="polite"></div>`;
    view.append(panel);
    panel.querySelector('[data-endpoint]').textContent = functionUrl ? `Endpoint: ${functionUrl}` : 'Endpoint is not configured. Ask the app owner to configure the tracker function URL.';
    const ids = node('details', undefined, 'activity-device');
    ids.append(node('summary', 'Owned account IDs for Shortcuts'));
    for (const account of accountList()) ids.append(node('p', `${account.name} · ${account.id}`));
    ids.append(node('p', 'Fetch current metadata with GET ?action=metadata at the same endpoint using the private Bearer token. Do not use account names as IDs.'));
    panel.querySelector('ol').after(ids);
    const pairForm = panel.querySelector('form'), fields = pairForm.elements;
    fields.deviceZone.value = timeZone();
    const devicesBox = panel.querySelector('[data-devices]'), message = panel.querySelector('[data-pair-message]'), tokenBox = panel.querySelector('[data-token]');
    let deviceRequest = 0;
    async function loadDevices() {
      const request = ++deviceRequest;
      devicesBox.replaceChildren(node('p', 'Loading devices…'));
      try {
        const devices = await api.devices();
        if (!alive(owner) || request !== deviceRequest) return;
        devicesBox.replaceChildren();
        if (!devices.length) devicesBox.append(node('p', 'No paired devices.'));
        for (const device of devices) {
          const card = node('div', undefined, 'activity-device');
          const state = device.revoked_at ? 'Revoked' : new Date(device.expires_at).getTime() <= Date.now() ? 'Expired' : 'Active';
          card.append(node('strong', device.name), node('span', state, 'activity-badge'));
          const date = value => value ? new Date(value).toLocaleString() : 'Never';
          card.append(node('p', `${device.time_zone || 'UTC'} · Created ${date(device.created_at)} · Expires ${date(device.expires_at)} · Last used ${date(device.last_used_at)}`));
          if (!device.revoked_at) {
            const revoke = node('button', `Revoke ${device.name}`); revoke.type = 'button';
            revoke.onclick = async () => {
              if (!alive(owner) || revoke.disabled || !window.confirm(`Revoke ${device.name}? Its Shortcuts will stop recording transactions.`)) return;
              revoke.disabled = true;
              try {
                const revoked = await api.revoke(device.id);
                if (!alive(owner)) return;
                if (!revoked) throw new Error('Device was not revoked. Refresh the list and try again.');
                await loadDevices();
              } catch (exception) { if (alive(owner)) { revoke.disabled = false; error(message, 'Unable to revoke device', exception); } }
            };
            card.append(revoke);
          }
          devicesBox.append(card);
        }
      } catch (exception) {
        if (!alive(owner) || request !== deviceRequest) return;
        error(devicesBox, 'Unable to list devices', exception);
        const retry = node('button', 'Retry devices'); retry.onclick = () => { if (alive(owner)) void loadDevices(); }; devicesBox.append(retry);
      }
    }
    pairForm.onsubmit = async event => {
      event.preventDefault();
      if (!alive(owner) || pairForm.querySelector('button').disabled || !pairForm.reportValidity()) return;
      const name = fields.deviceName.value.trim(), zone = fields.deviceZone.value.trim(), days = Number(fields.days.value);
      try {
        if (!name) throw new Error('Enter a device name.');
        new Intl.DateTimeFormat('en', { timeZone: zone });
        if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Choose between 1 and 365 days.');
      } catch (exception) { error(message, 'Invalid pairing details', exception); return; }
      const submit = pairForm.querySelector('button'); submit.disabled = true;
      clearToken(); message.replaceChildren(node('p', 'Generating private credential…'));
      try {
        const result = await api.mint({name, timeZone:zone, days});
        if (!alive(owner)) return;
        submit.disabled = false;
        message.replaceChildren(node('p', 'Copy this private credential now. It disappears when you leave Activity and cannot be retrieved again.'));
        const label = node('label', 'Private device token'), textarea = node('textarea', undefined, 'activity-token');
        textarea.readOnly = true; textarea.value = result.token; textarea.rows = 3;
        textarea.setAttribute('autocomplete', 'off'); textarea.setAttribute('spellcheck', 'false');
        label.append(textarea); tokenBox.append(label);
        const copy = node('button', 'Copy token'); copy.type = 'button';
        copy.onclick = async () => {
          if (!alive(owner)) return;
          try { await navigator.clipboard.writeText(textarea.value); if (alive(owner)) message.replaceChildren(node('p', 'Token copied. Keep it private.')); }
          catch { if (alive(owner)) message.replaceChildren(node('p', 'Clipboard unavailable. Select and copy the private token manually.', 'activity-error')); }
        };
        const dismiss = node('button', 'Dismiss token'); dismiss.type = 'button';
        dismiss.onclick = () => { if (alive(owner)) { textarea.value = ''; tokenBox.replaceChildren(); } };
        tokenBox.append(copy, dismiss); void loadDevices();
      } catch (exception) {
        if (!alive(owner)) return;
        submit.disabled = false;
        error(message, 'Unable to confirm token generation; check the device list before retrying', exception);
        void loadDevices();
      }
    };
    void loadDevices();
  }
  function mountExport(owner) {
    const panel = node('section', undefined, 'activity-panel');
    panel.append(node('h2', 'Transaction export'), node('p', 'Download all recorded transactions across every month. This is separate from your budget backup and never includes device tokens.'));
    const button = node('button', 'Export all transactions (JSON)'); button.type = 'button';
    const message = node('div'); message.setAttribute('aria-live', 'polite');
    panel.append(button, message); view.append(panel);
    button.onclick = async () => {
      if (!alive(owner) || button.disabled) return;
      button.disabled = true; message.replaceChildren(node('p', 'Loading all transaction pages…'));
      try {
        const entries = await api.exportAll();
        if (!alive(owner)) return;
        const blob = new Blob([JSON.stringify({version:1,kind:'saldo-transactions',entries}, null, 2)], {type:'application/json'});
        const url = URL.createObjectURL(blob), link = node('a');
        link.href = url; link.download = 'saldo-transactions.json'; link.hidden = true;
        panel.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        message.replaceChildren(node('p', 'Transaction JSON download requested. This is not a budget backup.'));
      } catch (exception) { if (alive(owner)) error(message, 'Unable to export transactions', exception); }
      finally { if (alive(owner)) button.disabled = false; }
    };
  }
  function clearToken() {
    if (!view) return;
    const tokenBox = view.querySelector('[data-token]');
    if (tokenBox) { for (const textarea of tokenBox.querySelectorAll('textarea')) textarea.value = ''; tokenBox.replaceChildren(); }
  }
  function refresh() {
    if (!visible || destroyed) return Promise.resolve();
    const selected = getBudget().selectedmonth || getBudget().selected;
    if (selected !== month) return open();
    return loadHistory();
  }
  async function open() {
    if (destroyed) return;
    clearToken(); saving = false; assignmentDrafts.clear(); pageCursor = null; pageEntries = []; hasMore = false;
    visible = true; const owner = ++generation; ++historyRequest;
    month = getBudget().selectedmonth || getBudget().selected;
    view = node('section', undefined, 'activity-view');
    view.innerHTML = `<header class="activity-heading"><div><span class="activity-eyebrow">ACTIVITY</span><h1>Money tracker</h1><p>Actual money in and out, separate from your planned budget and paid flags.</p></div></header><p data-month></p><section class="activity-summary" data-summary aria-live="polite"></section><section class="activity-panel"><h2>New entry</h2><p>Record what happened. The editable date defaults to now, not the selected plan month.</p><form class="activity-form"><label>Type<select name="type" aria-label="Type"><option value="income">Income</option><option value="expense" selected>Expense</option><option value="transfer">Transfer</option></select></label><label data-from>From account<select name="from"></select></label><label data-to>To account<select name="to"></select></label><label data-external>External party<input name="external" maxlength="160" placeholder="Person, shop or other external party"></label><label>Amount (RM)<input name="amount" type="number" min="0.01" max="100000000" step="0.01" required inputmode="decimal"></label><label>Date and time<input name="occurred" type="datetime-local" required></label><label data-category>Category<select name="category"><option value="">No category</option><option value="commitment">Commitment</option><option value="entertainment">Entertainment</option><option value="savings">Savings</option></select></label><label class="activity-wide">Note<textarea name="note" maxlength="500" rows="2"></textarea></label><div class="activity-wide" data-save-message aria-live="polite"></div><button class="primary" type="submit">Save entry</button></form></section><section class="activity-panel" data-history aria-live="polite"></section>`;
    root.replaceChildren(view);
    const controls = node('div', undefined, 'activity-actions');
    const connectionLabel = node('p', connection); connectionLabel.dataset.connection = ''; connectionLabel.setAttribute('role', 'status');
    const refreshButton = node('button', 'Refresh activity'); refreshButton.type = 'button';
    refreshButton.onclick = () => { if (alive(owner)) void refresh(); };
    controls.append(refreshButton, connectionLabel); view.querySelector('header').append(controls);
    const metadataMessage = node('div'); metadataMessage.dataset.metadataMessage = ''; metadataMessage.setAttribute('aria-live', 'polite');
    metadataMessage.textContent = 'Loading account metadata…';
    controls.after(metadataMessage);
    view.querySelector('[data-month]').textContent = `Actual activity · ${month}`;
    summaryBox = view.querySelector('[data-summary]'); historyBox = view.querySelector('[data-history]'); form = view.querySelector('form');
    const fields = form.elements;
    const now = new Date();
    fields.occurred.value = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const updateType = () => {
      if (!alive(owner)) return;
      const type = fields.type.value;
      accountSelect(fields.from, type !== 'transfer'); accountSelect(fields.to, type !== 'transfer');
      form.querySelector('[data-from]').hidden = type === 'income';
      form.querySelector('[data-to]').hidden = type === 'expense';
      fields.from.required = type === 'transfer'; fields.to.required = type === 'transfer';
      form.querySelector('[data-external]').hidden = type === 'transfer';
      form.querySelector('[data-category]').hidden = type !== 'expense';
    };
    fields.type.onchange = updateType; updateType();
    bindEntry(owner, updateType);
    mountPair(owner);
    mountExport(owner);
    const history = loadHistory();
    try { const result = await api.metadata(); if (alive(owner)) { metadata = result; metadataMessage.replaceChildren(); } }
    catch (exception) { if (alive(owner)) error(metadataMessage, 'Account metadata unavailable', exception); }
    await history;
  }
  function hide() {
    if (destroyed || !visible) return;
    clearToken(); visible = false; saving = false; ++generation; ++historyRequest;
  }
  const unsubscribe = api.subscribe(() => { if (visible && !destroyed) void refresh(); }, status => {
    if (destroyed) return;
    connection = status === 'SUBSCRIBED' ? 'Connected to transaction updates' : ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status) ? 'Updates disconnected — use Refresh activity to check for new entries.' : 'Connecting to transaction updates…';
    if (visible && view && root.contains(view)) view.querySelector('[data-connection]').textContent = connection;
  });
  function destroy() {
    if (destroyed) return;
    hide(); destroyed = true; pending = null; metadata = { accounts: [], categories: [] };
    window.removeEventListener('beforeunload', beforeUnload); unsubscribe?.();
  }
  return { open, hide, refresh, destroy };
}
