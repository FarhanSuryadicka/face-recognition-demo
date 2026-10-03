import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { ApiError, embed, health, ISSUE_TEXT, similarity } from './src/api';
import CaptureScreen, { VerifyCapture } from './src/CaptureScreen';
import {
  addAttempt,
  Attempt,
  clearAttempts,
  DEFAULT_SETTINGS,
  loadAttempts,
  loadProfiles,
  loadSettings,
  Profile,
  saveProfiles,
  saveSettings,
  Settings,
} from './src/storage';

type Row = { label: string; ok: boolean | null; value: string };
type Result = { ok: boolean; title: string; rows: Row[]; others: { name: string; sim: number }[] };

type Screen =
  | { name: 'home' }
  | { name: 'enroll'; profileName: string }
  | { name: 'verify'; profile: Profile }
  | { name: 'checking'; profile: Profile; capture: VerifyCapture }
  | { name: 'result'; profile: Profile; result: Result }
  | { name: 'settings' }
  | { name: 'history' };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const pendingEmbeddings = useRef<number[][]>([]);

  useEffect(() => {
    loadSettings().then(setSettings);
    loadProfiles().then(setProfiles);
  }, []);

  const home = () => setScreen({ name: 'home' });

  // ---------------- pendaftaran ----------------
  const onEnrollPhoto = useCallback(
    async (path: string): Promise<string | null | { fatal: string }> => {
      try {
        const r = await embed(settings.serverUrl, settings.apiKey, path);
        if (!r.quality.passed) return r.quality.issues.map((i) => ISSUE_TEXT[i] ?? i).join(', ');
        if (!r.spoof.is_real) return `terdeteksi bukan wajah asli (skor ${r.spoof.real_score.toFixed(2)})`;

        // 1 wajah = 1 karyawan: bandingkan dengan SEMUA wajah terdaftar (1:N).
        // Pakai threshold yang sama dengan absen: kalau wajah ini bisa lolos absen sebagai X, berarti ini X.
        // Di produksi pengecekan ini dilakukan Laravel terhadap seluruh tabel employee_faces.
        const dup = profiles
          .map((p) => ({ name: p.name, sim: Math.max(...p.embeddings.map((e) => similarity(e, r.embedding))) }))
          .sort((a, b) => b.sim - a.sim)[0];
        if (dup && dup.sim >= settings.threshold) {
          return { fatal: `Wajah ini sudah terdaftar sebagai "${dup.name}" (kemiripan ${dup.sim.toFixed(3)}). Satu wajah hanya boleh terdaftar sekali.` };
        }

        pendingEmbeddings.current.push(r.embedding);
        return null;
      } catch (e: any) {
        return e instanceof ApiError ? e.message : String(e?.message ?? e);
      }
    },
    [settings, profiles],
  );

  const onEnrollDone = useCallback(
    async (name: string) => {
      const profile: Profile = { id: String(Date.now()), name, embeddings: pendingEmbeddings.current, createdAt: Date.now() };
      const next = [...profiles, profile];
      await saveProfiles(next);
      setProfiles(next);
      Alert.alert('Berhasil', `Wajah ${name} terdaftar (${profile.embeddings.length} foto).`);
      home();
    },
    [profiles],
  );

  // ---------------- absen: di produksi seluruh blok ini dikerjakan Laravel ----------------
  const checkAttendance = useCallback(
    async (profile: Profile, capture: VerifyCapture) => {
      const base = { at: Date.now(), profileName: profile.name, challenges: capture.challenges };
      try {
        const r = await embed(settings.serverUrl, settings.apiKey, capture.photoPath);
        const best = (p: Profile) => Math.max(...p.embeddings.map((e) => similarity(e, r.embedding)));
        const sim = best(profile);
        const match = sim >= settings.threshold;
        const ok = r.quality.passed && r.spoof.is_real && match;
        const result: Result = {
          ok,
          title: ok ? 'ABSEN BERHASIL' : 'ABSEN DITOLAK',
          rows: [
            { label: `Liveness HP (${capture.challenges})`, ok: true, value: `${capture.seconds.toFixed(1)} dtk` },
            {
              label: 'Kualitas foto',
              ok: r.quality.passed,
              value: r.quality.issues.map((i) => ISSUE_TEXT[i] ?? i).join(', ') || 'ok',
            },
            { label: 'Anti-spoof server', ok: r.spoof.is_real, value: `${r.spoof.real_score.toFixed(3)} (min ${r.spoof.threshold})` },
            { label: `Kecocokan dgn ${profile.name}`, ok: match, value: `${sim.toFixed(3)} (min ${settings.threshold})` },
            { label: 'Waktu proses server', ok: null, value: `${r.timing_ms.total} ms` },
          ],
          // untuk kalibrasi: skor terhadap karyawan lain harus jauh di bawah threshold
          others: profiles.filter((p) => p.id !== profile.id).map((p) => ({ name: p.name, sim: best(p) })),
        };
        await addAttempt({ ...base, ok, similarity: sim, realScore: r.spoof.real_score, qualityPassed: r.quality.passed });
        setScreen({ name: 'result', profile, result });
      } catch (e: any) {
        const msg = e instanceof ApiError ? e.message : String(e?.message ?? e);
        await addAttempt({ ...base, ok: false, similarity: 0, realScore: 0, qualityPassed: false, note: msg });
        setScreen({
          name: 'result',
          profile,
          result: { ok: false, title: 'ABSEN GAGAL', rows: [{ label: 'Error', ok: false, value: msg }], others: [] },
        });
      }
    },
    [settings, profiles],
  );

  // ---------------- render ----------------
  switch (screen.name) {
    case 'enroll':
      return (
        <CaptureScreen
          mode="enroll"
          title={`Daftar wajah: ${screen.profileName}`}
          flipYaw={settings.flipYaw}
          onEnrollPhoto={onEnrollPhoto}
          onEnrollDone={() => onEnrollDone(screen.profileName)}
          onYawFlipDetected={() => {
            const next = { ...settings, flipYaw: !settings.flipYaw };
            setSettings(next);
            saveSettings(next);
          }}
          onCancel={home}
        />
      );
    case 'verify':
      return (
        <CaptureScreen
          mode="verify"
          title={`Absen: ${screen.profile.name}`}
          flipYaw={settings.flipYaw}
          onVerifyCapture={(capture) => {
            setScreen({ name: 'checking', profile: screen.profile, capture });
            checkAttendance(screen.profile, capture);
          }}
          onCancel={home}
        />
      );
    case 'checking':
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" />
          <Text style={styles.muted}>Memeriksa wajah di server…</Text>
        </View>
      );
    case 'result':
      return <ResultView screen={screen} onRetry={() => setScreen({ name: 'verify', profile: screen.profile })} onHome={home} />;
    case 'settings':
      return (
        <SettingsView
          settings={settings}
          onSave={async (s) => {
            await saveSettings(s);
            setSettings(s);
            home();
          }}
          onBack={home}
        />
      );
    case 'history':
      return <HistoryView onBack={home} />;
    default:
      return (
        <HomeView
          settings={settings}
          profiles={profiles}
          onEnroll={(name) => {
            if (profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
              Alert.alert('Nama sudah dipakai', `"${name}" sudah terdaftar. Hapus dulu kalau ingin mendaftarkan ulang.`);
              return;
            }
            pendingEmbeddings.current = [];
            setScreen({ name: 'enroll', profileName: name });
          }}
          onVerify={(profile) => setScreen({ name: 'verify', profile })}
          onDelete={async (profile) => {
            const next = profiles.filter((p) => p.id !== profile.id);
            await saveProfiles(next);
            setProfiles(next);
          }}
          onSettings={() => setScreen({ name: 'settings' })}
          onHistory={() => setScreen({ name: 'history' })}
        />
      );
  }
}

