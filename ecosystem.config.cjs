// Standalone checkouts only; ports match the kernel deploy configs (refs #2518).
const path = process.getBuiltinModule('node:path');
const os = process.getBuiltinModule('node:os');

function eventsApp(target, port) {
  const name = `${target}-events`;
  const cwd = path.join(os.homedir(), target, 'events');
  const logDir = path.join(os.homedir(), '.pm2', 'logs');
  return {
    name,
    cwd,
    // Exec the listener, not an npm/pnpm wrapper that can orphan next-server.
    script: 'scripts/start.ts',
    interpreter: 'node',
    node_args: `--import=tsx --env-file=${path.join(cwd, '.env.local')}`,
    exec_mode: 'fork',
    env: { PORT: port, NODE_ENV: 'production' },
    out_file: path.join(logDir, `${name}-out.log`),
    error_file: path.join(logDir, `${name}-error.log`),
    time: true,
    max_restarts: 10,
    min_uptime: '20s',
    kill_timeout: 15000,
  };
}

module.exports = {
  apps: [eventsApp('dev', 3006), eventsApp('prod', 7006)],
};
