/**
 * parkingStateMachine.ts — Zustand store + GPS watcher for parking flow
 *
 * State machine: IDLE → APPROACHING → PARKED → IDLE
 *
 * Architecture rules:
 *  - This store is the ONLY place Zustand is used in Spottr.
 *  - Gate C screens (Home, Search, LotDetail) keep their local useState.
 *  - Navigation calls live in screens, NOT in this file.
 *  - GPS subscription is module-level (not inside the store) so it survives
 *    React re-renders and can be started/stopped from anywhere.
 *
 * Usage:
 *   // In LotDetailScreen — "Take me there" handler:
 *   store.startSearching({ lotId, lot, zoneCentLat, zoneCentLng, openCount, zoneName });
 *   startParkingWatcher();
 *   openMaps(destLat, destLng);
 *   navigation.navigate('Approach', { lotId, lot, zoneCentLat, zoneCentLng, openCount, zoneName });
 *
 *   // In DrivingScreen — dwell detected:
 *   store.confirmParked();
 *   navigation.navigate('Parked', { lotId, lotName });
 *
 *   // In ParkedScreen — "Done parking":
 *   store.clearParked();
 *   stopParkingWatcher();
 *   navigation.navigate('Home');
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import type { Lot } from './api';

// ── State type ────────────────────────────────────────────────────────────────

export type ParkingPhase = 'IDLE' | 'APPROACHING' | 'PARKED';

export interface SearchingParams {
  lotId: string;
  lot: Lot;
  zoneCentLat: number;
  zoneCentLng: number;
  openCount: number;
  zoneName: string | null;
}

interface ParkingStore {
  phase: ParkingPhase;

  // Target lot (set when APPROACHING)
  lotId: string | null;
  lot: Lot | null;
  zoneCentLat: number | null;
  zoneCentLng: number | null;
  openCount: number | null;
  zoneName: string | null;

  // Live GPS — NOT persisted; always refreshed by watcher
  currentLat: number | null;
  currentLng: number | null;

  // Parked record (persisted — enables cold-launch rehydration)
  parkedAt: number | null;        // epoch ms
  parkedLat: number | null;
  parkedLng: number | null;
  parkedDescription: string | null;
  timeSavedMin: number | null;

  // Actions
  startSearching: (params: SearchingParams) => void;
  confirmParked: () => void;
  clearParked: () => void;
  reset: () => void;
  /** Internal — called by GPS watcher only */
  _setPosition: (lat: number, lng: number) => void;
}

// ── Helpers (exported for use in screens) ────────────────────────────────────

export function haversineMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => d * (Math.PI / 180);
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Maps zone name (A/B/C/D or null) to a human-readable description. */
export function zoneLabel(zoneName: string | null): string {
  if (!zoneName) return 'Front zone';
  const u = zoneName.trim().toUpperCase();
  if (u === 'A') return 'Front zone';
  if (u === 'B') return 'Mid zone';
  return 'Back zone';
}

/** Builds the one-line parked location description shown on ParkedScreen. */
export function buildParkedDescription(lot: Lot | null, zoneName: string | null): string {
  const zone = zoneLabel(zoneName);
  if (lot?.name) return `${zone} · ${lot.name}`;
  if (lot?.address) return `${zone} · ${lot.address}`;
  return zone;
}

/**
 * Human ETA string based on straight-line distance (walking speed 1.4 m/s).
 * Used by DrivingScreen InstructionBanner.
 */
export function etaString(distanceMeters: number): string {
  if (distanceMeters < 30) return 'arriving';
  const sec = distanceMeters / 1.4;
  if (sec < 90) return 'under 2 min';
  const min = Math.round(sec / 60);
  return `${min} min`;
}

/**
 * Returns true if (lat, lng) is inside the lot's bbox.
 * Falls back to a 250m radius check when bbox columns are absent.
 */
export function isInsideBbox(lat: number, lng: number, lot: Lot): boolean {
  if (
    lot.bbox_north != null && lot.bbox_south != null &&
    lot.bbox_east  != null && lot.bbox_west  != null
  ) {
    return (
      lat >= lot.bbox_south && lat <= lot.bbox_north &&
      lng >= lot.bbox_west  && lng <= lot.bbox_east
    );
  }
  return haversineMeters(lat, lng, lot.lat, lot.lng) < 250;
}

