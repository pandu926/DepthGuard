"use strict";
// Test the live domain and TLS virtual host before the owner creates its DNS record.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const crypto = require("node:crypto");
const { chromium } = require("@playwright/test");
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58").default;
const domain = "depthguard.rbexp.com";
const origin = `https://${domain}`;
const cert = fs.readFileSync(
  "/root/cashtoken-explorer/nginx/ssl/depthguard-origin.crt",
);
const pin = crypto
  .createHash("sha256")
  .update(
    new crypto.X509Certificate(cert).publicKey.export({
      type: "spki",
      format: "der",
    }),
  )
  .digest("base64");
function request(route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const wire = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(
      new URL(route, origin),
      {
        ca: cert,
        lookup: (_host, options, callback) =>
          options.all
            ? callback(null, [{ address: "127.0.0.1", family: 4 }])
            : callback(null, "127.0.0.1", 4),
        method: wire === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          ...headers,
        },
        timeout: 20000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () =>
      req.destroy(Error("HTTPS request deadline exceeded")),
    );
    req.end(wire);
  });
}
(async () => {
  let browser;
  let cookie;
  let csrf;
  try {
    const html = await request("/");
    assert.equal(html.status, 200);
    assert(html.text.includes("DepthGuard"));
    const capabilities = await request("/api/v1/capabilities");
    assert.equal(capabilities.status, 200);
    assert.equal(JSON.parse(capabilities.text).cluster, "devnet");
    const signer = Keypair.fromSecretKey(
      Uint8Array.from(
        JSON.parse(fs.readFileSync(".local/devnet/keys/creator.json")),
      ),
    );
    const wallet = signer.publicKey.toBase58();
    assert.equal(
      (
        await request(
          "/api/v1/auth/challenges",
          { wallet },
          { Origin: "https://untrusted.invalid" },
        )
      ).status,
      403,
    );
    const challengeResponse = await request("/api/v1/auth/challenges", {
      wallet,
    });
    assert.equal(challengeResponse.status, 200);
    const challenge = JSON.parse(challengeResponse.text);
    assert(
      challenge.message.includes(origin) &&
        challenge.message.includes("Cluster: devnet"),
    );
    const privateKey = crypto.createPrivateKey({
      format: "der",
      type: "pkcs8",
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        signer.secretKey.slice(0, 32),
      ]),
    });
    const authenticated = await request("/api/v1/auth/verify", {
      id: challenge.id,
      signature: bs58.encode(
        crypto.sign(null, Buffer.from(challenge.message), privateKey),
      ),
    });
    assert.equal(authenticated.status, 200);
    const setCookie = authenticated.headers["set-cookie"][0];
    assert(
      setCookie.includes("; Secure") &&
        setCookie.includes("HttpOnly") &&
        setCookie.includes("SameSite=Strict"),
    );
    cookie = setCookie.split(";")[0];
    csrf = JSON.parse(authenticated.text).csrf_token;
    assert.equal(
      JSON.parse(
        (await request("/api/v1/me", undefined, { Cookie: cookie })).text,
      ).wallet,
      wallet,
    );
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-proxy-server",
        `--host-resolver-rules=MAP ${domain} 127.0.0.1`,
        `--ignore-certificate-errors-spki-list=${pin}`,
      ],
    });
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
    });
    await context.addCookies([
      {
        name: "depthguard_session",
        value: cookie.split("=")[1],
        url: origin,
        secure: true,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const lifecycle = JSON.parse(
      fs.readFileSync("web/tests/evidence/devnet-lifecycle.json"),
    );
    const routes = [
      "/",
      "/explore",
      "/studio",
      "/research",
      "/models",
      `/tokens/${lifecycle.launch_address}`,
      `/tokens/${lifecycle.mechanisms.find((m) => m.mechanism === "funding").launch}/funding`,
    ];
    for (const route of routes) {
      const response = await page.goto(origin + route);
      assert.equal(response.status(), 200);
      await page.waitForFunction(
        () => document.querySelector("main")?.textContent.length > 50,
      );
      assert(await page.evaluate(() => window.isSecureContext));
    }
    const me = await page.evaluate(async () =>
      (await fetch("/api/v1/me")).json(),
    );
    assert.equal(me.wallet, wallet);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin + "/explore");
    await page.waitForFunction(
      () => document.querySelector("main")?.textContent.length > 50,
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    assert.deepEqual(errors, []);
    const evidence = {
      domain,
      network: "devnet",
      origin_https_accepted: true,
      dns_override: "127.0.0.1",
      tls_certificate: "self_signed_origin_explicitly_trusted_for_test",
      browser_certificate_scope: "single_origin_certificate_spki_pin",
      cloudflare_edge_verified: false,
      dns_pending_owner: true,
      authentication_verified: true,
      secure_httponly_cookie: true,
      wrong_origin_rejected: true,
      browser_secure_context: true,
      browser_errors: errors,
      responsive_overflow: false,
      routes_verified: routes,
      recorded_at: new Date().toISOString(),
    };
    fs.writeFileSync(
      "web/tests/evidence/devnet-https.json",
      JSON.stringify(evidence, null, 2) + "\n",
    );
    console.log(JSON.stringify(evidence));
  } finally {
    if (browser) await browser.close();
    if (cookie && csrf)
      assert.equal(
        (
          await request(
            "/api/v1/auth/logout",
            {},
            { Cookie: cookie, "X-CSRF-Token": csrf },
          )
        ).status,
        200,
      );
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
