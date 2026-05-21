import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Animated, Easing,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme, fonts } from '../theme';
import type { RootStackParamList } from '../../App';

// ── Slide data ────────────────────────────────────────────────────────────────

interface HeadPart { text: string; green?: boolean }
interface Slide {
  headParts: HeadPart[];
  body:      string;
  feats:     [string, string][];
  btn:       string;
}

const SLIDES: Slide[] = [
  {
    headParts: [
      { text: 'See every open spot ' },
      { text: 'before you arrive.', green: true },
    ],
    body:  'Satellite imagery + AI tells you exactly which row has spots — no circling, no guessing.',
    feats: [['🛰️', 'Satellite imagery'], ['🤖', 'AI detection'], ['⚡', 'Live updates']],
    btn:   'Next →',
  },
  {
    headParts: [
      { text: 'Row-level', green: true },
      { text: ' routing straight to open spaces.' },
    ],
    body:  'Pick a row, tap Take Me There — Maps opens with the exact entrance coordinate.',
    feats: [['📍', 'Exact GPS coords'], ['🗺️', 'Maps deep link'], ['↗', 'Row routing']],
    btn:   'Next →',
  },
  {
    headParts: [
      { text: 'Rerouted ' },
      { text: 'automatically', green: true },
      { text: ' if spots fill.' },
    ],
    body:  'We monitor the lot while you drive. If your row fills, you get an instant alert.',
    feats: [['🔔', 'Live alerts'], ['⚡', 'Auto reroute'], ['✓', 'No surprises']],
    btn:   "Let's go →",
  },
];

// ── Hero parking-grid (SVG-free, View-based) ──────────────────────────────────

// 4 cols × 4 rows; cells with muted fills or animated green spots.
// Layout matches spottr-complete.html SVG (334×182) proportionally.
const GRID_CELLS = [
  // row, col, fill, pulseIdx (-1 = static)
  [0,0,'#2A3A5E',-1], [0,1,'rgba(18,192,88,0.14)',0],  [0,2,'#285040',-1], [0,3,'rgba(18,192,88,0.14)',1],
  [1,0,'#5E2828',-1], [1,1,'#2A3E6A',-1],              [1,2,'transparent',-1], [1,3,'#4A285E',-1],
  [2,0,'#284A5E',-1], [2,1,'rgba(18,192,88,0.14)',2],  [2,2,'#5E3A2A',-1], [2,3,'transparent',-1],
  [3,0,'transparent',-1],[3,1,'transparent',-1],        [3,2,'rgba(18,192,88,0.14)',3],[3,3,'#285E3A',-1],
] as const;

