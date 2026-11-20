// Dodaje do AndroidManifest.xml uprawnienia potrzebne do GPS-a, kamery (skan QR), NFC, wibracji i trzymania ekranu wlaczonego.
const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
let xml = fs.readFileSync(manifestPath, 'utf8');

const wanted = [
  '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
  '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
  '<uses-permission android:name="android.permission.VIBRATE" />',
  '<uses-permission android:name="android.permission.WAKE_LOCK" />',
  '<uses-feature android:name="android.hardware.location.gps" android:required="false" />',
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-feature android:name="android.hardware.camera" android:required="false" />',
  '<uses-permission android:name="android.permission.NFC" />',
  '<uses-feature android:name="android.hardware.nfc" android:required="false" />',
];

const missing = wanted.filter((line) => {
  const name = line.match(/android:name="([^"]+)"/)[1];
  return !xml.includes(name);
});

if (missing.length) {
  const block = missing.map((l) => '    ' + l).join('\n') + '\n\n    ';
  if (!xml.includes('<application')) {
    console.error('Nie znaleziono <application> w AndroidManifest.xml');
    process.exit(1);
  }
  xml = xml.replace('<application', block + '<application');
  fs.writeFileSync(manifestPath, xml);
}
console.log('AndroidManifest: dodano', missing.length, 'wpisow');
