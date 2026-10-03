import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  runAtTargetFps,
  useCameraDevice,
  useCameraFormat,
  useCameraPermission,
  useFrameProcessor,
} from 'react-native-vision-camera';
// Sengaja TIDAK memakai komponen `Camera` dari library ini: komponen itu selalu memanggil
// useSkiaFrameProcessor, yang crash (force close) kalau @shopify/react-native-skia tidak terpasang.
import { FrameFaceDetectionOptions, useFaceDetector } from 'react-native-vision-camera-face-detector';
import { Worklets } from 'react-native-worklets-core';

// ---------------------------------------------------------------------------
// Metrik wajah dari ML Kit, diperbarui di setiap frame kamera.
// yaw (derajat): positif = pengguna menoleh ke KIRI-nya. Arah ini dikalibrasi otomatis saat
// pendaftaran (pose "agak kiri") dan disimpan sebagai pengaturan flipYaw.
// ---------------------------------------------------------------------------
type Metrics = { faces: number; yaw: number; pitch: number; eyeOpen: number; smile: number; size: number };
const EMPTY: Metrics = { faces: 0, yaw: 0, pitch: 0, eyeOpen: 0, smile: 0, size: 0 };

const MIN_FACE_SIZE = 0.25; // lebar wajah / sisi pendek frame
const OPEN = (m: Metrics) => m.eyeOpen > 0.6;
const FRONTAL = (m: Metrics) => Math.abs(m.yaw) < 10 && Math.abs(m.pitch) < 15 && OPEN(m);

// hint: pesan koreksi saat kondisi belum terpenuhi (mis. "sedikit lagi")
type Step = { text: string; cond: (m: Metrics) => boolean; hint?: (m: Metrics) => string | null; hold?: number; timeout?: number };

// Tantangan liveness. Diacak setiap absen supaya video rekaman tidak bisa dipakai ulang.
const CHALLENGES: Record<string, { text: string; steps: Step[] }> = {
  blink: {
    text: 'Kedipkan mata',
    steps: [
      { text: 'Kedipkan mata', cond: OPEN },
      { text: 'Kedipkan mata', cond: (m) => m.eyeOpen < 0.2 },
      { text: 'Kedipkan mata', cond: OPEN },
    ],
  },
  left: { text: 'Toleh ke kiri', steps: [{ text: 'Toleh ke kiri', cond: (m) => m.yaw > 25, hold: 150 }] },
  right: { text: 'Toleh ke kanan', steps: [{ text: 'Toleh ke kanan', cond: (m) => m.yaw < -25, hold: 150 }] },
  smile: { text: 'Tersenyum', steps: [{ text: 'Tersenyum', cond: (m) => m.smile > 0.7, hold: 200 }] },
};

function pickChallenges(n: number): string[] {
  const keys = Object.keys(CHALLENGES).sort(() => Math.random() - 0.5);
  const turn = (k: string) => k === 'left' || k === 'right';
  return keys.filter((k, i) => !(turn(k) && keys.slice(0, i).some(turn))).slice(0, n);
}

// Pose samping saat pendaftaran. Mata TIDAK dicek: saat menoleh, satu mata tertutup sebagian
// sehingga probabilitas "mata terbuka" dari ML Kit turun walau mata sebenarnya terbuka.
const SIDE_MIN = 10;
const SIDE_MAX = 35;
const inSide = (m: Metrics) => Math.abs(m.yaw) >= SIDE_MIN && Math.abs(m.yaw) <= SIDE_MAX;
// want: arah tanda yaw yang diharapkan (1 / -1), 0 = arah mana saja
const sideHint = (want: number) => (m: Metrics) => {
  if (want !== 0 && Math.abs(m.yaw) >= SIDE_MIN && Math.sign(m.yaw) !== want) return 'Arah sebaliknya';
  if (Math.abs(m.yaw) < SIDE_MIN) return 'Sedikit lagi';
  if (Math.abs(m.yaw) > SIDE_MAX) return 'Terlalu jauh, kembali sedikit';
  return null;
};

