import { spawn } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);

async function hasRunningCodeHarness() {
  try {
    const response = await globalThis.fetch(`http://${host}:${port}/api/health`, {
      signal: globalThis.AbortSignal.timeout(1_000)
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.service === 'codeharness-backend';
  } catch {
    return false;
  }
}

if (await hasRunningCodeHarness()) {
  if (process.env.CODEHARNESS_REUSE_BACKEND === 'true') {
    console.warn(`CodeHarness backend is already running at http://${host}:${port}; reusing it`);
    process.exit(0);
  }
  console.error(
    `CodeHarness backend is already running at http://${host}:${port}. Stop it before starting ` +
      'this checkout, or set CODEHARNESS_REUSE_BACKEND=true to reuse it explicitly.'
  );
  process.exit(1);
}

const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
const child = spawn(process.execPath, [tsxCli, 'watch', 'backend/src/server.ts'], {
  cwd: process.cwd(),
  stdio: 'inherit'
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}

child.once('error', (error) => {
  console.error('Failed to start CodeHarness backend watcher', error);
  process.exitCode = 1;
});

child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
