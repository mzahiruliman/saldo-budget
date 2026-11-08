// All monetary values are integer cents. Account balances are informational,
// never fabricated from a spending plan or automatically debited by paid flags.
const CATEGORIES = ["commitment", "entertainment", "savings"];
export function categoryTotals(month) {
  const totals = Object.fromEntries(
    CATEGORIES.map((category) => [category, 0]),
  );
  for (const item of month.items) totals[item.category] += item.amount;
  return totals;
}
export function summarize(month) {
  const salary = month.salary;
  const mother = Math.round((salary * month.motherPercent) / 100);
  const net = salary - mother;
  const totals = categoryTotals(month);
  const allocated = Object.values(totals).reduce((a, b) => a + b, 0);
  const flagged = (flag) =>
    month.items.reduce((sum, item) => sum + (item[flag] ? item.amount : 0), 0);
  return {
    salary,
    mother,
    net,
    allocated,
    unallocated: net - allocated,
    paid: flagged("paid"),
    credit: flagged("credit"),
    subscriptions: flagged("subscription"),
    shares: Object.fromEntries(
      CATEGORIES.map((cat) => [cat, net ? (totals[cat] / net) * 100 : 0]),
    ),
    targetTotal: CATEGORIES.reduce((sum, cat) => sum + month.targets[cat], 0),
  };
}
// Direct obligations only: no extra salary-to-wallet funding legs.
export function routes(month) {
  const groups = new Map();
  const add = (from, to, amount, name) => {
    if (from === to || amount === 0) return;
    const key = JSON.stringify([from, to]);
    if (!groups.has(key)) groups.set(key, { from, to, amount: 0, items: [] });
    const route = groups.get(key);
    route.amount += amount;
    route.items.push(name);
  };
  add(
    month.salaryAccount,
    month.motherAccount,
    summarize(month).mother,
    "Mother allowance",
  );
  for (const item of month.items)
    add(item.from, item.to, item.amount, item.name);
  return [...groups.values()];
}
const monthKey = (key) =>
  typeof key === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(key);
const recurring = (items) => items.filter(item => item.recurrence !== 'one-off');
const forwardItems = (month) => month.planning?.forwardItems ?? recurring(month.items);
const unpaid = (items) => items.map(item => ({...structuredClone(item), paid: false}));
export function nextMonth(state, key) {
  if (!monthKey(key)) throw new TypeError("Invalid month: expected YYYY-MM");
  const result = structuredClone(state);
  if (!Object.hasOwn(result.months, key)) {
    result.months[key] = structuredClone(state.months[state.selected]);
    const predecessor = Object.keys(state.months).filter((month) => month < key).sort().at(-1);
    result.months[key].items = unpaid(predecessor ? forwardItems(state.months[predecessor]) : []);
    result.months[key].planning = {source: predecessor ?? null, ownChanges: false, boundary: false, revision: 0};
    result.months[key].reviewChecklist = {};
    result.months[key].openingBalances = {};
    result.months[key].actualOpeningBalances = {};
    for (const item of result.months[key].items) item.paid = false;
  }
  result.selected = key;
  return result;
}
// Compare definitions in schema order, independent of object property order.
// Paid is monthly activity, never an inheritance boundary. Item order is part of the plan.
const breakdown = (items) => JSON.stringify(items.map((item) =>
  [item.id, item.name, item.amount, item.category, item.from, item.to,
    item.credit, item.subscription, item.review, item.note, item.recurrence ?? 'recurring']));