class FlowError extends Error {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type VerifyCapture = { photoPath: string; challenges: string; seconds: number };

type Props = {
  mode: 'enroll' | 'verify';
  title: string;
  flipYaw: boolean;
  // enroll: dipanggil per foto, kembalikan pesan error kalau foto ditolak server
  // string = foto ditolak tapi boleh diulang; { fatal } = hentikan pendaftaran (mis. wajah sudah terdaftar)
  onEnrollPhoto?: (path: string, label: string) => Promise<string | null | { fatal: string }>;
  onEnrollDone?: () => void;
  // pendaftaran mendeteksi arah yaw kebalikan dari pengaturan saat ini -> simpan flipYaw baru
  onYawFlipDetected?: () => void;
  onVerifyCapture?: (c: VerifyCapture) => void;
  onCancel: () => void;
};

export default function CaptureScreen(props: Props) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('front');
  const format = useCameraFormat(device, [
    { photoResolution: { width: 1280, height: 960 } },
    { videoResolution: { width: 1280, height: 720 } },
  ]);
  const camera = useRef<Camera>(null);
  const metrics = useRef<Metrics>(EMPTY);
  const lastUiUpdate = useRef(0);
  const cancelled = useRef(false);
  const strictPresence = useRef(false);
  const [live, setLive] = useState<Metrics>(EMPTY);
  const [prompt, setPrompt] = useState('Menyiapkan kamera…');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);

  const detectionOptions = useRef<FrameFaceDetectionOptions>({
    performanceMode: 'fast',
    classificationMode: 'all',
    landmarkMode: 'none',
    contourMode: 'none',
    cameraFacing: 'front',
    minFaceSize: 0.15,
  }).current;

  const { detectFaces, stopListeners } = useFaceDetector(detectionOptions);
  useEffect(() => () => stopListeners(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Dipanggil dari thread kamera (worklet) -> pindah ke thread JS. Hanya angka yang dikirim.
  const flip = props.flipYaw ? -1 : 1;
  const onMetrics = useMemo(
    () =>
      Worklets.createRunOnJS((m: Metrics) => {
        const next = m.faces === 1 ? { ...m, yaw: m.yaw * flip } : m;
        metrics.current = next;
        const now = Date.now();
        if (now - lastUiUpdate.current > 200) {
          lastUiUpdate.current = now;
          setLive(next);
        }
      }),
    [flip],
  );

  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet';
      runAtTargetFps(15, () => {
        'worklet';
        const faces = detectFaces(frame);
        const f = faces[0];
        onMetrics(
          f
            ? {
                faces: faces.length,
                yaw: f.yawAngle,
                pitch: f.pitchAngle,
                eyeOpen: Math.min(f.leftEyeOpenProbability, f.rightEyeOpenProbability),
                smile: f.smilingProbability,
                size: f.bounds.width / Math.min(frame.width, frame.height),
              }
            : { faces: 0, yaw: 0, pitch: 0, eyeOpen: 0, smile: 0, size: 0 },
        );
      });
    },
    [detectFaces, onMetrics],
  );

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  const [deviceTimedOut, setDeviceTimedOut] = useState(false);
  useEffect(() => {
    if (device) return;
    const t = setTimeout(() => setDeviceTimedOut(true), 6000);
    return () => clearTimeout(t);
  }, [device]);

  // Tunggu sampai kondisi terpenuhi selama `hold` ms dengan tepat satu wajah yang cukup dekat.
  const waitFor = useCallback(async (step: Step) => {
    const { hold = 0, timeout = 10000 } = step;
    const start = Date.now();
    let since: number | null = null;
    let lostSince: number | null = null;
    setPrompt(step.text);
    while (true) {
      if (cancelled.current) throw new FlowError('Dibatalkan');
      const m = metrics.current;
      const now = Date.now();
      if (now - start > timeout) throw new FlowError('Waktu habis. Ikuti instruksi di layar lalu ulangi.');
      if (m.faces > 1) throw new FlowError('Terdeteksi lebih dari satu wajah. Pastikan hanya Anda di kamera.');
      if (m.faces === 0) {
        lostSince ??= now;
        // saat absen, wajah hilang terlalu lama di tengah tantangan -> bisa jadi orangnya berganti
        if (strictPresence.current && now - lostSince > 1500) throw new FlowError('Wajah hilang dari kamera. Ulangi.');
        setPrompt(step.text);
      } else {
        lostSince = null;
      }
      const ok = m.faces === 1 && m.size >= MIN_FACE_SIZE && step.cond(m);
      if (m.faces === 1 && m.size < MIN_FACE_SIZE) setPrompt('Dekatkan wajah ke kamera');
      else if (m.faces === 1) {
        const hint = ok ? null : step.hint?.(m);
        setPrompt(hint ? `${step.text}\n${hint}` : step.text);
      }
      if (ok) {
        since ??= now;
        if (now - since >= hold) return;
      } else {
        since = null;
      }
      await sleep(40);
    }
  }, []);

  const takePhoto = useCallback(async () => {
    const photo = await camera.current!.takePhoto({ flash: 'off', enableShutterSound: false });
    return photo.path;
  }, []);

  const runEnroll = useCallback(async () => {
    // Arah yaw ML Kit bisa berbeda antar HP. Pose "agak kiri" menerima arah mana saja,
    // lalu tanda yaw-nya dipakai sebagai patokan "kiri" (pose "agak kanan" = kebalikannya).
    let leftSign = 0;
    const poses: { label: string; step: () => Step }[] = [
      { label: 'lurus', step: () => ({ text: 'Hadap lurus ke kamera', cond: FRONTAL, hold: 700, timeout: 20000 }) },
      {
        label: 'agak kiri',
        step: () => ({ text: 'Toleh SEDIKIT ke kiri', cond: inSide, hint: sideHint(0), hold: 500, timeout: 20000 }),
      },
      {
        label: 'agak kanan',
        step: () => ({
          text: 'Toleh SEDIKIT ke kanan',
          cond: (m) => inSide(m) && Math.sign(m.yaw) === -leftSign,
          hint: sideHint(-leftSign),
          hold: 500,
          timeout: 20000,
        }),
      },
    ];
    for (const pose of poses) {
      for (let attempt = 1; ; attempt++) {
        await waitFor(pose.step());
        if (pose.label === 'agak kiri') leftSign = Math.sign(metrics.current.yaw) || 1;
        setPrompt('Tahan…');
        const path = await takePhoto();
        setPrompt('Memeriksa foto…');
        const err = await props.onEnrollPhoto!(path, pose.label);
        if (!err) break;
        if (typeof err === 'object') throw new FlowError(err.fatal);
        if (attempt >= 3) throw new FlowError(`Foto "${pose.label}" ditolak 3 kali: ${err}`);
        setPrompt(`Foto ditolak: ${err}`);
        await sleep(1800);
      }
    }
    if (leftSign < 0) props.onYawFlipDetected?.();
    setPrompt('Pendaftaran selesai ✓');
    await sleep(800);
    props.onEnrollDone!();
  }, [props, takePhoto, waitFor]);

  const runVerify = useCallback(async () => {
    const chosen = pickChallenges(2);
    const t0 = Date.now();
    await waitFor({ text: 'Posisikan wajah di tengah, hadap lurus', cond: FRONTAL, hold: 300, timeout: 15000 });
    strictPresence.current = true;
    for (const key of chosen) {
      for (const step of CHALLENGES[key].steps) await waitFor(step);
      setPrompt('✓');
      await sleep(300);
    }
    await waitFor({ text: 'Hadap lurus lagi', cond: FRONTAL, hold: 400 });
    setPrompt('Memeriksa…');
    const photoPath = await takePhoto();
    props.onVerifyCapture!({
      photoPath,
      challenges: chosen.map((k) => CHALLENGES[k].text.toLowerCase()).join(' + '),
      seconds: (Date.now() - t0) / 1000,
    });
  }, [props, takePhoto, waitFor]);

  const start = useCallback(async () => {
    setError(null);
    setBusy(true);
    cancelled.current = false;
    strictPresence.current = false;
    try {
      await (props.mode === 'enroll' ? runEnroll() : runVerify());
    } catch (e: any) {
      if (!cancelled.current) setError(e instanceof FlowError ? e.message : `Error: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }, [props.mode, runEnroll, runVerify]);

  // mulai otomatis begitu kamera siap
  useEffect(() => {
    if (cameraReady) start();
    return () => {
      cancelled.current = true;
    };
  }, [cameraReady]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!hasPermission) {
    return (
      <View style={styles.center}>
        <Text style={styles.msg}>Izin kamera dibutuhkan.</Text>
        <Pressable style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Beri izin kamera</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnSec]} onPress={props.onCancel}>
          <Text style={[styles.btnText, { color: '#111' }]}>Kembali</Text>
        </Pressable>
      </View>
    );
  }
  if (!device) {
    // daftar kamera Android baru tersedia setelah CameraX siap (biasanya < 1 detik)
    return (
      <View style={styles.center}>
        {deviceTimedOut ? (
          <Text style={styles.msg}>Kamera depan tidak ditemukan. Tutup aplikasi sepenuhnya lalu buka lagi.</Text>
        ) : (
          <>
            <ActivityIndicator size="large" />
            <Text style={styles.msg}>Menyiapkan kamera…</Text>
          </>
        )}
        <Pressable style={[styles.btn, styles.btnSec]} onPress={props.onCancel}>
          <Text style={[styles.btnText, { color: '#111' }]}>Kembali</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        format={format}
        isActive
        photo
        onInitialized={() => setCameraReady(true)}
        onError={(e) => setError(`Kamera error: ${e.code} ${e.message}`)}
        frameProcessor={frameProcessor}
        pixelFormat="yuv"
      />

      <View style={styles.top}>
        <Text style={styles.title}>{props.title}</Text>
        <Text style={styles.live}>
          {live.faces === 1
            ? `yaw ${live.yaw.toFixed(0)}° · mata ${live.eyeOpen.toFixed(2)} · senyum ${live.smile.toFixed(2)} · ukuran ${live.size.toFixed(2)}`
            : `wajah: ${live.faces}`}
        </Text>
      </View>

      <View style={styles.bottom}>
        {error ? (
          <>
            <Text style={[styles.prompt, styles.err]}>{error}</Text>
            <View style={styles.row}>
              <Pressable style={styles.btn} onPress={start}>
                <Text style={styles.btnText}>Ulangi</Text>
              </Pressable>
              <Pressable style={[styles.btn, styles.btnSec]} onPress={props.onCancel}>
                <Text style={[styles.btnText, { color: '#111' }]}>Kembali</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <View style={styles.row}>
              {busy && prompt.startsWith('Memeriksa') && <ActivityIndicator color="#fff" />}
              <Text style={styles.prompt}>{prompt}</Text>
            </View>
            <Pressable
              style={[styles.btn, styles.btnSec]}
              onPress={() => {
                cancelled.current = true;
                props.onCancel();
              }}
            >
              <Text style={[styles.btnText, { color: '#111' }]}>Batal</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  msg: { fontSize: 16, textAlign: 'center' },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingTop: 48, paddingHorizontal: 16, paddingBottom: 10, backgroundColor: 'rgba(0,0,0,0.45)' },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  live: { color: '#d1d5db', fontSize: 12, marginTop: 4, fontVariant: ['tabular-nums'] },
  bottom: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 16, paddingBottom: 40, gap: 12, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center' },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' },
  prompt: { color: '#fff', fontSize: 24, fontWeight: '800', textAlign: 'center' },
  err: { color: '#fecaca', fontSize: 18 },
  btn: { backgroundColor: '#2563eb', paddingVertical: 12, paddingHorizontal: 22, borderRadius: 8 },
  btnSec: { backgroundColor: '#e5e7eb' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
