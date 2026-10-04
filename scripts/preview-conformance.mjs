#!/usr/bin/env node
/**
 * Serve the preview-conformance fixture the way the real preview listener does.
 *
 * This is deliberately **not** production code and not part of `src/`: it is the
 * owner's tool for answering one question in a real browser — under the CSP
 * `sandbox` the preview sends, does `'self'` match, or is the explicit origin
 * doing all the work? The fixture page states its expectations per row, and the
 * outcome is recorded in `.hyperion/coordination/decisions.md`.
 *
 * It stands up the real listener, mints through the real service and lets the
 * real path seam resolve every request. What it does not do is boot the API or
 * touch the user's data: everything happens in a throwaway `HYPERION_HOME` under
 * the system temp directory, which is why the environment is set before anything
 * under `src/` is imported.
 *
 * Usage: `node scripts/preview-conformance.mjs`
 *
 * Options, for the case where something in front of this process maps a known
 * public port (a reverse proxy, a tunnel, a hosted sandbox):
 *
 *   --port <n>     listen on that port instead of a free one
 *   --bind <host>  bind that address instead of HYPERION_BIND (0.0.0.0 when a
 *                  proxy in front of the process connects from outside it)
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const fixture = path.join(repoRoot, 'test', 'fixtures', 'preview-conformance');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-conformance-'));
process.env.NODE_ENV = 'test';
process.env.HYPERION_HOME = home;
process.env.HYPERION_LOG_LEVEL = 'info';
process.env.HYPERION_BIND = '127.0.0.1';

const { ensureDirectories } = await import('../src/config/env.ts');
ensureDirectories();

const { provisionWorktree } = await import('../src/services/code/worktree.ts');
const { mintPreview, DEFAULT_TTL_MS } = await import('../src/services/code/preview.ts');
const { startPreviewServer, previewReady, stopPreviewServer } = await import(
  '../src/http/previewServer.ts'
);

// The task's workspace, inside the throwaway home: a copy, so a browser writing
// nothing back cannot matter and the fixture in the repository stays pristine.
const workspace = path.join(home, 'projects', 'preview-conformance');
fs.mkdirSync(workspace, { recursive: true });
fs.cpSync(fixture, workspace, { recursive: true });

const worktree = await provisionWorktree('preview-conformance', workspace);
if (!fs.existsSync(path.join(worktree.dir, 'index.html'))) {
  throw new Error(`the fixture was not copied into ${worktree.dir}`);
}

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const portFlag = flag('--port');
const bind = flag('--bind');

// A free port, taken the way the tests take one: `0` is the *disabled* value
// for HYPERION_PREVIEW_PORT, so "pick one for me" is not something the listener
// offers — deliberately, because that would make a misconfiguration look like a
// working preview. `--port` is for when the caller already knows which port
// something in front of this process will map.
const port =
  portFlag === undefined
    ? await new Promise((resolve, reject) => {
        const probe = http.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
          const address = probe.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('no port'));
            return;
          }
          const { port: free } = address;
          probe.close(() => resolve(free));
        });
      })
    : Number(portFlag);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`--port needs a whole port number in 1-65535, not "${String(portFlag)}".`);
  process.exit(1);
}

startPreviewServer({ port, ...(bind === undefined ? {} : { host: bind }) });
const listener = await previewReady();
if (!listener.running) {
  console.error(`The preview listener did not start: ${listener.reason ?? 'unknown reason'}`);
  process.exitCode = 1;
} else {
  const minted = mintPreview(worktree.taskId, { host: listener.host, port: listener.port });

  console.log('');
  console.log('  Open this URL in a real browser:');
  console.log('');
  console.log(`    ${minted.url}`);
  console.log('');
  console.log(`  (a tab, and then inside the app's preview panel if the app is running)`);
  console.log(`  Token expires at ${new Date(minted.expiresAt).toISOString()} (${DEFAULT_TTL_MS / 60000} minutes)`);
  console.log(`  Workspace: ${workspace}`);
  console.log('');
  console.log('  Row 1 external .js        expected: runs');
  console.log('  Row 2 module script       expected: runs');
  console.log('  Row 3 fetch data.json     expected: 200, parsed');
  console.log('  Row 4 image pixel.png     expected: loads 1x1');
  console.log('  Row 5 inline script       expected: runs');
  console.log('  Row 6 localStorage        expected: blocked (SecurityError)');
  console.log('  Row 7 postMessage parent  expected: posted');
  console.log('');
  console.log('  Record the outcome in .hyperion/coordination/decisions.md, e.g.:');
  console.log('');
  console.log('    | browser | 1 | 2 | 3 | 4 | 5 | 6 | 7 | reading |');
  console.log('    | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  console.log('    | <name + version> | runs | runs | 200 | 1x1 | runs | blocked | posted | <self or explicit origin did the work> |');
  console.log('');
  console.log('  Press Ctrl+C to stop the listener.');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopPreviewServer();
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(0);
  });
}
