/**
 * Settings depth and bulk export — Prompts 1.18 and 1.20.
 *
 * These routes are all validation and persistence, which is exactly where a
 * plausible-looking handler goes wrong quietly: a rejected field that is
 * silently ignored, an "unset" that stores an empty string, a cap of zero that
 * locks the user out of their own machine. So every case here drives real HTTP
 * and then asks the database or the settings accessor what actually landed,
 * rather than trusting the response echo.
 *
 * The bulk export cases assert the *empty* selection hardest. An export with
 * nothing in it is the one a user is most likely to mistake for a broken
 * feature, and a 404 would confirm that suspicion wrongly — see the reasoning in
 * `services/export/bulk.ts`.
 */

import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import { cleanupHome, freshDb } from './helpers.ts';

import type { Server } from 'node:http';

const { getDb } = await import('../src/db/adapter.ts');
const {
  CAPABILITIES,
  capabilityToggles,
  dailySpendCapUsd,
  isCapabilityOn,
  responsePreferences,
  subagentCountLimit,
  taskIterationCeiling,
  taskTokenCeiling,
  toolAccessMode,
} = await import('../src/db/settings.ts');
const { assertCapability } = await import('../src/services/limits/capabilities.ts');
const { createChat, appendMessage } = await import('../src/db/chats.ts');

let server: Server;
let base: string;

before(async () => {
  await freshDb();
  const { createApp } = await import('../src/http/app.ts');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo from listen(0)');
  }
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupHome();
});

