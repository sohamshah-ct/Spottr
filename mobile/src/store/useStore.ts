import { create } from 'zustand';
import { Lot } from '../services/api';

interface Store {
  recentLots: Lot[];
  addRecentLot: (lot: Lot) => void;
  searchLat: number | null;
  searchLng: number | null;
  setSearchCoords: (lat: number, lng: number) => void;
}

export const useStore = create<Store>((set) => ({
  recentLots: [],
  addRecentLot: (lot) =>
    set((s) => ({
      recentLots: [lot, ...s.recentLots.filter((l) => l.id !== lot.id)].slice(0, 10),
    })),
  searchLat: null,
  searchLng: null,
  setSearchCoords: (lat, lng) => set({ searchLat: lat, searchLng: lng }),
}));
