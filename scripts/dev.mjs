import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['server/index.mjs'], { stdio: 'inherit', env: { ...process.env, APP_ORIGIN: 'http://localhost:4323' } }),
  spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['exec', 'vite'], { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' }),
];

const stop = () => {
  for (const child of children) if (!child.killed) child.kill();
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => {
  if (code && code !== 0) process.exitCode = code;
  stop();
});
