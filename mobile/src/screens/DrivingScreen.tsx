/**
 * DrivingScreen.tsx — SCREEN 07 (Approach / Driving)
 *
 * Registered under the "Driving" route now; wired to "Approach" in Commit 7.
 *
 * Layout (vertical flex stack — NOT full-screen map overlay):
 *   SafeArea top → header strip (lot name + back)
 *   MapView (flex:1) — current-position dot · ZoneHighlight · AnimatedRoutePath
 *   InstructionBanner
 *   "I'm parked" manual confirm button
 *   SafeArea bottom
 *
 * Behaviour:
 *   - Polls /api/lots/:id/rows every 30 s → LOT FULL mode when openCount === 0
 *   - Dwell detection: GPS inside lot bbox, < 10 m movement for 30 s → auto confirmParked
 *   - "I'm parked" tap → manual confirmParked + navigate('Parked')
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
} from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';

import type { RootStackParamList } from '../../App';
import {
  useParkingStore,
  haversineMeters,
  isInsideBbox,
  etaString,
  zoneLabel,
} from '../services/parkingStateMachine';
import { api } from '../services/api';
import { useTheme, fonts } from '../theme';
import ZoneHighlight from '../components/ZoneHighlight';
import AnimatedRoutePath from '../components/AnimatedRoutePath';
import InstructionBanner, { type BannerMode } from '../components/InstructionBanner';

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS   = 30_000;
const DWELL_THRESHOLD_MS = 30_000;
const DWELL_MOVE_CUTOFF  = 10;

type Nav = NativeStackNavigationProp<RootStackParamList>;

// ── Component ─────────────────────────────────────────────────────────────────

export default function DrivingScreen() {
  const navigation = useNavigation<Nav>();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  // ── Store ──────────────────────────────────────────────────────────────────
  const lot         = useParkingStore(s => s.lot);
  const lotId       = useParkingStore(s => s.lotId);
  const zoneCentLat = useParkingStore(s => s.zoneCentLat);
  const zoneCentLng = useParkingStore(s => s.zoneCentLng);
  const openCount   = useParkingStore(s => s.openCount);
  const zoneName    = useParkingStore(s => s.zoneName);
  const currentLat  = useParkingStore(s => s.currentLat);
  const currentLng  = useParkingStore(s => s.currentLng);
  const confirmParked = useParkingStore(s => s.confirmParked);

  // ── Local state ────────────────────────────────────────────────────────────
  const [bannerMode, setBannerMode] = useState<BannerMode>('approaching');
  const [liveOpenCount, setLiveOpenCount] = useState<number | null>(openCount ?? null);

  // Dwell detection refs
  const dwellAnchorLat  = useRef<number | null>(null);
  const dwellAnchorLng  = useRef<number | null>(null);
  const dwellStartTime  = useRef<number | null>(null);
  const hasConfirmed    = useRef(false);

  // ── Navigate to Parked ────────────────────────────────────────────────────
  const goParked = useCallback(() => {
    if (hasConfirmed.current) return;
    hasConfirmed.current = true;
    confirmParked();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    navigation.replace('Parked', {
      lotId: lotId ?? '',
      lotName: lot?.name ?? undefined,
    });
  }, [confirmParked, navigation, lotId, lot]);

  // ── Dwell detection — runs whenever GPS updates ────────────────────────────
  useEffect(() => {
    if (currentLat == null || currentLng == null || !lot) return;
    if (hasConfirmed.current) return;

    // Must be inside the lot to trigger auto-parked
    if (!isInsideBbox(currentLat, currentLng, lot)) {
      dwellAnchorLat.current = null;
      dwellAnchorLng.current = null;
      dwellStartTime.current = null;
      return;
    }

    const now = Date.now();

    if (dwellAnchorLat.current == null) {
      // First inside-lot fix — set anchor
      dwellAnchorLat.current = currentLat;
      dwellAnchorLng.current = currentLng;
      dwellStartTime.current = now;
      return;
    }

    const moved = haversineMeters(
      currentLat, currentLng,
      dwellAnchorLat.current, dwellAnchorLng.current!,
    );

    if (moved > DWELL_MOVE_CUTOFF) {
      // Significant movement — reset dwell anchor
      dwellAnchorLat.current = currentLat;
      dwellAnchorLng.current = currentLng;
      dwellStartTime.current = now;
      return;
    }

    // Still near anchor — check elapsed dwell time
    if (dwellStartTime.current != null && now - dwellStartTime.current >= DWELL_THRESHOLD_MS) {
      goParked();
    }
  }, [currentLat, currentLng, lot, goParked]);

  // ── Banner mode: update based on position ─────────────────────────────────
  useEffect(() => {
    if (bannerMode === 'full') return; // sticky once full
    if (currentLat == null || currentLng == null || !lot) return;
    const inside = isInsideBbox(currentLat, currentLng, lot);
    setBannerMode(inside ? 'arrived' : 'approaching');
  }, [currentLat, currentLng, lot, bannerMode]);

  // ── 30 s lot-rows poll ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!lotId) return;

    const poll = async () => {
      try {
        const data = await api.getLotRows(lotId);
        const total = data.rows.reduce((s, r) => s + r.open, 0);
        setLiveOpenCount(total);
        if (total === 0) {
          setBannerMode('full');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
        }
      } catch {
        // ignore poll errors — don't disrupt driving UX
      }
    };

    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [lotId]);

  // ── Map region ────────────────────────────────────────────────────────────
  const mapRegion = {
    latitude:      currentLat  ?? lot?.lat  ?? (zoneCentLat ?? 0),
    longitude:     currentLng  ?? lot?.lng  ?? (zoneCentLng ?? 0),
    latitudeDelta:  0.006,
    longitudeDelta: 0.006,
  };

  // ── Banner subtitle ───────────────────────────────────────────────────────
  const zoneDesc = zoneLabel(zoneName);
  let subtitle: string | undefined;
  if (bannerMode === 'full') {
    subtitle = 'Rerouting…';
  } else if (currentLat != null && currentLng != null && zoneCentLat != null && zoneCentLng != null) {
    const dist = haversineMeters(currentLat, currentLng, zoneCentLat, zoneCentLng);
    const eta  = etaString(dist);
    const cnt  = liveOpenCount ?? openCount;
    subtitle = cnt != null
      ? `${cnt} open · ${zoneDesc} · ${eta}`
      : `${zoneDesc} · ${eta}`;
  }

  return (
    <View style={[s.root, { backgroundColor: colors.bg }]}>
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <View style={[s.header, { paddingTop: insets.top + 8, backgroundColor: colors.s1, borderBottomColor: colors.b }]}>
        <TouchableOpacity
          style={s.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={[s.backIcon, { color: colors.a, fontFamily: fonts.sansMd }]}>←</Text>
        </TouchableOpacity>
        <Text style={[s.headerTitle, { color: colors.t1, fontFamily: fonts.sansMd }]} numberOfLines={1}>
          {lot?.name ?? 'Navigating'}
        </Text>
        <View style={s.backBtn} />
      </View>

      {/* ── Map ───────────────────────────────────────────────────────────── */}
      <MapView
        style={s.map}
        region={mapRegion}
        showsUserLocation
        showsMyLocationButton={false}
        showsCompass={false}
        rotateEnabled={false}
        pitchEnabled={false}
      >
        {/* Zone centroid highlight */}
        {zoneCentLat != null && zoneCentLng != null && (
          <ZoneHighlight
            lat={zoneCentLat}
            lng={zoneCentLng}
            radius={30}
            pulse={bannerMode === 'arrived'}
          />
        )}

        {/* Dashed route line */}
        {currentLat  != null && currentLng  != null &&
         zoneCentLat != null && zoneCentLng != null && (
          <AnimatedRoutePath
            fromLat={currentLat}
            fromLng={currentLng}
            toLat={zoneCentLat}
            toLng={zoneCentLng}
            visible={bannerMode === 'approaching'}
          />
        )}

        {/* Lot centre pin (fallback when user location dot is off-screen) */}
        {lot && (
          <Marker
            coordinate={{ latitude: lot.lat, longitude: lot.lng }}
            anchor={{ x: 0.5, y: 1 }}
          >
            <View style={[s.pin, { backgroundColor: colors.a }]}>
              <Text style={[s.pinText, { color: colors.bg, fontFamily: fonts.sansBold }]}>P</Text>
            </View>
          </Marker>
        )}
      </MapView>

      {/* ── Instruction banner ────────────────────────────────────────────── */}
      <InstructionBanner mode={bannerMode} subtitle={subtitle} />

      {/* ── Bottom action ─────────────────────────────────────────────────── */}
      <View style={[s.bottom, { paddingBottom: insets.bottom + 12, backgroundColor: colors.s1, borderTopColor: colors.b }]}>
        {bannerMode === 'full' ? (
          <TouchableOpacity
            style={[s.reroute, { backgroundColor: colors.warnBg, borderColor: colors.warn }]}
            onPress={() => navigation.navigate('Reroute', {
              lotId:      lotId ?? '',
              oldRow:     zoneDesc,
              newRow:     '',
              newRowLat:  lot?.lat ?? 0,
              newRowLng:  lot?.lng ?? 0,
              openCount:  0,
              lotName:    lot?.name ?? undefined,
            })}
            activeOpacity={0.82}
          >
            <Text style={[s.rerouteText, { color: colors.warn, fontFamily: fonts.sansMd }]}>
              Find alternate lot
            </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[s.parkedBtn, { backgroundColor: colors.a }]}
            onPress={goParked}
            activeOpacity={0.85}
          >
            <Text style={[s.parkedBtnText, { color: colors.bg, fontFamily: fonts.sansMd }]}>
              I'm parked
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: 0.5,
  },
  backBtn: {
    width: 40,
    alignItems: 'flex-start',
  },
  backIcon: {
    fontSize: 22,
  },
  headerTitle: {
    flex: 1,
    fontSize: 15,
    textAlign: 'center',
  },
  map: {
    flex: 1,
  },
  pin: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '45deg' }],
  },
  pinText: {
    fontSize: 11,
    transform: [{ rotate: '-45deg' }],
  },
  bottom: {
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: 0.5,
  },
  parkedBtn: {
    borderRadius: 13,
    paddingVertical: 15,
    alignItems: 'center',
  },
  parkedBtnText: {
    fontSize: 15,
  },
  reroute: {
    borderRadius: 13,
    paddingVertical: 15,
    alignItems: 'center',
    borderWidth: 1,
  },
  rerouteText: {
    fontSize: 15,
  },
});
