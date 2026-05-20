import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { fonts, colors } from '../theme';

interface SearchBarProps {
  placeholder?: string;
  onPress?: () => void;
  /** When true, renders inside a BottomSheet (uses non-pressable display) */
  passive?: boolean;
}

/**
 * SearchBar — tap target / display bar that opens SearchScreen.
 *
 * Spec .sbar:
 *   background: s2, border: 0.5px solid b, border-radius 12,
 *   padding 11 14, flex row, gap 10
 *   icon: t3, 18px
 *   placeholder: t3, 14px
 *
 * Two render modes:
 *   passive=false (default): TouchableOpacity wrapper — tapping opens Search
 *   passive=true: plain View — used inside the bottom sheet's handle area
 *   where the gesture handler owns touch events
 */
export default function SearchBar({ placeholder = 'Search lots, malls, campuses…', onPress, passive = false }: SearchBarProps) {
  const inner = (
    <View style={styles.bar}>
      <Text style={styles.icon}>⌕</Text>
      <Text style={styles.placeholder} numberOfLines={1}>{placeholder}</Text>
    </View>
  );

  if (passive || !onPress) return inner;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.75}>
      {inner}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.s2,
    borderWidth: 0.5,
    borderColor: colors.b,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  icon: {
    fontSize: 18,
    color: colors.t3,
    fontFamily: fonts.sans,
  },
  placeholder: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.t3,
  },
});
