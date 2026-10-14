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
node scripts/preview-conformance.mjs --port 4320 --bind 0.0.0.0   # behind a proxy
```

The script copies this directory into a throwaway `HYPERION_HOME`, registers it
as a Code task's workspace, starts the real preview listener and prints a URL.
Open that URL in a real browser (a tab, and — if the app is running — inside the
preview panel, which is an `<iframe>`).

The sandbox directive under test is exactly
`sandbox allow-scripts allow-forms allow-pointer-lock`. No automatic row
below depends on `allow-popups`, `allow-downloads` or `allow-modals`, so
removing those tokens does not change rows 1–7: scripts, fetches, images
and `postMessage` keep their expectations, and `localStorage` stays
blocked by the opaque origin. `allow-pointer-lock`, popups, modals and
downloads are manual rows (8–10) because pointer lock and dialogs need a
user gesture and a download leaves no trace a page can observe.

## The rows

| # | Probe | Expected | Why |
| --- | --- | --- | --- |
| 1 | external classic script `external.js` | runs | `script-src` must match the document's URL; `allow-scripts` lets it run |
| 2 | module script `module.mjs` (`type="module"`) | runs | modules are fetched and evaluated on a separate path from classic scripts |
| 3 | `fetch('./data.json')` | 200, JSON parsed | `connect-src` must match the page's own origin |
| 4 | `<img src="./pixel.png">` | loads 1×1 | `img-src` |
| 5 | inline script | runs | `script-src` keeps `'unsafe-inline'` for the single-file pages an agent produces |
| 6 | `localStorage.getItem('probe')` | **blocked** — `SecurityError` | `sandbox` without `allow-same-origin` gives an opaque origin: this row is the isolation, not a bug |
| 7 | `postMessage` to the parent | posted | the panel listens; in a tab the parent is the page itself, so the message echoes back and the row reports *received* rather than only sent |
| 8 | pointer lock from a click (manual button) | **allowed** | `allow-pointer-lock` keeps mouse-capture previews (games) working |
| 9 | `window.open` popup (manual button) | **blocked** | no `allow-popups`: generated code must not open windows |
| 10 | `alert()` dialog and a download link (manual) | **blocked** | no `allow-modals` and no `allow-downloads`: no dialogs, no file downloads |

A row that reports `blocked` for 6 and `ran` for everything else is the pass
condition for the automatic rows; rows 8–10 pass when 8 is allowed and 9–10
are blocked. If rows 1–5 fail, `'self'` is not matching under the opaque origin
*and* the explicit origin is missing or wrong — check the CSP header's sources
against the URL bar.

## Recording the result

The outcome belongs in `.hyperion/coordination/decisions.md`, with the browser
and version it was measured in, because "which mechanism did the work" is a
claim about browsers rather than about this repository. Each row is its own
record — the table is the result — and the script prints a markdown skeleton to
paste into `decisions.md`.
