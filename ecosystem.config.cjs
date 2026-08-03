/**
 * PM2 process definition for the Hyperion backend.
 *
 * The server is meant to run continuously in the background (XAMPP-style),
 * not be started by hand each session.
 *
 *   npm install -g pm2
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * Start-on-boot:
 *   Linux/macOS:  pm2 startup     (then run the command it prints)
 *   Windows:      npm i -g pm2-windows-startup && pm2-startup install
 *
 * Node 26 runs TypeScript directly (type-stripping), so there is no build
 * step and PM2 points straight at the entrypoint.
 */
module.exports = {
  apps: [
    {
      name: 'hyperion',
      script: 'src/index.ts',
      interpreter: 'node',
      cwd: __dirname,

      // Single instance: the app enforces a single-active-job lock in process
      // memory, and SQLite is opened for writing. Clustering would break both.
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      watch: false,

      // If the process dies 10 times inside a minute it is crash-looping;
      // back off rather than hammering the machine.
      max_restarts: 10,
      min_uptime: '60s',
      restart_delay: 2000,
      exp_backoff_restart_delay: 250,

      max_memory_restart: '1G',

      // Let in-flight SSE streams and the DB close cleanly on restart.
      kill_timeout: 8000,

      env: {
        NODE_ENV: 'production',
      },

      out_file: 'logs/hyperion-out.log',
      error_file: 'logs/hyperion-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
