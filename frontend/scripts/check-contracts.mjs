import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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

if (removed.length || added.length || duplicates.length || invalidContracts.length || duplicateContractIds.length || missingSse.length || mispointed.length) {
  console.error('Frontend contract snapshot check failed.');
  if (removed.length) console.error('\nRemoved or changed routes:\n' + removed.map((x) => `  - ${x}`).join('\n'));
  if (added.length) console.error('\nUndocumented routes:\n' + added.map((x) => `  + ${x}`).join('\n'));
  if (duplicates.length) console.error('\nDuplicate route records:\n' + duplicates.map((x) => `  * ${x}`).join('\n'));
  if (invalidContracts.length) console.error(`\nInvalid frontend contracts: ${invalidContracts.length}`);
  if (duplicateContractIds.length) console.error('\nDuplicate contract ids:\n' + duplicateContractIds.join('\n'));
  if (missingSse.length) console.error('\nMissing required SSE declarations:\n' + missingSse.join('\n'));
  if (mispointed.length) {
    console.error(`\nRoute sources that no longer point at their registration (${mispointed.length}):\n`
      + mispointed.map((x) => `  - ${x}`).join('\n'));
  }
  process.exitCode = 1;
} else {
  const counts = Object.fromEntries(frontend.statuses.map((status) => [status, 0]));
  for (const contract of frontend.contracts) counts[contract.status] += 1;
  console.log(`Contract snapshot OK: ${expected.length} backend routes, ${frontend.contracts.length} frontend contracts.`);
  console.log(counts);
}
