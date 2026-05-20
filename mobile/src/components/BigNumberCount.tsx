import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { fonts, colors } from '../theme';

interface BigNumberCountProps {
  count: number | null;
  label?: string;
}

/**
 * BigNumberCount — the hero count display on LotDetail.
 *
 * Spec .bnb / .bn / .bl:
 *   .bnb: flex row, align flex-end, gap 12, margin 20 0 4
 *   .bn:  62px / accent / 500 / line-height .9 / letter-spacing -.03em
 *   .bl:  14px / t2 / padding-bottom 8 (aligns baseline with number)
 */
export default function BigNumberCount({ count, label = 'open' }: BigNumberCountProps) {
  const display = count != null ? String(count) : '—';
  return (
    <View style={styles.container}>
      <Text style={styles.number}>{display}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 12,
    marginTop: 20,
    marginBottom: 4,
  },
  number: {
    fontFamily: fonts.sansMd,
    fontSize: 62,
    color: colors.a,
    lineHeight: 62 * 0.9,
    letterSpacing: 62 * -0.03,
  },
  label: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.t2,
    paddingBottom: 8,
  },
});
