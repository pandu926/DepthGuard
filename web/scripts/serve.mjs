// Static production Vite assets and same-origin Rust API transport. No application logic.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist",
);
const upstream = new URL(
  process.env.DEPTHGUARD_BACKEND_URL || "http://127.0.0.1:8800",
);
if (
  upstream.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(upstream.hostname) ||
  upstream.username ||
  upstream.password
)
  throw Error("Frontend transport requires a private loopback Rust backend.");
const headers = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".srt": "application/x-subrip; charset=utf-8",
};
function error(res, status, message) {
  res.writeHead(status, {
    ...headers,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ error: { code: "transport_error", message } }));
}
const server = http.createServer((req, res) => {
  let incoming;
  try {
    incoming = new URL(req.url, "http://frontend.invalid");
  } catch {
    return error(res, 400, "Invalid request URL.");
  }
  const pathname = incoming.pathname;
  if (pathname.startsWith("/api/v1/")) {
    const declared = Number(req.headers["content-length"] || 0);
    if (!Number.isFinite(declared) || declared > 2097152)
      return error(res, 413, "Request exceeds the supported size.");
    const h = {
      ...req.headers,
      host: upstream.host,
      "x-forwarded-for": req.socket.remoteAddress || "",
    };
    delete h["x-forwarded-host"];
    delete h["x-forwarded-proto"];
    delete h.connection;
    delete h["transfer-encoding"];
    const proxy = http.request(
      new URL(incoming.pathname + incoming.search, upstream),
      { method: req.method, headers: h, timeout: 320000 },
      (response) => {
        const forward = {
          ...response.headers,
          ...headers,
          "cache-control": "no-store",
        };
        delete forward.connection;
        res.writeHead(response.statusCode || 502, forward);
        response.pipe(res);
      },
    );
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 2097152) {
        proxy.destroy();
        if (!res.headersSent)
          error(res, 413, "Request exceeds the supported size.");
      }
    });
    proxy.on("timeout", () => proxy.destroy());
    proxy.on("error", () => {
      if (!res.headersSent)
        error(res, 502, "The backend is temporarily unavailable.");
      else res.destroy();
    });
    req.on("aborted", () => proxy.destroy());
    req.pipe(proxy);
    return;
  }
  if (pathname.startsWith("/api/") || !["GET", "HEAD"].includes(req.method))
    return error(res, 404, "Resource not found.");
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return error(res, 400, "Invalid path.");
  }
  if (
    decoded.includes("\0") ||
    decoded.split("/").some((v) => v.startsWith(".") && v !== "")
  )
    return error(res, 404, "Resource not found.");
  let file = path.resolve(directory, "." + decoded);
  if (!file.startsWith(directory + path.sep) && file !== directory)
    return error(res, 404, "Resource not found.");
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {}
  if (!stat?.isFile()) {
    if (decoded.startsWith("/assets/"))
      return error(res, 404, "Asset not found.");
    file = path.join(directory, "index.html");
    try {
      stat = fs.statSync(file);
    } catch {
      return error(res, 503, "Build the frontend before starting it.");
    }
  }
  if (!mime[path.extname(file)]) return error(res, 404, "Resource not found.");
  const mediaHeaders = {};
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const isVideo = [".mp4", ".webm"].includes(path.extname(file));
  if (isVideo) {
    mediaHeaders["Accept-Ranges"] = "bytes";
    if (req.method === "GET" && req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      let valid = Boolean(range && (range[1] || range[2]));
      if (valid) {
        if (!range[1]) {
          const suffix = Number(range[2]);
          valid = Number.isSafeInteger(suffix) && suffix > 0;
          start = Math.max(0, stat.size - suffix);
        } else {
          start = Number(range[1]);
          const requestedEnd = range[2] ? Number(range[2]) : end;
          valid =
            Number.isSafeInteger(start) && Number.isSafeInteger(requestedEnd);
          end = Math.min(requestedEnd, end);
        }
        valid = valid && start >= 0 && start < stat.size && end >= start;
      }
      if (!valid) {
        res.writeHead(416, {
          ...headers,
          ...mediaHeaders,
          "Content-Range": `bytes */${stat.size}`,
          "Content-Length": 0,
        });
        return res.end();
      }
      status = 206;
      mediaHeaders["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    }
  }
  res.writeHead(status, {
    ...headers,
    ...mediaHeaders,
    "Content-Type": mime[path.extname(file)],
    "Content-Length": end - start + 1,
    "Cache-Control": decoded.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-store",
  });
  if (req.method === "HEAD") return res.end();
  const stream = fs.createReadStream(
    file,
    isVideo && stat.size > 0 ? { start, end } : undefined,
  );
  stream.on("error", () => res.destroy());
  stream.pipe(res);
});
server.requestTimeout = 330000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
server.listen(
  Number(process.env.DEPTHGUARD_WEB_PORT || 8790),
  process.env.DEPTHGUARD_WEB_HOST || "127.0.0.1",
  () => console.log("DepthGuard static frontend listening."),
);
function stop() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
