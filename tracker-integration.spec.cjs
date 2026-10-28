const { test, expect } = require("@playwright/test");
const { randomUUID } = require("node:crypto");
const HOST = "https://cxezfmlzvyodmjxtjtzb.supabase.co",
  UID = "11111111-1111-4111-8111-111111111111";
test("compiled app records actual activity via the real SDK without changing the plan (synthetic HTTP)", async ({
  page,
  context,
}) => {
  const { initialState } = await import("./model.mjs");
  const budget = initialState();
  let entries = [],
    planWrites = 0;
  await context.routeWebSocket("**", (ws) => ws.close());
  await context.addInitScript(
    ({ UID }) => {
      localStorage.setItem(
        "saldo-cloud-connection-v1",
        "sb_publishable_SYNTHETIC_BROWSER_TEST_ONLY",
      );
      localStorage.setItem(
        "sb-cxezfmlzvyodmjxtjtzb-auth-token",
        JSON.stringify({
          access_token:
            btoa("{}") +
            "." +
            btoa(
              JSON.stringify({
                sub: UID,
                role: "authenticated",
                exp: 2100000000,
              }),
            ) +
            ".synthetic",
          refresh_token: "synthetic",
          token_type: "bearer",
          expires_at: 2100000000,
          user: { id: UID, aud: "authenticated", role: "authenticated" },
        }),
      );
    },
    { UID },
  );
  await context.route(HOST + "/**", async (route) => {
    const url = new URL(route.request().url()),
      body = route.request().postDataJSON();
    let data;
    if (url.pathname === "/rest/v1/budget_documents")
      data = [{ user_id: UID, payload: budget, revision: 1 }];
    else if (url.pathname === "/rest/v1/rpc/save_budget") {
      planWrites++;
      data = [{ user_id: UID, payload: body.p_payload, revision: 2 }];
    } else if (url.pathname === "/rest/v1/rpc/tracker_metadata")
      data = {
        accounts: budget.accounts.filter(
          (a) => !["recipient", "external"].includes(a.type),
        ),
        categories: ["commitment", "entertainment", "savings"],
      };
    else if (url.pathname === "/rest/v1/rpc/tracker_summary")
      data = {
        income_cents: 0,
        expense_cents: entries.reduce((s, e) => s + e.amount_cents, 0),
        transfer_cents: 0,
        unassigned_income_cents: 0,
        unassigned_expense_cents: entries.reduce(
          (s, e) => s + e.amount_cents,
          0,
        ),
        movements: {},
      };
    else if (url.pathname === "/rest/v1/rpc/list_shortcut_devices") data = [];
    else if (url.pathname === "/rest/v1/transactions") data = entries;
    else if (url.pathname === "/rest/v1/rpc/record_transaction") {
      const entry = {
        ...body.p_entry,
        id: randomUUID(),
        user_id: UID,
        entry_date: budget.selected + "-10",
        source: "app",
        created_at: new Date().toISOString(),
        voided_at: null,
      };
      entries.push(entry);
      data = { transaction: entry, duplicate: false };
    } else
      return route.fulfill({
        status: 400,
        json: { message: "Unexpected synthetic request: " + url.pathname },
      });
    await route.fulfill({
      status: 200,
      json: data,
      headers: { "access-control-allow-origin": "*" },
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/saldo-budget/");
  await expect(page.locator("#save-status")).toContainText("Ready");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Money tracker", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Amount (RM)", { exact: true }).fill("12.34");
  await page
    .getByLabel("External party", { exact: true })
    .fill("Synthetic cafe");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  await expect.poll(() => entries.length).toBe(1);
  await expect(page.locator("[data-history]")).toContainText("Synthetic cafe");
  expect(entries[0].amount_cents).toBe(1234);
  expect(planWrites).toBe(0);
  await page.locator('[data-view="budget"]').click();
  await expect(
    page.getByRole("heading", { name: "Your month, accounted for." }),
  ).toBeVisible();
  expect(planWrites).toBe(0);
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.locator("[data-history]")).toContainText("Synthetic cafe");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:"test-results/tracker-phone.png",fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.screenshot({path:"test-results/tracker-desktop.png",fullPage:true});
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
