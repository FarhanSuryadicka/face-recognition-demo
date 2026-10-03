# Face Demo HRIS (prototipe)

Aplikasi Android untuk menguji face-service langsung dari HP, **tanpa Laravel**.

- **Daftar wajah:** 3 pose (lurus, agak kiri, agak kanan). Foto diambil otomatis.
- **Absen:** 2 tantangan liveness acak (kedip / toleh kiri / toleh kanan / senyum), lalu foto otomatis. Foto dikirim ke `face-service /embed`, lalu dicocokkan dengan wajah terdaftar.
- **Riwayat & skor:** skor kecocokan dan anti-spoof setiap percobaan, untuk kalibrasi threshold.

Liveness memakai ML Kit (lewat `react-native-vision-camera-face-detector`) yang berjalan di HP.

> ⚠️ Prototipe ini memanggil face-service **langsung** dengan API key yang tersimpan di app, dan data wajah disimpan di HP (AsyncStorage).
> Di aplikasi HRIS sungguhan, app memanggil **Laravel**. Laravel yang menyimpan embedding, memanggil face-service, dan memutuskan absen sah atau tidak.

## Stack

Expo SDK 54 (React Native 0.81, arsitektur lama), `react-native-vision-camera` 4.7, `react-native-vision-camera-face-detector` 1.10, `react-native-worklets-core`.

| File | Isi |
|---|---|
| `src/CaptureScreen.tsx` | Kamera, deteksi wajah, alur pose pendaftaran, dan tantangan liveness |
| `src/api.ts` | Panggilan ke face-service, perhitungan cosine similarity (nantinya dikerjakan Laravel) |
| `src/storage.ts` | Pengaturan, data wajah, dan riwayat di HP |
| `App.tsx` | Layar beranda, hasil, pengaturan, riwayat |

## Build APK

Butuh Node 20+, JDK 17, dan Android SDK.

```powershell
npm install
npx expo prebuild --platform android
cd android
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
.\gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

Hasilnya ada di `android\app\build\outputs\apk\release\app-release.apk`. APK ini ditandatangani dengan debug keystore, cukup untuk uji internal, tidak untuk Play Store.

`arm64-v8a` mencakup hampir semua HP Android 2018 ke atas. ABI di APK dibatasi oleh `plugins/withAbiFilters.js` (diatur di `app.json`). Tanpa plugin ini, APK membengkak menjadi sekitar 93 MB karena ikut membawa library x86. Untuk HP lama 32-bit, tambahkan `armeabi-v7a` di **kedua** tempat: plugin dan `-PreactNativeArchitectures`.

## Menjalankan face-service supaya bisa diakses HP

HP dan laptop harus berada di **Wi-Fi yang sama**. Di laptop:

```powershell
cd D:\face-service
$env:FACE_API_KEY="rahasia"
venv\Scripts\python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Saat pertama kali dijalankan, Windows akan menampilkan pop-up firewall untuk Python. Pilih **Allow** untuk jaringan **Private**.
Di app, buka **Pengaturan**, lalu isi alamat server dengan `http://<IP-laptop>:8000`. IP laptop bisa dilihat dengan `ipconfig`, di baris IPv4 adapter Wi-Fi.
