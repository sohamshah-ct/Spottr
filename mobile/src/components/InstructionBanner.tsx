/**
 * InstructionBanner — top-of-screen status strip on DrivingScreen.
 *
 * Shows:  STATE LABEL · distance/eta line
 * Colors transition: approaching = accent, arrived = accent, full = warning
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme, fonts } from '../theme';

export type BannerMode = 'approaching' | 'arrived' | 'full';

interface Props {
  mode: BannerMode;
  /** e.g. "247 open · 3 min" */
  subtitle?: string;
}

export default function InstructionBanner({ mode, subtitle }: Props) {
  const { colors } = useTheme();

  const labelMap: Record<BannerMode, string> = {
    approaching: 'APPROACHING',
    arrived:     'ARRIVED',
    full:        'LOT FULL',
  };
  const colorMap: Record<BannerMode, string> = {
    approaching: colors.a,
    arrived:     colors.a,
    full:        colors.warn,
  };
  const bgMap: Record<BannerMode, string> = {
    approaching: colors.ad,
    arrived:     colors.ad,
    full:        colors.warnBg,
  };

  return (
    <View style={[s.wrap, { backgroundColor: bgMap[mode], borderColor: colorMap[mode] }]}>
      <Text style={[s.label, { color: colorMap[mode], fontFamily: fonts.monoMd }]}>
        {labelMap[mode]}
      </Text>
      {!!subtitle && (
        <Text style={[s.sub, { color: colors.t2, fontFamily: fonts.mono }]}>{subtitle}</Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 8,
  },
  label: {
    fontSize: 12,
    letterSpacing: 12 * 0.07,
    textTransform: 'uppercase',
  },
  sub: {
    fontSize: 13,
    marginTop: 2,
  },
});
