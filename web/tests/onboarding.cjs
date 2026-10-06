// Read-only UI acceptance: no wallet signatures or on-chain transactions.
const { chromium, expect } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const origin =
  process.env.DEPTHGUARD_WEB_ORIGIN || "https://depthguard.rbexp.com";
(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const results = [];
  async function fresh(options = {}) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    return { context, page };
  }
  try {
    const { context, page } = await fresh({
      viewport: { width: 1440, height: 1050 },
    });
    await page.goto(origin + "/explore?sort=newest");
    await expect(
      page.getByRole("heading", { name: "An economy starts with an idea." }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/onboarding\?returnTo=/);
    await page.getByRole("button", { name: /^Continue →$/ }).click();
    await expect(
      page.getByText("Devnet · Test network", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Wallet not connected", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Connect wallet", exact: false })
      .last()
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Close wallet chooser" }).click();
    await page
      .getByRole("button", { name: "Continue without signing in" })
      .click();
    await expect(
      page.getByRole("heading", { name: "You know where to go next." }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Explore economies" }).click();
    await expect(page).toHaveURL(origin + "/explore");
    await page.reload();
    await expect(
      page.getByRole("link", { name: "Getting started", exact: true }),
    ).toBeVisible();
    assert.equal(new URL(page.url()).pathname, "/explore");
    await page
      .getByRole("link", { name: "Getting started", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "An economy starts with an idea." }),
    ).toBeVisible();
    results.push(
      "Automatic first visit, optional wallet, completion persistence and guide replay",
    );
    for (const [name, action, route] of [
      ["Launch a token", "Create your token", "/create/identity"],
      ["Design an economy", "Open Economy Studio", "/studio"],
    ]) {
      await page.goto(origin + "/onboarding");
      await page.getByRole("button", { name: new RegExp(name) }).click();
      await page.getByRole("button", { name: "Your first step" }).click();
      await page.getByRole("button", { name: action }).click();
      await expect(page).toHaveURL(origin + route);
    }
    results.push("Creator and designer paths open their real workspaces");
    await context.close();
    const skipped = await fresh();
    await skipped.page.goto(origin + "/explore?sort=newest");
    await skipped.page.getByRole("button", { name: "Skip for now" }).click();
    await expect(skipped.page).toHaveURL(origin + "/explore?sort=newest");
    await skipped.page.reload();
    await expect(
      skipped.page.getByRole("link", { name: "Getting started", exact: true }),
    ).toBeVisible();
    assert.equal(new URL(skipped.page.url()).pathname, "/explore");
    results.push("Skip remembers preference and preserves the requested query");
    await skipped.context.close();
    const mobile = await fresh({
      viewport: { width: 390, height: 844 },
      isMobile: true,
    });
    await mobile.page.goto(origin + "/settings");
    await expect(
      mobile.page.getByText("New to DepthGuard?", { exact: false }),
    ).toBeVisible();
    assert.equal(new URL(mobile.page.url()).pathname, "/settings");
    await mobile.page
      .getByRole("link", { name: "Get started", exact: false })
      .click();
    for (let step = 0; step < 3; step++) {
      await expect(mobile.page.locator(".onboarding-heading h1")).toBeVisible();
      assert(
        await mobile.page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        "Mobile horizontal overflow",
      );
      if (step < 2)
        await mobile.page
          .getByRole("button", {
            name: step ? /^Continue without signing in/ : /^Continue →$/,
          })
          .click();
    }
    fs.mkdirSync(".local/onboarding", { recursive: true });
    await mobile.page.screenshot({
      path: ".local/onboarding/mobile.png",
      fullPage: true,
    });
    await mobile.page.getByRole("button", { name: "Skip for now" }).click();
    await expect(mobile.page).toHaveURL(origin + "/settings");
    results.push(
      "Direct links preserved, contextual invitation, all three mobile steps fit",
    );
    await mobile.context.close();
    const blocked = await fresh();
    await blocked.context.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("Disabled", "SecurityError");
        },
      });
    });
    await blocked.page.goto(origin + "/explore");
    await blocked.page.getByRole("button", { name: "Skip for now" }).click();
    await expect(blocked.page).toHaveURL(origin + "/explore");
    await blocked.page.goto(
      origin + "/onboarding?returnTo=https%3A%2F%2Fevil.example",
    );
    await blocked.page.getByRole("button", { name: "Skip for now" }).click();
    await expect(blocked.page).toHaveURL(origin + "/explore");
    results.push(
      "Disabled browser storage remains usable; external return destinations rejected",
    );
    await blocked.context.close();
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({ passed: results, pageErrors: errors }, null, 2),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
