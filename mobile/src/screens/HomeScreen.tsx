/**
 * HomeScreen.tsx — Gate C rebuild
 *
 * Layout:
 *   - MapView (react-native-maps + Mapbox satellite UrlTile) fills screen
 *   - Lot pins on map (accent = fresh A/B/C, dim = D)
 *   - @gorhom/bottom-sheet at 30% / 60% / 95%
 *   - Sheet: SearchBar → "nearby/recent" label → LotCard list
 *
 * Spec: spottr-finalframe.html SCREEN 04
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet,
} from 'react-native';
import MapView, { Marker, UrlTile } from 'react-native-maps';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { api, type Lot } from '../services/api';
import { colors, fonts } from '../theme';
import SearchBar from '../components/SearchBar';
import LotCard from '../components/LotCard';
import type { RootStackParamList } from '../../App';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAPBOX_TOKEN = (process.env as any).EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
const MAPBOX_TILE_URL = `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${MAPBOX_TOKEN}`;
const RECENT_KEY = '@spottr_recent_lots';
const MAX_RECENT = 8;

// ── Types ─────────────────────────────────────────────────────────────────────

type Nav = NativeStackNavigationProp<RootStackParamList, 'Home'>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isFresh(lot: Lot): boolean {
  return lot.freshness_state != null && lot.freshness_state !== 'D';
}

async function loadRecent(): Promise<Lot[]> {
  try {
    const raw = await AsyncStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function saveRecent(lot: Lot, existing: Lot[]): Promise<void> {
  try {
    const filtered = existing.filter(l => l.id !== lot.id);
    const next = [lot, ...filtered].slice(0, MAX_RECENT);
    await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const nav = useNavigation<Nav>();
  const sheetRef = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ['30%', '60%', '95%'], []);

  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [lots, setLots] = useState<Lot[]>([]);
  const [recentLots, setRecentLots] = useState<Lot[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Load recent lots from storage ──────────────────────────────────────────
  useEffect(() => {
    loadRecent().then(setRecentLots);
  }, []);

  // ── Get GPS + fetch nearby lots ───────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (cancelled) return;
        const { latitude: lat, longitude: lng } = pos.coords;
        setLocation({ lat, lng });

        const resp = await api.getLotsNear(lat, lng, 800);
        if (!cancelled) setLots(resp.lots);
      } catch (err) {
        console.warn('[HomeScreen] location/lots error:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Navigate to LotDetail ─────────────────────────────────────────────────
  const handleLotPress = useCallback((lot: Lot) => {
    setRecentLots(prev => {
      const next = [lot, ...prev.filter(l => l.id !== lot.id)].slice(0, MAX_RECENT);
      saveRecent(lot, prev);
      return next;
    });
    nav.navigate('LotDetail', { lotId: lot.id, lotName: lot.name ?? undefined, lot });
  }, [nav]);

  // ── Display list: API lots if available, else recent ─────────────────────
  const displayLots = lots.length > 0 ? lots : recentLots;
  const listLabel = lots.length > 0 ? 'nearby' : 'recent';

  // ── Map region ────────────────────────────────────────────────────────────
  const initialRegion = location
    ? { latitude: location.lat, longitude: location.lng, latitudeDelta: 0.02, longitudeDelta: 0.02 }
    : { latitude: 41.8, longitude: -72.56, latitudeDelta: 0.05, longitudeDelta: 0.05 };

  return (
    <View style={styles.root}>
      {/* ── Map ─────────────────────────────────────────────────────────── */}
      <MapView
        style={StyleSheet.absoluteFillObject}
        initialRegion={initialRegion}
        showsUserLocation
        showsMyLocationButton={false}
        showsCompass={false}
        showsScale={false}
        rotateEnabled={false}
        toolbarEnabled={false}
      >
        {!!MAPBOX_TOKEN && (
          <UrlTile
            urlTemplate={MAPBOX_TILE_URL}
            maximumZ={19}
            flipY={false}
            tileSize={256}
          />
        )}

        {/* Lot pins */}
        {lots.map(lot => (
          <Marker
            key={lot.id}
            coordinate={{ latitude: lot.lat, longitude: lot.lng }}
            onPress={() => handleLotPress(lot)}
            anchor={{ x: 0.5, y: 1 }}
          >
            <View style={[styles.pin, isFresh(lot) ? styles.pinFresh : styles.pinDim]}>
              <Text style={[styles.pinText, isFresh(lot) ? styles.pinTextFresh : styles.pinTextDim]}>
                P
              </Text>
            </View>
            {isFresh(lot) && lot.total_spaces != null && (
              <View style={styles.pinLabel}>
                <Text style={styles.pinLabelText}>
                  {(lot.name ?? 'LOT').toUpperCase().slice(0, 8)} · {lot.total_spaces}
                </Text>
              </View>
            )}
          </Marker>
        ))}
      </MapView>

      {/* ── Bottom Sheet ─────────────────────────────────────────────────── */}
      <BottomSheet
        ref={sheetRef}
        index={0}
        snapPoints={snapPoints}
        backgroundStyle={styles.sheetBg}
        handleIndicatorStyle={styles.sheetHandle}
        enablePanDownToClose={false}
      >
        <BottomSheetScrollView
          contentContainerStyle={styles.sheetContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Search bar — tapping navigates to Search */}
          <SearchBar
            placeholder="where are you going?"
            onPress={() => nav.navigate('Search')}
          />

          {/* List label */}
          {displayLots.length > 0 && (
            <Text style={styles.slab}>{listLabel}</Text>
          )}

          {/* Loading / empty states */}
          {loading && lots.length === 0 && (
            <Text style={styles.emptyText}>Finding nearby lots…</Text>
          )}
          {!loading && displayLots.length === 0 && (
            <Text style={styles.emptyText}>No lots found nearby</Text>
          )}

          {/* Lot cards */}
          {displayLots.map(lot => (
            <LotCard key={lot.id} lot={lot} onPress={handleLotPress} />
          ))}
        </BottomSheetScrollView>
      </BottomSheet>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const PIN_SIZE = 32;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },

  // Pins (spec: accent fill for fresh, s3 fill for dim; diamond via rotate)
  pin: {
    width: PIN_SIZE,
    height: PIN_SIZE,
    borderRadius: PIN_SIZE / 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '45deg' }],
  },
  pinFresh: {
    backgroundColor: colors.a,
    borderColor: colors.a,
  },
  pinDim: {
    backgroundColor: colors.s3,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  pinText: {
    transform: [{ rotate: '-45deg' }],
    fontSize: 13,
    fontFamily: fonts.sansBold,
    lineHeight: 16,
  },
  pinTextFresh: {
    color: colors.bg,
  },
  pinTextDim: {
    color: colors.t2,
  },
  pinLabel: {
    marginTop: 2,
    backgroundColor: colors.bg,
    borderWidth: 0.5,
    borderColor: colors.bs,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignSelf: 'center',
  },
  pinLabelText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.t1,
    letterSpacing: 10 * 0.03,
  },

  // Bottom sheet
  sheetBg: {
    backgroundColor: colors.s1,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  sheetHandle: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    width: 36,
    height: 4,
  },
  sheetContent: {
    paddingHorizontal: 18,
    paddingBottom: 40,
    paddingTop: 4,
  },

  // Section label (.slab)
  slab: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.t3,
    letterSpacing: 11 * 0.06,
    textTransform: 'lowercase',
    marginTop: 14,
    marginBottom: 6,
  },
  emptyText: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.t3,
    marginTop: 20,
    textAlign: 'center',
  },
});
