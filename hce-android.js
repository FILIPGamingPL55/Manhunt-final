// Dodaje do projektu Androida natywną wtyczkę "ManhuntHce":
// telefon biegacza udaje tag NFC z jego kodem, więc łowca łapie go przez przyłożenie telefonu do telefonu.
// Uruchamiane w GitHub Actions po "npx cap add android" i po patch-android.js.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'android', 'app', 'src', 'main');
const javaDir = path.join(root, 'java', 'pl', 'manhunt', 'app');
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

if (!fs.existsSync(path.join(javaDir, 'MainActivity.java'))) {
  console.error('Nie znaleziono MainActivity.java w', javaDir);
  process.exit(1);
}

/* ---------- usługa emulacji tagu NFC typu 4 (NDEF) ---------- */
write(path.join(javaDir, 'HceService.java'), `package pl.manhunt.app;

import android.nfc.cardemulation.HostApduService;
import android.os.Bundle;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public class HceService extends HostApduService {
    private static final byte[] SW_OK = {(byte) 0x90, 0x00};
    private static final byte[] SW_NOT_FOUND = {0x6A, (byte) 0x82};
    private static final byte[] SW_WRONG_LENGTH = {0x67, 0x00};
    private static final byte[] SW_BAD_OFFSET = {0x6B, 0x00};
    private static final byte[] SW_INS_NOT_SUPPORTED = {0x6D, 0x00};
    private static final byte[] AID = {(byte) 0xD2, 0x76, 0x00, 0x00, (byte) 0x85, 0x01, 0x01};
    // Capability Container: 15 bajtow, NDEF file E104, rozmiar max 255, tylko do odczytu
    private static final byte[] CC = {
        0x00, 0x0F, 0x20, 0x00, 0x3B, 0x00, 0x34,
        0x04, 0x06, (byte) 0xE1, 0x04, 0x00, (byte) 0xFF, 0x00, (byte) 0xFF
    };

    private static volatile byte[] ndefFile = new byte[] {0x00, 0x00};
    private int selected = 0; // 0 nic, 1 CC, 2 NDEF

    public static void setText(String text) {
        byte[] t = text.getBytes(StandardCharsets.UTF_8);
        int plen = 3 + t.length; // bajt statusu + "en" + tekst
        byte[] rec = new byte[4 + plen];
        rec[0] = (byte) 0xD1;       // MB | ME | SR | TNF=1 (well known)
        rec[1] = 0x01;              // dlugosc typu
        rec[2] = (byte) plen;       // dlugosc payloadu
        rec[3] = 0x54;              // typ "T" (tekst)
        rec[4] = 0x02;              // status: UTF-8, kod jezyka 2 bajty
        rec[5] = 'e';
        rec[6] = 'n';
        System.arraycopy(t, 0, rec, 7, t.length);
        byte[] file = new byte[2 + rec.length];
        file[0] = (byte) ((rec.length >> 8) & 0xFF);
        file[1] = (byte) (rec.length & 0xFF);
        System.arraycopy(rec, 0, file, 2, rec.length);
        ndefFile = file;
    }

    public static void clear() {
        ndefFile = new byte[] {0x00, 0x00};
    }

    @Override
    public byte[] processCommandApdu(byte[] apdu, Bundle extras) {
        if (apdu == null || apdu.length < 4) return SW_WRONG_LENGTH;
        int ins = apdu[1] & 0xFF;

        if (ins == 0xA4) { // SELECT
            int p1 = apdu[2] & 0xFF;
            if (apdu.length < 5) return SW_WRONG_LENGTH;
            int lc = apdu[4] & 0xFF;
            if (apdu.length < 5 + lc) return SW_WRONG_LENGTH;
            byte[] data = Arrays.copyOfRange(apdu, 5, 5 + lc);
            if (p1 == 0x04) { // wybor aplikacji po nazwie (AID)
                if (Arrays.equals(data, AID)) { selected = 0; return SW_OK; }
                return SW_NOT_FOUND;
            }
            if (p1 == 0x00 && lc == 2 && data[0] == (byte) 0xE1) { // wybor pliku
                if (data[1] == 0x03) { selected = 1; return SW_OK; }
                if (data[1] == 0x04) { selected = 2; return SW_OK; }
            }
            return SW_NOT_FOUND;
        }

        if (ins == 0xB0) { // READ BINARY
            if (apdu.length < 5) return SW_WRONG_LENGTH;
            byte[] file = selected == 1 ? CC : (selected == 2 ? ndefFile : null);
            if (file == null) return SW_NOT_FOUND;
            int offset = ((apdu[2] & 0xFF) << 8) | (apdu[3] & 0xFF);
            int le = apdu[4] & 0xFF;
            if (le == 0) le = 256;
            if (offset > file.length) return SW_BAD_OFFSET;
            int n = Math.min(le, file.length - offset);
            byte[] out = new byte[n + 2];
            System.arraycopy(file, offset, out, 0, n);
            out[n] = (byte) 0x90;
            out[n + 1] = 0x00;
            return out;
        }

        return SW_INS_NOT_SUPPORTED;
    }

    @Override
    public void onDeactivated(int reason) {
        selected = 0;
    }
}
`);

