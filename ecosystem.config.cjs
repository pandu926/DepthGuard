module.exports = {
  apps: [
    {
      name: "depthguard",
      cwd: __dirname,
      script: "web/scripts/serve.mjs",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      restart_delay: 3000,
      kill_timeout: 12000,
      time: true,
      env: {
        NODE_ENV: "production",
        DEPTHGUARD_WEB_HOST: process.env.DEPTHGUARD_WEB_HOST || "127.0.0.1",
        DEPTHGUARD_WEB_PORT: process.env.DEPTHGUARD_WEB_PORT || "8790",
        DEPTHGUARD_BACKEND_URL: "http://127.0.0.1:8800",
      },
    },
  ],
};
