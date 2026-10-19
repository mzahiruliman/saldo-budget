const { test, expect } = require("@playwright/test");
const HOST = "https://cxezfmlzvyodmjxtjtzb.supabase.co";
const UID = "11111111-1111-4111-8111-111111111111";
const PUB = "sb_publishable_SYNTHETIC_BROWSER_TEST_ONLY";
const token =
  Buffer.from("{}").toString("base64url") +
  "." +
  Buffer.from(
    JSON.stringify({ sub: UID, role: "authenticated", exp: 2100000000 }),
  ).toString("base64url") +
  ".synthetic-test-signature";
async function session(context) {
  await context.addInitScript(
    ({ PUB, UID, token }) => {
      localStorage.setItem("saldo-cloud-connection-v1", PUB);
      localStorage.setItem(
        "sb-cxezfmlzvyodmjxtjtzb-auth-token",
        JSON.stringify({
          access_token: token,
          refresh_token: "synthetic-test-refresh",
          token_type: "bearer",
          expires_in: 3600,
          expires_at: 2100000000,
          user: {
            id: UID,
            aud: "authenticated",
            role: "authenticated",
            email: "synthetic@example.invalid",
            app_metadata: { provider: "github" },
            user_metadata: {},
          },
        }),
      );
    },
    { PUB, UID, token },
  );
}
test("cloud entry never reveals a budget while signed out and rejects privileged keys", async ({
  page,
}) => {
  await page.goto("/saldo-budget/");
  await expect(
    page.getByRole("heading", { name: "Connect your private budget." }),
  ).toBeVisible();
  await page
    .getByLabel("Supabase publishable key")
    .fill("sb_secret_do_not_accept_this_key");
  await page.getByRole("button", { name: "Save connection" }).click();
  await expect(page.getByRole("alert")).toContainText("publishable");
  await expect(
    page.getByRole("heading", { name: "Your month, accounted for." }),
  ).toHaveCount(0);
});
test("real browser UI and SDK sync across two clients and stop stale overwrites (simulated Supabase HTTP)", async ({
  browser,
}) => {
  let row = null,
    writes = 0;
  const c1 = await browser.newContext(),
    c2 = await browser.newContext();
  for (const ctx of [c1, c2]) {
    await session(ctx);
    await ctx.route(HOST + "/**", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.pathname === "/auth/v1/logout") {
        await route.fulfill({ status: 204 });
        return;
      }
      if (url.pathname.startsWith("/rest/v1/")) {
        expect(req.headers().authorization).toBe("Bearer " + token);
        if (url.pathname.endsWith("/rpc/save_budget")) {
          const b = req.postDataJSON();
          if (b.p_expected_revision !== (row?.revision || 0)) {
            await route.fulfill({
              status: 400,
              json: { message: "SALDO_CONFLICT", code: "P0001" },
            });
            return;
          }
          writes++;
          row = {
            user_id: UID,
            payload: b.p_payload,
            revision: (row?.revision || 0) + 1,
            updated_at: new Date().toISOString(),
          };
          await route.fulfill({ json: [row] });
          return;
        }
        await route.fulfill({ json: row ? [row] : [] });
        return;
      }
      await route.fulfill({
        status: 400,
        json: { message: "Unexpected test request " + url.pathname },
      });
    });
  }
  const p1 = await c1.newPage();
  const errors = [];
  p1.on("pageerror", (e) => errors.push(e.message));
  await p1.goto("/saldo-budget/");
  await expect(
    p1.getByRole("heading", { name: "Your month, accounted for." }),
  ).toBeVisible();
  expect(writes).toBe(0);
  await p1.getByRole("button", { name: "Edit income" }).click();
  await p1.getByLabel("Monthly salary (RM)").fill("1234.56");
  await p1.getByRole("button", { name: "Save income" }).click();
  await expect(p1.locator("#save-status")).toContainText("Saved to cloud");
  expect(row.revision).toBe(1);
  const p2 = await c2.newPage();
  await p2.setViewportSize({ width: 390, height: 844 });
  await p2.goto("/saldo-budget/");
  await expect(p2.locator('[data-testid="net"]')).toContainText("1,111.10");
  await p2.getByRole("button", { name: "Add item" }).click();
  await p2
    .getByLabel("Item name", { exact: true })
    .fill("Synthetic phone item");
  await p2.getByLabel("Amount (RM)", { exact: true }).fill("12.34");
  await p2.getByRole("button", { name: "Save item" }).click();
  await expect(p2.locator("#save-status")).toContainText("Saved to cloud");
  await p1.getByRole("button", { name: "Edit income" }).click();
  await p1.getByLabel("Monthly salary (RM)").fill("2000");
  await p1.getByRole("button", { name: "Save income" }).click();
  await expect(p1.locator("#cloud-message")).toContainText("Another device");
  expect(row.payload.months[row.payload.selected].salary).toBe(123456);
  await p1.getByRole("button", { name: "Load latest", exact: true }).click();
  await p1.getByRole("button", { name: "Discard draft and load" }).click();
  await expect(
    p1.getByText("Synthetic phone item", { exact: true }),
  ).toBeVisible();
  await p1.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    p1.getByRole("button", { name: "Continue with GitHub" }),
  ).toBeVisible();
  await expect(p1.locator('[data-testid="net"]')).toHaveCount(0);
  expect(errors).toEqual([]);
  await c1.close();
  await c2.close();
});
test("failed initial cloud load can be retried without discarding local edits (simulated HTTP)", async ({
  browser,
}) => {
  const c = await browser.newContext();
  await session(c);
  let down = true,
    row = null;
  await c.route(HOST + "/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith("/rest/v1/")) {
      if (down) {
        await route.fulfill({
          status: 400,
          json: { message: "Synthetic unavailable fixture" },
        });
        return;
      }
      if (u.pathname.endsWith("/rpc/save_budget")) {
        const p = route.request().postDataJSON();
        row = { user_id: UID, payload: p.p_payload, revision: 1 };
        await route.fulfill({ json: [row] });
        return;
      }
      await route.fulfill({ json: row ? [row] : [] });
      return;
    }
    await route.fulfill({
      status: 400,
      json: { message: "Unexpected request" },
    });
  });
  const p = await c.newPage();
  await p.goto("/saldo-budget/");
  await expect(p.locator("#cloud-message")).toContainText("Not saved");
  await p.getByRole("button", { name: "Edit income" }).click();
  await p.getByLabel("Monthly salary (RM)").fill("987.65");
  await p.getByRole("button", { name: "Save income" }).click();
  down = false;
  await p.getByRole("button", { name: "Retry cloud save" }).click();
  await expect(p.locator("#save-status")).toContainText("Saved to cloud");
  expect(row.payload.months[row.payload.selected].salary).toBe(98765);
  await c.close();
});
