/**
 * ApproachScreen — placeholder for Checkpoint 2 / Task 06.
 *
 * The real implementation fires automatically via geofence when the
 * user's GPS crosses the lot polygon. It shows:
 *   • Close-up Mapbox aerial of the lot
 *   • Animated dashed path from entry to open-zone centroid
 *   • Live GPS dot updating at 1 Hz
 *   • Short server-generated instruction (≤ 8 words)
 *   • "I parked" button → POST /api/lots/:id/parked → ParkedScreen
 *
 * Implemented in Task 06 (Checkpoint 3).
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme, fonts } from '../theme';

export default function ApproachScreen() {
  const { colors } = useTheme();

  return (
    <View style={[s.root, { backgroundColor: colors.bg }]}>
      <View style={[s.pill, { backgroundColor: colors.ad, borderColor: colors.a }]}>
        <View style={[s.dot, { backgroundColor: colors.a }]} />
        <Text style={[s.pillText, { color: colors.a, fontFamily: fonts.monoMd }]}>
          APPROACHING
        </Text>
      </View>
      <Text style={[s.heading, { color: colors.t1, fontFamily: fonts.sansMd }]}>
        Approach view
      </Text>
      <Text style={[s.sub, { color: colors.t3, fontFamily: fonts.mono }]}>
        SCREEN 07 · TASK 06 · CHECKPOINT 3
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 32,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 0.5,
    borderRadius: 99,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 8,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  pillText: {
    fontSize: 11,
    letterSpacing: 0.8,
  },
  heading: {
    fontSize: 22,
    letterSpacing: -0.22,
  },
  sub: {
    fontSize: 11,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
});
