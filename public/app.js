// Shrink photos before upload: keeps posts fast on store wifi and re-encoding drops EXIF (GPS) data.
document.querySelector('input[name=photos]')?.addEventListener('change', async (e) => {
  const out = new DataTransfer();
  for (const file of e.target.files) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const canvas = Object.assign(document.createElement('canvas'), { width: bmp.width * scale, height: bmp.height * scale });
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((done) => canvas.toBlob(done, 'image/jpeg', 0.82));
      out.items.add(new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
    } catch {
      out.items.add(file); // undecodable here; the server validates it
    }
  }
  e.target.files = out.files;
});

// Remember the player's name between reports (per device).
const player = document.querySelector('input[name=player]');
try {
  if (player && !player.value) player.value = localStorage.getItem('player') ?? '';
  player?.form.addEventListener('submit', () => localStorage.setItem('player', player.value));
} catch { /* storage blocked: the field just starts empty */ }

document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.matches('[data-print]')) print();
  else if (t.matches('[data-back]')) { e.preventDefault(); history.back(); }
  else if (t.matches('[data-copy]')) navigator.clipboard.writeText(t.previousElementSibling.textContent).then(() => { t.textContent = 'Copied'; });
});

const qr = document.querySelector('[data-qr]');
if (qr && window.qrcode) {
  const code = window.qrcode(0, 'M');
  code.addData(qr.dataset.qr);
  code.make();
  qr.innerHTML = code.createSvgTag({ scalable: true });
}
