import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const appSource = await readFile(resolve(root, 'src/http/app.ts'), 'utf8');
const snapshot = await readJson('frontend/contracts/backend-routes.json');
const frontend = await readJson('frontend/contracts/frontend-contracts.json');
const sse = await readJson('frontend/contracts/sse-events.json');

const mounts = new Map();
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
    discovered.push(`${match[2].toUpperCase()} ${path}`);
  }
}

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

if (removed.length || added.length || duplicates.length || invalidContracts.length || duplicateContractIds.length || missingSse.length) {
  console.error('Frontend contract snapshot check failed.');
  if (removed.length) console.error('\nRemoved or changed routes:\n' + removed.map((x) => `  - ${x}`).join('\n'));
  if (added.length) console.error('\nUndocumented routes:\n' + added.map((x) => `  + ${x}`).join('\n'));
  if (duplicates.length) console.error('\nDuplicate route records:\n' + duplicates.map((x) => `  * ${x}`).join('\n'));
  if (invalidContracts.length) console.error(`\nInvalid frontend contracts: ${invalidContracts.length}`);
  if (duplicateContractIds.length) console.error('\nDuplicate contract ids:\n' + duplicateContractIds.join('\n'));
  if (missingSse.length) console.error('\nMissing required SSE declarations:\n' + missingSse.join('\n'));
  process.exitCode = 1;
} else {
  const counts = Object.fromEntries(frontend.statuses.map((status) => [status, 0]));
  for (const contract of frontend.contracts) counts[contract.status] += 1;
  console.log(`Contract snapshot OK: ${expected.length} backend routes, ${frontend.contracts.length} frontend contracts.`);
  console.log(counts);
}
