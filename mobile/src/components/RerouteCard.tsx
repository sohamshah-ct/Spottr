/**
 * RerouteCard — single lot option card on RerouteScreen.
 *
 * Variants:
 *   original  — shows the original (now full) lot, name struck through
 *   alternate — shows the suggested alternate lot, with open count badge
 */

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme, fonts } from '../theme';

interface Props {
  variant: 'original' | 'alternate';
  lotName: string;
  openCount?: number;
  distanceLabel?: string;
  onPress?: () => void;
}

export default function RerouteCard({ variant, lotName, openCount, distanceLabel, onPress }: Props) {
  const { colors } = useTheme();

  const isOriginal = variant === 'original';

  return (
    <TouchableOpacity
      style={[
        s.card,
        {
          backgroundColor: isOriginal ? colors.s2 : colors.s1,
          borderColor:      isOriginal ? colors.b  : colors.a,
          borderWidth:      isOriginal ? 0.5 : 1.5,
          opacity:          isOriginal ? 0.6 : 1,
        },
      ]}
      onPress={onPress}
      activeOpacity={isOriginal ? 1 : 0.82}
      disabled={isOriginal}
    >
      <View style={s.left}>
        {isOriginal && (
          <Text style={[s.tag, { color: colors.full, fontFamily: fonts.monoMd }]}>FULL</Text>
        )}
        <Text
          style={[
            s.name,
            { color: isOriginal ? colors.t3 : colors.t1, fontFamily: fonts.sansMd },
            isOriginal && s.strikethrough,
          ]}
          numberOfLines={2}
        >
          {lotName}
        </Text>
        {distanceLabel && (
          <Text style={[s.dist, { color: colors.t3, fontFamily: fonts.mono }]}>{distanceLabel}</Text>
        )}
      </View>

      {!isOriginal && openCount != null && (
        <View style={[s.badge, { backgroundColor: colors.ad, borderColor: colors.a }]}>
          <Text style={[s.badgeCount, { color: colors.a, fontFamily: fonts.sansMd }]}>
            {openCount}
          </Text>
          <Text style={[s.badgeLabel, { color: colors.t3, fontFamily: fonts.mono }]}>open</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  card: {
    borderRadius: 14,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  left: {
    flex: 1,
  },
  tag: {
    fontSize: 10,
    letterSpacing: 10 * 0.08,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  name: {
    fontSize: 16,
    lineHeight: 16 * 1.25,
  },
  strikethrough: {
    textDecorationLine: 'line-through',
  },
  dist: {
    fontSize: 12,
    marginTop: 4,
  },
  badge: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    marginLeft: 12,
  },
  badgeCount: {
    fontSize: 22,
    lineHeight: 26,
  },
  badgeLabel: {
    fontSize: 10,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginTop: 1,
  },
});
