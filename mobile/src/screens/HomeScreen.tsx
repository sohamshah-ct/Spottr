/**
 * HomeScreen.tsx — Gate C rebuild
 *
 * Layout:
 *   - MapView (react-native-maps + Mapbox satellite UrlTile) fills screen
 *   - Lot pins on map (accent = fresh A/B/C, dim = D)
 *   - Animated bottom sheet at 30% / 60% / 95% (pure RN Animated, no native deps)
 *   - Sheet: SearchBar → "nearby/recent" label → LotCard list
 *
 * Spec: spottr-finalframe.html SCREEN 04
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Animated, PanResponder, Dimensions, ScrollView,
} from 'react-native';
import MapView, { Marker, UrlTile } from 'react-native-maps';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { api, type Lot } from '../services/api';
import { useTheme, fonts } from '../theme';
import SearchBar from '../components/SearchBar';
import LotCard from '../components/LotCard';
import type { RootStackParamList } from '../../App';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAPBOX_TOKEN = (process.env as any).EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
const MAPBOX_TILE_URL = `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${MAPBOX_TOKEN}`;
const RECENT_KEY = '@spottr_recent_lots';
const MAX_RECENT = 8;

const { height: SCREEN_H } = Dimensions.get('window');
const SNAP_30  = SCREEN_H * 0.70;
const SNAP_60  = SCREEN_H * 0.40;
const SNAP_95  = SCREEN_H * 0.05;
const SNAPS    = [SNAP_30, SNAP_60, SNAP_95];

function nearestSnap(y: number): number {
  return SNAPS.reduce((prev, curr) =>
    Math.abs(curr - y) < Math.abs(prev - y) ? curr : prev
  );
}

const PIN_SIZE = 32;

type Nav = NativeStackNavigationProp<RootStackParamList, 'Home'>;

function isFresh(lot: Lot): boolean {
  return lot.freshness_state != null && lot.freshness_state !== 'D';
}

async function loadRecent(): Promise<Lot[]> {
  try {
    const raw = await AsyncStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function saveRecent(lot: Lot, existing: Lot[]): Promise<void> {
  try {
    const next = [lot, ...existing.filter(l => l.id !== lot.id)].slice(0, MAX_RECENT);
    await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const { colors } = useTheme();
  const nav = useNavigation<Nav>();
  const translateY = useRef(new Animated.Value(SNAP_30)).current;
  const lastY = useRef(SNAP_30);

  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [lots, setLots] = useState<Lot[]>([]);
  const [recentLots, setRecentLots] = useState<Lot[]>([]);
  const [loading, setLoading] = useState(true);

  const snapTo = useCallback((y: number) => {
    lastY.current = y;
    Animated.spring(translateY, {
      toValue: y,
      useNativeDriver: true,
      tension: 68,
      friction: 12,
    }).start();
  }, [translateY]);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 5,
      onPanResponderGrant: () => {
        translateY.stopAnimation(v => { lastY.current = v; });
        (translateY as any).setOffset(lastY.current);
        (translateY as any).setValue(0);
      },
      onPanResponderMove: Animated.event([null, { dy: translateY }], { useNativeDriver: false }),
      onPanResponderRelease: (_, g) => {
        (translateY as any).flattenOffset();
        const rawY = lastY.current + g.dy;
        const clampedY = Math.max(SNAP_95, Math.min(SNAP_30, rawY));
        const snap = g.vy > 0.5 ? SNAP_30 : g.vy < -0.5 ? SNAP_95 : nearestSnap(clampedY);
        snapTo(snap);
      },
    })
  ).current;

  useEffect(() => { loadRecent().then(setRecentLots); }, []);

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

  const handleLotPress = useCallback((lot: Lot) => {
    setRecentLots(prev => {
      const next = [lot, ...prev.filter(l => l.id !== lot.id)].slice(0, MAX_RECENT);
      saveRecent(lot, prev);
      return next;
    });
    nav.navigate('LotDetail', { lotId: lot.id, lotName: lot.name ?? undefined, lot });
  }, [nav]);

  const displayLots = lots.length > 0 ? lots : recentLots;
  const listLabel   = lots.length > 0 ? 'nearby' : 'recent';

  const initialRegion = location
    ? { latitude: location.lat, longitude: location.lng, latitudeDelta: 0.02, longitudeDelta: 0.02 }
    : { latitude: 41.8, longitude: -72.56, latitudeDelta: 0.05, longitudeDelta: 0.05 };

  return (
    <View style={[s.root, { backgroundColor: colors.bg }]}>
      {/* ── Map ───────────────────────────────────────────────────────────── */}
      <MapView
        style={StyleSheet.absoluteFillObject}
        initialRegion={initialRegion}
        showsUserLocation
        showsMyLocationButton={false}
        showsCompass={false}
        rotateEnabled={false}
        toolbarEnabled={false}
      >
        {!!MAPBOX_TOKEN && (
          <UrlTile urlTemplate={MAPBOX_TILE_URL} maximumZ={19} flipY={false} tileSize={256} />
        )}
        {lots.map(lot => {
          const fresh = isFresh(lot);
          return (
            <Marker
              key={lot.id}
              coordinate={{ latitude: lot.lat, longitude: lot.lng }}
              onPress={() => handleLotPress(lot)}
              anchor={{ x: 0.5, y: 1 }}
            >
              <View style={[
                s.pin,
                {
                  backgroundColor: fresh ? colors.a    : colors.s3,
                  borderColor:     fresh ? colors.a    : 'rgba(255,255,255,0.4)',
                },
              ]}>
                <Text style={[s.pinText, { color: fresh ? colors.bg : colors.t2 }]}>P</Text>
              </View>
              {fresh && lot.total_spaces != null && (
                <View style={[s.pinLabel, { backgroundColor: colors.bg, borderColor: colors.bs }]}>
                  <Text style={[s.pinLabelText, { color: colors.t1 }]}>
                    {(lot.name ?? 'LOT').toUpperCase().slice(0, 8)} · {lot.total_spaces}
                  </Text>
                </View>
              )}
            </Marker>
          );
        })}
      </MapView>

      {/* ── Animated bottom sheet ─────────────────────────────────────────── */}
      <Animated.View
        style={[s.sheet, { backgroundColor: colors.s1, transform: [{ translateY }] }]}
        {...panResponder.panHandlers}
      >
        <View style={[s.handle, { backgroundColor: 'rgba(255,255,255,0.18)' }]} />

        <View style={s.sheetContent}>
          <SearchBar placeholder="where are you going?" onPress={() => nav.navigate('Search')} />
          {displayLots.length > 0 && (
            <Text style={[s.slab, { color: colors.t3 }]}>{listLabel}</Text>
          )}
          {loading && lots.length === 0 && (
            <Text style={[s.emptyText, { color: colors.t3 }]}>Finding nearby lots…</Text>
          )}
          {!loading && displayLots.length === 0 && (
            <Text style={[s.emptyText, { color: colors.t3 }]}>No lots found nearby</Text>
          )}
        </View>

        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
        >
          {displayLots.map(lot => (
            <LotCard key={lot.id} lot={lot} onPress={handleLotPress} />
          ))}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

