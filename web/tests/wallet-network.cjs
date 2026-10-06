// Public browser check with a Wallet Standard fixture; no auth signatures or transactions.
const { chromium } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const origin = process.env.DEPTHGUARD_WEB_ORIGIN || "https://depthguard.rbexp.com";
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await context.addInitScript(() => {
      let listener;
      let account = {
        address: "11111111111111111111111111111111",
        publicKey: new Uint8Array(32),
        chains: ["solana:mainnet"],
        features: ["solana:signTransaction", "solana:signMessage"],
      };
      const wallet = {
        version: "1.0.0",
        name: "Network Test Wallet",
        icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
        chains: ["solana:mainnet", "solana:devnet"],
        accounts: [account],
        features: {
          "standard:connect": {
            version: "1.0.0",
            connect: async () => ({ accounts: [account] }),
          },
          "standard:disconnect": {
            version: "1.0.0",
            disconnect: async () => {},
          },
          "standard:events": {
            version: "1.0.0",
            on: (_, fn) => {
              listener = fn;
              return () => {
                listener = undefined;
              };
            },
          },
          "solana:signMessage": {
            version: "1.0.0",
            signMessage: () => {
              throw Error("Signing is forbidden in this test");
            },
          },
          "solana:signTransaction": {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy", 0],
            signTransaction: () => {
              throw Error("Signing is forbidden in this test");
            },
          },
        },
      };
      window.__enableDevnet = () => {
        account = { ...account, chains: ["solana:mainnet", "solana:devnet"] };
        wallet.accounts = [account];
        listener?.({ accounts: [account] });
      };
      window.addEventListener("wallet-standard:app-ready", (e) =>
        e.detail.register(wallet),
      );
      window.dispatchEvent(
        new CustomEvent("wallet-standard:register-wallet", {
          detail: (api) => api.register(wallet),
        }),
      );
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin + "/explore");
    const connect = page.locator("button.wallet");
    await connect.waitFor();
    assert((await connect.innerText()).includes("Devnet"));
    await connect.click();
    const modal = page.getByRole("dialog");
    await modal.getByRole("heading", { name: "Connect to Devnet." }).waitFor();
    assert((await modal.innerText()).includes("Mainnet balances are separate"));
    await modal.getByRole("button", { name: "Network Test Wallet" }).click();
    await page.locator(".network-mismatch").waitFor();
    assert(
      await modal
        .getByRole("button", { name: "Authenticate", exact: true })
        .isDisabled(),
    );
    assert(await modal.locator("details").evaluate((e) => e.open));
    assert((await modal.innerText()).includes("select Devnet, then reconnect"));
    assert.equal(
      await modal
        .getByRole("link", { name: "Get Devnet SOL" })
        .getAttribute("href"),
      "https://faucet.solana.com/",
    );
    await page.evaluate(() => window.__enableDevnet());
    await page.waitForFunction(
      () => !document.querySelector(".network-mismatch"),
    );
    assert(
      await modal
        .getByRole("button", { name: "Authenticate", exact: true })
        .isEnabled(),
    );
    assert(
      (await modal.innerText()).includes("This wallet account supports Devnet"),
    );
    await page.reload();
    await page.locator("button.wallet").click();
    await page.waitForFunction(() =>
      document.querySelector(".network-mismatch"),
    );
    assert(
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Authenticate", exact: true })
        .isDisabled(),
    );
    await page.evaluate(() => window.__enableDevnet());
    await page.waitForFunction(() =>
      document.querySelector(".network-compatible"),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: ".local/wallet-network-mobile.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Close wallet chooser" }).click();
    await page.goto("https://depthguard.rbexp.com/settings");
    await page.getByRole("heading", { name: "Your connection." }).waitFor();
    assert(
      (await page.locator("main").innerText()).includes("Application network"),
    );
    console.log(
      "Wallet network checks passed: network label, unsupported account blocking, guidance, account change, reconnect and mobile layout.",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
