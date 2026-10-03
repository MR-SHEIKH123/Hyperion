# Preview conformance fixture

A browser-verified fixture for the sandboxed preview listener
(`src/http/previewServer.ts`). It exists because one question about that header
set cannot be answered from Node: **under a CSP `sandbox` the document has an
opaque origin, and whether a source of `'self'` matches the document's own URL
there is a browser's business, not ours.** The listener sends both `'self'` and
the explicit origin built from the validated `Host` header so a failure of
either is not a failure of the page, and this fixture is how the owner sees
which one did the work.

## Run it

```sh
node scripts/preview-conformance.mjs
```

The script copies this directory into a throwaway `HYPERION_HOME`, registers it
as a Code task's workspace, starts the real preview listener and prints a URL.
Open that URL in a real browser (a tab, and — if the app is running — inside the
preview panel, which is an `<iframe>`).

## The rows

| # | Probe | Expected | Why |
| --- | --- | --- | --- |
| 1 | external classic script `external.js` | runs | `script-src` must match the document's URL; `allow-scripts` lets it run |
| 2 | module script `module.mjs` (`type="module"`) | runs | modules are fetched and evaluated on a separate path from classic scripts |
| 3 | `fetch('./data.json')` | 200, JSON parsed | `connect-src` must match the page's own origin |
| 4 | `<img src="./pixel.png">` | loads 1×1 | `img-src` |
| 5 | inline script | runs | `script-src` keeps `'unsafe-inline'` for the single-file pages an agent produces |
| 6 | `localStorage.getItem('probe')` | **blocked** — `SecurityError` | `sandbox` without `allow-same-origin` gives an opaque origin: this row is the isolation, not a bug |
| 7 | `postMessage` to the parent | posted | the panel listens; in a tab the parent is the page itself |

A row that reports `blocked` for 6 and `ran` for everything else is the pass
condition. If rows 1–5 fail, `'self'` is not matching under the opaque origin
*and* the explicit origin is missing or wrong — check the CSP header's sources
against the URL bar.

## Recording the result

The outcome belongs in `.hyperion/coordination/decisions.md`, with the browser
and version it was measured in, because "which mechanism did the work" is a
claim about browsers rather than about this repository. The page prints an
`n of 7 probes behaved as expected` line and the script prints a markdown
skeleton to paste.
