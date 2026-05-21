import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme, fonts } from '../theme';
import FreshnessLabel from './FreshnessLabel';
import type { Lot } from '../services/api';

interface LotCardProps {
  lot: Lot;
  onPress: (lot: Lot) => void;
}

/**
 * LotCard — one row in the bottom sheet lot list.
 *
 * Spec .lc layout:
 *   Left: name (14px/500) + subtitle (12px/t3)
 *   Right: count (16px/500) + freshness (mono 11/t3)
 *
 * Count color: state A/B/C = accent, state D = t1 (white).
 */
export default function LotCard({ lot, onPress }: LotCardProps) {
  const { colors } = useTheme();

  const count = lot.total_spaces != null ? String(lot.total_spaces) : '—';
  const subtitle = lot.city ?? lot.address ?? '';
  const freshState = lot.freshness_state ?? 'D';
  const freshLabel = lot.freshness_label ?? 'Capacity only';
  const countColor = freshState === 'D' ? colors.t1 : colors.a;

  return (
    <TouchableOpacity
      style={[s.row, { borderBottomColor: colors.b }]}
      onPress={() => onPress(lot)}
      activeOpacity={0.7}
    >
      <View style={s.left}>
        <Text style={[s.name, { color: colors.t1 }]} numberOfLines={1}>
          {lot.name ?? 'Parking Lot'}
        </Text>
        {!!subtitle && (
          <Text style={[s.sub, { color: colors.t3 }]} numberOfLines={1}>{subtitle}</Text>
        )}
      </View>
      <View style={s.right}>
        <Text style={[s.count, { color: countColor }]}>{count}</Text>
        <FreshnessLabel label={freshLabel} />
      </View>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderBottomWidth: 0.5,
  },
  left: {
    flex: 1,
    marginRight: 12,
  },
  name: {
    fontFamily: fonts.sansMd,
    fontSize: 14,
    marginBottom: 3,
  },
  sub: {
    fontSize: 12,
    fontFamily: fonts.sans,
  },
  right: {
    alignItems: 'flex-end',
  },
  count: {
    fontFamily: fonts.sansMd,
    fontSize: 16,
    textAlign: 'right',
  },
});