// Pure item-only edit. Explicit saved boundaries beat snapshot equality, even
// for identical edits. forwardItems preserves the recurring baseline when a
// user chooses month-only, including for months not created yet.
export function updateMonthItems(state, key, items, {scope = "onward"} = {}) {
  if (!["month", "onward"].includes(scope)) throw new TypeError("Invalid edit scope");
  if (!validateState(state).valid) throw new TypeError("Invalid budget state");
  if (!monthKey(key) || !Object.hasOwn(state.months, key))
    throw new TypeError("Edited month must exist");
  const result = structuredClone(state);
  const baseline = forwardItems(state.months[key]);
  const previous = breakdown(baseline);
  result.months[key].items = structuredClone(items);
  if (!validateState(result).valid) throw new TypeError("Invalid breakdown");
  // The UI supplies the visible snapshot, which may contain prior month-only
  // changes. Apply only this operation's definition delta to the forward plan.
  const before = new Map(state.months[key].items.map(item => [item.id, item]));
  const after = new Map(items.map(item => [item.id, item]));
  const changed = new Set([...before.keys(), ...after.keys()].filter(id =>
    !before.has(id) || !after.has(id) || breakdown([before.get(id)]) !== breakdown([after.get(id)])));
  const baselineIds = new Set(baseline.map(item => item.id));
  // Retain baseline order for edits; append genuinely new recurring entries.
  const forward = scope === 'month' ? baseline : [
    ...baseline.flatMap(item => !changed.has(item.id) ? [item]
      : after.has(item.id) && after.get(item.id).recurrence !== 'one-off' ? [after.get(item.id)] : []),
    ...recurring(items).filter(item => changed.has(item.id) && !baselineIds.has(item.id)),
  ];
  result.months[key].planning = {...state.months[key].planning, source: state.months[key].planning?.source ?? null,
    ownChanges: true, boundary: true, revision: (state.months[key].planning?.revision ?? 0) + 1,
    forwardItems: unpaid(forward)};
  if (!validateState(result).valid) throw new TypeError("Invalid breakdown");
  if (scope === "onward" && previous !== breakdown(forward)) {
    for (const future of Object.keys(state.months).filter((month) => month > key).sort()) {
      if (state.months[future].planning?.boundary || breakdown(recurring(state.months[future].items)) !== previous) break;
      const paid = new Map(state.months[future].items.map((item) => [item.id, item.paid]));
      const localOneOffs = state.months[future].items.filter(item => item.recurrence === 'one-off' && !changed.has(item.id));
      result.months[future].items = [...forward.map((item) => ({...structuredClone(item), paid: paid.get(item.id) ?? false})), ...structuredClone(localOneOffs)];
      result.months[future].planning = {...state.months[future].planning, source: key, ownChanges: localOneOffs.length > 0, boundary: false,
        forwardItems: unpaid(forward), revision: (state.months[future].planning?.revision ?? 0) + 1};
    }
  }
  if (!validateState(result).valid) throw new TypeError('Invalid propagated breakdown');
  return result;
}
// Explicit maintenance operation only. Never invoked by mounting or month creation.
// Replaces recurring definitions in ALL later saved snapshots (including
// overrides), resetting paid flags. Public helper stays pure and idempotent.
export function resetLaterBreakdowns(state, sourceKey) {
  if (!validateState(state).valid) throw new TypeError("Invalid budget state");
  if (!monthKey(sourceKey) || !Object.hasOwn(state.months, sourceKey))
    throw new TypeError("Source month must exist");
  const result = structuredClone(state);
  for (const key of Object.keys(result.months).filter((key) => key > sourceKey)) {
    const items = unpaid(recurring(state.months[sourceKey].items));
    const p = state.months[key].planning;
    if (JSON.stringify(state.months[key].items) === JSON.stringify(items) && p?.source === sourceKey &&
        p.ownChanges === false && p.boundary === false && JSON.stringify(p.forwardItems) === JSON.stringify(items)) continue;
    result.months[key].items = items;
    result.months[key].planning = {source: sourceKey, ownChanges: false, boundary: false,
      forwardItems: structuredClone(items), revision: (p?.revision ?? 0) + 1};
  }
  if (!validateState(result).valid) throw new TypeError('Invalid reset result');
  return result;
}
export function previewLaterBreakdowns(state, sourceKey) {
  if (!validateState(state).valid || !monthKey(sourceKey) || !Object.hasOwn(state.months, sourceKey))
    throw new TypeError('Source month must exist in a valid budget');
  const items = recurring(state.months[sourceKey].items);
  const total = entries => entries.reduce((sum, item) => sum + item.amount, 0);
  return {source: sourceKey, items: structuredClone(items), targets: Object.keys(state.months)
    .filter(key => key > sourceKey).sort().map(key => ({key, beforeCount: state.months[key].items.length,
      afterCount: items.length, beforeTotal: total(state.months[key].items), afterTotal: total(items),
      ownChanges: state.months[key].planning?.ownChanges ?? null}))};
}
const breakdownSnapshot = month => ({items: structuredClone(month.items), planning: structuredClone(month.planning)});
export function replaceLaterBreakdowns(state, sourceKey) {
  const preview = previewLaterBreakdowns(state, sourceKey);
  if (!preview.targets.length) throw new TypeError('No later saved target months');
  const result = structuredClone(state), entries = [];
  for (const {key} of preview.targets) {
    const before = breakdownSnapshot(state.months[key]);
    result.months[key].items = unpaid(preview.items);
    result.months[key].planning = {source: sourceKey, ownChanges: false, boundary: false,
      forwardItems: unpaid(preview.items), revision: (state.months[key].planning?.revision ?? 0) + 1};
    entries.push({key, before, after: breakdownSnapshot(result.months[key])});
  }
  const undo = {entries};
  if (new TextEncoder().encode(JSON.stringify(undo)).length > 1800000)
    throw new TypeError('Replacement undo snapshot exceeds the 1.8 MB size limit');
  if (!validateState(result).valid) throw new TypeError('Invalid replacement result');
  return {state: result, undo};
}
export function undoBreakdownReplacement(state, undo) {
  if (!validateState(state).valid || !record(undo) || !Array.isArray(undo.entries) || !undo.entries.length ||
      new TextEncoder().encode(JSON.stringify(undo)).length > 1800000)
    throw new TypeError('Invalid undo snapshot');
  const keys = new Set();
  for (const entry of undo.entries) {
    if (!record(entry) || !monthKey(entry.key) || keys.has(entry.key) || !Object.hasOwn(state.months, entry.key) ||
        !record(entry.before) || !record(entry.after) ||
        [entry.before, entry.after].some(snapshot => !Array.isArray(snapshot.items) || Object.keys(snapshot).some(key => !['items','planning'].includes(key))))
      throw new TypeError('Invalid undo snapshot');
    keys.add(entry.key);
    if (JSON.stringify(breakdownSnapshot(state.months[entry.key])) !== JSON.stringify(entry.after))
      throw new TypeError('Breakdown changed since replacement; undo rejected to protect newer work');
  }
  const result = structuredClone(state);
  for (const {key, before} of undo.entries) {
    result.months[key].items = structuredClone(before.items);
    if (before.planning === undefined) delete result.months[key].planning;
    else result.months[key].planning = structuredClone(before.planning);
  }
  if (!validateState(result).valid) throw new TypeError('Invalid undo result');
  return result;
}
const REVIEW_FIELDS = ['income', 'recurring', 'balances', 'unpaid'];
export function updateMonthReview(state, key, field, checked) {
  if (!validateState(state).valid || !Object.hasOwn(state.months, key) ||
      !REVIEW_FIELDS.includes(field) || typeof checked !== 'boolean')
    throw new TypeError('Invalid month review');
  const result = structuredClone(state);
  result.months[key].reviewChecklist = {...result.months[key].reviewChecklist, [field]: checked};
  return result;
}
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const cents = (value) => Number.isSafeInteger(value) && value >= 0;
const percent = (value) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 100;
const text = (value) => typeof value === "string" && value.trim().length > 0;
const dayKey = (value) => {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
};
export function validateMonth(month) {
  const errors = [],
    warnings = [];
  const result = () => ({ valid: errors.length === 0, errors, warnings });
  if (!record(month)) {
    errors.push("Month must be an object");
    return result();
  }
  if (month.reviewChecklist !== undefined && (!record(month.reviewChecklist) ||
      Object.entries(month.reviewChecklist).some(([key, value]) => !REVIEW_FIELDS.includes(key) || typeof value !== 'boolean')))
    errors.push('Invalid month review checklist');
  if (month.planning !== undefined) {
    const p = month.planning;
    if (!record(p) || !(p.source === null || monthKey(p.source)) ||
        typeof p.ownChanges !== 'boolean' || typeof p.boundary !== 'boolean' ||
        !Number.isSafeInteger(p.revision) || p.revision < 0)
      errors.push('Invalid planning metadata');
    if (record(p) && p.forwardItems !== undefined) {
      if (!Array.isArray(p.forwardItems) || p.forwardItems.length > 1000)
        errors.push('Invalid forward plan size');
      else {
        const validation = validateMonth({...month, planning: undefined, items: p.forwardItems});
        errors.push(...validation.errors.map(error => `Forward plan: ${error}`));
        if (p.forwardItems.some(item => record(item) && (item.recurrence === 'one-off' || item.paid !== false)))
          errors.push('Forward plan must be recurring and unpaid');
      }
    }
  }
  if (!cents(month.salary))
    errors.push("Salary must be nonnegative integer cents");
  if (!percent(month.motherPercent))
    errors.push("Mother percentage must be between 0 and 100");
  for (const key of ["salaryAccount", "motherAccount"])
    if (!text(month[key])) errors.push(`${key} is required`);
  if (!record(month.targets)) errors.push("Targets must be an object");
  else {
    for (const cat of CATEGORIES)
      if (!percent(month.targets[cat]))
        errors.push(`${cat} target must be between 0 and 100`);
    if (
      CATEGORIES.every((cat) => percent(month.targets[cat])) &&
      Math.abs(
        CATEGORIES.reduce((sum, cat) => sum + month.targets[cat], 0) - 100,
      ) > 1e-9
    )
      warnings.push("Category targets do not total 100%");
  }
  if (!Array.isArray(month.items)) errors.push("Items must be an array");
  else {
    const ids = new Set();
    month.items.forEach((item, index) => {
      const prefix = `Item ${index + 1}`;
      if (!record(item)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      if (item.recurrence !== undefined && !['recurring', 'one-off'].includes(item.recurrence))
        errors.push(`${prefix} recurrence is invalid`);
      if (!cents(item.amount))
        errors.push(`${prefix} amount must be nonnegative integer cents`);
      if (!CATEGORIES.includes(item.category))
        errors.push(`${prefix} category is invalid`);
      for (const key of ["id", "name", "from", "to"])
        if (!text(item[key])) errors.push(`${prefix} ${key} is required`);
      if (ids.has(item.id)) errors.push(`${prefix} duplicate id`);
      ids.add(item.id);
      for (const key of ["credit", "subscription", "paid", "review"])
        if (typeof item[key] !== "boolean")
          errors.push(`${prefix} ${key} must be boolean`);
      if (typeof item.note !== "string")
        errors.push(`${prefix} note must be a string`);
    });
  }
  if (month.openingBalances !== undefined) {
    if (!record(month.openingBalances))
      errors.push("Opening balances must be an object");
    else
      for (const balance of Object.values(month.openingBalances))
        if (balance !== null && !Number.isSafeInteger(balance))
          errors.push("Opening balance must be null or signed integer cents");
  }
  if (month.actualOpeningBalances !== undefined) {
    if (!record(month.actualOpeningBalances))
      errors.push("Actual opening balances must be an object");
    else
      for (const [id, entry] of Object.entries(month.actualOpeningBalances)) {
        if (!text(id)) errors.push("Actual balance account id is required");
        if (!record(entry))
          errors.push("Actual opening balance must contain amount and asOf");
        else {
          if (!Number.isSafeInteger(entry.amount))
            errors.push("Actual opening balance must be signed integer cents");
          if (!dayKey(entry.asOf))
            errors.push("Actual opening balance date must be YYYY-MM-DD");
        }
      }
  }
  if (month.transfers !== undefined) {
    if (!Array.isArray(month.transfers))
      errors.push("Transfers must be an array");
    else {
      const transferIds = new Set();
      for (const transfer of month.transfers) {
        if (!record(transfer)) {
          errors.push("Invalid transfer");
          continue;
        }
        if (!text(transfer.id) || transferIds.has(transfer.id))
          errors.push("Transfer id must be unique");
        transferIds.add(transfer.id);
        if (!cents(transfer.amount) || transfer.amount === 0)
          errors.push("Transfer amount must be positive integer cents");
        if (
          !text(transfer.from) ||
          !text(transfer.to) ||
          transfer.from === transfer.to
        )
          errors.push("Transfer requires two different accounts");
      }
    }
  }
  return result();
}
export function money(value) {
  if (!Number.isSafeInteger(value))
    throw new TypeError("Money requires integer cents");
  const absolute = Math.abs(value);
  return `${value < 0 ? "-" : ""}RM ${Math.floor(absolute / 100).toLocaleString("en-US")}.${String(absolute % 100).padStart(2, "0")}`;
}
// Same validation result shape as validateMonth; unknown account IDs are
// checked here because standalone month validation has no account registry.
export function validateState(state) {
  const errors = [],
    warnings = [];
  const result = () => ({ valid: errors.length === 0, errors, warnings });
  if (!record(state)) {
    errors.push("State must be an object");
    return result();
  }
  if (state.version !== 1) errors.push("Unsupported state version");
  const ids = new Set();
  if (!Array.isArray(state.accounts)) errors.push("Accounts must be an array");
  else
    for (const account of state.accounts) {
      if (!record(account)) {
        errors.push("Invalid account");
        continue;
      }
      if (!text(account.id) || ids.has(account.id))
        errors.push("Account ids must be nonempty and unique");
      ids.add(account.id);
      if (!text(account.name) || !text(account.type))
        errors.push("Account name and type are required");
      if (account.balance !== null && !Number.isSafeInteger(account.balance))
        errors.push("Balance must be null or signed integer cents");
    }
  if (!record(state.months)) errors.push("Months must be an object");
  else {
    if (
      !monthKey(state.selected) ||
      !Object.hasOwn(state.months, state.selected)
    )
      errors.push("Selected month does not exist");
    for (const [key, month] of Object.entries(state.months)) {
      if (!monthKey(key)) errors.push(`Invalid month key: ${key}`);
      const validation = validateMonth(month);
      errors.push(...validation.errors.map((error) => `${key}: ${error}`));
      warnings.push(
        ...validation.warnings.map((warning) => `${key}: ${warning}`),
      );
      if (record(month)) {
        if (record(month.planning) && month.planning.source !== null &&
            (!Object.hasOwn(state.months, month.planning.source) || month.planning.source >= key))
          errors.push(`${key}: Carry source must be an earlier saved month`);
        for (const id of [month.salaryAccount, month.motherAccount])
          if (!ids.has(id)) errors.push(`${key}: Unknown account ${id}`);
        if (Array.isArray(month.items))
          for (const item of [...month.items, ...(Array.isArray(month.planning?.forwardItems) ? month.planning.forwardItems : [])])
            if (record(item))
              for (const id of [item.from, item.to])
                if (!ids.has(id)) errors.push(`${key}: Unknown account ${id}`);
        if (record(month.openingBalances))
          for (const id of Object.keys(month.openingBalances))
            if (!ids.has(id))
              errors.push(`${key}: Unknown balance account ${id}`);
        if (record(month.actualOpeningBalances))
          for (const [id, entry] of Object.entries(month.actualOpeningBalances)) {
            if (!ids.has(id))
              errors.push(`${key}: Unknown actual balance account ${id}`);
            if (record(entry) && dayKey(entry.asOf) && entry.asOf !== `${key}-01`)
              warnings.push(
                `${key}: Actual opening balance must be dated the first of the month`,
              );
          }
        if (Array.isArray(month.transfers))
          for (const transfer of month.transfers)
            if (record(transfer))
              for (const id of [transfer.from, transfer.to])
                if (!ids.has(id))
                  errors.push(`${key}: Unknown transfer account ${id}`);
      }
    }
  }
  return result();
}
export function initialState() {
  const now = new Date();
  const selected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return {
    version: 1,
    selected,
    accounts: [
      { id: "bank", name: "Main bank", type: "bank", balance: null },
      { id: "mum", name: "Mother", type: "recipient", balance: null },
      {
        id: "external",
        name: "Merchant / external",
        type: "external",
        balance: null,
      },
    ],
    months: {
      [selected]: {
        salary: 0,
        motherPercent: 10,
        salaryAccount: "bank",
        motherAccount: "mum",
        targets: { commitment: 0, entertainment: 0, savings: 0 },
        items: [],
        openingBalances: {},
        actualOpeningBalances: {},
        transfers: [],
      },
    },
  };
}
