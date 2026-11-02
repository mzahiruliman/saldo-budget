import test from "node:test";
import assert from "node:assert/strict";
import { initialState, validateState, nextMonth, summarize } from "./model.mjs";
test("public initial state is blank, valid, and preserves budgeting invariants", () => {
  let s = initialState(),
    m = s.months[s.selected];
  assert.equal(m.salary, 0);
  assert.deepEqual(m.items, []);
  assert.equal(m.motherPercent, 10);
  assert.ok(validateState(s).valid);
  m.salary = 123456;
  assert.equal(summarize(m).mother, 12346);
  let n = nextMonth(s, "2027-04");
  n.months[n.selected].salary = 99000;
  assert.equal(m.salary, 123456);
});
test("actual opening balances are signed, dated on the first of the month, and start empty", () => {
  const s = initialState(),
    m = s.months[s.selected];
  assert.deepEqual(m.actualOpeningBalances, {});
  m.actualOpeningBalances = { bank: { amount: -25000, asOf: `${s.selected}-01` } };
  assert.equal(validateState(s).valid, true);
  m.actualOpeningBalances.bank.amount = 12.5;
  assert.equal(validateState(s).valid, false);
  m.actualOpeningBalances.bank.amount = 25000;
  m.actualOpeningBalances.bank.asOf = `${s.selected}-02`;
  const wrongDate = validateState(s);
  assert.equal(wrongDate.valid, true);
  assert.ok(
    wrongDate.warnings.some((warning) =>
      warning.includes("first of the month"),
    ),
  );
  m.actualOpeningBalances.bank.asOf = `${s.selected}-01`;
  m.actualOpeningBalances.missing = { amount: 1, asOf: `${s.selected}-01` };
  assert.equal(validateState(s).valid, false);
  delete m.actualOpeningBalances.missing;
  m.actualOpeningBalances.bank.asOf = "2026-02-30";
  assert.equal(validateState(s).valid, false);
});
test("new months clear actual opening balances while keeping the previous month intact", () => {
  const s = initialState(),
    m = s.months[s.selected];
  m.actualOpeningBalances = { bank: { amount: 80000, asOf: `${s.selected}-01` } };
  const n = nextMonth(s, "2028-05");
  assert.deepEqual(n.months[n.selected].actualOpeningBalances, {});
  assert.equal(m.actualOpeningBalances.bank.amount, 80000);
});