/* ---------- wtyczka Capacitor dla JS ---------- */
write(path.join(javaDir, 'ManhuntHcePlugin.java'), `package pl.manhunt.app;

import android.content.Context;
import android.content.pm.PackageManager;
import android.nfc.NfcAdapter;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ManhuntHce")
public class ManhuntHcePlugin extends Plugin {

    @PluginMethod
    public void isSupported(PluginCall call) {
        Context ctx = getContext();
        boolean hce = ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION);
        NfcAdapter adapter = NfcAdapter.getDefaultAdapter(ctx);
        JSObject r = new JSObject();
        r.put("supported", hce && adapter != null);
        r.put("enabled", adapter != null && adapter.isEnabled());
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.isEmpty() || text.length() > 150) {
            call.reject("Nieprawidlowy kod");
            return;
        }
        HceService.setText(text);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        HceService.clear();
        call.resolve();
    }
}
`);

/* ---------- MainActivity rejestruje wtyczke ---------- */
write(path.join(javaDir, 'MainActivity.java'), `package pl.manhunt.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ManhuntHcePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`);

/* ---------- zasoby ---------- */
write(path.join(root, 'res', 'xml', 'apduservice.xml'), `<?xml version="1.0" encoding="utf-8"?>
<host-apdu-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/hce_description"
    android:requireDeviceUnlock="false">
    <aid-group
        android:description="@string/hce_description"
        android:category="other">
        <aid-filter android:name="D2760000850101" />
    </aid-group>
</host-apdu-service>
`);
write(path.join(root, 'res', 'values', 'hce_strings.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="hce_description">Manhunt - kod biegacza</string>
</resources>
`);

/* ---------- AndroidManifest ---------- */
const manifestPath = path.join(root, 'AndroidManifest.xml');
let xml = fs.readFileSync(manifestPath, 'utf8');
if (!xml.includes('.HceService')) {
  const service = `
        <service
            android:name=".HceService"
            android:exported="true"
            android:permission="android.permission.BIND_NFC_SERVICE">
            <intent-filter>
                <action android:name="android.nfc.cardemulation.action.HOST_APDU_SERVICE" />
            </intent-filter>
            <meta-data
                android:name="android.nfc.cardemulation.host_apdu_service"
                android:resource="@xml/apduservice" />
        </service>
`;
  if (!xml.includes('</application>')) { console.error('Brak </application> w AndroidManifest.xml'); process.exit(1); }
  xml = xml.replace('</application>', service + '    </application>');
}
if (!xml.includes('android.hardware.nfc.hce')) {
  xml = xml.replace('<application', '<uses-feature android:name="android.hardware.nfc.hce" android:required="false" />\n\n    <application');
}
fs.writeFileSync(manifestPath, xml);
console.log('HCE: dodano usluge emulacji tagu NFC');
