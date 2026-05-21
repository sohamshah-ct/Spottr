import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, TouchableOpacity, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme, fonts } from '../theme';
import type { RootStackParamList } from '../../App';

export default function SplashScreen() {
  const nav         = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { colors }  = useTheme();

  // Icon: spring pop
  const iconScale   = useRef(new Animated.Value(0.4)).current;
  const iconOpacity = useRef(new Animated.Value(0)).current;

  // Text: staggered fade-up (single value → opacity + translateY via interpolate)
  const wordAnim  = useRef(new Animated.Value(0)).current;
  const tagAnim   = useRef(new Animated.Value(0)).current;
  const hintAnim  = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Icon spring pop
    Animated.parallel([
      Animated.spring(iconScale, {
        toValue:    1,
        tension:    40,
        friction:   6,
        useNativeDriver: true,
      }),
      Animated.timing(iconOpacity, {
        toValue:  1,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start();

    // Staggered text fade-up
    const fu = (val: Animated.Value, delay: number) =>
      Animated.timing(val, {
        toValue:  1,
        duration: 500,
        delay,
        useNativeDriver: true,
      });

    fu(wordAnim, 200).start();
    fu(tagAnim,  350).start();
    fu(hintAnim, 550).start();
  }, []);

  const ty = (anim: Animated.Value) =>
    anim.interpolate({ inputRange: [0, 1], outputRange: [14, 0] });

  return (
    <TouchableOpacity
      style={[s.root, { backgroundColor: colors.bg }]}
      activeOpacity={1}
      onPress={() => nav.replace('Onboarding')}
    >
      {/* Icon: glow rings + rounded square */}
      <Animated.View
        style={[
          s.glowOuter,
          { backgroundColor: 'rgba(18,192,88,0.04)' },
          { opacity: iconOpacity, transform: [{ scale: iconScale }] },
        ]}
      >
        <View style={[s.glowInner, { backgroundColor: colors.openBg }]}>
          <View style={[s.iconBox, { backgroundColor: colors.open }]}>
            <Text style={s.iconEmoji}>🛰️</Text>
          </View>
        </View>
      </Animated.View>

      {/* Wordmark */}
      <Animated.View style={{ opacity: wordAnim, transform: [{ translateY: ty(wordAnim) }] }}>
        <Text style={[s.wordmark, { color: colors.ink, fontFamily: fonts.black }]}>
          SPOTTR
        </Text>
      </Animated.View>

      {/* Tagline */}
      <Animated.View style={{ opacity: tagAnim, transform: [{ translateY: ty(tagAnim) }] }}>
        <Text style={[s.tagline, { color: colors.ink3, fontFamily: fonts.medium }]}>
          See every open parking spot before you arrive
        </Text>
      </Animated.View>

      {/* Hint */}
      <Animated.View
        style={[
          s.hintWrap,
          { opacity: hintAnim, transform: [{ translateY: ty(hintAnim) }] },
        ]}
      >
        <Text style={[s.hint, { color: colors.ink4, fontFamily: fonts.mono }]}>
          tap to begin →
        </Text>
      </Animated.View>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 0,
  },

  // Concentric glow layers (simulates CSS box-shadow rings)
  glowOuter: {
    width: 160,
    height: 160,
    borderRadius: 80,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 26,
  },
  glowInner: {
    width: 128,
    height: 128,
    borderRadius: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBox: {
    width: 96,
    height: 96,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconEmoji: {
    fontSize: 44,
    lineHeight: 52,
  },

  wordmark: {
    fontSize: 38,
    fontWeight: '900',
    letterSpacing: 7,
    marginBottom: 6,
  },
  tagline: {
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
    lineHeight: 21,
    maxWidth: 220,
  },
  hintWrap: {
    marginTop: 48,
  },
  hint: {
    fontSize: 11,
    letterSpacing: 1,
  },
});
