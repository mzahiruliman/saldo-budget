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
