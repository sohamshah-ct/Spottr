import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet } from 'react-native';
import { useTheme, fonts } from '../theme';

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
 *
 * Polish: scale-bounce animation when count value changes.
 */
export default function BigNumberCount({ count, label = 'open' }: BigNumberCountProps) {
  const { colors } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const prevCount = useRef(count);

  useEffect(() => {
    if (prevCount.current !== count && count != null) {
      prevCount.current = count;
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.08, duration: 120, useNativeDriver: true }),
        Animated.spring(scale,  { toValue: 1.00, useNativeDriver: true, tension: 180, friction: 8 }),
      ]).start();
    }
  }, [count, scale]);

  const display = count != null ? String(count) : '—';

  return (
    <View style={s.container}>
      <Animated.Text
        style={[s.number, { color: colors.a, transform: [{ scale }] }]}
      >
        {display}
      </Animated.Text>
      <Text style={[s.label, { color: colors.t2 }]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
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
    lineHeight: 62 * 0.9,
    letterSpacing: 62 * -0.03,
  },
  label: {
    fontFamily: fonts.sans,
    fontSize: 14,
    paddingBottom: 8,
  },
});
