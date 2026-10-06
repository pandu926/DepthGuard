import { spawn } from "node:child_process";
const children = [
  spawn(
    process.execPath,
    ["node_modules/ts-node/dist/bin.js", "server/src/index.ts"],
    { stdio: "inherit" },
  ),
  spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--config", "web/vite.config.mjs"],
    { stdio: "inherit" },
  ),
];
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
};
for (const c of children)
  c.on("exit", (code) => {
    stop();
    process.exitCode = code ?? 0;
  });
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
