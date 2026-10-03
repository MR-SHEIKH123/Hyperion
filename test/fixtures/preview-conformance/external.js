// Row 1 of the conformance page: an external classic script. If `script-src`
// in the preview's CSP is wrong (neither 'self' nor the explicit origin
// matching), this file is blocked and the flag is never set.
window.__conformance = window.__conformance || {};
window.__conformance.external = 'ran';
