import React, { useRef } from 'react';
import { View, Text, TouchableOpacity, Animated, StyleSheet } from 'react-native';
import { useTheme, fonts } from '../theme';

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
 *
 * Polish: scale-down feedback on press.
 */
export default function SearchBar({ placeholder = 'Search lots, malls, campuses…', onPress, passive = false }: SearchBarProps) {
  const { colors } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;

  function onPressIn() {
    Animated.timing(scale, { toValue: 0.97, duration: 80, useNativeDriver: true }).start();
  }
  function onPressOut() {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, tension: 200, friction: 8 }).start();
  }

  const inner = (
    <Animated.View
      style={[
        s.bar,
        {
          backgroundColor: colors.s2,
          borderColor: colors.b,
          transform: [{ scale }],
        },
      ]}
    >
      <Text style={[s.icon, { color: colors.t3 }]}>⌕</Text>
      <Text style={[s.placeholder, { color: colors.t3 }]} numberOfLines={1}>{placeholder}</Text>
    </Animated.View>
  );

  if (passive || !onPress) return inner;
  return (
    <TouchableOpacity
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      activeOpacity={1}
    >
      {inner}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 0.5,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  icon: {
    fontSize: 18,
    fontFamily: fonts.sans,
  },
  placeholder: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 14,
  },
});
