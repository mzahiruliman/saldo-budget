const { test, expect } = require("@playwright/test");
const esbuild = require("esbuild");
const fs = require("node:fs");

test.use({ timezoneId: "UTC" });

async function fixture(page, options = {}) {
  const built = await esbuild.build({
    entryPoints: ["budget-ui.mjs"],
    bundle: true,
    write: false,
    format: "esm",
  });
  await page.route("**/budget-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fs.readFileSync("style.css", "utf8")}</style><div id="workspace"><div class="app"><aside><nav><button data-view="budget" class="active">Monthly budget</button><button data-view="activity">Activity</button><button data-view="accounts">Accounts & routes</button><button data-view="settings">Plan settings</button></nav></aside><main><header><b id="page-name">Monthly budget</b><input type="month" id="month"><button id="month-prev">‹</button><button id="month-next">›</button></header><div id="content"></div></main></div><button id="export">Export</button><input id="import" type="file" hidden><dialog id="modal"><div id="modal-content"></div></dialog><div id="toast"></div></div><script type="module" src="/budget-fixture.mjs"></script>`,
    }),
  );
  await page.route("**/budget-fixture.mjs", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: built.outputFiles[0].text + "\nwindow.mountBudget=mountBudget;",
    }),
  );
  await page.goto("/budget-fixture");
  await page.waitForFunction(() => window.mountBudget);
  await page.evaluate((options) => {
    window.actualCalls = [];
    window.actualError = options.error;
    window.summary = {
      income_cents: 0,
      expense_cents: 0,
      transfer_cents: 0,
      unassigned_income_cents: 100,
      unassigned_expense_cents: 400,
      movements: { bank: 150000, card: -50000, deleted: 999 },
    };
    const accounts = [
      { id: "bank", name: "Main bank", type: "bank", balance: null },
      { id: "card", name: "Visa", type: "card", balance: null },
      { id: "mum", name: "Mother", type: "recipient", balance: null },
      { id: "external", name: "Merchant", type: "external", balance: null },
    ];
    const selected = "2026-11";
    const month = {
      salary: 500000,
      motherPercent: 10,
      salaryAccount: "bank",
      motherAccount: "mum",
      targets: { commitment: 50, entertainment: 0, savings: 0 },
      items: [
        {
          id: "rent",
          name: "Rent",
          amount: 100000,
          category: "commitment",
          from: "bank",
          to: "external",
          credit: false,
          subscription: false,
          paid: false,
          review: false,
          note: "",
        },
      ],
      openingBalances: { bank: 100000, card: 0 },
      actualOpeningBalances: {
        bank: {
          amount: 200000,
          asOf: options.wrongActualDate ? "2026-10-01" : `${selected}-01`,
        },
      },
      transfers: [],
    };
    window.saved = null;
    window.controller = window.mountBudget({
      initial: { version: 1, selected, accounts, months: { [selected]: month } },
      onChange: (next) => {
        window.saved = structuredClone(next);
      },
      loadActuals: async (key) => {
        window.actualCalls.push(key);
        if (window.actualError) throw new Error("Synthetic offline");
        return structuredClone(window.summary);
      },
    });
  }, options);
}

test("accounts show recorded movement and tracked balance without changing the plan projection", async ({ page }) => {
  await fixture(page);
  await page.locator('[data-view="accounts"]').click();
  const bank = page.locator('[data-account="bank"]');
  await expect(bank).toContainText("Recorded this month");
  await expect(bank.locator("[data-recorded]")).toHaveText("+RM 1,500.00");
  await expect(bank.locator("[data-tracked]")).toHaveText("RM 3,500.00");
  await expect(bank.locator("[data-projected]")).toHaveText("RM 4,500.00");
  await expect(bank).toContainText("Plan opening: RM 1,000.00");
  await expect(page.locator('[data-account="card"]')).toContainText("Not set");
  await expect(page.locator('[data-account="card"]')).toContainText("-RM 500.00");
  await expect(page.locator("[data-actuals-note]")).toContainText("no longer listed");
  await expect(page.locator("[data-actuals-note]")).toContainText(
    "net -RM 3.00",
  );
  expect(await page.evaluate(() => window.actualCalls)).toEqual(["2026-11"]);
});

test("setting an actual opening balance is signed, dated at month start, and does not rewrite plan fields", async ({ page }) => {
  await fixture(page);
  await page.locator('[data-view="accounts"]').click();
  const card = page.locator('[data-account="card"]');
  await card.getByRole("button", { name: "Set actual opening" }).click();
  await page.getByLabel("Actual opening balance (RM)").fill("500");
  await page.getByRole("button", { name: "Save actual balance" }).click();
  const saved = await page.evaluate(() => window.saved.months["2026-11"]);
  expect(saved.actualOpeningBalances.card).toEqual({
    amount: 50000,
    asOf: "2026-11-01",
  });
  expect(saved.openingBalances).toEqual({ bank: 100000, card: 0 });
  await expect(page.locator('[data-account="card"]')).toContainText("RM 0.00");
  await expect(page.locator('[data-account="card"]')).toContainText("1 Nov 2026");
  await page.locator('[data-view="budget"]').click();
  await expect(page.locator('[data-testid="net"]')).toHaveText("4,500.00");
});

test("recorded activity failure is honest and retryable", async ({ page }) => {
  await fixture(page, { error: true });
  await page.locator('[data-view="accounts"]').click();
  await expect(page.locator("[data-actuals-status]")).toContainText(
    "Recorded activity unavailable",
  );
  await expect(page.locator('[data-account="bank"]')).toContainText(
    "Plan projection",
  );
  await page.evaluate(() => {
    window.actualError = false;
  });
  await page.getByRole("button", { name: "Retry recorded activity" }).click();
  await expect(page.locator('[data-account="bank"]')).toContainText(
    "+RM 1,500.00",
  );
});

test("an actual balance copied with the wrong month date is not used silently", async ({ page }) => {
  await fixture(page, { wrongActualDate: true });
  await page.locator('[data-view="accounts"]').click();
  const bank = page.locator('[data-account="bank"]');
  await expect(bank.locator("[data-tracked]")).toHaveText("Not set");
  await expect(bank).toContainText("different date");
  await expect(
    bank.getByRole("button", { name: "Reset actual opening" }),
  ).toBeVisible();
});
