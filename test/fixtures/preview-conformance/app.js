(() => {
  const set = (id, ok, detail) => {
    const cell = document.querySelector(`#${id} td:last-child`);
    if (cell) {
      cell.textContent = `${ok ? 'PASS' : 'FAIL'} — ${detail}`;
      cell.dataset.ok = String(ok);
    }
  };

  set('external', true, 'external classic script ran');

  fetch('data.json')
    .then((response) => response.json())
    .then((data) => set('fetch', data.ok === true, `received ${JSON.stringify(data)}`))
    .catch((error) => set('fetch', false, String(error)));

  const image = document.querySelector('#fixture-image');
  if (image.complete) set('image', image.naturalWidth > 0, `${image.naturalWidth}×${image.naturalHeight}`);
  image.addEventListener('load', () => set('image', true, `${image.naturalWidth}×${image.naturalHeight}`));
  image.addEventListener('error', () => set('image', false, 'image load failed'));

  setTimeout(() => {
    set('inline', document.documentElement.dataset.inlineRan !== 'yes', 'inline script did not run');
  }, 50);

  try {
    localStorage.setItem('hyperion-preview-conformance', 'unexpected');
    set('storage', false, 'localStorage write succeeded');
  } catch (error) {
    set('storage', true, error instanceof DOMException ? error.name : String(error));
  }

  window.addEventListener('message', (event) => {
    if (event.data?.type === 'hyperion-preview-conformance') {
      set('message', true, 'message event received');
    }
  });
  parent.postMessage({ type: 'hyperion-preview-conformance' }, '*');

  setTimeout(() => {
    const cells = [...document.querySelectorAll('tbody td:last-child')];
    if (cells.every((cell) => cell.dataset.ok !== undefined)) {
      document.documentElement.dataset.conformanceComplete = 'yes';
    }
  }, 250);
})();