async function put(path: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

/** Rows in `settings` for a key — the authority on "was it stored or cleared". */
function settingRowCount(key: string): number {
  const row = getDb()
    .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM settings WHERE key = ? AND value IS NOT NULL')
    .get(key);
  return row?.n ?? 0;
}

describe('response preferences are stored, never injected', () => {
  test('a preference round-trips through PUT and GET', async () => {
    const saved = await put('/api/settings/preferences', { preferences: 'Be terse. British spelling.' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.preferences, 'Be terse. British spelling.');

    const res = await fetch(`${base}/api/settings/preferences`);
    const body = (await res.json()) as { preferences: string | null };
    assert.equal(body.preferences, 'Be terse. British spelling.');
    assert.equal(responsePreferences(), 'Be terse. British spelling.');
  });

  test('a blank preference clears the row instead of storing an empty string', async () => {
    await put('/api/settings/preferences', { preferences: 'something' });
    assert.equal(settingRowCount('response_preferences'), 1);

    // Whitespace only, because "   " is what a user leaves behind when they
    // select-all-and-delete in a textarea.
    const cleared = await put('/api/settings/preferences', { preferences: '   ' });
    assert.equal(cleared.status, 200);
    // `responsePreferences()` reports unset as '' by contract, so that is what
    // the route echoes; the absence has to be asserted where it is represented.
    assert.equal(cleared.body.preferences, '');
    // The distinction that matters: unset must not be a stored empty string,
    // or "has the user configured preferences?" gains a third answer.
    assert.equal(settingRowCount('response_preferences'), 0);
    assert.equal(responsePreferences(), '');
  });

  test('a non-string preference is rejected by name', async () => {
    const res = await put('/api/settings/preferences', { preferences: 42 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'bad_request');
    assert.equal(res.body.error.details?.field, 'preferences');
  });
});

describe('capability toggles are all-or-nothing', () => {
  test('GET reports both the raw toggle and its effective value', async () => {
    const res = await fetch(`${base}/api/settings/capabilities`);
    const body = (await res.json()) as {
      capabilities: Record<string, boolean>;
      effective: Record<string, boolean>;
    };

    assert.equal(res.status, 200);
    // Every known capability appears in both maps, so the UI never has to treat
    // a missing key as a third state.
    for (const capability of CAPABILITIES) {
      assert.equal(typeof body.capabilities[capability], 'boolean', capability);
      assert.equal(typeof body.effective[capability], 'boolean', capability);
    }
  });

  test('one unknown name rejects the whole batch, changing nothing', async () => {
    const before = capabilityToggles();
    const target = CAPABILITIES[0];
    assert.ok(target !== undefined);

    const res = await put('/api/settings/capabilities', {
      capabilities: { [target]: !before[target], not_a_capability: true },
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'bad_request');
    assert.equal(res.body.error.details?.field, 'capabilities.not_a_capability');
    // The valid toggle in the same request must not have been applied. A partial
    // write here would leave the UI showing a state the user never chose.
    assert.equal(capabilityToggles()[target], before[target]);
  });

  test('a non-boolean value is rejected and names the offending capability', async () => {
    const target = CAPABILITIES[0];
    assert.ok(target !== undefined);

    const res = await put('/api/settings/capabilities', {
      capabilities: { [target]: 'yes' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details?.field, `capabilities.${target}`);
  });

  test('an empty or non-object capabilities field is rejected', async () => {
    for (const payload of [{ capabilities: {} }, { capabilities: [] }, {}]) {
      const res = await put('/api/settings/capabilities', payload);
      assert.equal(res.status, 400, JSON.stringify(payload));
      assert.equal(res.body.error.details?.field, 'capabilities');
    }
  });

  test('a valid batch applies and reports which names changed', async () => {
    const target = CAPABILITIES[0];
    assert.ok(target !== undefined);
    const next = !capabilityToggles()[target];

    const res = await put('/api/settings/capabilities', { capabilities: { [target]: next } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.updated, [target]);
    assert.equal(capabilityToggles()[target], next);
  });
});

/**
 * `web_research` is the one capability most likely to be "tidied" into a
 * sub-toggle of `code_execution` later, on the reasoning that both reach the
 * network. These cases exist to make that change fail loudly: research goes
 * through a supervised MCP server, not an arbitrary binary, so a research-only
 * install with shell execution switched off must keep working.
 */
describe('web research is a peer capability, not a sub-toggle', () => {
  test('it is a capability in its own right rather than an alias for egress', async () => {
    assert.ok(CAPABILITIES.includes('web_research'));
    assert.ok(CAPABILITIES.includes('network_egress'));

    const res = await fetch(`${base}/api/settings/capabilities`);
    const body = (await res.json()) as {
      capabilities: Record<string, boolean>;
      effective: Record<string, boolean>;
    };
    assert.equal(typeof body.capabilities.web_research, 'boolean');
    assert.equal(typeof body.effective.web_research, 'boolean');
  });

  test('switching code execution off leaves web research effective', async () => {
    const res = await put('/api/settings/capabilities', {
      capabilities: { code_execution: false, web_research: true },
    });
    assert.equal(res.status, 200);

    const after = await fetch(`${base}/api/settings/capabilities`);
    const body = (await after.json()) as { effective: Record<string, boolean> };

    // The contrast is the whole point: egress collapses with execution because
    // there is nothing left to reach the network *with*, while research does not,
    // because the MCP server is still there and still supervised.
    assert.equal(body.effective.network_egress, false);
    assert.equal(body.effective.web_research, true);
    assert.equal(isCapabilityOn('web_research'), true);
  });

  test('turning it off refuses by name instead of returning nothing', async () => {
    await put('/api/settings/capabilities', { capabilities: { web_research: false } });

    // A disabled research capability must throw, not answer with an empty result
    // set — an agent that "found no sources" is indistinguishable from a broken
    // search, and the user has no way back to the switch they flipped.
    assert.throws(
      () => assertCapability('web_research'),
      (error: unknown) => {
        const err = error as { code?: string; details?: { capability?: string }; message?: string };
        assert.equal(err.code, 'capability_disabled');
        assert.equal(err.details?.capability, 'web_research');
        assert.match(String(err.message), /Web research/);
        return true;
      },
    );

    await put('/api/settings/capabilities', { capabilities: { web_research: true, code_execution: true } });
  });
});

describe('tool access mode is advisory but still validated', () => {
  test('a known mode is stored', async () => {
    const res = await put('/api/settings/tool-access-mode', { mode: 'load_when_needed' });
    assert.equal(res.status, 200);
    assert.equal(res.body.mode, 'load_when_needed');
    assert.equal(toolAccessMode(), 'load_when_needed');
  });

  test('an unknown mode is refused rather than stored for the agent to misread', async () => {
    const res = await put('/api/settings/tool-access-mode', { mode: 'whenever' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details?.field, 'mode');
    assert.equal(toolAccessMode(), 'load_when_needed');
  });

  test('a missing mode is refused by name', async () => {
    const res = await put('/api/settings/tool-access-mode', {});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details?.field, 'mode');
  });
});

describe('network egress reports enabled separately from effective', () => {
  test('the PUT reports what was asked for and what it amounts to', async () => {
    const res = await put('/api/settings/network-egress', { enabled: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    // Two fields because they answer different questions: `enabled` is what the
    // user asked for, `effective` is what the agent may actually do. Collapsing
    // them would make a dependency failure look like the toggle not working.
    assert.equal(typeof res.body.effective, 'boolean');
  });

  test('effective stays false until code execution is on too', async () => {
    await put('/api/settings/capabilities', { capabilities: { code_execution: false } });
    await put('/api/settings/network-egress', { enabled: true });

    const off = (await (await fetch(`${base}/api/settings/network-egress`)).json()) as {
      enabled: boolean;
      effective: boolean;
      requiresCodeExecution: boolean;
      enforced: string;
    };
    assert.equal(off.enabled, true);
    // The dependency, stated: egress without the ability to run a command is
    // not egress. The GET names the prerequisite so the UI can explain the gap
    // instead of showing a toggle that appears not to work.
    assert.equal(off.effective, false);
    assert.equal(off.requiresCodeExecution, true);
    // Names where enforcement lives, so nobody goes looking for a sandbox.
    assert.equal(off.enforced, 'command_prefix_match');

    await put('/api/settings/capabilities', { capabilities: { code_execution: true } });
    const on = (await (await fetch(`${base}/api/settings/network-egress`)).json()) as {
      effective: boolean;
    };
    assert.equal(on.effective, true);
  });

  test('a missing enabled flag is refused by name', async () => {
    const res = await put('/api/settings/network-egress', {});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details?.field, 'enabled');
  });
});

describe('the cost ceilings', () => {
  test('GET returns the ceilings alongside live spend', async () => {
    const res = await fetch(`${base}/api/settings/limits`);
    const body = (await res.json()) as {
      ceilings: { tokenCeiling: number; iterationCeiling: number; subagentLimit: number };
      spend: { capUsd: number | null; capReached: boolean; windowResetsAt: number };
    };

    assert.equal(res.status, 200);
    assert.equal(typeof body.ceilings.tokenCeiling, 'number');
    assert.equal(typeof body.ceilings.iterationCeiling, 'number');
    assert.equal(typeof body.ceilings.subagentLimit, 'number');
    assert.equal(body.spend.capReached, false);
    assert.ok(body.spend.windowResetsAt > 0);
  });

  test('the three ceilings persist and are reported back', async () => {
    const res = await put('/api/settings/limits', {
      tokenCeiling: 12345,
      iterationCeiling: 7,
      subagentLimit: 3,
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.updated.sort(), ['iterationCeiling', 'subagentLimit', 'tokenCeiling']);
    assert.equal(taskTokenCeiling(), 12345);
    assert.equal(taskIterationCeiling(), 7);
    assert.equal(subagentCountLimit(), 3);
  });

  test('a spend cap of zero removes the cap instead of blocking everything', async () => {
    const set = await put('/api/settings/limits', { dailySpendCapUsd: 25 });
    assert.equal(set.status, 200);
    assert.equal(dailySpendCapUsd(), 25);

    const removed = await put('/api/settings/limits', { dailySpendCapUsd: 0 });
    assert.equal(removed.status, 200);
    // Zero as "refuse all autonomous work" is not what anyone types into a cap
    // field, so it clears the row and `capUsd` goes null.
    assert.equal(dailySpendCapUsd(), null);
    assert.equal(removed.body.spend.capUsd, null);
    assert.equal(removed.body.spend.capReached, false);
  });

  test('a negative cap is refused', async () => {
    const res = await put('/api/settings/limits', { dailySpendCapUsd: -1 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details?.field, 'dailySpendCapUsd');
  });

  test('a non-positive or fractional ceiling is refused by name', async () => {
    const cases: Array<[string, unknown]> = [
      ['tokenCeiling', 0],
      ['tokenCeiling', -5],
      ['iterationCeiling', 2.5],
      ['subagentLimit', 0],
    ];

    for (const [field, value] of cases) {
      const res = await put('/api/settings/limits', { [field]: value });
      assert.equal(res.status, 400, `${field}=${String(value)}`);
      assert.equal(res.body.error.details?.field, field, `${field}=${String(value)}`);
    }

    // Unchanged from the successful case above — a rejected write stores nothing.
    assert.equal(taskTokenCeiling(), 12345);
    assert.equal(taskIterationCeiling(), 7);
    assert.equal(subagentCountLimit(), 3);
  });

  test('a request naming no limit at all is refused', async () => {
    const res = await put('/api/settings/limits', {});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'bad_request');
  });
});

describe('bulk export', () => {
  test('an empty selection is a zip with a manifest, not a 404', async () => {
    const res = await fetch(`${base}/api/export/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A window that closed before this database existed, so nothing matches.
      body: JSON.stringify({ contentType: 'chats', timeframe: { from: 1, to: 2 } }),
    });
    const buffer = Buffer.from(await res.arrayBuffer());

    assert.equal(res.status, 200);
    // "Nothing matched" is an answer, and the manifest is where it is stated.
    // A 404 would tell the user their export is broken when it worked.
    assert.match(res.headers.get('content-type') ?? '', /^application\/zip/);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="hyperion-export-.*\.zip"/);

    const summary = JSON.parse(res.headers.get('x-export-summary') ?? '{}') as {
      counts: { chats: number; artifacts: number };
      skipped: number;
    };
    assert.deepEqual(summary.counts, { chats: 0, artifacts: 0 });
    assert.equal(summary.skipped, 0);

    // A real zip, not an empty body: PK magic bytes, and MANIFEST.json inside.
    assert.equal(buffer.subarray(0, 2).toString('latin1'), 'PK');
    assert.ok(buffer.includes(Buffer.from('MANIFEST.json')));
  });

  test('a chat in range is carried and counted', async () => {
    const chat = createChat({ tool: 'chat', title: 'exported chat' });
    appendMessage({ chatId: chat.id, role: 'user', content: 'in the archive' });

    const res = await fetch(`${base}/api/export/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentType: 'chats' }),
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    const summary = JSON.parse(res.headers.get('x-export-summary') ?? '{}') as {
      counts: { chats: number };
    };

    assert.equal(res.status, 200);
    assert.ok(summary.counts.chats >= 1);
    assert.ok(buffer.length > 0);
  });

  test('an unknown contentType is refused by name', async () => {
    const res = await fetch(`${base}/api/export/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentType: 'everything' }),
    });
    const body = (await res.json()) as { error: { code: string; details?: { field?: string } } };

    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'bad_request');
    assert.equal(body.error.details?.field, 'contentType');
  });

  test('a malformed timeframe is refused rather than silently ignored', async () => {
    for (const timeframe of ['last week', [1, 2]]) {
      const res = await fetch(`${base}/api/export/bulk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeframe }),
      });
      const body = (await res.json()) as { error: { details?: { field?: string } } };

      assert.equal(res.status, 400, JSON.stringify(timeframe));
      // Ignoring it would export the user's entire history when they asked for
      // one week — the kind of surprise that is only noticed after sharing it.
      assert.equal(body.error.details?.field, 'timeframe');
    }
  });

  test('an omitted body exports everything rather than failing', async () => {
    const res = await fetch(`${base}/api/export/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^application\/zip/);
  });
});