// ── Styles — no color values; all colors applied inline ───────────────────────

const s = StyleSheet.create({
  root: { flex: 1 },

  pin: {
    width: PIN_SIZE, height: PIN_SIZE, borderRadius: PIN_SIZE / 2,
    borderWidth: 2, alignItems: 'center', justifyContent: 'center',
    transform: [{ rotate: '45deg' }],
  },
  pinText: { transform: [{ rotate: '-45deg' }], fontSize: 13, fontFamily: fonts.sansBold, lineHeight: 16 },
  pinLabel: {
    marginTop: 2, borderWidth: 0.5,
    borderRadius: 4, paddingHorizontal: 8, paddingVertical: 4, alignSelf: 'center',
  },
  pinLabelText: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 0.3 },

  sheet: {
    position: 'absolute', left: 0, right: 0,
    height: SCREEN_H,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.3, shadowRadius: 12, elevation: 20,
  },
  handle: {
    width: 36, height: 4,
    borderRadius: 2, alignSelf: 'center', marginTop: 10, marginBottom: 8,
  },
  sheetContent: { paddingHorizontal: 18 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 18, paddingBottom: 40 },

  slab: {
    fontFamily: fonts.mono, fontSize: 11,
    letterSpacing: 11 * 0.06, textTransform: 'lowercase',
    marginTop: 14, marginBottom: 6,
  },
  emptyText: {
    fontFamily: fonts.sans, fontSize: 14,
    marginTop: 20, textAlign: 'center',
  },
});