// =========================================================================

function HomeView(props: {
  settings: Settings;
  profiles: Profile[];
  onEnroll: (name: string) => void;
  onVerify: (p: Profile) => void;
  onDelete: (p: Profile) => void;
  onSettings: () => void;
  onHistory: () => void;
}) {
  const [name, setName] = useState('');
  const [server, setServer] = useState<string>('memeriksa…');

  const check = useCallback(() => {
    setServer('memeriksa…');
    health(props.settings.serverUrl)
      .then((s) => setServer(`✅ terhubung (${s})`))
      .catch((e) => setServer(`❌ ${e.message}`));
  }, [props.settings.serverUrl]);
  useEffect(check, [check]);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <StatusBar style="dark" />
      <Text style={styles.h1}>Face Demo HRIS</Text>
      <Pressable onPress={check}>
        <Text style={styles.muted}>Server {props.settings.serverUrl}</Text>
        <Text style={styles.muted}>{server} · ketuk untuk cek ulang</Text>
      </Pressable>

      <View style={styles.card}>
        <Text style={styles.h2}>1. Daftarkan wajah karyawan</Text>
        <TextInput style={styles.input} placeholder="Nama karyawan" value={name} onChangeText={setName} />
        <Pressable
          style={[styles.btn, !name.trim() && styles.disabled]}
          disabled={!name.trim()}
          onPress={() => {
            props.onEnroll(name.trim());
            setName('');
          }}
        >
          <Text style={styles.btnText}>Mulai pendaftaran (3 pose)</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.h2}>2. Absen</Text>
        {props.profiles.length === 0 && <Text style={styles.muted}>Belum ada karyawan terdaftar.</Text>}
        {props.profiles.map((p) => (
          <View key={p.id} style={styles.profileRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.profileName}>{p.name}</Text>
              <Text style={styles.muted}>{p.embeddings.length} foto terdaftar</Text>
            </View>
            <Pressable style={styles.btn} onPress={() => props.onVerify(p)}>
              <Text style={styles.btnText}>Absen</Text>
            </Pressable>
            <Pressable
              style={[styles.btn, styles.btnSec]}
              onPress={() =>
                Alert.alert('Hapus', `Hapus data wajah ${p.name}?`, [
                  { text: 'Batal', style: 'cancel' },
                  { text: 'Hapus', style: 'destructive', onPress: () => props.onDelete(p) },
                ])
              }
            >
              <Text style={styles.btnSecText}>Hapus</Text>
            </Pressable>
          </View>
        ))}
        <Text style={[styles.muted, { marginTop: 8 }]}>
          Tips uji: daftarkan 2 orang, lalu coba absen sebagai orang lain. Harus DITOLAK.
        </Text>
      </View>

      <View style={styles.rowWrap}>
        <Pressable style={[styles.btn, styles.btnSec]} onPress={props.onHistory}>
          <Text style={styles.btnSecText}>Riwayat & skor</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnSec]} onPress={props.onSettings}>
          <Text style={styles.btnSecText}>Pengaturan</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function ResultView({ screen, onRetry, onHome }: { screen: { profile: Profile; result: Result }; onRetry: () => void; onHome: () => void }) {
  const { result } = screen;
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={[styles.verdict, result.ok ? styles.verdictOk : styles.verdictBad]}>
        <Text style={[styles.verdictText, { color: result.ok ? '#15803d' : '#b91c1c' }]}>{result.title}</Text>
        <Text style={styles.muted}>{screen.profile.name}</Text>
      </View>
      <View style={styles.card}>
        {result.rows.map((r) => (
          <View key={r.label} style={styles.resultRow}>
            <Text style={{ flex: 1 }}>{r.label}</Text>
            <Text style={{ textAlign: 'right', flexShrink: 1 }}>
              {r.ok !== null && <Text style={{ color: r.ok ? '#15803d' : '#b91c1c', fontWeight: '700' }}>{r.ok ? 'LULUS ' : 'GAGAL '}</Text>}
              {r.value}
            </Text>
          </View>
        ))}
      </View>
      {result.others.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.h2}>Skor terhadap karyawan lain</Text>
          {result.others.map((o) => (
            <View key={o.name} style={styles.resultRow}>
              <Text style={{ flex: 1 }}>{o.name}</Text>
              <Text>{o.sim.toFixed(3)}</Text>
            </View>
          ))}
        </View>
      )}
      <View style={styles.rowWrap}>
        <Pressable style={styles.btn} onPress={onRetry}>
          <Text style={styles.btnText}>Absen lagi</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnSec]} onPress={onHome}>
          <Text style={styles.btnSecText}>Beranda</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function SettingsView({ settings, onSave, onBack }: { settings: Settings; onSave: (s: Settings) => void; onBack: () => void }) {
  const [s, setS] = useState(settings);
  const [threshold, setThreshold] = useState(String(settings.threshold));
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.h1}>Pengaturan</Text>
      <View style={styles.card}>
        <Text style={styles.label}>Alamat face-service</Text>
        <TextInput
          style={styles.input}
          value={s.serverUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onChangeText={(v) => setS({ ...s, serverUrl: v.trim().replace(/\/+$/, '') })}
        />
        <Text style={styles.muted}>Laptop di Wi-Fi yang sama: http://IP-LAPTOP:8000</Text>

        <Text style={styles.label}>API key</Text>
        <TextInput style={styles.input} value={s.apiKey} autoCapitalize="none" autoCorrect={false} onChangeText={(v) => setS({ ...s, apiKey: v })} />

        <Text style={styles.label}>Threshold kecocokan (0–1)</Text>
        <TextInput style={styles.input} value={threshold} keyboardType="decimal-pad" onChangeText={setThreshold} />

        <View style={[styles.resultRow, { marginTop: 12 }]}>
          <View style={{ flex: 1 }}>
            <Text>Balik arah toleh kiri/kanan</Text>
            <Text style={styles.muted}>Diatur otomatis saat pendaftaran wajah. Ubah manual hanya kalau "toleh ke kiri" saat absen terdeteksi kanan.</Text>
          </View>
          <Switch value={s.flipYaw} onValueChange={(v) => setS({ ...s, flipYaw: v })} />
        </View>
      </View>
      <View style={styles.rowWrap}>
        <Pressable
          style={styles.btn}
          onPress={() => {
            const t = parseFloat(threshold.replace(',', '.'));
            if (!(t > 0 && t < 1)) return Alert.alert('Threshold harus di antara 0 dan 1');
            onSave({ ...s, threshold: t });
          }}
        >
          <Text style={styles.btnText}>Simpan</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnSec]} onPress={onBack}>
          <Text style={styles.btnSecText}>Batal</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function HistoryView({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<Attempt[] | null>(null);
  useEffect(() => {
    loadAttempts().then(setItems);
  }, []);
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.h1}>Riwayat absen</Text>
      <Text style={styles.muted}>Catat skor "orang yang sama" vs "orang lain" untuk menentukan threshold.</Text>
      <View style={styles.card}>
        {items === null && <ActivityIndicator />}
        {items?.length === 0 && <Text style={styles.muted}>Belum ada riwayat.</Text>}
        {items?.map((a) => (
          <View key={a.at} style={styles.historyRow}>
            <Text style={{ fontWeight: '600', color: a.ok ? '#15803d' : '#b91c1c' }}>
              {a.ok ? '✓' : '✗'} {a.profileName} · {new Date(a.at).toLocaleString('id-ID')}
            </Text>
            <Text style={styles.muted}>
              {a.note ?? `cocok ${a.similarity.toFixed(3)} · spoof ${a.realScore.toFixed(3)} · kualitas ${a.qualityPassed ? 'ok' : 'gagal'} · ${a.challenges}`}
            </Text>
          </View>
        ))}
      </View>
      <View style={styles.rowWrap}>
        <Pressable style={[styles.btn, styles.btnSec]} onPress={onBack}>
          <Text style={styles.btnSecText}>Kembali</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnSec]}
          onPress={async () => {
            await clearAttempts();
            setItems([]);
          }}
        >
          <Text style={styles.btnSecText}>Hapus riwayat</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingTop: 56, paddingBottom: 48, gap: 14, backgroundColor: '#f5f6f8', flexGrow: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  h1: { fontSize: 24, fontWeight: '800', color: '#1d2330' },
  h2: { fontSize: 16, fontWeight: '700', marginBottom: 8, color: '#1d2330' },
  label: { fontSize: 13, color: '#6b7280', marginTop: 10, marginBottom: 4 },
  muted: { fontSize: 13, color: '#6b7280' },
  card: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#e3e6eb', padding: 14 },
  input: { borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 16, marginBottom: 8, backgroundColor: '#fff' },
  btn: { backgroundColor: '#2563eb', paddingVertical: 11, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center' },
  btnSec: { backgroundColor: '#e5e7eb' },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  btnSecText: { color: '#1d2330', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  rowWrap: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  profileRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f0f1f3' },
  profileName: { fontSize: 16, fontWeight: '600' },
  verdict: { borderRadius: 10, padding: 18, alignItems: 'center' },
  verdictOk: { backgroundColor: '#dcfce7' },
  verdictBad: { backgroundColor: '#fee2e2' },
  verdictText: { fontSize: 26, fontWeight: '800' },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: '#f0f1f3' },
  historyRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f0f1f3' },
});
