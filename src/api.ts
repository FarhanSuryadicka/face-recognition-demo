// Panggilan langsung ke face-service. Di produksi, app memanggil Laravel,
// lalu Laravel yang meneruskan ke face-service (API key tidak boleh ada di app).

export type EmbedResult = {
  faces_count: number;
  quality: { passed: boolean; issues: string[]; face_width_px: number; blur: number; brightness: number; yaw: number };
  spoof: { real_score: number; is_real: boolean; threshold: number };
  embedding: number[];
  timing_ms: { total: number };
};

export class ApiError extends Error {}

const ERROR_TEXT: Record<string, string> = {
  no_face: 'Wajah tidak terdeteksi di foto',
  unauthorized: 'API key salah (cek Pengaturan)',
  image_too_large: 'Ukuran foto terlalu besar',
  invalid_image: 'Foto tidak valid',
};

export const ISSUE_TEXT: Record<string, string> = {
  multiple_faces: 'lebih dari satu wajah',
  face_too_small: 'wajah terlalu jauh',
  blurry: 'foto buram',
  too_dark: 'terlalu gelap',
  too_bright: 'terlalu terang',
  not_frontal: 'wajah tidak lurus',
};

async function request(url: string, init: RequestInit, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch {
    throw new ApiError(`Server tidak bisa dihubungi (${url}). Cek alamat server, Wi-Fi, dan firewall laptop.`);
  } finally {
    clearTimeout(timer);
  }
}

export async function health(serverUrl: string): Promise<string> {
  const res = await request(`${serverUrl}/health`, {}, 5000);
  const body = await res.json();
  return `${body.status} · v${body.version}`;
}

export async function embed(serverUrl: string, apiKey: string, photoPath: string): Promise<EmbedResult> {
  const form = new FormData();
  const uri = photoPath.startsWith('file://') ? photoPath : `file://${photoPath}`;
  form.append('image', { uri, name: 'selfie.jpg', type: 'image/jpeg' } as any);
  const res = await request(`${serverUrl}/embed`, { method: 'POST', headers: { 'X-API-Key': apiKey }, body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(ERROR_TEXT[body.error] ?? body.message ?? `HTTP ${res.status}`);
  return body as EmbedResult;
}

// embedding sudah dinormalisasi L2 oleh server -> cosine similarity = dot product.
// Ini yang nanti dihitung Laravel.
export function similarity(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
