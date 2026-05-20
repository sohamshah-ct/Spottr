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
  // Gate C additions
  freshness_state?: 'A' | 'B' | 'C' | 'D';
  freshness_label?: string;
  bbox_source?: string;
  place_lat?: number | null;
  place_lng?: number | null;
  besttime_venue_id?: string | null;
  bbox_north?: number;
  bbox_south?: number;
  bbox_east?: number;
  bbox_west?: number;
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

export interface PlaceResult {
  place_id: string;
  description: string;
  mainText: string;
  secondaryText: string;
  lat: number | null;
  lng: number | null;
}

export const api = {
  getLotsNear: (lat: number, lng: number, radius?: number, placeName?: string, placeId?: string, placeType?: string) => {
    const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
    if (radius != null) params.set('radius', String(radius));
    if (placeName) params.set('place_name', placeName);
    if (placeId) params.set('place_id', placeId);
    if (placeType) params.set('place_type', placeType);
    return apiFetch<LotsNearResponse>(`/api/lots/near?${params}`);
  },

  getLotRows: (lotId: string) =>
    apiFetch<RowsResponse>(`/api/lots/${lotId}/rows`),

  getLot: (lotId: string) =>
    apiFetch<Lot>(`/api/lots/${lotId}`),

  searchPlaces: (q: string, lat?: number, lng?: number) => {
    const params = new URLSearchParams({ q });
    if (lat != null) params.set('lat', String(lat));
    if (lng != null) params.set('lng', String(lng));
    return apiFetch<{ results: PlaceResult[]; count: number }>(`/api/search?${params}`);
  },

  // fallback DB-only substring search — unused by SearchSheet but kept for future secondary search
  searchLots: (q: string, lat?: number, lng?: number) => {
    const params = new URLSearchParams({ q });
    if (lat != null) params.set('lat', String(lat));
    if (lng != null) params.set('lng', String(lng));
    return apiFetch<{ lots: Lot[]; count: number }>(`/api/lots/search?${params}`);
  },
};
