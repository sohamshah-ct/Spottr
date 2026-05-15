const BASE_URL = (process.env as any).EXPO_PUBLIC_API_URL || 'https://spottr-backend-production.up.railway.app';

export interface Space {
  lat: number;
  lng: number;
  occupied: boolean;
  confidence: number;
  source: 'sam2' | 'grid_fallback';
  row_label?: string;
  space_num?: number;
}

export interface LotRow {
  label: string;
  spaces: Space[];
  open: number;
  total: number;
  occupancy_pct: number | null;
}

export interface Lot {
  id: string;
  name: string | null;
  lot_type: string;
  address: string | null;
  city: string | null;
  state: string | null;
  lat: number;
  lng: number;
  total_spaces: number | null;
  region: string;
  spot_detection_status: string;
  distance_meters?: number;
  spaces?: Space[];
  detection_age_seconds: number | null;
  source: string;
  confidence: number;
  cached: boolean;
  modal_duration_ms?: number | null;
  cars_detected?: number;
  sam2_stripes_found?: number;
  error?: string;
}

export interface LotsNearResponse {
  lots: Lot[];
  count: number;
  source?: string;
}

export interface RowsResponse {
  rows: LotRow[];
  count: number;
  spaces_total: number;
  detection_age_seconds: number | null;
  source: string;
  confidence: number;
  cached: boolean;
  modal_duration_ms?: number | null;
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...((options?.headers ?? {}) as Record<string, string>) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body.slice(0, 120)}`);
  }
  return res.json();
}

export const api = {
  getLotsNear: (lat: number, lng: number) =>
    apiFetch<LotsNearResponse>(`/api/lots/near?lat=${lat}&lng=${lng}`),

  getLotRows: (lotId: string) =>
    apiFetch<RowsResponse>(`/api/lots/${lotId}/rows`),

  getLot: (lotId: string) =>
    apiFetch<Lot>(`/api/lots/${lotId}`),

  searchLots: (q: string, lat?: number, lng?: number) => {
    const params = new URLSearchParams({ q });
    if (lat != null) params.set('lat', String(lat));
    if (lng != null) params.set('lng', String(lng));
    return apiFetch<{ lots: Lot[]; count: number }>(`/api/lots/search?${params}`);
  },
};
