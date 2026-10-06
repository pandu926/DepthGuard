"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromium } = require("@playwright/test");
const origin =
  process.env.DEPTHGUARD_LANDING_ORIGIN || "https://depthguard.rbexp.com";
(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [],
    failures = [],
    api = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("response", (r) => {
      if (r.status() >= 400)
        failures.push({ path: new URL(r.url()).pathname, status: r.status() });
    });
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.startsWith("/api/"))
        api.push(new URL(r.url()).pathname);
    });
    assert.equal((await page.goto(origin)).status(), 200);
    await page
      .getByRole("heading", {
        level: 1,
        name: "Design the economy. Launch the token.",
      })
      .waitFor();
    assert(await page.evaluate(() => isSecureContext));
    assert((await page.title()).includes("Design the economy"));
    assert.equal(
      await page.locator('link[rel="canonical"]').getAttribute("href"),
      origin + "/",
    );
    await page.locator('.lp-engine[data-animating="true"]').waitFor();
    await page.getByRole("button", { name: "Pause economy animation" }).click();
    await page.locator('.lp-engine[data-animating="false"]').waitFor();
    const frozen = await page.locator(".lp-engine-svg").innerHTML();
    await page.waitForTimeout(150);
    assert.equal(await page.locator(".lp-engine-svg").innerHTML(), frozen);
    await page
      .getByRole("button", { name: "Resume economy animation" })
      .click();
    for (const name of [
      "Milestone funding",
      "Reserve-backed",
      "Asset-quoted",
      "Community",
    ]) {
      const button = page
        .locator(".lp-model-list")
        .getByRole("button", { name: new RegExp(name) });
      await button.click();
      assert.equal(await button.getAttribute("aria-pressed"), "true");
      assert(
        (
          await page.locator(".lp-engine-svg").getAttribute("aria-label")
        ).startsWith(name),
      );
      if (name === "Asset-quoted")
        assert(
          (await page.locator(".lp-model-detail").innerText()).includes(
            "Research only",
          ),
        );
    }
    const links = await page
      .locator(".lp-page a[href]")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href")));
    assert(
      links.includes("/explore") &&
        links.includes("/create/identity") &&
        links.includes("/models") &&
        links.includes("/docs/mathematical-framework"),
    );
    for (const href of links.filter((h) => h.startsWith("#")))
      assert.equal(await page.locator(href).count(), 1);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: ".local/landing-desktop.png",
      fullPage: true,
    });
    assert.equal(
      api.length,
      0,
      "Public landing must not request backend capabilities or wallet data",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin);
    await page.locator(".lp-model-detail").waitFor();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: ".local/landing-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 320, height: 740 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "320px overflow",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(origin);
    await page.locator('.lp-engine[data-animating="false"]').waitFor();
    const still = await page.locator(".lp-engine-svg").innerHTML();
    await page.waitForTimeout(150);
    assert.equal(await page.locator(".lp-engine-svg").innerHTML(), still);
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement.textContent),
      "Skip to content",
    );
    await page.keyboard.press("Enter");
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "lp-main",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(origin);
    await page.getByRole("link", { name: "Open app" }).first().click();
    await page.waitForURL("**/explore");
    await page
      .getByRole("heading", { name: "More than a token.", exact: true })
      .waitFor();
    await page.getByRole("link", { name: "Docs", exact: true }).click();
    await page.locator(".dg-article-heading h1").waitFor();
    await page.getByRole("link", { name: "Open app" }).click();
    await page.waitForURL("**/explore");
    await page
      .getByRole("heading", { name: "More than a token.", exact: true })
      .waitFor();
    await page.locator("a.wordmark").click();
    await page.locator(".lp-hero h1").waitFor();
    for (const route of [
      "/create/identity",
      "/models",
      "/studio",
      "/research",
    ]) {
      await page.locator(`.lp-page a[href="${route}"]`).first().click();
      await page.waitForURL(`**${route}`);
      await page.locator(".page-heading h1").waitFor();
      await page.reload();
      await page.locator(".page-heading h1").waitFor();
      await page.locator("a.wordmark").click();
      await page.locator(".lp-hero h1").waitFor();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(failures, []);
    fs.writeFileSync(
      "web/tests/evidence/landing-browser.json",
      JSON.stringify(
        {
          checked_at: new Date().toISOString(),
          origin,
          public_https_verified: true,
          desktop: 1440,
          mobile: [390, 320],
          mechanisms: 4,
          no_backend_requests_on_landing: true,
          autoplay_pause_and_reduced_motion: true,
          app_and_docs_navigation: true,
          cta_routes_and_reload: [
            "/create/identity",
            "/models",
            "/studio",
            "/research",
          ],
          errors,
          failures,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      "Landing HTTPS acceptance passed: four mechanisms, responsive layout, animation controls, keyboard access, and app/docs navigation.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
