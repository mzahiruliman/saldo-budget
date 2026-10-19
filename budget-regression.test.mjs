import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  summarize,
  categoryTotals,
  routes,
  nextMonth,
  validateState,
} from "./model.mjs";
test("category shares use post-Ibu income and unassigned income is separate", () => {
  const s = initialState(),
    m = s.months[s.selected];
  m.salary = 100000;
  m.targets = { commitment: 20, entertainment: 10, savings: 10 };
  m.items = [
    { category: "commitment", amount: 18000 },
    { category: "savings", amount: 9000 },
  ];
  const a = summarize(m);
  assert.equal(a.net, 90000);
  assert.equal(a.shares.commitment, 20);
  assert.equal(a.unallocated, 63000);
  assert.equal(a.targetTotal, 40);
});
test("transfers do not alter expenses and routes do not double-count card flags", () => {
  const s = initialState(),
    m = s.months[s.selected];
  m.items = [
    {
      name: "Synthetic purchase",
      category: "commitment",
      amount: 2345,
      from: "bank",
      to: "external",
      credit: true,
    },
  ];
  m.transfers = [{ id: "fund", from: "bank", to: "external", amount: 500 }];
  assert.equal(categoryTotals(m).commitment, 2345);
  assert.equal(
    routes(m).find((r) => r.items.includes("Synthetic purchase")).amount,
    2345,
  );
});
test("month transitions preserve old amounts reset paid and clear opening balances", () => {
  const s = initialState(),
    m = s.months[s.selected];
  m.openingBalances = { bank: 150 };
  m.items = [{ paid: true, amount: 125 }];
  const n = nextMonth(s, "2028-03");
  assert.deepEqual(n.months[n.selected].openingBalances, {});
  assert.equal(n.months[n.selected].items[0].paid, false);
  assert.equal(m.items[0].paid, true);
});
test("validation rejects invalid imports and unknown account routes", () => {
  const s = initialState(),
    m = s.months[s.selected];
  assert.equal(validateState(s).valid, true);
  m.salary = -1;
  assert.equal(validateState(s).valid, false);
  m.salary = 0;
  m.salaryAccount = "missing";
  assert.equal(validateState(s).valid, false);
});
