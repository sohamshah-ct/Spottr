/**
 * RerouteScreen.tsx — SCREEN 07b (Lot Full / Reroute)
 *
 * Presented when the target lot polls to 0 open spaces.
 * Transparent-modal bottom sheet style — map visible behind.
 *
 * Shows:
 *   Original lot card (struck-through, "FULL" tag)
 *   Alternate lot card (nearest lot with openCount > 0, if available)
 *   "Reroute" CTA → navigates back to Driving with new lot loaded into store
 *   "Keep going" → back to DrivingScreen (dismisses sheet)
 */

import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';

import type { RootStackParamList } from '../../App';
import { useParkingStore, haversineMeters } from '../services/parkingStateMachine';
import { api, type Lot } from '../services/api';
import { useTheme, fonts } from '../theme';
import RerouteCard from '../components/RerouteCard';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type RerouteRoute = NativeStackScreenProps<RootStackParamList, 'Reroute'>['route'];

export default function RerouteScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<RerouteRoute>();
  const { lotId, lotName, newRowLat, newRowLng } = route.params;
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const lot          = useParkingStore(s => s.lot);
  const startSearching = useParkingStore(s => s.startSearching);

  const [alternate, setAlternate]   = useState<Lot | null>(null);
  const [loading, setLoading]       = useState(true);

  const searchLat = newRowLat || lot?.lat || 0;
  const searchLng = newRowLng || lot?.lng || 0;

  useEffect(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});

    async function findAlternate() {
      try {
        const res = await api.getLotsNear(searchLat, searchLng, 2000);
        // Find the nearest lot that isn't the current one and has open spaces
        const candidates = (res.lots ?? []).filter(
          l => l.id !== lotId && (l.spot_detection_status !== 'detected' || (l.total_spaces ?? 0) > 0),
        );
        setAlternate(candidates[0] ?? null);
      } catch {
        setAlternate(null);
      } finally {
        setLoading(false);
      }
    }
    findAlternate();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function distLabel(l: Lot): string {
    const d = haversineMeters(searchLat, searchLng, l.lat, l.lng);
    if (d < 1600) return `${Math.round(d / 160) / 10} mi away`;
    return `${(d / 1609).toFixed(1)} mi away`;
  }

  function handleReroute() {
    if (!alternate) return;
    // Best zone: no zone data in the summary yet — use lot centre
    startSearching({
      lotId:       alternate.id,
      lot:         alternate,
      zoneCentLat: alternate.place_lat ?? alternate.lat,
      zoneCentLng: alternate.place_lng ?? alternate.lng,
      openCount:   alternate.total_spaces ?? 0,
      zoneName:    null,
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    // Navigate back to approach screen with new lot
    navigation.replace('Approach', {
      lotId:       alternate.id,
      lotName:     alternate.name ?? undefined,
      lot:         alternate,
      zoneCentLat: alternate.place_lat ?? alternate.lat,
      zoneCentLng: alternate.place_lng ?? alternate.lng,
      openCount:   alternate.total_spaces ?? 0,
      zoneName:    null,
    });
  }

  return (
    <View style={[s.backdrop, { backgroundColor: colors.bg }]}>
      {/* Dimmed top area — tapping dismisses */}
      <TouchableOpacity
        style={s.dismissArea}
        activeOpacity={1}
        onPress={() => navigation.goBack()}
      />

      {/* Sheet */}
      <View style={[s.sheet, { backgroundColor: colors.s1, borderColor: colors.b, paddingBottom: insets.bottom + 16 }]}>
        {/* Handle */}
        <View style={[s.handle, { backgroundColor: colors.bs }]} />

        <Text style={[s.heading, { color: colors.full, fontFamily: fonts.sansMd }]}>
          That lot just filled up
        </Text>
        <Text style={[s.sub, { color: colors.t2, fontFamily: fonts.sans }]}>
          Here's what's nearby.
        </Text>

        {/* Original lot — struck-through */}
        <RerouteCard
          variant="original"
          lotName={lotName ?? lot?.name ?? 'Your lot'}
        />

        {/* Alternate lot */}
        {loading ? (
          <View style={s.loadingRow}>
            <ActivityIndicator size="small" color={colors.a} />
            <Text style={[s.loadingText, { color: colors.t3, fontFamily: fonts.mono }]}>
              finding nearby lots…
            </Text>
          </View>
        ) : alternate ? (
          <RerouteCard
            variant="alternate"
            lotName={alternate.name ?? 'Nearby lot'}
            openCount={alternate.total_spaces ?? undefined}
            distanceLabel={distLabel(alternate)}
            onPress={handleReroute}
          />
        ) : (
          <Text style={[s.noAlt, { color: colors.t3, fontFamily: fonts.sans }]}>
            No nearby lots found — try expanding your search.
          </Text>
        )}

        {/* Actions */}
        <View style={s.actions}>
          {alternate && !loading && (
            <TouchableOpacity
              style={[s.rerouteBtn, { backgroundColor: colors.a }]}
              onPress={handleReroute}
              activeOpacity={0.85}
            >
              <Text style={[s.rerouteBtnText, { color: colors.bg, fontFamily: fonts.sansMd }]}>
                Reroute
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[s.keepBtn, { borderColor: colors.b }]}
            onPress={() => navigation.goBack()}
            activeOpacity={0.82}
          >
            <Text style={[s.keepBtnText, { color: colors.t2, fontFamily: fonts.sans }]}>
              Keep going
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  dismissArea: {
    flex: 1,
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderTopWidth: 0.5,
    padding: 20,
    paddingTop: 10,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 14,
  },
  heading: {
    fontSize: 18,
    marginBottom: 4,
  },
  sub: {
    fontSize: 14,
    marginBottom: 16,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
  },
  loadingText: {
    fontSize: 13,
  },
  noAlt: {
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: 12,
  },
  actions: {
    gap: 10,
    marginTop: 8,
  },
  rerouteBtn: {
    borderRadius: 13,
    paddingVertical: 15,
    alignItems: 'center',
  },
  rerouteBtnText: {
    fontSize: 15,
  },
  keepBtn: {
    borderRadius: 13,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 0.5,
  },
  keepBtnText: {
    fontSize: 15,
  },
});
