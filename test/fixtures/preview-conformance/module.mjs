const cell = document.querySelector('#module td:last-child');
if (cell) {
  cell.textContent = 'PASS — external module ran';
  cell.dataset.ok = 'true';
}
