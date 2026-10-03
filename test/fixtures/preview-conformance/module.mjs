// Row 2 of the conformance page: a `type="module"` script. Modules are deferred
// and fetched separately from classic scripts, so a CSP that lets one through
// does not automatically let the other. The event is how the classic inline
// script that painted the table learns this one ran.
window.__conformance = window.__conformance || {};
window.__conformance.module = 'ran';
window.dispatchEvent(new Event('conformance-module'));
