import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { once } from "node:events";
import fs from "node:fs";

test("production transport isolates API, preserves authentication and serves SPA routes", async () => {
  const api = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader("content-type", "application/json");
    res.setHeader("set-cookie", "session=opaque; HttpOnly; SameSite=Strict");
    res.end(
      JSON.stringify({
        path: req.url,
        origin: req.headers.origin,
        cookie: req.headers.cookie,
        csrf: req.headers["x-csrf-token"],
        body: Buffer.concat(chunks).toString(),
      }),
    );
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const reservation = http.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const child = spawn(process.execPath, ["web/scripts/serve.mjs"], {
    env: {
      ...process.env,
      DEPTHGUARD_WEB_PORT: String(port),
      DEPTHGUARD_BACKEND_URL: `http://127.0.0.1:${api.address().port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const mediaDirectory = fs.mkdtempSync("web/dist/transport-");
  try {
    await once(child.stdout, "data");
    const base = `http://127.0.0.1:${port}`;
    const spa = await fetch(base + "/tokens/a/reserve");
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /<div id="root">/);
    assert.match(
      spa.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    assert.equal(spa.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(base + "/assets/missing.js")).status, 404);
    assert.equal((await fetch(base + "/%2eenv")).status, 404);
    assert.equal((await fetch(base + "/api/launches")).status, 404);
    // Test byte ranges without requiring presentation files in the source tree.
    const video = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    fs.writeFileSync(mediaDirectory + "/sample.mp4", video);
    fs.writeFileSync(mediaDirectory + "/sample.srt", "1\n00:00:00,000 --> 00:00:01,000\nTransport fixture\n");
    const mediaBase = base + "/" + mediaDirectory.split("/").at(-1);
    const mediaPath = mediaBase + "/sample.mp4";
    const mediaHead = await fetch(mediaPath, {
      method: "HEAD",
      headers: { range: "bytes=0-15" },
    });
    assert.equal(mediaHead.status, 200);
    assert.equal(mediaHead.headers.get("content-type"), "video/mp4");
    assert.equal(mediaHead.headers.get("accept-ranges"), "bytes");
    assert.equal(Number(mediaHead.headers.get("content-length")), video.length);
    const partial = await fetch(mediaPath, {
      headers: { range: "bytes=0-15" },
    });
    assert.equal(partial.status, 206);
    assert.equal(
      partial.headers.get("content-range"),
      `bytes 0-15/${video.length}`,
    );
    assert.deepEqual(
      Buffer.from(await partial.arrayBuffer()),
      video.subarray(0, 16),
    );
    const suffix = await fetch(mediaPath, { headers: { range: "bytes=-16" } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(
      Buffer.from(await suffix.arrayBuffer()),
      video.subarray(-16),
    );
    const openRange = await fetch(mediaPath, {
      headers: { range: `bytes=${video.length - 16}-` },
    });
    assert.equal(openRange.status, 206);
    assert.deepEqual(
      Buffer.from(await openRange.arrayBuffer()),
      video.subarray(-16),
    );
    for (const range of [
      `bytes=${video.length}-`,
      "bytes=20-5",
      "bytes=-0",
      "bytes=0-1,4-5",
      "bytes=999999999999999999999-",
    ]) {
      const rejected = await fetch(mediaPath, { headers: { range } });
      assert.equal(rejected.status, 416);
      assert.equal(
        rejected.headers.get("content-range"),
        `bytes */${video.length}`,
      );
    }
    assert.match(
      (await fetch(mediaBase + "/sample.srt")).headers.get(
        "content-type",
      ),
      /application\/x-subrip/,
    );
    const result = await fetch(base + "/api/v1/auth/verify?check=1", {
      method: "POST",
      headers: {
        origin: base,
        cookie: "session=opaque",
        "x-csrf-token": "token",
        "content-type": "application/json",
      },
      body: '{"message":"exact"}',
    });
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.match(result.headers.get("set-cookie"), /HttpOnly/);
    assert.deepEqual(await result.json(), {
      path: "/api/v1/auth/verify?check=1",
      origin: base,
      cookie: "session=opaque",
      csrf: "token",
      body: '{"message":"exact"}',
    });
    assert.equal(
      (
        await fetch(base + "/api/v1/body", {
          method: "POST",
          body: "x".repeat(2097153),
        })
      ).status,
      413,
    );
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    await new Promise((r) => api.close(r));
    fs.rmSync(mediaDirectory, { recursive: true, force: true });
  }
});
