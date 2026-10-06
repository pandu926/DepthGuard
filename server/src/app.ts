import { API_ORIGIN, WEB_ORIGIN, API_PORT, WEB_PORT } from "./config";
import Fastify from "fastify";
import { resolve, extname, sep } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { preview, PRESETS } from "../../packages/engine/src/preview";
import { Runtime, ApiError } from "./runtime";
export async function createApp(runtime?: Runtime) {
  const rt = runtime ?? new Runtime();
  if (!runtime) await rt.init();
  const app = Fastify({ logger: false, bodyLimit: 3_000_000 });
  app.addHook("onRequest", async (req) => {
    const origin = req.headers.origin;
    if (
      origin &&
      ![
        WEB_ORIGIN,
        API_ORIGIN,
        `http://localhost:${WEB_PORT}`,
        `http://localhost:${API_PORT}`,
      ].includes(origin)
    )
      throw new ApiError(403, "Origin is not allowed for the local VM.");
    if (
      req.method === "POST" &&
      req.headers["x-depthguard-session"] !== rt.session
    )
      throw new ApiError(409, "The VM session changed. Reload the page.");
  });
  app.setErrorHandler((err, req, reply) => {
    reply
      .status(err instanceof ApiError ? err.status : 400)
      .send({ error: err instanceof Error ? err.message : "Request failed" });
  });
  app.get("/api/session", async () => ({
    session: rt.session,
    revision: rt.revision,
    network: "LiteSVM local",
    platform: rt.platform.publicKey.toBase58(),
    binaryHashes: rt.vm.binaryHashes,
    presets: PRESETS,
    versions: { dbc: "1.5.13", damm: "1.5.1", vm: "0.1.0" },
  }));
  app.post("/api/preview", async (req) =>
    rt.exclusive(async () => preview(req.body).summary),
  );
  app.get<{ Params: { wallet: string } }>("/api/wallet/:wallet", async (req) =>
    rt.exclusive(async () => rt.wallet(req.params.wallet)),
  );
  app.post("/api/faucet", async (req) =>
    rt.exclusive(() => rt.faucet((req.body as any).wallet)),
  );
  app.get("/api/launches", async () => rt.exclusive(() => rt.list()));
  app.post("/api/launches/prepare", async (req) =>
    rt.exclusive(() => rt.create(req.body)),
  );
  app.get<{ Params: { id: string } }>("/api/launches/:id", async (req) =>
    rt.exclusive(() => rt.view(req.params.id)),
  );
  app.post<{ Params: { id: string } }>(
    "/api/launches/:id/resume",
    async (req) =>
      rt.exclusive(() => rt.resume(req.params.id, (req.body as any).wallet)),
  );
  app.post<{ Params: { id: string } }>("/api/launches/:id/quote", async (req) =>
    rt.exclusive(async () =>
      rt.quoteJson(await rt.quote(req.params.id, req.body)),
    ),
  );
  app.post<{ Params: { id: string } }>("/api/launches/:id/swap", async (req) =>
    rt.exclusive(() => rt.swap(req.params.id, req.body)),
  );
  app.post<{ Params: { id: string } }>(
    "/api/launches/:id/migrate",
    async (req) => rt.exclusive(() => rt.migrate(req.params.id)),
  );
  app.post("/api/transactions/send", async (req) =>
    rt.exclusive(() => {
      const b = req.body as any;
      if (typeof b.transaction !== "string" || b.transaction.length > 10000)
        throw new ApiError(400, "Invalid transaction.");
      return rt.submit(b.id, b.transaction, b.session);
    }),
  );
  app.get<{ Params: { id: string } }>("/api/launches/:id/export", async (req) =>
    rt.exclusive(async () => rt.export(req.params.id)),
  );
  app.get<{ Params: { id: string } }>(
    "/api/launches/:id/receipts",
    async (req) => rt.receipts.filter((r) => r.launchId === req.params.id),
  );
  app.get<{ Params: { id: string } }>("/metadata/:id.json", async (req) => {
    const l = rt.launches.get(req.params.id);
    if (!l) throw new ApiError(404, "Metadata not found.");
    return {
      name: l.name,
      symbol: l.symbol,
      description: l.description,
      image: l.image ? `${API_ORIGIN}/images/${l.id}` : undefined,
      external_url: l.link,
      attributes: [{ trait_type: "Network", value: "Local LiteSVM" }],
    };
  });
  app.get<{ Params: { id: string } }>("/images/:id", async (req, reply) => {
    const img = rt.launches.get(req.params.id)?.image;
    if (!img) throw new ApiError(404, "Image not found.");
    const [header, data] = img.split(",");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply
      .type(header.split(":")[1].split(";")[0])
      .send(Buffer.from(data, "base64"));
  });
  const dist = resolve(__dirname, "../../web/dist");
  app.get("/*", async (req, reply) => {
    if (req.url.startsWith("/api/"))
      throw new ApiError(404, "Endpoint not found.");
    const path = resolve(
      dist,
      decodeURIComponent(req.url.split("?")[0]).replace(/^\//, ""),
    );
    if (path !== dist && !path.startsWith(dist + sep))
      throw new ApiError(403, "Invalid path.");
    const file =
      existsSync(path) && extname(path) ? path : resolve(dist, "index.html");
    if (!existsSync(file))
      return reply.code(404).send({
        error:
          "The frontend has not been built. Run npm run dev or npm run build.",
      });
    const mime: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".woff2": "font/woff2",
    };
    return reply
      .type(mime[extname(file)] ?? "application/octet-stream")
      .send(readFileSync(file));
  });
  return { app, rt };
}
