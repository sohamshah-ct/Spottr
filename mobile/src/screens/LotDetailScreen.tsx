/**
 * LotDetailScreen.tsx — Gate C rebuild
 *
 * Layout:
 *   - MapView fills the full screen (behind the sheet)
 *   - Live Sat toggle: absolute, top-right, above sheet, zIndex 20
 *   - Animated bottom sheet (Animated.Value + PanResponder, no native deps)
 *     snaps between SNAP_LOW (40% visible) and SNAP_HIGH (92% visible)
 *   - Sheet: name/address + BigNumberCount + FreshnessLabel + ZoneThumbnail
 *            + all zone rows + "Take me there" CTA + stats row + ConfidencePill
 *
 * Spec: spottr-finalframe.html SCREEN 06
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Platform, Linking, RefreshControl,
  Animated, PanResponder, Dimensions,
} from 'react-native';
import MapView, { Marker, UrlTile, Circle } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { api, type Lot, type RowsResponse, type Space, type Zone } from '../services/api';
import { colors, fonts } from '../theme';
import BigNumberCount from '../components/BigNumberCount';
import FreshnessLabel from '../components/FreshnessLabel';
import ZoneThumbnail from '../components/ZoneThumbnail';
import ConfidencePill from '../components/ConfidencePill';
import type { RootStackParamList } from '../../App';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAPBOX_TOKEN = (process.env as any).EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
const MAPBOX_TILE_URL = `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${MAPBOX_TOKEN}`;

const { height: SCREEN_H } = Dimensions.get('window');
// Snap positions: translateY = distance from screen top to sheet top
const SNAP_LOW  = SCREEN_H * 0.60; // collapsed — 40% of screen visible
const SNAP_HIGH = SCREEN_H * 0.08; // expanded  — 92% of screen visible
const SNAPS     = [SNAP_LOW, SNAP_HIGH];

function nearestSnap(y: number): number {
  return SNAPS.reduce((prev, curr) =>
    Math.abs(curr - y) < Math.abs(prev - y) ? curr : prev
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Props = NativeStackScreenProps<RootStackParamList, 'LotDetail'>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function distanceLabel(meters: number | undefined): string | null {
  if (meters == null) return null;
  if (meters < 1600) return `${Math.round(meters / 160) / 10} mi`;
  return `${(meters / 1609).toFixed(1)} mi`;
}

function openMaps(lat: number, lng: number): void {
  const url = Platform.select({
    ios: `maps://app?daddr=${lat},${lng}`,
    android: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
  }) ?? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  Linking.openURL(url).catch(err => console.warn('[LotDetail] openMaps error:', err));
}

function regionFromLot(lot: Lot) {
  if (lot.bbox_north && lot.bbox_south && lot.bbox_east && lot.bbox_west) {
    const latDelta = (lot.bbox_north - lot.bbox_south) * 1.15;
    const lngDelta = (lot.bbox_east - lot.bbox_west) * 1.15;
    return {
      latitude: (lot.bbox_north + lot.bbox_south) / 2,
      longitude: (lot.bbox_east + lot.bbox_west) / 2,
      latitudeDelta: Math.max(latDelta, 0.002),
      longitudeDelta: Math.max(lngDelta, 0.002),
    };
  }
  return { latitude: lot.lat, longitude: lot.lng, latitudeDelta: 0.006, longitudeDelta: 0.006 };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function LotDetailScreen({ route, navigation }: Props) {
  const { lotId, lotName, lot: routeLot } = route.params ?? {};
  const insets = useSafeAreaInsets();

  const [lot, setLot] = useState<Lot | null>(routeLot ?? null);
  const [rowsData, setRowsData] = useState<RowsResponse | null>(null);
  // loading: full-screen spinner only when we have no lot data at all
  const [loading, setLoading] = useState(!routeLot);
  const [refreshing, setRefreshing] = useState(false);
  const [showMarkers, setShowMarkers] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slowLoad, setSlowLoad] = useState(false);

  // ── Animated sheet ──────────────────────────────────────────────────────────
  const translateY = useRef(new Animated.Value(SNAP_LOW)).current;
  const lastY = useRef(SNAP_LOW);

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
        const clampedY = Math.max(SNAP_HIGH, Math.min(SNAP_LOW, rawY));
        const snap = g.vy > 0.5 ? SNAP_LOW : g.vy < -0.5 ? SNAP_HIGH : nearestSnap(clampedY);
        snapTo(snap);
      },
    })
  ).current;

  // ── Data loading ────────────────────────────────────────────────────────────

  const load = useCallback(async (isRefresh = false) => {
    // Full-screen spinner only when we have no lot data yet; never on refreshes or
    // background row fetches (which just update counts inside the already-rendered sheet).
    const needsFullSpinner = !lot && !isRefresh;
    let slowTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      if (needsFullSpinner) {
        setLoading(true);
        slowTimer = setTimeout(() => setSlowLoad(true), 30000);
      }
      setError(null);
      const [rowsRes, lotRes] = await Promise.all([
        api.getLotRows(lotId),
        lot ? Promise.resolve(lot) : api.getLot(lotId),
      ]);
      setRowsData(rowsRes);
      if (!lot || isRefresh) setLot(lotRes as Lot);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load');
    } finally {
      if (slowTimer) clearTimeout(slowTimer);
      setSlowLoad(false);
      setLoading(false);
      setRefreshing(false);
    }
  }, [lotId, lot]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (lot?.name) navigation.setOptions({ title: lot.name });
  }, [lot, navigation]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load(true);
  }, [load]);

  // ── Loading / error states ─────────────────────────────────────────────────
  if (loading && !lot) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator size="large" color={colors.a} />
        <Text style={styles.loadingText}>{lotName ?? 'Loading lot…'}</Text>
        {slowLoad && (
          <Text style={styles.slowText}>Still working… large lots take a moment</Text>
        )}
      </View>
    );
  }

  if (error && !lot) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => load()}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Derived data ──────────────────────────────────────────────────────────
  const displayLot = lot!;
  const rows = rowsData?.rows ?? [];
  const allSpaces: Space[] = rows.flatMap(r => r.spaces ?? []);
  const openCount = rows.reduce((s, r) => s + r.open, 0);
  const totalCapacity = displayLot.total_spaces ?? rowsData?.spaces_total ?? null;
  const occupancyPct = totalCapacity && totalCapacity > 0
    ? Math.round(((totalCapacity - openCount) / totalCapacity) * 100)
    : null;

  const freshState = displayLot.freshness_state ?? 'D';
  const freshLabel = displayLot.freshness_label ?? 'Capacity only';

  // Bug I: route to the best zone centroid (most open spaces), not the storefront pin
  const sortedZones: Zone[] = (rowsData?.zones ?? [])
    .filter((z): z is Zone => z.centroid_lat != null && z.centroid_lng != null)
    .sort((a, b) => b.open_count - a.open_count);
  const destLat = sortedZones[0]?.centroid_lat ?? displayLot.place_lat ?? displayLot.lat;
  const destLng = sortedZones[0]?.centroid_lng ?? displayLot.place_lng ?? displayLot.lng;
  const dist = distanceLabel(displayLot.distance_meters);

  const mapRegion = regionFromLot(displayLot);

  return (
    <View style={styles.root}>
      {/* ── Map — fills full screen behind sheet ──────────────────────────── */}
      <MapView
        style={StyleSheet.absoluteFillObject}
        region={mapRegion}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        rotateEnabled={false}
        scrollEnabled={false}
        zoomEnabled={false}
        pitchEnabled={false}
      >
        {!!MAPBOX_TOKEN && (
          <UrlTile urlTemplate={MAPBOX_TILE_URL} maximumZ={19} flipY={false} tileSize={256} />
        )}
        <Marker coordinate={{ latitude: displayLot.lat, longitude: displayLot.lng }} anchor={{ x: 0.5, y: 1 }}>
          <View style={styles.centerPin}>
            <Text style={styles.centerPinText}>P</Text>
          </View>
        </Marker>
        {showMarkers && allSpaces.map((sp, i) => (
          <Circle
            key={i}
            center={{ latitude: sp.lat, longitude: sp.lng }}
            radius={1.2}
            strokeColor={sp.occupied ? colors.full : colors.a}
            fillColor={sp.occupied ? colors.full : colors.a}
            strokeWidth={0}
          />
        ))}
      </MapView>

      {/* ── Live Sat toggle — sibling above sheet, high zIndex ────────────── */}
      <TouchableOpacity
        style={[styles.satToggle, { top: insets.top + 10 }]}
        onPress={() => setShowMarkers(v => !v)}
        activeOpacity={0.8}
      >
        <Text style={[styles.satToggleText, !showMarkers && styles.satToggleInactive]}>
          {showMarkers ? 'AI Map' : 'Live Sat'}
        </Text>
      </TouchableOpacity>

      {/* ── Animated bottom sheet ─────────────────────────────────────────── */}
      <Animated.View
        style={[styles.sheet, { transform: [{ translateY }], paddingBottom: insets.bottom + 12 }]}
        {...panResponder.panHandlers}
      >
        {/* Handle — visual cue that sheet is draggable */}
        <View style={styles.handle} />

        <ScrollView
          contentContainerStyle={styles.sheetContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.a} />
          }
        >
          {/* ── Header: name + address + distance (.dhead) ─────────────── */}
          <View style={styles.dhead}>
            <View style={styles.dheadLeft}>
              <Text style={styles.dn} numberOfLines={2}>{displayLot.name ?? `Lot ${lotId.slice(0, 8)}`}</Text>
              {(displayLot.address || displayLot.city) && (
                <Text style={styles.da} numberOfLines={2}>
                  {[displayLot.address, displayLot.city, displayLot.state].filter(Boolean).join(', ')}
                </Text>
              )}
            </View>
            {dist && <Text style={styles.dd}>{dist}</Text>}
          </View>

          {/* ── Big number (.bnb / .bn) ────────────────────────────────── */}
          <BigNumberCount count={freshState === 'D' ? totalCapacity : openCount} label="spots open" />

          {/* ── Freshness (.fr) ───────────────────────────────────────── */}
          <FreshnessLabel label={freshLabel} style={styles.fr} />

          {/* ── Best zone thumbnail + remaining zones ─────────────────── */}
          {rows.length > 0 && <ZoneThumbnail rows={rows} />}
          {rows.length > 1 && (
            [...rows]
              .sort((a, b) => b.open - a.open)
              .slice(1)
              .map(row => (
                <View key={row.label} style={styles.zoneRow}>
                  <Text style={styles.zoneRowLabel}>Zone {row.label}</Text>
                  <Text style={styles.zoneRowCount}>{row.open} / {row.total} open</Text>
                </View>
              ))
          )}

          {/* ── "Take me there" CTA (.tk) ─────────────────────────────── */}
          <TouchableOpacity
            style={styles.tk}
            onPress={() => openMaps(destLat, destLng)}
            activeOpacity={0.85}
          >
            <Text style={styles.tkIcon}>→</Text>
            <Text style={styles.tkText}>Take me there</Text>
          </TouchableOpacity>

          {/* ── Stats row (.secln) — TYPICAL omitted when no BestTime ──── */}
          <View style={styles.secln}>
            <View style={styles.si}>
              <Text style={styles.sil}>CAPACITY</Text>
              <Text style={styles.siv}>{totalCapacity ?? '—'}</Text>
            </View>
            <View style={styles.si}>
              <Text style={styles.sil}>% FULL</Text>
              <Text style={styles.siv}>{occupancyPct != null ? `${occupancyPct}%` : '—'}</Text>
            </View>
          </View>

          {/* ── Confidence pill ───────────────────────────────────────── */}
          <ConfidencePill bboxSource={displayLot.bbox_source} />
        </ScrollView>
      </Animated.View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.t3,
    marginTop: 12,
  },
  slowText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.t4,
    marginTop: 8,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  errorText: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.full,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  retryBtn: {
    marginTop: 12,
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.s2,
    borderWidth: 0.5,
    borderColor: colors.bs,
  },
  retryText: {
    fontFamily: fonts.sansMd,
    fontSize: 14,
    color: colors.a,
  },

  // Centre pin on map
  centerPin: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.a,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '45deg' }],
  },
  centerPinText: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    color: colors.bg,
    transform: [{ rotate: '-45deg' }],
  },

  // Live Sat / AI Map toggle — absolute sibling, above the sheet
  satToggle: {
    position: 'absolute',
    right: 14,
    zIndex: 20,
    backgroundColor: 'rgba(10,10,10,0.82)',
    borderWidth: 1,
    borderColor: colors.a,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  satToggleText: {
    fontFamily: fonts.monoMd,
    fontSize: 11,
    color: colors.a,
    letterSpacing: 11 * 0.05,
    textTransform: 'uppercase',
  },
  satToggleInactive: {
    color: colors.t3,
  },

  // Animated sheet
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: SCREEN_H,
    backgroundColor: colors.s1,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 20,
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 4,
  },
  sheetContent: {
    paddingHorizontal: 20,
    paddingTop: 6,
    paddingBottom: 20,
  },

  // Header (.dhead / .dn / .da / .dd)
  dhead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginTop: 6,
    gap: 14,
  },
  dheadLeft: {
    flex: 1,
  },
  dn: {
    fontFamily: fonts.sansMd,
    fontSize: 17,
    color: colors.t1,
    lineHeight: 17 * 1.2,
    marginBottom: 3,
  },
  da: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.t3,
    lineHeight: 12 * 1.4,
  },
  dd: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.t2,
  },

  // Freshness (.fr)
  fr: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.t3,
    textAlign: 'left',
    marginTop: 0,
  },

  // CTA (.tk)
  tk: {
    backgroundColor: colors.a,
    borderRadius: 13,
    paddingVertical: 15,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 4,
  },
  tkIcon: {
    fontSize: 18,
    color: colors.bg,
    fontFamily: fonts.sans,
  },
  tkText: {
    fontFamily: fonts.sansMd,
    fontSize: 15,
    color: colors.bg,
  },

  // Stats row (.secln / .si / .sil / .siv)
  secln: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
    paddingTop: 12,
    paddingBottom: 12,
    borderTopWidth: 0.5,
    borderTopColor: colors.b,
  },
  si: {
    flex: 1,
    alignItems: 'flex-start',
  },
  sil: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.t4,
    letterSpacing: 10 * 0.06,
    textTransform: 'uppercase',
    marginBottom: 3,
  },
  siv: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.t2,
  },

  // Additional zone rows (below best-zone ZoneThumbnail)
  zoneRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 9,
    paddingHorizontal: 12,
    marginBottom: 6,
    backgroundColor: colors.s2,
    borderRadius: 9,
  },
  zoneRowLabel: {
    fontFamily: fonts.sansMd,
    fontSize: 13,
    color: colors.t1,
  },
  zoneRowCount: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.t3,
  },
});
