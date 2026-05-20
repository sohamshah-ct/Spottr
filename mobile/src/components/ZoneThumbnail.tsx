import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { fonts, colors } from '../theme';
import type { LotRow } from '../services/api';

interface ZoneThumbnailProps {
  rows: LotRow[];
  onPress?: () => void;
}

/**
 * ZoneThumbnail — shows the best available zone (row with most open spaces).
 *
 * Spec .zt / .zi / .zinfo:
 *   .zt:  s2 bg, border-radius 11, flex row, gap 12, padding 9, margin 16 0
 *   .zi:  76×56, border-radius 6, dark bg #1F2A20 (accent-tinted)
 *   .zinfo: flex 1 column
 *
 * The .zi thumbnail is a View-based rectangle with no nested MapView
 * (performance: avoid multiple MapView instances on LotDetail).
 * A dark background with an accent-bordered inner rect represents the zone.
 */
export default function ZoneThumbnail({ rows, onPress }: ZoneThumbnailProps) {
  if (!rows || rows.length === 0) return null;

  // Best zone = row with highest open space count
  const best = rows.reduce((a, b) => (b.open > a.open ? b : a), rows[0]);
  const openPct = best.total > 0 ? best.open / best.total : 0;

  // Normalised rect for zone preview (simple column representation)
  const rectWidthPct = Math.max(0.3, Math.min(0.85, openPct));

  return (
    <TouchableOpacity style={styles.container} onPress={onPress} activeOpacity={onPress ? 0.7 : 1}>
      {/* Thumbnail */}
      <View style={styles.thumb}>
        {/* Dark lot background */}
        <View style={styles.thumbBg} />
        {/* Accent-bordered open zone rect */}
        <View style={[
          styles.zoneRect,
          { width: `${Math.round(rectWidthPct * 100)}%` as unknown as number },
        ]} />
      </View>

      {/* Info */}
      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={1}>
          Zone {best.label}
        </Text>
        <Text style={styles.sub}>
          {best.open} of {best.total} open
        </Text>
      </View>

      {/* Chevron hint */}
      {onPress && <Text style={styles.chevron}>›</Text>}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 9,
    marginVertical: 16,
    backgroundColor: colors.s2,
    borderRadius: 11,
  },
  thumb: {
    width: 76,
    height: 56,
    borderRadius: 6,
    backgroundColor: '#1F2A20',
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'flex-start',
    padding: 8,
  },
  thumbBg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#1F2A20',
  },
  zoneRect: {
    height: 28,
    borderRadius: 3,
    borderWidth: 1.5,
    borderColor: colors.a,
    backgroundColor: colors.af,
  },
  info: {
    flex: 1,
  },
  title: {
    fontFamily: fonts.sansMd,
    fontSize: 13,
    color: colors.t1,
    marginBottom: 2,
  },
  sub: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.t3,
  },
  chevron: {
    fontFamily: fonts.sans,
    fontSize: 16,
    color: colors.t3,
  },
});
