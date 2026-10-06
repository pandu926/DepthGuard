// Browser-only workspace checks. Imported by the live devnet harness.
const { expect } = require("@playwright/test");
const assert = require("node:assert/strict");
module.exports = async function ({
  p,
  origin,
  evidence,
  record,
  tx,
  importEconomy,
  forkActor,
}) {
  const done = (s) => evidence.checkpoints.some((c) => c.stage === s);
  if (!done("fees-swept-and-claimed")) {
    for (const [mechanism, item] of Object.entries(evidence.launches)) {
      const stage = mechanism + "-damm-fees-generated";
      if (!mechanism.startsWith("funding_") || done(stage)) continue;
      await p.goto(origin + item.token);
      await p.getByLabel("You pay · WSOL").fill("0.001");
      await tx(
        p,
        p.getByRole("button", { name: new RegExp("^Buy " + item.symbol) }),
      );
      record(stage);
    }
    await p.goto(origin + "/earnings");
    for (const item of Object.values(evidence.launches)) {
      const row = p
        .locator(".list-row")
        .filter({ has: p.getByText(item.name, { exact: true }) });
      for (const protocol of ["DBC", "DAMM"]) {
        const stage = `fee-sweep-${item.symbol}-${protocol}`;
        if (done(stage)) continue;
        await tx(
          p,
          row.getByRole("button", { name: "Sweep " + protocol, exact: true }),
        );
        record(stage);
      }
    }
    await expect(
      p
        .getByRole("button", { name: "Claim ↗", exact: true })
        .and(p.locator(":enabled"))
        .first(),
    ).toBeVisible({ timeout: 30000 });
    let count = 0;
    while (
      await p
        .getByRole("button", { name: "Claim ↗", exact: true })
        .and(p.locator(":enabled"))
        .count()
    ) {
      await tx(
        p,
        p
          .getByRole("button", { name: "Claim ↗", exact: true })
          .and(p.locator(":enabled"))
          .first(),
      );
      await expect(
        p.getByRole("button", { name: "Claim ↗", exact: true }).first(),
      ).toHaveAttribute("aria-busy", "false", { timeout: 30000 });
      record("fee-claim-finalized");
      if (++count > 20) throw Error("Claim list did not settle");
    }
    record("fees-swept-and-claimed", { claims: count });
  }
  if (!done("invalid-import-identity-and-reviewer-guards")) {
    await p.goto(origin + evidence.launches.funding.token + "/review");
    await expect(
      p.getByText("Only the fixed reviewer set can vote.", { exact: true }),
    ).toBeVisible();
    await expect(
      p.getByRole("button", { name: "Approve milestone", exact: true }),
    ).toBeDisabled();
    await importEconomy(p);
    await p.locator("input[type=file]").setInputFiles({
      name: "invalid.json",
      mimeType: "application/json",
      buffer: Buffer.from("{invalid"),
    });
    await expect(p.locator("p.error")).toBeVisible();
    await p.getByRole("button", { name: "New model", exact: true }).click();
    await p.goto(origin + "/create/identity");
    await p.getByLabel("Token name").fill("UI invalid identity");
    await p.getByLabel("Symbol", { exact: true }).fill("INVALID");
    await p.getByLabel("Metadata URI").fill("http://example.com/test.json");
    await p.getByRole("button", { name: /Continue/ }).click();
    await expect(
      p.getByText("Use an HTTPS or IPFS metadata URI.", { exact: true }),
    ).toBeVisible();
    assert(p.url().endsWith("/create/identity"));
    await p
      .getByLabel("Metadata URI")
      .fill("https://example.com/metadata.json");
    await p.getByRole("button", { name: /Continue/ }).click();
    await p.getByRole("button", { name: /Asset markets/ }).click();
    await p.getByRole("link", { name: /Continue/ }).click();
    await p.getByRole("link", { name: /Simulate economy/ }).click();
    await p.getByRole("link", { name: /Review launch/ }).click();
    await expect(
      p.getByRole("button", { name: /Create launch workflow/ }),
    ).toBeDisabled();
    record("asset-quote-research-only-guard");
    record("invalid-import-identity-and-reviewer-guards");
  }
  if (!done("studio-model-published-forked-imported")) {
    let version = evidence.checkpoints.findLast(
      (c) => c.stage === "model-version-published",
    )?.version;
    if (!version) {
      await importEconomy(p);
      await p
        .getByLabel("Model name")
        .fill("UI reusable economy " + Date.now());
      await p.getByRole("button", { name: /Advanced controls/ }).click();
      await expect(p.getByLabel("Native configuration JSON")).not.toHaveValue(
        "",
      );
      await p
        .getByRole("button", {
          name: "Validate native configuration",
          exact: true,
        })
        .click();
      await expect(
        p.getByText("Structural validation evidence", { exact: true }),
      ).toBeVisible();
      await p.getByLabel("Native configuration JSON").fill("{}");
      await p
        .getByRole("button", {
          name: "Validate native configuration",
          exact: true,
        })
        .click();
      await expect(p.locator("p.error")).toBeVisible();
      await p
        .getByRole("button", { name: "Reset to launch profile", exact: true })
        .click();
      await expect(p.getByLabel("Native configuration JSON")).not.toHaveValue(
        "{}",
      );
      await p
        .getByRole("button", {
          name: "Validate native configuration",
          exact: true,
        })
        .click();
      await expect(p.locator("p.error")).toHaveCount(0);
      await p
        .getByText("Structural validation evidence", { exact: true })
        .click();
      await expect(
        p
          .locator("pre")
          .filter({ hasText: "idl_structure_and_selected_constraints" }),
      ).toContainText('"valid": true');
      await p
        .getByRole("button", { name: "Close advanced", exact: true })
        .click();
      await p
        .getByRole("button", { name: "Add segment +", exact: true })
        .click();
      await p
        .getByRole("button", { name: "Remove segment 3", exact: true })
        .click();
      await p.getByLabel("Trading fee", { exact: true }).fill("50");
      await p.getByRole("button", { name: "Validate", exact: true }).click();
      await expect(
        p.getByText("Validation result", { exact: true }),
      ).toBeVisible();
      await p.getByRole("button", { name: /Review publication/ }).click();
      await p.getByRole("button", { name: /Publish version/ }).click();
      await p.waitForURL(/\/models\/[0-9a-f-]+$/);
      version = p.url();
      record("model-version-published", { version });
    } else await p.goto(version);
    for (let i = 0; i < 8; i++) {
      const b = p.getByRole("button", {
        name: /Continue on-chain registration/,
      });
      await p.waitForTimeout(800);
      if (!(await b.count())) break;
      const close = p.getByRole("button", { name: "Dismiss transaction" });
      if (await close.count()) await close.click();
      const [response] = await Promise.all([
        p.waitForResponse(
          (r) =>
            r.url().includes("/factory/models/") &&
            r.url().endsWith("/next") &&
            r.request().method() === "POST",
        ),
        b.click(),
      ]);
      assert(response.ok());
      const prepared = await response.json();
      if (prepared.state !== "complete") {
        await expect(p.locator(".tx-toast strong")).toHaveText("finalized", {
          timeout: 150000,
        });
        await expect(
          p.getByRole("button", { name: "Dismiss transaction" }),
        ).toBeVisible();
      }
      await expect(
        p.getByRole("button", { name: "Preparing registration…", exact: true }),
      ).toHaveCount(0, { timeout: 30000 });
      assert.deepEqual(await p.locator("p.error").allTextContents(), []);
      if (i === 7) throw Error("Registration did not finish");
    }
    const download = p.waitForEvent("download");
    await p.getByRole("button", { name: /Export JSON/ }).click();
    const file = await download;
    const filePath = await file.path();
    await p
      .getByRole("button", { name: "Fork into Studio", exact: true })
      .click();
    await p.waitForURL("**/studio");
    await p.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(p.getByText("Draft saved", { exact: true })).toBeVisible();
    await p.locator("input[type=file]").setInputFiles(filePath);
    await expect(
      p.getByText("Validation result", { exact: true }),
    ).toBeVisible();
    await p.getByText("Validation result", { exact: true }).click();
    await expect(
      p.locator("pre").filter({ hasText: "author_preserved" }),
    ).toContainText("true");
    const fs = require("node:fs");
    const exported = JSON.parse(fs.readFileSync(filePath));
    const tampered = structuredClone(exported);
    tampered.economy.trade_fee_bps += 1;
    await p.locator("input[type=file]").setInputFiles({
      name: "tampered-model.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(tampered)),
    });
    await expect(p.locator("p.error")).toContainText(
      "does not match the published economy",
    );
    await p.goto(version);
    await p.getByRole("button", { name: /Use this economy/ }).click();
    await p.waitForURL("**/create/identity");
    record("studio-model-published-forked-imported", { version });
  }
  if (forkActor && !done("cross-wallet-author-attribution-preserved")) {
    const version = evidence.checkpoints.find(
      (c) => c.stage === "studio-model-published-forked-imported",
    ).version;
    const other = await forkActor();
    await other.goto(version);
    await other
      .getByText("Inspect economy parameters", { exact: true })
      .click();
    const source = JSON.parse(
      await other
        .locator("details")
        .filter({
          has: other.getByText("Inspect economy parameters", { exact: true }),
        })
        .locator("pre")
        .textContent(),
    );
    await other
      .getByRole("button", { name: "Fork into Studio", exact: true })
      .click();
    await other.waitForURL("**/studio");
    await other
      .getByText("Author attribution and fee sharing", { exact: true })
      .click();
    await expect(
      other.getByLabel("Original author", { exact: true }),
    ).toHaveValue(source.fee_policy.author);
    await other
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await expect(other.getByText("Draft saved", { exact: true })).toBeVisible();
    await other.context().close();
    record("cross-wallet-author-attribution-preserved");
  }
  if (!done("research-scenarios-and-export")) {
    const researchEconomy = await importEconomy(p);
    await p.goto(origin + "/research");
    const cases = [
      ["graduation", {}],
      ["single_swap", {}],
      ["sequential_trading", {}],
      [
        "whale_sell",
        {
          sqrt_price: (
            BigInt(researchEconomy.sqrt_start_price) * 2n
          ).toString(),
          quote_reserve: "10000000",
        },
      ],
      [
        "redemption",
        { reserve: "1000000", outstanding_supply: "1000000", burn: "1000" },
      ],
      [
        "funding",
        {
          escrow_reserve: "1000000",
          requested_release: "1000",
          approved: true,
        },
      ],
      ["compounding", { non_protocol_fees: "1000000" }],
      ["royalty_fork", { claimable_fees: "1000000" }],
      ["historical_replay", {}],
    ];
    for (const [scenario, inputs] of cases) {
      await p.getByLabel("Scenario", { exact: true }).selectOption(scenario);
      const orders =
        scenario === "whale_sell"
          ? [{ direction: "sell", amount: "1000000000", exact_out: false }]
          : scenario === "sequential_trading"
            ? [
                { direction: "buy", amount: "1000000", exact_out: false },
                { direction: "sell", amount: "100000000", exact_out: false },
              ]
            : [{ direction: "buy", amount: "1000000", exact_out: false }];
      await p.getByLabel("Order sequence").fill(JSON.stringify(orders));
      await p.getByLabel("Scenario inputs").fill(JSON.stringify(inputs));
      const response = p.waitForResponse(
        (r) =>
          r.url().endsWith("/api/v1/previews") &&
          r.request().method() === "POST",
      );
      await p.getByRole("button", { name: /Run preview/ }).click();
      const result = await (await response).json();
      assert.equal(result.status, "completed", JSON.stringify(result));
      if (result.result?.orders)
        assert(
          result.result.orders.every((o) => o.status === "success"),
          JSON.stringify(result),
        );
      record("research-preview", { scenario });
    }
    await p
      .getByRole("button", { name: "Pin as baseline", exact: true })
      .click();
    await expect(
      p.getByText("Pinned comparison baseline", { exact: true }),
    ).toBeVisible();
    const download = p.waitForEvent("download");
    await p.getByRole("button", { name: /Export evidence/ }).click();
    await download;
    await p
      .getByRole("button", { name: "Save research run", exact: true })
      .click();
    await p.getByRole("link", { name: /Open research job/ }).click();
    await expect(
      p.locator(".metric").filter({ hasText: "Status" }),
    ).toContainText("completed", { timeout: 60000 });
    record("research-scenarios-and-export");
  }
  if (!done("research-job-cancellation")) {
    await importEconomy(p);
    for (let attempt = 0; attempt < 3; attempt++) {
      await p.goto(origin + "/research");
      await p
        .getByLabel("Scenario", { exact: true })
        .selectOption("sequential_trading");
      await p.getByLabel("Order sequence").fill(
        JSON.stringify(
          Array.from({ length: 1000 }, () => ({
            direction: "buy",
            amount: "18446744073709551615",
            exact_out: true,
          })),
        ),
      );
      await p.getByLabel("Scenario inputs").fill("{}");
      await p
        .getByRole("button", { name: "Save research run", exact: true })
        .click();
      await p.getByRole("link", { name: /Open research job/ }).click();
      const cancel = p.getByRole("button", { name: "Cancel run", exact: true });
      try {
        await cancel.waitFor({ timeout: 2000 });
      } catch {
        continue;
      }
      const [response] = await Promise.all([
        p.waitForResponse(
          (r) => r.url().endsWith("/cancel") && r.request().method() === "POST",
        ),
        cancel.click(),
      ]);
      if (!response.ok()) continue;
      assert.equal((await response.json()).cancel_requested, true);
      await expect(
        p.locator(".metric").filter({ hasText: "Status" }),
      ).toContainText("cancelled", { timeout: 60000 });
      record("research-job-cancellation", { job: p.url() });
      break;
    }
    assert(
      done("research-job-cancellation"),
      "The job completed before cancellation could be exercised",
    );
  }
  if (!done("research-cancel-completion-race")) {
    await importEconomy(p);
    for (let attempt = 0; attempt < 8; attempt++) {
      await p.goto(origin + "/research");
      await p
        .getByLabel("Scenario", { exact: true })
        .selectOption("sequential_trading");
      await p.getByLabel("Order sequence").fill(
        JSON.stringify(
          Array.from({ length: 1000 }, () => ({
            direction: "buy",
            amount: "1000000000",
            exact_out: true,
          })),
        ),
      );
      await p.getByLabel("Scenario inputs").fill("{}");
      await p
        .getByRole("button", { name: "Save research run", exact: true })
        .click();
      await p.getByRole("link", { name: /Open research job/ }).click();
      const cancel = p.getByRole("button", { name: "Cancel run", exact: true });
      try {
        await cancel.waitFor({ timeout: 1500 });
      } catch {
        continue;
      }
      await p.waitForTimeout(1100);
      if (!(await cancel.isVisible())) continue;
      let response;
      try {
        [response] = await Promise.all([
          p.waitForResponse(
            (r) =>
              r.url().endsWith("/cancel") && r.request().method() === "POST",
            { timeout: 4000 },
          ),
          cancel.click({ timeout: 1000 }),
        ]);
      } catch {
        continue;
      }
      if (response.status() !== 404) continue;
      await expect(
        p.locator(".metric").filter({ hasText: "Status" }),
      ).toContainText("completed", { timeout: 15000 });
      await expect(p.locator("p.error")).toHaveCount(0);
      record("research-cancel-completion-race", {
        job: p.url(),
        response_status: 404,
      });
      break;
    }
    assert(
      done("research-cancel-completion-race"),
      "Completion/cancellation race was not exercised",
    );
  }
  if (!done("search-pagination-receipts-mobile")) {
    await p.goto(origin + "/explore");
    await p.getByLabel("Search tokens").fill(evidence.launches.meme.name);
    await expect(
      p.getByRole("link").filter({
        has: p.getByRole("heading", {
          name: evidence.launches.meme.name,
          exact: true,
        }),
      }),
    ).toBeVisible();
    await p.getByLabel("Filter mechanism").selectOption("backed");
    await expect(
      p.getByText("No launches match this selection.", { exact: true }),
    ).toBeVisible();
    await p.goto(origin + "/creator");
    await p.locator(".draft-list a.list-row").first().click();
    await p.waitForURL("**/studio");
    await expect(p.getByLabel("Model name")).not.toHaveValue("");
    record("creator-draft-navigation");
    await p.goto(origin + "/models");
    await p.getByLabel("Search models").fill("UI reusable");
    await p.waitForTimeout(1500);
    assert.equal(await p.locator(".error").count(), 0);
    await p.goto(origin + "/activity");
    const next = p.getByRole("button", { name: "Next →", exact: true });
    if (await next.isEnabled()) {
      await next.click();
      await p.getByRole("button", { name: "← Previous", exact: true }).click();
    }
    await p.locator("a.list-row").first().click();
    await expect(
      p.getByRole("heading", { name: "The exact record.", exact: true }),
    ).toBeVisible();
    await expect(
      p.locator(".metric").filter({ hasText: "State" }),
    ).toContainText("finalized");
    await p.setViewportSize({ width: 390, height: 844 });
    for (const route of ["/explore", "/studio", "/settings"]) {
      await p.goto(origin + route);
      await p.locator("h1").waitFor();
      const overflow = await p.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert.equal(overflow, false, "Mobile overflow " + route);
    }
    await p.setViewportSize({ width: 1440, height: 1000 });
    record("search-pagination-receipts-mobile");
  }
  if (!done("landing-and-documentation-interactions")) {
    await p.goto(origin + "/");
    const models = p.getByRole("button", { name: /^Preview .* economy$/ });
    for (let i = 0; i < (await models.count()); i++) {
      await models.nth(i).click();
      await expect(models.nth(i)).toHaveAttribute("aria-pressed", "true");
    }
    await p
      .getByRole("button", { name: "Pause economy animation", exact: true })
      .click();
    await p
      .getByRole("button", { name: "Resume economy animation", exact: true })
      .click();
    await p.goto(origin + "/docs");
    await p.getByRole("button", { name: /Search documentation/ }).click();
    await p
      .getByLabel("Search documentation", { exact: true })
      .fill("graduation");
    await p.getByRole("option").first().click();
    await expect(p.locator("h1")).toBeVisible();
    await p.setViewportSize({ width: 390, height: 844 });
    await p
      .getByRole("button", {
        name: "Open documentation navigation",
        exact: true,
      })
      .click();
    await expect(p.locator(".dg-navigation-dialog")).toBeVisible();
    await p.keyboard.press("Escape");
    await p.setViewportSize({ width: 1440, height: 1000 });
    record("landing-and-documentation-interactions");
  }
  if (!done("unwrap-and-reconnect")) {
    await p.goto(origin + "/portfolio");
    await p
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await p
      .getByRole("button", { name: "Copy mint", exact: true })
      .first()
      .click();
    const copied = await p.evaluate(() => navigator.clipboard.readText());
    assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(copied));
    record("portfolio-mint-clipboard");
    await tx(
      p,
      p.getByRole("button", {
        name: "Unwrap entire WSOL account",
        exact: true,
      }),
    );
    await p.goto(origin + "/settings");
    await p.locator(".wallet").click();
    await p
      .locator(".wallet-modal")
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    await expect(p.locator(".wallet")).toContainText("Connect wallet");
    await p
      .locator(".wallet-modal")
      .getByRole("button", { name: /Devnet E2E Wallet/ })
      .click();
    await p
      .locator(".wallet-modal")
      .getByRole("button", { name: "Authenticate", exact: true })
      .click();
    await expect(
      p
        .locator(".wallet-modal")
        .getByRole("button", { name: "Authenticated", exact: true }),
    ).toBeVisible();
    await p.getByRole("button", { name: "Close wallet chooser" }).click();
    await p.reload();
    await expect(
      p.locator(".metric").filter({ hasText: "Session" }),
    ).toContainText("Authenticated");
    record("unwrap-and-reconnect");
  }
  if (!done("portfolio-mint-clipboard")) {
    await p.goto(origin + "/portfolio");
    await p
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await p
      .getByRole("button", { name: "Copy mint", exact: true })
      .first()
      .click();
    const copied = await p.evaluate(() => navigator.clipboard.readText());
    assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(copied));
    record("portfolio-mint-clipboard");
  }
  if (!done("creator-draft-navigation")) {
    await p.goto(origin + "/creator");
    await p.locator(".draft-list a.list-row").first().click();
    await p.waitForURL("**/studio");
    await expect(p.getByLabel("Model name")).not.toHaveValue("");
    record("creator-draft-navigation");
  }
  if (!done("mobile-route-coverage")) {
    await p.setViewportSize({ width: 390, height: 844 });
    const routes = [
      "/",
      "/docs",
      "/explore",
      "/models",
      "/studio",
      "/research",
      "/create/identity",
      "/create/parameters",
      "/creator",
      "/authors",
      "/portfolio",
      "/earnings",
      "/activity",
      "/settings",
      evidence.launches.funding_completed.token,
      evidence.launches.backed.token + "/reserve",
      evidence.launches.funding.token + "/funding",
    ];
    for (const route of routes) {
      await p.goto(origin + route);
      await p.locator("h1").first().waitFor();
      await expect(p.locator(".skeleton")).toHaveCount(0);
      await p.evaluate(() => document.fonts.ready);
      assert.equal(
        await p.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        ),
        false,
        "Mobile overflow " + route,
      );
    }
    await p.setViewportSize({ width: 1440, height: 1000 });
    record("mobile-route-coverage", { routes });
  }
};
