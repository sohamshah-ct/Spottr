import React, { useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Animated, Easing,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Location from 'expo-location';
import { useTheme, fonts } from '../theme';
import type { RootStackParamList } from '../../App';

// ── Permission items ──────────────────────────────────────────────────────────

const ITEMS = [
  {
    icon:    '📍',
    iconBg:  'openBg'  as const,
    title:   'Background location',
    sub:     'Passively logs visits to improve predictions for everyone',
  },
  {
    icon:    '🔔',
    iconBg:  'warnBg'  as const,
    title:   'Push notifications',
    sub:     'Only used to alert you if a row fills while driving',
  },
  {
    icon:    '🔒',
    iconBg:  'blue08'  as const,
    title:   'Never sold, never shared',
    sub:     'Your data contributes only to anonymous occupancy patterns',
  },
];

// ── Screen ────────────────────────────────────────────────────────────────────

export default function PermissionsScreen() {
  const nav        = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { colors } = useTheme();

  // Icon: spring pop (same pattern as SplashScreen)
  const iconScale   = useRef(new Animated.Value(0.4)).current;
  const iconOpacity = useRef(new Animated.Value(0)).current;
  const contentAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(iconScale, {
        toValue:         1,
        tension:         40,
        friction:        6,
        useNativeDriver: true,
      }),
      Animated.timing(iconOpacity, {
        toValue:         1,
        duration:        180,
        useNativeDriver: true,
      }),
    ]).start();

    Animated.timing(contentAnim, {
      toValue:         1,
      duration:        500,
      delay:           250,
      easing:          Easing.out(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, []);

  const contentTranslate = contentAnim.interpolate({
    inputRange:  [0, 1],
    outputRange: [16, 0],
  });

  const proceed = useCallback(() => {
    nav.replace('Home');
  }, [nav]);

  const handleEnable = useCallback(async () => {
    try {
      await Location.requestForegroundPermissionsAsync();
    } catch {
      // Permissions best-effort — proceed regardless
    }
    proceed();
  }, [proceed]);

  const iconBgColor = (key: typeof ITEMS[number]['iconBg']) => {
    if (key === 'openBg')  return colors.openBg;
    if (key === 'warnBg')  return colors.warnBg;
    return 'rgba(37,99,235,0.08)';
  };

  return (
    <View style={[s.root, { backgroundColor: colors.bg }]}>

      {/* ── Top: icon + title + body + items ── */}
      <View style={s.top}>

        {/* Blue location icon with glow */}
        <Animated.View
          style={[
            s.iconWrap,
            { opacity: iconOpacity, transform: [{ scale: iconScale }] },
          ]}
        >
          <View style={[s.iconBox, { backgroundColor: colors.blue }]}>
            <Text style={s.iconEmoji}>📍</Text>
          </View>
        </Animated.View>

        {/* Title + body */}
        <Animated.View
          style={{
            opacity:   contentAnim,
            transform: [{ translateY: contentTranslate }],
          }}
        >
          <Text style={[s.title, { color: colors.ink, fontFamily: fonts.black }]}>
            {'One permission,\nzero effort'}
          </Text>
          <Text style={[s.body, { color: colors.ink3, fontFamily: fonts.medium }]}>
            Enable location once and the app works silently — no tapping, no recording.
          </Text>

          {/* Permission items */}
          <View style={s.items}>
            {ITEMS.map((item, i) => (
              <View
                key={i}
                style={[s.item, { backgroundColor: colors.sf, borderColor: colors.bd }]}
              >
                <View style={[s.itemIcon, { backgroundColor: iconBgColor(item.iconBg) }]}>
                  <Text style={s.itemEmoji}>{item.icon}</Text>
                </View>
                <View style={s.itemText}>
                  <Text style={[s.itemTitle, { color: colors.ink, fontFamily: fonts.bold }]}>
                    {item.title}
                  </Text>
                  <Text style={[s.itemSub, { color: colors.ink3, fontFamily: fonts.medium }]}>
                    {item.sub}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </Animated.View>
      </View>

      {/* ── Bottom: CTAs ── */}
      <Animated.View
        style={[
          s.btns,
          {
            opacity:   contentAnim,
            transform: [{ translateY: contentTranslate }],
          },
        ]}
      >
        <TouchableOpacity
          style={[s.cta, { backgroundColor: colors.open }]}
          onPress={handleEnable}
          activeOpacity={0.85}
        >
          <Text style={[s.ctaText, { fontFamily: fonts.bold }]}>
            Enable Location & Continue
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.ghost, { borderColor: colors.bd2 }]}
          onPress={proceed}
          activeOpacity={0.7}
        >
          <Text style={[s.ghostText, { color: colors.ink3, fontFamily: fonts.bold }]}>
            Not now
          </Text>
        </TouchableOpacity>
      </Animated.View>

    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {
    flex:            1,
    justifyContent:  'space-between',
  },

  // Top section
  top: {
    flex:             1,
    justifyContent:   'center',
    paddingHorizontal: 28,
  },

  // Icon
  iconWrap: {
    alignSelf:    'center',
    marginBottom: 22,
  },
  iconBox: {
    width:          80,
    height:         80,
    borderRadius:   24,
    alignItems:     'center',
    justifyContent: 'center',
    // Shadow (iOS box-shadow equivalent: 0 0 0 12px rgba(37,99,235,0.08))
    shadowColor:    '#2563EB',
    shadowOffset:   { width: 0, height: 0 },
    shadowRadius:   20,
    shadowOpacity:  0.25,
    elevation:      8,
  },
  iconEmoji: {
    fontSize:   36,
    lineHeight: 44,
  },

  // Title
  title: {
    fontSize:      26,
    fontWeight:    '900',
    letterSpacing: -0.5,
    textAlign:     'center',
    marginBottom:  10,
    lineHeight:    32,
  },
  body: {
    fontSize:     15,
    fontWeight:   '500',
    textAlign:    'center',
    lineHeight:   23,
    marginBottom: 24,
  },

  // Permission items
  items: {
    width: '100%',
    gap:   8,
  },
  item: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            14,
    borderRadius:   14,
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderWidth:    1,
  },
  itemIcon: {
    width:          36,
    height:         36,
    borderRadius:   10,
    alignItems:     'center',
    justifyContent: 'center',
    flexShrink:     0,
  },
  itemEmoji: {
    fontSize: 18,
  },
  itemText: {
    flex: 1,
  },
  itemTitle: {
    fontSize:     13,
    fontWeight:   '700',
    marginBottom: 1,
  },
  itemSub: {
    fontSize:   12,
    fontWeight: '500',
    lineHeight: 17,
  },

  // Buttons
  btns: {
    paddingHorizontal: 28,
    paddingBottom:     32,
    paddingTop:        20,
    gap:               8,
  },
  cta: {
    width:           '100%',
    paddingVertical: 15,
    borderRadius:    18,
    alignItems:      'center',
  },
  ctaText: {
    fontSize:      16,
    fontWeight:    '700',
    color:         '#FFFFFF',
    letterSpacing: -0.1,
  },
  ghost: {
    width:           '100%',
    paddingVertical: 13,
    borderRadius:    14,
    alignItems:      'center',
    borderWidth:     1.5,
    backgroundColor: 'transparent',
  },
  ghostText: {
    fontSize:   14,
    fontWeight: '600',
  },
});
