/**
 * ParkedScreen.tsx — SCREEN 08 (You're parked!)
 *
 * Layout (.prk / .prkt / .prkcd / .prkb):
 *   padding 28 around everything
 *   .prkt  — centered top section: checkmark icon (74×74), heading 22/500, subtext 14/t2
 *   .prkcd — spot card (margin-top 32, bg s1, radius 13) — ParkedSummary component
 *   .prkb  — bottom actions (margin-top auto): "Find my car" + "Done parking"
 *
 * Behaviour:
 *   - Saves parked coordinates to AsyncStorage key @parked_spot
 *   - "Find my car" opens Maps deeplink to saved coordinates
 *   - "Done parking" → clearParked + stopParkingWatcher + navigate('Home')
 *   - Auto-clear: if parkedAt > 24 h ago on mount, clearParked silently
 */

import React, { useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Linking,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';

import type { RootStackParamList } from '../../App';
import {
  useParkingStore,
  stopParkingWatcher,
} from '../services/parkingStateMachine';
import { useTheme, fonts } from '../theme';
import ParkedSummary from '../components/ParkedSummary';

// ── Constants ─────────────────────────────────────────────────────────────────

const PARKED_SPOT_KEY   = '@parked_spot';
const AUTO_CLEAR_MS     = 24 * 60 * 60 * 1000; // 24 h

type Props = NativeStackScreenProps<RootStackParamList, 'Parked'>;

// ── Component ─────────────────────────────────────────────────────────────────

export default function ParkedScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const parkedAt          = useParkingStore(s => s.parkedAt);
  const parkedLat         = useParkingStore(s => s.parkedLat);
  const parkedLng         = useParkingStore(s => s.parkedLng);
  const parkedDescription = useParkingStore(s => s.parkedDescription);
  const timeSavedMin      = useParkingStore(s => s.timeSavedMin);
  const clearParked       = useParkingStore(s => s.clearParked);

  // ── On mount: save coords + haptic celebration + auto-clear old records ────
  useEffect(() => {
    // Auto-clear stale parked record (> 24 h old)
    if (parkedAt != null && Date.now() - parkedAt > AUTO_CLEAR_MS) {
      clearParked();
      stopParkingWatcher();
      navigation.replace('Home');
      return;
    }

    // Persist coordinates for "Find my car"
    if (parkedLat != null && parkedLng != null) {
      AsyncStorage.setItem(
        PARKED_SPOT_KEY,
        JSON.stringify({ lat: parkedLat, lng: parkedLng, savedAt: parkedAt ?? Date.now() }),
      ).catch(() => {});
    }

    // Celebration haptic
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── "Find my car" ─────────────────────────────────────────────────────────
  function findMyCar() {
    if (parkedLat == null || parkedLng == null) return;
    const url = Platform.select({
      ios:     `maps://app?ll=${parkedLat},${parkedLng}&q=My+Car`,
      android: `https://www.google.com/maps/search/?api=1&query=${parkedLat},${parkedLng}`,
    }) ?? `https://www.google.com/maps/search/?api=1&query=${parkedLat},${parkedLng}`;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    Linking.openURL(url).catch(err => console.warn('[Parked] openMaps error:', err));
  }

  // ── "Done parking" ────────────────────────────────────────────────────────
  function done() {
    clearParked();
    stopParkingWatcher();
    AsyncStorage.removeItem(PARKED_SPOT_KEY).catch(() => {});
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    navigation.navigate('Home');
  }

  const hasCoords = parkedLat != null && parkedLng != null;

  return (
    <View style={[s.prk, { backgroundColor: colors.bg, paddingTop: insets.top + 28, paddingBottom: insets.bottom + 28 }]}>

      {/* ── Top section ───────────────────────────────────────────────────── */}
      <View style={s.prkt}>
        <View style={[s.icon, { backgroundColor: colors.ad, borderColor: colors.a }]}>
          <Text style={[s.iconText, { color: colors.a }]}>✓</Text>
        </View>
        <Text style={[s.heading, { color: colors.t1, fontFamily: fonts.sansMd }]}>
          You're parked!
        </Text>
        <Text style={[s.subtext, { color: colors.t2, fontFamily: fonts.sans }]}>
          Spottr found your spot. Nice work.
        </Text>
      </View>

      {/* ── Spot card ─────────────────────────────────────────────────────── */}
      <View style={s.prkcd}>
        <ParkedSummary
          description={parkedDescription}
          parkedAt={parkedAt}
          timeSavedMin={timeSavedMin}
        />
      </View>

      {/* ── Bottom actions ────────────────────────────────────────────────── */}
      <View style={s.prkb}>
        {hasCoords && (
          <TouchableOpacity
            style={[s.findBtn, { backgroundColor: colors.s2, borderColor: colors.b }]}
            onPress={findMyCar}
            activeOpacity={0.82}
          >
            <Text style={[s.findIcon, { color: colors.t1 }]}>📍</Text>
            <Text style={[s.findText, { color: colors.t1, fontFamily: fonts.sansMd }]}>
              Find my car
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[s.doneBtn, { backgroundColor: colors.a }]}
          onPress={done}
          activeOpacity={0.85}
        >
          <Text style={[s.doneBtnText, { color: colors.bg, fontFamily: fonts.sansMd }]}>
            Done parking
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  prk: {
    flex: 1,
    paddingHorizontal: 28,
  },

  // Top centered section
  prkt: {
    alignItems: 'center',
    marginBottom: 8,
  },
  icon: {
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  iconText: {
    fontSize: 32,
  },
  heading: {
    fontSize: 22,
    letterSpacing: 22 * -0.01,
    marginBottom: 8,
  },
  subtext: {
    fontSize: 14,
    lineHeight: 14 * 1.55,
    textAlign: 'center',
    paddingHorizontal: 20,
  },

  // Spot card
  prkcd: {
    marginTop: 32,
  },

  // Bottom actions
  prkb: {
    marginTop: 'auto',
    gap: 10,
  },
  findBtn: {
    borderRadius: 13,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 0.5,
  },
  findIcon: {
    fontSize: 16,
  },
  findText: {
    fontSize: 15,
  },
  doneBtn: {
    borderRadius: 13,
    paddingVertical: 15,
    alignItems: 'center',
  },
  doneBtnText: {
    fontSize: 15,
  },
});
