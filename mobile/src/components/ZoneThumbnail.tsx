import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme, fonts } from '../theme';
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
 */
export default function ZoneThumbnail({ rows, onPress }: ZoneThumbnailProps) {
  const { colors } = useTheme();

  if (!rows || rows.length === 0) return null;

  const best = rows.reduce((a, b) => (b.open > a.open ? b : a), rows[0]);
  const openPct = best.total > 0 ? best.open / best.total : 0;
  const rectWidthPct = Math.max(0.3, Math.min(0.85, openPct));

  return (
    <TouchableOpacity
      style={[s.container, { backgroundColor: colors.s2 }]}
      onPress={onPress}
      activeOpacity={onPress ? 0.7 : 1}
    >
      {/* Thumbnail */}
      <View style={s.thumb}>
        <View style={s.thumbBg} />
        <View
          style={[
            s.zoneRect,
            {
              width: `${Math.round(rectWidthPct * 100)}%` as unknown as number,
              borderColor: colors.a,
              backgroundColor: colors.af,
            },
          ]}
        />
      </View>

      {/* Info */}
      <View style={s.info}>
        <Text style={[s.title, { color: colors.t1 }]} numberOfLines={1}>
          Zone {best.label}
        </Text>
        <Text style={[s.sub, { color: colors.t3 }]}>
          {best.open} of {best.total} open
        </Text>
      </View>

      {onPress && <Text style={[s.chevron, { color: colors.t3 }]}>›</Text>}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 9,
    marginVertical: 16,
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
  },
  info: {
    flex: 1,
  },
  title: {
    fontFamily: fonts.sansMd,
    fontSize: 13,
    marginBottom: 2,
  },
  sub: {
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  chevron: {
    fontFamily: fonts.sans,
    fontSize: 16,
  },
});
