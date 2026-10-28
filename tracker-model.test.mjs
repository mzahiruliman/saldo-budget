import test from "node:test";
import assert from "node:assert/strict";
test("parseAmount converts valid decimal text to exact cents and rejects invalid amounts", async () => {
  const { parseAmount } = await import("./tracker-model.mjs");
  assert.equal(parseAmount("12.34"), 1234);
  assert.equal(parseAmount("0.01"), 1);
  assert.equal(parseAmount("100000000"), 10000000000);
  for (const s of [
    "0",
    "-1",
    "1.001",
    "1e3",
    "NaN",
    "Infinity",
    "",
    "1,234.56",
    "100000000.01",
  ])
    assert.throws(() => parseAmount(s));
});
test("month helpers preserve accounting entry dates and handle year rollover", async () => {
  const { monthBounds, entryMonth } = await import("./tracker-model.mjs");
  assert.deepEqual(monthBounds("2026-12"), {
    start: "2026-12-01",
    end: "2027-01-01",
  });
  assert.equal(
    entryMonth({
      entry_date: "2026-11-01",
      occurred_at: "2026-10-31T16:30:00Z",
    }),
    "2026-11",
  );
  assert.throws(() => monthBounds("2026-13"));
  assert.throws(() => entryMonth({ entry_date: "2026-02-30" }));
});
