#!/usr/bin/env node
/**
 * Real-browser runner for test/fixtures/preview-conformance.
 *
 * First copy that fixture into an active Code task and mint its preview URL,
 * then run:
 *   node scripts/preview-conformance.mjs http://127.0.0.1:4320/p/<token>/
 *
 * Playwright is deliberately not a production dependency. Run this in an
 * environment that already provides `playwright` (or install it temporarily
 * outside the repository). Record the printed browser/version and rows in
 * .hyperion/coordination/decisions.md.
 */
const url = process.argv[2];
if (!url) {
  console.error('usage: node scripts/preview-conformance.mjs <minted-preview-url>');
  process.exit(2);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('preview conformance needs Playwright in the runner environment: npm install playwright');
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const response = await page.goto(url, { waitUntil: 'load' });
  if (!response?.ok()) throw new Error(`preview navigation returned ${response?.status() ?? 'no response'}`);
  await page.waitForFunction(
    () => document.documentElement.dataset.conformanceComplete === 'yes',
    undefined,
    { timeout: 10_000 },
  );
  const rows = await page.locator('tbody tr').evaluateAll((items) =>
    items.map((row) => {
      const cells = [...row.querySelectorAll('td')].map((cell) => cell.textContent?.trim() ?? '');
      return { capability: cells[0], expected: cells[1], result: cells[2] };
    }),
  );
  console.log(JSON.stringify({ browser: await browser.version(), url, rows }, null, 2));
  if (rows.some((row) => !row.result.startsWith('PASS'))) process.exitCode = 1;
} finally {
  await browser.close();
}
