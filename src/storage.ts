// Penyimpanan lokal di HP, pengganti sementara database Laravel (tabel employee_faces & log absensi).
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Settings = {
  serverUrl: string;
  apiKey: string;
  threshold: number;
  flipYaw: boolean; // kalau arah "toleh kiri/kanan" terbalik di HP tertentu
};

export type Profile = { id: string; name: string; embeddings: number[][]; createdAt: number };

export type Attempt = {
  at: number;
  profileName: string;
  ok: boolean;
  similarity: number;
  realScore: number;
  qualityPassed: boolean;
  challenges: string;
  note?: string;
};

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: 'http://192.168.1.64:8000',
  apiKey: 'rahasia',
  threshold: 0.45,
  flipYaw: false,
};

async function load<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

async function loadList<T>(key: string): Promise<T[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export const loadSettings = () => load('settings', DEFAULT_SETTINGS);
export const saveSettings = (s: Settings) => AsyncStorage.setItem('settings', JSON.stringify(s));

export const loadProfiles = () => loadList<Profile>('profiles');
export const saveProfiles = (p: Profile[]) => AsyncStorage.setItem('profiles', JSON.stringify(p));

export const loadAttempts = () => loadList<Attempt>('attempts');
export async function addAttempt(a: Attempt) {
  const list = [a, ...(await loadAttempts())].slice(0, 100);
  await AsyncStorage.setItem('attempts', JSON.stringify(list));
}
export const clearAttempts = () => AsyncStorage.removeItem('attempts');
