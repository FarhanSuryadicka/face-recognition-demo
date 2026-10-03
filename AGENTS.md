# AGENTS.md: face-demo-app (prototipe absensi wajah)

Konteks untuk AI agent dan developer. Bahasa komunikasi dengan pemilik proyek: **Bahasa Indonesia**.
Gambaran besar proyek HRIS, arsitektur, dan status ada di `D:\face-service\AGENTS.md`. Baca itu dulu.

## Apa ini

Prototipe Android untuk menguji **face-service** langsung dari HP, **tanpa Laravel**:
- **Daftar wajah**: 3 pose (lurus, agak kiri, agak kanan), foto diambil otomatis, dan tiap foto dicek kualitas + anti-spoof di server.
- **Absen**: 2 tantangan liveness acak (kedip / toleh kiri / toleh kanan / senyum), lalu "hadap lurus", foto otomatis → `POST /embed` → cosine similarity terhadap embedding terdaftar.
- **Riwayat & skor**: untuk kalibrasi threshold. **Pengaturan**: alamat server, API key, threshold, dan tombol balik arah toleh.

Prototipe ini sengaja mengambil jalan pintas yang **tidak boleh** dibawa ke produksi: API key disimpan di app, embedding disimpan di HP (AsyncStorage), dan keputusan absen dibuat di HP.
Di aplikasi HRIS sungguhan semua itu dikerjakan Laravel. Yang layak dipakai ulang tim mobile adalah logika kamera + liveness di `src/CaptureScreen.tsx`.

## Stack (versi dikunci, jangan di-upgrade sembarangan)

- **Expo SDK 54** (React Native 0.81.5), **`newArchEnabled: false`**. `react-native-vision-camera-face-detector` hanya dites di arsitektur lama.
- `react-native-vision-camera` **4.7.3** + `react-native-vision-camera-face-detector` **1.10.2** (ML Kit) + `react-native-worklets-core`.
  VisionCamera 5.x / face-detector 2.x memakai API Nitro yang berbeda. Jangan naik versi tanpa menulis ulang `CaptureScreen`.
- **`patches/react-native-vision-camera+4.7.3.patch`** (diterapkan otomatis lewat `postinstall: patch-package`): perbaikan bug VisionCamera 4 di Android. Daftar kamera dibaca sebelum CameraX selesai inisialisasi, sehingga kosong dan tidak pernah diperbarui, dan app menampilkan "Kamera depan tidak ditemukan". Patch ini mengirim ulang daftar kamera setelah inisialisasi selesai. Kalau membuat ulang patch dan gagal karena "Filename too long", hapus dulu `node_modules/react-native-vision-camera/android/build`.
- **Jangan pakai komponen `Camera` dari `react-native-vision-camera-face-detector`.** Komponen itu selalu memanggil `useSkiaFrameProcessor`, yang force close kalau `@shopify/react-native-skia` tidak terpasang. Pakai `Camera` dari VisionCamera + `useFrameProcessor` + `useFaceDetector` (lihat `CaptureScreen.tsx`).
- `index.ts` memasang `ErrorBoundary` + global error handler, supaya error JS tampil di layar, bukan force close diam-diam.
- Navigasi cukup dengan state di `App.tsx`. Tidak memakai Expo Router (prototipe kecil, sengaja).
- `babel.config.js` memakai plugin `react-native-worklets-core/plugin`. Plugin ini butuh devDependencies `babel-preset-expo`, `@babel/plugin-proposal-optional-chaining`, `@babel/plugin-proposal-nullish-coalescing-operator`, `@babel/plugin-transform-template-literals`. Kalau hilang, build gagal di `createBundleReleaseJsAndAssets`.

| File | Isi |
|---|---|
| `src/CaptureScreen.tsx` | Kamera depan, metrik ML Kit (yaw, mata, senyum, ukuran wajah), pose pendaftaran, tantangan liveness |
| `src/api.ts` | `health`, `embed` (multipart `image`), `similarity` (dot product) |
| `src/storage.ts` | Pengaturan, profil + embedding, riwayat (AsyncStorage). Default server `http://192.168.1.64:8000` = IP PC kantor |
| `App.tsx` | Layar beranda, hasil, pengaturan, riwayat |
| `plugins/withAbiFilters.js` | Config plugin: `abiFilters arm64-v8a` (APK 35 MB, bukan 93 MB) |

## Server berbeda di kantor / rumah

**Tidak perlu build ulang APK.** Jalankan face-service di PC yang sedang dipakai dengan `--host 0.0.0.0`, cek IP dengan `ipconfig`, lalu di app buka **Pengaturan** dan isi alamat server dengan `http://<IP>:8000`. HP dan PC harus di Wi-Fi yang sama. Kalau beranda app menampilkan ❌, cek: IP, Wi-Fi yang sama, firewall Windows (izinkan Python untuk jaringan Private), dan uvicorn jalan dengan `--host 0.0.0.0`.
Build ulang hanya perlu kalau kode berubah.

## Build APK (Windows)

Butuh Node 20+, JDK 17, dan Android SDK (`%LOCALAPPDATA%\Android\Sdk`).

```powershell
cd D:\face-demo-app
npm install
npx expo prebuild --platform android
cd android
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
.\gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

Hasil: `android\app\build\outputs\apk\release\app-release.apk`. Salin ke `dist\FaceDemoHRIS-<versi>.apk`. Ditandatangani dengan debug keystore, hanya untuk uji internal.
Kalau mengubah versi, naikkan `version` di `app.json` supaya APK baru bisa menimpa yang lama.

## Aturan

- `android/` hasil generate (`.gitignore`). Jangan edit langsung. Atur lewat `app.json` / config plugin, lalu `npx expo prebuild`.
- Tambah library: `npx expo install <pkg>`. Library native butuh build ulang APK (Expo Go tidak bisa dipakai karena ada VisionCamera).
- Sebelum menyatakan selesai: `npx tsc --noEmit` dan `npx expo-doctor`.
- Expo sering berubah antar SDK. Untuk API Expo, rujuk dokumentasi versi 54: https://docs.expo.dev/versions/v54.0.0/

## Yang belum terverifikasi (cek dulu kalau ada laporan bug dari HP)

- **Arah yaw ML Kit**: dikalibrasi otomatis saat pendaftaran. Pose "agak kiri" menerima arah mana saja, lalu tanda yaw-nya menentukan `flipYaw` (disimpan di Pengaturan). Kalau sudah pasti arahnya di banyak HP, default-nya bisa diperbaiki di kode.
- Batas liveness (`CaptureScreen.tsx`): mata terbuka > 0.6 / tertutup < 0.2, senyum > 0.7, toleh > 25°, frontal < 10°, ukuran wajah ≥ 0.25. Pose samping pendaftaran: 10°–35° **tanpa cek mata**. Saat menoleh, ML Kit menurunkan probabilitas mata terbuka; versi 1.0.2 sempat macet di "agak kiri" karena hal ini. Sesuaikan dengan angka yang muncul di layar kamera (baris kecil di atas).
- Foto `takePhoto` dari kamera depan bisa tersimpan miring + EXIF. Server (OpenCV) sudah menanganinya.
