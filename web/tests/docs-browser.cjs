"use strict";
// Public HTTPS acceptance against the deployed docs, without certificate bypasses.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromium } = require("@playwright/test");
const origin =
  process.env.DEPTHGUARD_DOCS_ORIGIN || "https://depthguard.rbexp.com";
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const errors = [],
      resourceFailures = [],
      apiRequests = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("response", (r) => {
      if (r.status() >= 400)
        resourceFailures.push({
          url: new URL(r.url()).pathname,
          status: r.status(),
        });
    });
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.startsWith("/api/"))
        apiRequests.push(new URL(r.url()).pathname);
    });
    const response = await page.goto(origin + "/docs");
    assert.equal(response.status(), 200);
    await page
      .getByRole("heading", { name: "Economies by design.", exact: true })
      .waitFor();
    assert(await page.evaluate(() => window.isSecureContext));
    await page.screenshot({ path: ".local/docs-desktop.png", fullPage: false });
    const articles = await page
      .locator(".dg-sidebar .dg-chapters a")
      .evaluateAll((links) =>
        links.map((link) => ({
          href: link.getAttribute("href"),
          title: link.textContent,
        })),
      );
    assert.equal(articles.length, 31);
    const pages = [];
    for (const article of articles) {
      await page.goto(origin + article.href);
      await page.locator(".dg-article-heading h1").waitFor();
      const title = await page.locator(".dg-article-heading h1").innerText();
      assert(title.length > 0);
      assert((await page.title()).includes("DepthGuard Docs"));
      assert(
        (await page.locator('meta[name="description"]').getAttribute("content"))
          .length > 30,
      );
      assert.equal(
        await page.locator(".dg-prose .dg-article-section").count(),
        4,
      );
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `Desktop overflow: ${article.href}`,
      );
      pages.push({
        path: article.href,
        title,
        equations: await page.locator("math").count(),
      });
    }
    await page.keyboard.press("Control+k");
    const input = page.getByRole("combobox", { name: "Search documentation" });
    await input.fill("capital conservation");
    await page.getByRole("option").first().waitFor();
    await input.press("Enter");
    await page.waitForURL("**/docs/capital-conservation#*");
    assert.equal(
      await page.locator(".dg-search-dialog").evaluate((el) => el.open),
      false,
    );
    await page.getByRole("button", { name: "Search documentation" }).click();
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator(".dg-search-dialog").evaluate((el) => el.open),
      false,
    );
    await page.goto(origin + "/docs/price-discovery");
    await page.getByRole("button", { name: "convex", exact: true }).click();
    assert.equal(
      await page
        .getByRole("button", { name: "convex", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    const before = await page.locator(".dg-chart-metrics").innerText();
    await page.getByLabel("Purchase interval").focus();
    await page.getByLabel("Purchase interval").press("ArrowRight");
    assert.notEqual(
      await page.locator(".dg-chart-metrics").innerText(),
      before,
    );
    await page.screenshot({
      path: ".local/docs-math-desktop.png",
      fullPage: false,
    });
    await page.goto(origin + "/docs/faq");
    const faq = page.getByText("Can I run any mathematical curve?", {
      exact: true,
    });
    await faq.click();
    assert.equal(await faq.locator("..").getAttribute("open"), "");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin + "/docs");
    await page
      .getByRole("heading", { name: "Economies by design.", exact: true })
      .waitFor();
    await page.screenshot({ path: ".local/docs-mobile.png", fullPage: false });
    await page
      .getByRole("button", { name: "Open documentation navigation" })
      .click();
    await page
      .locator(".dg-navigation-dialog")
      .getByRole("link", {
        name: "Redemption & outstanding supply",
        exact: true,
      })
      .click();
    await page.waitForURL("**/docs/redemption-math");
    assert.equal(
      await page.locator(".dg-navigation-dialog").evaluate((el) => el.open),
      false,
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page.screenshot({
      path: ".local/docs-math-mobile.png",
      fullPage: false,
    });
    await page.goto(origin + "/docs/this-article-does-not-exist");
    await page
      .getByRole("heading", { name: "Let's find your next page." })
      .waitFor();
    assert.equal(
      apiRequests.length,
      0,
      "Documentation must remain independent of application API availability",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(resourceFailures, []);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page
      .locator(".dg-docs-header")
      .getByRole("link", { name: "Open app" })
      .click();
    await page
      .getByRole("heading", { name: "More than a token.", exact: true })
      .waitFor();
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Docs", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Economies by design.", exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(resourceFailures, []);
    const evidence = {
      origin,
      public_https_verified: true,
      certificate_bypass: false,
      articles: pages,
      mathematics_equations: pages.reduce((s, p) => s + p.equations, 0),
      search_keyboard_verified: true,
      search_escape_verified: true,
      interactive_curve_verified: true,
      mobile_navigation_verified: true,
      faq_verified: true,
      unknown_article_verified: true,
      responsive_overflow: false,
      documentation_api_requests: [],
      app_navigation_verified: true,
      browser_errors: errors,
      resource_failures: resourceFailures,
      recorded_at: new Date().toISOString(),
    };
    fs.writeFileSync(
      "web/tests/evidence/docs-browser.json",
      JSON.stringify(evidence, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        origin,
        articles: pages.length,
        equations: evidence.mathematics_equations,
        public_https_verified: true,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
