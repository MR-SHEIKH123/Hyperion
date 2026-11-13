import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Script } from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  CONSOLE_ARG_CAP,
  CONSOLE_KINDS,
  CONSOLE_MESSAGE_CAP,
  CONSOLE_SOURCE,
} from './consoleShim';

/**
 * The backend↔frontend drift test.
 *
 * The wire contract is defined once — by the string the preview listener
 * injects into served HTML — and enforced on the receiving side by the gate
 * in `consoleShim.ts`. Nothing but this test connects the two: if the
 * backend re-tags the messages, tightens a bound, or drops a kind, the tab
 * would go quietly silent (or start rejecting everything). This reads the
 * backend source and fails first.
 *
 * Precedent: `src/contracts/wire/common.test.ts` parses `src/util/errors.ts`
 * the same way for the API error envelope.
 */
describe('the injected shim and the frontend gate agree', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../../../../src/http/previewServer.ts'),
    'utf8',
  );

  const match = /export const PREVIEW_CONSOLE_SHIM = `([\s\S]*?)`;/.exec(source);
  it('finds the shim in the preview listener', () => {
    expect(match).not.toBeNull();
  });
  const shim = match?.[1] ?? '';

  it('carries the same tag, bounds and kinds the frontend enforces', () => {
    expect(shim).toContain(`source="${CONSOLE_SOURCE}"`);
    expect(shim).toContain(`const cap=${CONSOLE_ARG_CAP}`);
    expect(shim).toContain(`const max=${CONSOLE_MESSAGE_CAP}`);
    expect(shim).toContain(`const kinds=[${CONSOLE_KINDS.map((kind) => `"${kind}"`).join(',')}]`);
  });

  it('is valid JavaScript — a broken shim parses but never runs', () => {
    // The old PR shipped a template-literal slip that made the whole injected
    // script a SyntaxError; its tests asserted on patterns and never noticed.
    // `Script` compiles without running — a parse failure throws here.
    expect(() => new Script(shim)).not.toThrow();
  });

  it('injects only into HTML, on the content-type the listener serves HTML as', () => {
    expect(source).toContain("if (type === 'text/html; charset=utf-8') bytes = injectPreviewConsoleShim(bytes);");
    // The HTML content type itself lives in the table above the injector.
    expect(source).toMatch(/html:\s*'text\/html; charset=utf-8'/);
  });
});
