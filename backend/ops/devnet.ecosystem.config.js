// PM2 keeps the isolated devnet stack alive after browser acceptance.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const env = JSON.parse(
  fs.readFileSync(path.join(root, ".local/devnet/runtime-env.json")),
);
if (env.SOLANA_CLUSTER !== "devnet" || env.BIND_ADDRESS !== "127.0.0.1:8812")
  throw Error("Invalid isolated devnet runtime");
const common = {
  cwd: root,
  autorestart: true,
  restart_delay: 3000,
  kill_timeout: 45000,
  env,
};
module.exports = {
  apps: [
    {
      ...common,
      name: "depthguard-devnet-api",
      script: "backend/target/debug/depthguard-api",
      interpreter: "none",
    },
    {
      ...common,
      name: "depthguard-devnet-worker",
      script: "backend/target/debug/depthguard-worker",
      interpreter: "none",
    },
    {
      ...common,
      name: "depthguard-devnet-web",
      script: "web/scripts/serve.mjs",
      env: {
        ...env,
        DEPTHGUARD_BACKEND_URL: "http://127.0.0.1:8812",
        DEPTHGUARD_WEB_PORT: "5176",
        DEPTHGUARD_WEB_HOST: env.DEPTHGUARD_WEB_HOST || "127.0.0.1",
      },
    },
  ],
};