function ParkingHero() {
  const p = [
    useRef(new Animated.Value(0.80)).current,
    useRef(new Animated.Value(1.00)).current,
    useRef(new Animated.Value(0.90)).current,
    useRef(new Animated.Value(0.85)).current,
  ];

  useEffect(() => {
    const dur = [1000, 1200, 900, 1100];
    p.forEach((val, i) => {
      Animated.loop(
        Animated.sequence([
          Animated.timing(val, { toValue: 1,   duration: dur[i], useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
          Animated.timing(val, { toValue: 0.65, duration: dur[i], useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        ])
      ).start();
    });
  }, []);

  // Build 4 rows from flat cell list
  const rows: (typeof GRID_CELLS[number])[][] = [[], [], [], []];
  GRID_CELLS.forEach(cell => rows[cell[0]].push(cell));

  return (
    <View style={hero.container}>
      <View style={hero.grid}>
        {rows.map((row, ri) => (
          <View key={ri} style={hero.row}>
            {row.map((cell, ci) => {
              const [, , fill, pulseIdx] = cell;
              const isAnim  = pulseIdx >= 0;
              const lastCol = ci === row.length - 1;
              const lastRow = ri === rows.length - 1;

              const baseStyle = [
                hero.cell,
                !lastCol && hero.cellGapRight,
                !lastRow && hero.cellGapBottom,
                isAnim && hero.greenCell,
                { backgroundColor: fill as string },
              ];

              if (isAnim) {
                return (
                  <Animated.View
                    key={ci}
                    style={[...baseStyle, { opacity: p[pulseIdx as number] }]}
                  />
                );
              }
              return <View key={ci} style={baseStyle} />;
            })}
          </View>
        ))}
      </View>
      <Text style={hero.caption}>SATELLITE · AI DETECTION · REAL-TIME</Text>
    </View>
  );
}

const hero = StyleSheet.create({
  container: {
    height: 182,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#181F2C',
    justifyContent: 'flex-end',
  },
  grid: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    padding: 10,
    gap: 4,
  },
  row: {
    flex: 1,
    flexDirection: 'row',
    gap: 4,
  },
  cell: {
    flex: 1,
    borderRadius: 4,
  },
  cellGapRight:  {},
  cellGapBottom: {},
  greenCell: {
    borderWidth: 1.5,
    borderColor: '#12C058',
  },
  caption: {
    fontFamily: 'monospace',
    fontSize: 8,
    color: 'rgba(255,255,255,0.28)',
    textAlign: 'center',
    letterSpacing: 0.5,
    paddingBottom: 7,
    zIndex: 1,
  },
});

// ── Animated dot ──────────────────────────────────────────────────────────────

function Dot({ active }: { active: boolean }) {
  const width = useRef(new Animated.Value(active ? 20 : 6)).current;

  useEffect(() => {
    Animated.timing(width, {
      toValue:         active ? 20 : 6,
      duration:        300,
      useNativeDriver: false,
      easing:          Easing.out(Easing.ease),
    }).start();
  }, [active]);

  return (
    <Animated.View
      style={[
        s.dot,
        {
          width,
          backgroundColor: active ? '#12C058' : '#3E3E48',
        },
      ]}
    />
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function OnboardingScreen() {
  const nav          = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { colors }   = useTheme();
  const [idx, setIdx] = useState(0);
  const fadeAnim     = useRef(new Animated.Value(1)).current;
  const slideData    = SLIDES[idx];

  const transitionTo = useCallback((nextIdx: number) => {
    Animated.timing(fadeAnim, {
      toValue: 0, duration: 150, useNativeDriver: true,
    }).start(() => {
      setIdx(nextIdx);
      Animated.timing(fadeAnim, {
        toValue: 1, duration: 250, useNativeDriver: true,
      }).start();
    });
  }, [fadeAnim]);

  const handleNext = useCallback(() => {
    if (idx < SLIDES.length - 1) {
      transitionTo(idx + 1);
    } else {
      nav.replace('Permissions');
    }
  }, [idx, nav, transitionTo]);

  const handleSkip = useCallback(() => {
    nav.replace('Permissions');
  }, [nav]);

  return (
    <View style={[s.root, { backgroundColor: colors.bg }]}>
      {/* Hero */}
      <ParkingHero />

      {/* Dot progress */}
      <View style={s.dots}>
        {SLIDES.map((_, i) => <Dot key={i} active={i === idx} />)}
      </View>

      {/* Animated content block */}
      <Animated.View style={[s.content, { opacity: fadeAnim }]}>
        {/* Headline */}
        <Text style={[s.headline, { color: colors.ink, fontFamily: fonts.black }]}>
          {slideData.headParts.map((part, i) => (
            <Text key={i} style={part.green ? { color: colors.open } : undefined}>
              {part.text}
            </Text>
          ))}
        </Text>

        {/* Body */}
        <Text style={[s.body, { color: colors.ink3, fontFamily: fonts.medium }]}>
          {slideData.body}
        </Text>

        {/* Feature pills */}
        <View style={s.feats}>
          {slideData.feats.map(([icon, label], i) => (
            <View
              key={i}
              style={[s.feat, { backgroundColor: colors.sf, borderColor: colors.bd }]}
            >
              <Text style={s.featIcon}>{icon}</Text>
              <Text style={[s.featLabel, { color: colors.ink2, fontFamily: fonts.bold }]}>
                {label}
              </Text>
            </View>
          ))}
        </View>
      </Animated.View>

      {/* Actions */}
      <View style={s.actions}>
        <TouchableOpacity
          style={[s.cta, { backgroundColor: colors.open }]}
          onPress={handleNext}
          activeOpacity={0.85}
        >
          <Text style={[s.ctaText, { fontFamily: fonts.bold }]}>
            {slideData.btn}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={handleSkip} activeOpacity={0.7}>
          <Text style={[s.skip, { color: colors.ink3, fontFamily: fonts.mono }]}>
            Skip intro
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 16,
    paddingBottom: 0,
  },

  // Dots
  dots: {
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    marginTop: 20,
    marginBottom: 20,
  },
  dot: {
    height: 6,
    borderRadius: 3,
  },

  // Content
  content: {
    flex: 1,
  },
  headline: {
    fontSize:      27,
    fontWeight:    '900',
    letterSpacing: -0.7,
    lineHeight:    30,
    marginBottom:  10,
  },
  body: {
    fontSize:     15,
    fontWeight:   '500',
    lineHeight:   23,
    marginBottom: 22,
  },

  // Feature pills
  feats: {
    flexDirection: 'row',
    gap:           8,
  },
  feat: {
    flex:          1,
    borderRadius:  14,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems:    'center',
    borderWidth:   1,
  },
  featIcon: {
    fontSize:     22,
    marginBottom: 5,
  },
  featLabel: {
    fontSize:      11,
    fontWeight:    '700',
    lineHeight:    15,
    textAlign:     'center',
  },

  // Actions
  actions: {
    gap:           8,
    paddingBottom: 32,
    paddingTop:    24,
  },
  cta: {
    width:         '100%',
    paddingVertical: 15,
    borderRadius:  18,
    alignItems:    'center',
  },
  ctaText: {
    fontSize:      16,
    fontWeight:    '700',
    color:         '#FFFFFF',
    letterSpacing: -0.1,
  },
  skip: {
    textAlign:     'center',
    fontSize:      11,
    paddingVertical: 6,
    letterSpacing: 0.5,
  },
});
