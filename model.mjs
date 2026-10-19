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
export function nextMonth(state, key) {
  if (!monthKey(key)) throw new TypeError("Invalid month: expected YYYY-MM");
  const result = structuredClone(state);
  if (!Object.hasOwn(result.months, key)) {
    result.months[key] = structuredClone(state.months[state.selected]);
    result.months[key].openingBalances = {};
    for (const item of result.months[key].items) item.paid = false;
  }
  result.selected = key;
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
export function validateMonth(month) {
  const errors = [],
    warnings = [];
  const result = () => ({ valid: errors.length === 0, errors, warnings });
  if (!record(month)) {
    errors.push("Month must be an object");
    return result();
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
        for (const id of [month.salaryAccount, month.motherAccount])
          if (!ids.has(id)) errors.push(`${key}: Unknown account ${id}`);
        if (Array.isArray(month.items))
          for (const item of month.items)
            if (record(item))
              for (const id of [item.from, item.to])
                if (!ids.has(id)) errors.push(`${key}: Unknown account ${id}`);
        if (record(month.openingBalances))
          for (const id of Object.keys(month.openingBalances))
            if (!ids.has(id))
              errors.push(`${key}: Unknown balance account ${id}`);
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
        transfers: [],
      },
    },
  };
}