// ── Module-level GPS watcher ──────────────────────────────────────────────────

let _locationSub: Location.LocationSubscription | null = null;

/**
 * Starts the high-accuracy GPS watcher.
 * Safe to call multiple times — no-ops if already watching.
 */
export async function startParkingWatcher(): Promise<void> {
  if (_locationSub) return;
  const { status } = await Location.getForegroundPermissionsAsync();
  if (status !== 'granted') return;
  _locationSub = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.High,
      distanceInterval: 8,   // emit when moved ≥ 8 m
      timeInterval: 4_000,   // or every 4 s (whichever comes first)
    },
    ({ coords }) => {
      useParkingStore.getState()._setPosition(coords.latitude, coords.longitude);
    },
  );
}

/** Stops the GPS watcher and releases the OS subscription. */
export function stopParkingWatcher(): void {
  _locationSub?.remove();
  _locationSub = null;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useParkingStore = create<ParkingStore>()(
  persist(
    (set, get) => ({
      // ── Initial state ───────────────────────────────────────────────────────
      phase: 'IDLE',

      lotId:       null,
      lot:         null,
      zoneCentLat: null,
      zoneCentLng: null,
      openCount:   null,
      zoneName:    null,

      currentLat: null,
      currentLng: null,

      parkedAt:          null,
      parkedLat:         null,
      parkedLng:         null,
      parkedDescription: null,
      timeSavedMin:      null,

      // ── Actions ─────────────────────────────────────────────────────────────

      startSearching: ({ lotId, lot, zoneCentLat, zoneCentLng, openCount, zoneName }) =>
        set({
          phase: 'APPROACHING',
          lotId,
          lot,
          zoneCentLat,
          zoneCentLng,
          openCount,
          zoneName,
          // clear any stale parked record from a prior session
          parkedAt:          null,
          parkedLat:         null,
          parkedLng:         null,
          parkedDescription: null,
          timeSavedMin:      null,
        }),

      confirmParked: () => {
        const { currentLat, currentLng, lot, zoneName, parkedAt } = get();
        // Idempotent — if already PARKED, do not overwrite the record.
        if (parkedAt !== null) return;
        set({
          phase:             'PARKED',
          parkedAt:          Date.now(),
          parkedLat:         currentLat,
          parkedLng:         currentLng,
          parkedDescription: buildParkedDescription(lot, zoneName),
          timeSavedMin:      null,
        });
      },

      clearParked: () =>
        set({
          phase: 'IDLE',
          parkedAt:          null,
          parkedLat:         null,
          parkedLng:         null,
          parkedDescription: null,
          timeSavedMin:      null,
        }),

      reset: () => {
        stopParkingWatcher();
        set({
          phase:       'IDLE',
          lotId:       null,
          lot:         null,
          zoneCentLat: null,
          zoneCentLng: null,
          openCount:   null,
          zoneName:    null,
          currentLat:  null,
          currentLng:  null,
          parkedAt:          null,
          parkedLat:         null,
          parkedLng:         null,
          parkedDescription: null,
          timeSavedMin:      null,
        });
      },

      _setPosition: (lat, lng) => set({ currentLat: lat, currentLng: lng }),
    }),

    {
      name:    'parking-state-v1',
      storage: createJSONStorage(() => AsyncStorage),
      // Exclude live GPS from persistence — always fresh from watcher
      partialize: (s): Omit<ParkingStore,
        | 'currentLat' | 'currentLng'
        | 'startSearching' | 'confirmParked' | 'clearParked' | 'reset' | '_setPosition'
      > => ({
        phase:             s.phase,
        lotId:             s.lotId,
        lot:               s.lot,
        zoneCentLat:       s.zoneCentLat,
        zoneCentLng:       s.zoneCentLng,
        openCount:         s.openCount,
        zoneName:          s.zoneName,
        parkedAt:          s.parkedAt,
        parkedLat:         s.parkedLat,
        parkedLng:         s.parkedLng,
        parkedDescription: s.parkedDescription,
        timeSavedMin:      s.timeSavedMin,
      }),
    },
  ),
);
