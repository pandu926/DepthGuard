import { API_PORT, API_ORIGIN, API_HOST } from "./config";
import { createApp } from "./app";
createApp()
  .then(async ({ app, rt }) => {
    await app.listen({ host: API_HOST, port: API_PORT });
    console.log(`DepthGuard VM ready: ${API_ORIGIN} · session ${rt.session}`);
    console.log("Local fixture execution only. Restart resets market state.");
  })
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
