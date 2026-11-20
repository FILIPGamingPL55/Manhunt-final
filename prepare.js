// Sklada folder www (czesc aplikacji + mapa Leaflet), z ktorego Capacitor zrobi APK.
const fs = require('fs');
const path = require('path');

const www = path.join(__dirname, 'www');
fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });

for (const f of ['index.html', 'app.js', 'style.css', 'config.js']) {
  fs.copyFileSync(path.join(__dirname, f), path.join(www, f));
}

const leaflet = path.join(__dirname, 'node_modules', 'leaflet', 'dist');
if (!fs.existsSync(leaflet)) {
  console.error('Brak node_modules/leaflet - uruchom najpierw: npm install');
  process.exit(1);
}
fs.cpSync(leaflet, path.join(www, 'vendor', 'leaflet'), { recursive: true });

// Skaner QR (jsQR) i generator QR (qrcode-generator)
const libs = [
  [['jsqr', 'dist', 'jsQR.js'], ['vendor', 'jsqr', 'jsQR.js']],
  [['qrcode-generator', 'dist', 'qrcode.js'], ['vendor', 'qrcode', 'qrcode.js']],
];
for (const [from, to] of libs) {
  const src = path.join(__dirname, 'node_modules', ...from);
  if (!fs.existsSync(src)) { console.error('Brak pliku:', src); process.exit(1); }
  const dst = path.join(www, ...to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
console.log('Folder www gotowy');
