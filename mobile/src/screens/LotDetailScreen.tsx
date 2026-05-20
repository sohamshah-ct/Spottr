/**
 * LotDetailScreen.tsx — Gate C rebuild
 *
 * Layout:
 *   - MapView (190px) zoomed to lot bbox + Mapbox satellite + space markers
 *   - Sheet overlaid covering the bottom portion
 *   - Sheet: name/address + BigNumberCount + FreshnessLabel + ZoneThumbnail
 *            + "Take me there" CTA + stats row
 *
 * Spec: spottr-finalframe.html SCREEN 06
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Platform, Linking, RefreshControl,
} from 'react-native';
import MapView, { Marker, UrlTile, Circle } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { api, type Lot, type RowsResponse, type Space } from '../services/api';
import { colors, fonts } from '../theme';
import BigNumberCount from '../components/BigNumberCount';
import FreshnessLabel from '../components/FreshnessLabel';
import ZoneThumbnail from '../components/ZoneThumbnail';
import ConfidencePill from '../components/ConfidencePill';
import type { RootStackParamList } from '../../App';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAPBOX_TOKEN = (process.env as any).EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
const MAPBOX_TILE_URL = `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${MAPBOX_TOKEN}`;
const MAP_HEIGHT = 190;

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
  const [loading, setLoading] = useState(!routeLot);
  const [refreshing, setRefreshing] = useState(false);
  const [showMarkers, setShowMarkers] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slowLoad, setSlowLoad] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    let slowTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      if (!isRefresh) {
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

  const destLat = displayLot.place_lat ?? displayLot.lat;
  const destLng = displayLot.place_lng ?? displayLot.lng;
  const dist = distanceLabel(displayLot.distance_meters);

  const mapRegion = regionFromLot(displayLot);

  return (
    <View style={styles.root}>
      {/* ── Map container (190px) — toggle lives inside to stay above sheet ── */}
      <View style={styles.mapContainer}>
        <MapView
          style={styles.map}
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
          {/* Centre pin */}
          <Marker coordinate={{ latitude: displayLot.lat, longitude: displayLot.lng }} anchor={{ x: 0.5, y: 1 }}>
            <View style={styles.centerPin}>
              <Text style={styles.centerPinText}>P</Text>
            </View>
          </Marker>
          {/* AI Map: space dots when showMarkers is true */}
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

        {/* Live Sat toggle — inside map container so it stays above the sheet */}
        <TouchableOpacity
          style={styles.satToggle}
          onPress={() => setShowMarkers(v => !v)}
          activeOpacity={0.8}
        >
          <Text style={[styles.satToggleText, showMarkers && styles.satToggleActive]}>
            Live Sat
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── Detail sheet ─────────────────────────────────────────────────── */}
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
        {/* Handle */}
        <View style={styles.handle} />

        <ScrollView
          contentContainerStyle={styles.sheetContent}
          showsVerticalScrollIndicator={false}
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

          {/* ── Zone thumbnail (best zone) + remaining zones ──────────── */}
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
      </View>
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

  // Map container — explicit height so toggle is positioned within it, not behind the sheet
  mapContainer: {
    height: MAP_HEIGHT,
    width: '100%',
  },
  map: {
    height: MAP_HEIGHT,
    width: '100%',
  },

  // Centre pin
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

  // Live Sat toggle — positioned inside mapContainer so it's above the sheet
  satToggle: {
    position: 'absolute',
    top: 12,
    right: 14,
    backgroundColor: 'rgba(10,10,10,0.75)',
    borderWidth: 0.5,
    borderColor: colors.bs,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  satToggleText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.t3,
    letterSpacing: 11 * 0.04,
  },
  satToggleActive: {
    color: colors.a,
  },

  // Sheet
  sheet: {
    flex: 1,
    backgroundColor: colors.s1,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    marginTop: -24,
    paddingTop: 10,
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 2,
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
    marginTop: 'auto' as any,
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
