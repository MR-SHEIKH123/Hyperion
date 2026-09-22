import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// `--fix` rewrites the snapshot's `source` pointers from the same discovery pass
// the check uses, for the recurring case the comparison cannot avoid: a route file
// gains lines above a registration and every pointer below it drifts. Pointers are
// derived data, so regenerating them is not a review decision — the check stays the
// authority, and a `--fix` run still reports what it rewrote.
const fix = process.argv.includes('--fix');

const root = resolve(import.meta.dirname, '../..');
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const appSource = await readFile(resolve(root, 'src/http/app.ts'), 'utf8');
const snapshot = await readJson('frontend/contracts/backend-routes.json');
const frontend = await readJson('frontend/contracts/frontend-contracts.json');
const sse = await readJson('frontend/contracts/sse-events.json');

const mounts = new Map();
const discoveredSources = new Map();
for (const match of appSource.matchAll(/app\.use\('([^']+)',\s*(\w+Router)\)/g)) {
  mounts.set(match[2], match[1]);
}

const discovered = [];
const files = [...new Set(snapshot.routes.map((route) => route.source.split(':')[0]))];
for (const file of files) {
  const source = await readFile(resolve(root, file), 'utf8');
  const routePattern = /(\w+Router)\.(get|post|put|patch|delete)\s*\(\s*(['"])(.*?)\3/gs;
  for (const match of source.matchAll(routePattern)) {
    const mount = mounts.get(match[1]);
    if (!mount) continue;
    const localPath = match[4];
    const path = localPath === '/' ? mount : `${mount.replace(/\/$/, '')}/${localPath.replace(/^\//, '')}`;
    const key = `${match[2].toUpperCase()} ${path}`;
    discovered.push(key);
    // The line the *registration* starts on, so the snapshot's pointer can be
    // compared against it. Multi-line registrations are normal here (the path
    // literal often sits on the line after `router.get(`), which is why the
    // comparison uses this line rather than looking for the path on it.
    discoveredSources.set(key, `${file}:${source.slice(0, match.index).split('\n').length}`);
  }
}

/**
 * The snapshot's `source` is `file:line`, and it is meant to point at the route's
 * own registration — it is how a reader jumps from the contract to the handler.
 *
 * Nothing checked it, and by 2026-09-21 **92 of 180** entries pointed somewhere
 * else: any file that had lines inserted above a route drifted, silently, because
 * the only thing compared here was the *set* of routes. A pointer that lands in the
 * middle of an unrelated function is worse than no pointer.
 *
 * The comparison is against the same discovery pass the route set comes from, so
 * the two cannot disagree: a source is right when it names the file and the line
 * where `router.verb(` starts for that method and path. Multi-line registrations
 * need no special case, because the recorded line is the one the registration
 * starts on either way.
 */
const mispointed = snapshot.routes
  .map((route) => {
    const expectedSource = discoveredSources.get(`${route.method} ${route.path}`);
    if (expectedSource === undefined) return undefined; // reported as a removed/changed route
    if (route.source === expectedSource) return undefined;
    return `${route.method} ${route.path} — ${route.source} should be ${expectedSource}`;
  })
  .filter((entry) => entry !== undefined);

const expected = snapshot.routes.map((route) => `${route.method} ${route.path}`);
const expectedSet = new Set(expected);
const discoveredSet = new Set(discovered);
const removed = expected.filter((route) => !discoveredSet.has(route));
const added = discovered.filter((route) => !expectedSet.has(route));
const duplicates = expected.filter((route, index) => expected.indexOf(route) !== index);

/**
 * The status of every contract is a claim, and until now nothing checked it.
 *
 * `frontend-contracts.json` is hand-curated — the check verified its *shape* (a
 * known status string, no duplicate ids) and the route snapshot beside it, but
 * never asked whether a row's status was still true. Two rows had drifted while
 * the gate stayed green: `artifacts.lineage` named a path that does not exist while
 * its own reason documented the real one, and `settings.reload` was the only
 * mismatch row with no reason for the mismatch. Four facts are mechanically
 * decidable from the two snapshots, so they are checked rather than trusted:
 *
 * - `implemented` means a client calls a real route, so the route must exist.
 * - `route-mismatch` means the specification and the implementation disagree,
 *   which needs an implementation: the recorded `expectedPath` must exist.
 * - a mismatch must say *what* it is measured against (`specifiedPath`) and why
 *   (`reason`), and the two paths must actually differ — a row whose specified
 *   path is its implemented path is not describing a mismatch at all.
 * - `specifiedPath` belongs to a mismatch: carrying it on an `implemented` or
 *   `missing` row would leave two answers to "which path is this?".
 * - **`implemented` also means a client calls it** — the same sentence the first
 *   rule is the first half of. Until 2026-09-22 only the route half was checked,
 *   and four rows were wrong about the client half: `providers.zdr`,
 *   `plugins.unified`, `plugins.availability` and `design.preview` all named a real
 *   route that no frontend module calls. The Plugins rows had no client and no
 *   screen, the ZDR row had no write gesture anywhere in the app, and the Design
 *   preview row has no Design surface to render one in.
 *
 * `{tool}` is expanded the way the API-coverage check expands it, because the
 * three agent tools share one contract each.
 */
const routeExists = (method, path) =>
  ['code', 'cowork', 'design']
    .map((tool) => `${method} ${path.replaceAll('{tool}', tool)}`)
    .some((route) => expectedSet.has(route));

/**
 * The client half of `implemented`, checked against the frontend's own source.
 *
 * Two things make this matcher looser than a path comparison, and both are how the
 * clients are actually written rather than conveniences:
 *
 *   - **A parameter matches anything inside one segment.** The clients are template
 *     literals: `request(`/api/chat/${encodeURIComponent(chatId)}/messages`)`, where
 *     `:id` stands for an expression rather than an identifier.
 *   - **The tool segment may be an interpolation.** `api/tasks.ts` writes
 *     `/api/${tool}/tasks/${encodeURIComponent(taskId)}/state`, while the ledger's
 *     rows spell the tool out (one row per tool, because that is what the backend
 *     mounts). A row whose path begins `/api/<tool>/` therefore also matches the
 *     interpolated form.
 *
 * Test files are excluded: a test that asserts a path is not a client, and
 * counting one would let a row pass on the strength of its own assertion. The
 * method is not compared — a client for the same path with a different verb
 * satisfies the check — and that is stated here rather than discovered later: this
 * check can prove no client exists, not that the right one does.
 */
const pathSegmentPattern = "[^/`']*";

function clientPatterns(path) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withParams = escaped.replace(/:[A-Za-z_]+/g, pathSegmentPattern);
  const patterns = [withParams];
  for (const tool of ['code', 'cowork', 'design']) {
    const literal = `/api/${tool}/`;
    if (path.startsWith(literal)) {
      patterns.push(withParams.replace(literal, `/api/(?:\\$\\{[^}]*\\}|${tool})/`));
    }
  }
  return patterns.map((pattern) => new RegExp(pattern));
}

const frontendFiles = [];
const walkFrontend = async (dir) => {
  for (const entry of await readdir(resolve(root, dir), { withFileTypes: true })) {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walkFrontend(child);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) frontendFiles.push(child);
  }
};
await walkFrontend('frontend/src');
const frontendSources = await Promise.all(
  frontendFiles.map((file) => readFile(resolve(root, file), 'utf8')),
);

const hasClient = (contract) =>
  clientPatterns(contract.expectedPath).some((pattern) =>
    frontendSources.some((source) => pattern.test(source)),
  );

const statusProblems = [];
for (const contract of frontend.contracts) {
  const where = `${contract.id} (${contract.status})`;
  if (contract.status === 'implemented') {
    if (!routeExists(contract.method, contract.expectedPath)) {
      statusProblems.push(
        `${where} claims an implemented route that does not exist: ${contract.method} ${contract.expectedPath}`,
      );
    } else if (!hasClient(contract)) {
      // Only reported when the route is real: a row naming a path that was never
      // built has one problem, and it is the path.
      statusProblems.push(
        `${where} claims a client calls it, and no frontend module does: ${contract.method} ${contract.expectedPath}`,
      );
    }
  }
  if (contract.status === 'route-mismatch') {
    if (!routeExists(contract.method, contract.expectedPath)) {
      statusProblems.push(
        `${where} is a mismatch, so its own path must exist: ${contract.method} ${contract.expectedPath}`,
      );
    }
    if (typeof contract.specifiedPath !== 'string' || contract.specifiedPath.trim() === '') {
      statusProblems.push(`${where} does not say what the specification asked for (specifiedPath)`);
    } else if (contract.specifiedPath === contract.expectedPath) {
      statusProblems.push(
        `${where} records the same path as specified and implemented, which is not a mismatch: ${contract.specifiedPath}`,
      );
    }
    if (typeof contract.reason !== 'string' || contract.reason.trim() === '') {
      statusProblems.push(`${where} does not say why the two paths differ (reason)`);
    }
  } else if (contract.specifiedPath !== undefined) {
    statusProblems.push(`${where} carries a specifiedPath without the route-mismatch status`);
  }
}

const allowedStatuses = new Set(frontend.statuses);
const invalidContracts = frontend.contracts.filter(
  (contract) => !contract.id || !contract.method || !contract.expectedPath || !allowedStatuses.has(contract.status),
);
const duplicateContractIds = frontend.contracts
  .map((contract) => contract.id)
  .filter((id, index, ids) => ids.indexOf(id) !== index);

const chatEvents = new Set(sse.protocols?.chat?.events ?? []);
const agentChannels = new Set(sse.protocols?.agent?.channels ?? []);
const requiredChatEvents = ['open', 'token', 'paused', 'resumed', 'usage', 'done', 'error'];
const requiredAgentChannels = ['started', 'partial', 'approval_required', 'task_parked', 'stopped', 'result'];
const missingSse = [
  ...requiredChatEvents.filter((event) => !chatEvents.has(event)).map((event) => `chat:${event}`),
  ...requiredAgentChannels.filter((event) => !agentChannels.has(event)).map((event) => `agent:${event}`),
];

// `--fix` clears the pointer complaint by regenerating it; the other checks still
// fail the run, because none of them is derived data.
if (fix && mispointed.length > 0) {
  for (const route of snapshot.routes) {
    const expectedSource = discoveredSources.get(`${route.method} ${route.path}`);
    if (expectedSource !== undefined) route.source = expectedSource;
  }
  await writeFile(
    resolve(root, 'frontend/contracts/backend-routes.json'),
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );
  console.log(`Rewrote ${mispointed.length} route source pointer(s):`);
  for (const entry of mispointed) console.log(`  ${entry}`);
}

const stalePointers = fix ? [] : mispointed;

if (removed.length || added.length || duplicates.length || invalidContracts.length || duplicateContractIds.length || missingSse.length || stalePointers.length || statusProblems.length) {
  console.error('Frontend contract snapshot check failed.');
  if (removed.length) console.error('\nRemoved or changed routes:\n' + removed.map((x) => `  - ${x}`).join('\n'));
  if (added.length) console.error('\nUndocumented routes:\n' + added.map((x) => `  + ${x}`).join('\n'));
  if (duplicates.length) console.error('\nDuplicate route records:\n' + duplicates.map((x) => `  * ${x}`).join('\n'));
  if (invalidContracts.length) console.error(`\nInvalid frontend contracts: ${invalidContracts.length}`);
  if (duplicateContractIds.length) console.error('\nDuplicate contract ids:\n' + duplicateContractIds.join('\n'));
  if (missingSse.length) console.error('\nMissing required SSE declarations:\n' + missingSse.join('\n'));
  if (statusProblems.length) {
    console.error(
      `\nContracts whose declared status the tree contradicts (${statusProblems.length}):\n`
      + statusProblems.map((x) => `  - ${x}`).join('\n')
      + '\n  (a status is a review decision, so `--fix` does not rewrite it)',
    );
  }
  if (stalePointers.length) {
    console.error(`\nRoute sources that no longer point at their registration (${stalePointers.length}):\n`
      + stalePointers.map((x) => `  - ${x}`).join('\n')
      + '\n  (run `node scripts/check-contracts.mjs --fix` to rewrite them)');
  }
  process.exitCode = 1;
} else {
  const counts = Object.fromEntries(frontend.statuses.map((status) => [status, 0]));
  for (const contract of frontend.contracts) counts[contract.status] += 1;
  console.log(`Contract snapshot OK: ${expected.length} backend routes, ${frontend.contracts.length} frontend contracts.`);
  console.log(counts);
}
