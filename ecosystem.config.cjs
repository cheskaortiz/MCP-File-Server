// PM2 process file for the HTTP server. Run `npm run build` first.
// Secrets are NOT stored here: the server reads MCP_AUTH_TOKEN etc. from ./.env (cwd below).
module.exports = {
  apps: [
    {
      name: "mcp-file-server",
      script: "dist/httpServer.js",
      cwd: __dirname,
      // One process only: the per-file locks and if_version checks are per process.
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 2000,
      max_memory_restart: "300M",
      kill_timeout: 5000, // matches the 5 s graceful-shutdown window in src/httpServer.ts
      time: true,
      merge_logs: true,
      out_file: "logs/pm2-out.log",
      error_file: "logs/pm2-error.log",
      env: { NODE_ENV: "production" },
    },
  ],
};
