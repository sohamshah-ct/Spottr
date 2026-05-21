/**
 * App.tsx — Spottr root
 *
 * Navigation: react-navigation v6 native stack, NO tab bar.
 * Eight canonical routes per the design spec:
 *   Splash → Onboarding → Permissions → Home → Search →
 *   LotDetail → Approach → Parked
 *
 * Legacy routes (Driving, Reroute) remain registered so existing
 * screen code compiles; they will be removed when their screens
 * are replaced in Checkpoint 3.
 */

import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_700Bold,
} from '@expo-google-fonts/dm-sans';
import {
  DMMono_400Regular,
  DMMono_500Medium,
} from '@expo-google-fonts/dm-mono';

import { ThemeProvider, useTheme, fonts, colors as C } from './src/theme';
import type { Lot } from './src/services/api';
import { useParkingStore } from './src/services/parkingStateMachine';

import SplashScreen      from './src/screens/SplashScreen';
import OnboardingScreen  from './src/screens/OnboardingScreen';
import PermissionsScreen from './src/screens/PermissionsScreen';
import HomeScreen        from './src/screens/HomeScreen';
import SearchScreen      from './src/screens/SearchScreen';
import LotDetailScreen   from './src/screens/LotDetailScreen';
import ParkedScreen      from './src/screens/ParkedScreen';
import DrivingScreen     from './src/screens/DrivingScreen';
import RerouteScreen     from './src/screens/RerouteScreen';

// ── Route param types ─────────────────────────────────────────────────────────

export type RootStackParamList = {
  // Canonical spec routes (spottr-finalframe.html §03)
  Splash:      undefined;
  Onboarding:  undefined;
  Permissions: undefined;
  Home:        undefined;
  Search:      undefined;
  LotDetail:   { lotId: string; lotName?: string; lot?: Lot };
  Approach:    {
    lotId:       string;
    lotName?:    string;
    lot?:        Lot;
    zoneCentLat?: number;
    zoneCentLng?: number;
    openCount?:  number;
    zoneName?:   string | null;
  };
  Parked:      { lotId: string; lotName?: string; spotId?: string; timeSavedMin?: number };
  Reroute:     { lotId: string; oldRow: string; newRow: string; newRowLat: number; newRowLng: number; openCount: number; lotName?: string };

  // Legacy route — kept so DrivingScreen can navigate back from DrivingScreen (Reroute → Approach)
  Driving:     { lotId: string; rowLabel: string; rowLat: number; rowLng: number; lotName?: string };

  // Typography smoke-test screen — remove before production
  TypeTest:    undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

// ── Typography smoke-test screen ──────────────────────────────────────────────
// Verifies DM Sans and DM Mono load correctly at every weight the spec uses.
// Navigate here via nav.navigate('TypeTest') during development.

function TypeTestScreen() {
  const { colors } = useTheme();
  const rows: Array<{ label: string; style: object; value: string }> = [
    {
      label: 'wordmark · sansBold 36 / -4%',
      style: { fontFamily: fonts.sansBold, fontSize: 36, letterSpacing: 36 * -0.04, color: colors.t1 },
      value: 'Spottr',
    },
    {
      label: 'h1 · sansMd 30 / -2%',
      style: { fontFamily: fonts.sansMd, fontSize: 30, letterSpacing: 30 * -0.02, color: colors.t1 },
      value: 'See every open spot',
    },
    {
      label: 'h2 · sansMd 22 / -1%',
      style: { fontFamily: fonts.sansMd, fontSize: 22, letterSpacing: 22 * -0.01, color: colors.t1 },
      value: 'Approach view',
    },
    {
      label: 'big number · sansMd 62 / -3% / accent',
      style: { fontFamily: fonts.sansMd, fontSize: 62, letterSpacing: 62 * -0.03, color: colors.a },
      value: '247',
    },
    {
      label: 'body · sans 15 / lh 1.55',
      style: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 15 * 1.55, color: colors.t2 },
      value: 'Spottr counts open spots using satellite imagery and AI.',
    },
    {
      label: 'body medium · sansMd 15',
      style: { fontFamily: fonts.sansMd, fontSize: 15, color: colors.t1 },
      value: 'Take me there',
    },
    {
      label: 'small · sans 14 / lh 1.6',
      style: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 14 * 1.6, color: colors.t2 },
      value: 'scanned 3 min ago',
    },
    {
      label: 'mono label · mono 11 / +6%',
      style: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 11 * 0.06, color: colors.t3, textTransform: 'uppercase' as const },
      value: 'recent',
    },
    {
      label: 'mono medium · monoMd 12 / +5%',
      style: { fontFamily: fonts.monoMd, fontSize: 12, letterSpacing: 12 * 0.05, color: colors.a },
      value: 'APPROACHING · 60 FT',
    },
    {
      label: 'mono xs · mono 10 / +6%',
      style: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 10 * 0.06, color: colors.t4, textTransform: 'uppercase' as const },
      value: 'YOUR SPOT',
    },
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 28, paddingBottom: 60 }}
    >
      <Text style={[ts.header, { fontFamily: fonts.monoMd, color: colors.a }]}>
        TYPE RAMP SMOKE TEST
      </Text>
      <Text style={[ts.sub, { fontFamily: fonts.mono, color: colors.t3 }]}>
        DM Sans + DM Mono · all spec-defined sizes
      </Text>
      <View style={[ts.rule, { backgroundColor: colors.b }]} />

      {rows.map((row, i) => (
        <View key={i} style={ts.row}>
          <Text style={[ts.rowLabel, { fontFamily: fonts.mono, color: colors.t4 }]}>
            {row.label}
          </Text>
          <Text style={row.style}>{row.value}</Text>
        </View>
      ))}

      <View style={[ts.rule, { backgroundColor: colors.b }]} />
      <Text style={[ts.rowLabel, { fontFamily: fonts.mono, color: colors.t3 }]}>
        bg {colors.bg} · s1 {colors.s1} · a {colors.a} · ah {colors.ah}
      </Text>
    </ScrollView>
  );
}

const ts = StyleSheet.create({
  header:   { fontSize: 12, letterSpacing: 1.2, marginBottom: 4 },
  sub:      { fontSize: 11, marginBottom: 20 },
  rule:     { height: 0.5, marginVertical: 16 },
  row:      { marginBottom: 20 },
  rowLabel: { fontSize: 10, letterSpacing: 0.6, marginBottom: 6, textTransform: 'uppercase' },
});

// ── App content ───────────────────────────────────────────────────────────────

function AppContent() {
  const { colors, isDark } = useTheme();
  const navRef = React.useRef<any>(null);

  // Cold-launch rehydration: if the store rehydrated with PARKED state, navigate there
  const handleNavReady = React.useCallback(() => {
    const phase = useParkingStore.getState().phase;
    if (phase === 'PARKED' && navRef.current) {
      const parkedLotId = useParkingStore.getState().lotId;
      const parkedLotName = useParkingStore.getState().lot?.name;
      navRef.current.navigate('Parked', {
        lotId:   parkedLotId ?? '',
        lotName: parkedLotName ?? undefined,
      });
    }
  }, []);

  return (
    <NavigationContainer ref={navRef} onReady={handleNavReady}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack.Navigator
        initialRouteName="Splash"
        screenOptions={{
          headerShown:  false,
          contentStyle: { backgroundColor: colors.bg },
          animation:    'fade',
        }}
      >
        {/* ── Onboarding flow ──────────────────────────────────────────── */}
        <Stack.Screen name="Splash"      component={SplashScreen} />
        <Stack.Screen name="Onboarding"  component={OnboardingScreen} />
        <Stack.Screen name="Permissions" component={PermissionsScreen} />

        {/* ── Core loop ────────────────────────────────────────────────── */}
        <Stack.Screen name="Home"      component={HomeScreen} />
        <Stack.Screen name="Search"    component={SearchScreen} />
        <Stack.Screen name="LotDetail" component={LotDetailScreen} />
        <Stack.Screen name="Approach"  component={DrivingScreen} />
        <Stack.Screen name="Parked"    component={ParkedScreen} />
        <Stack.Screen name="Reroute"   component={RerouteScreen} />

        {/* ── Legacy Driving route — used by RerouteScreen → DrivingScreen ── */}
        <Stack.Screen name="Driving"   component={DrivingScreen} />

        {/* ── Dev tools ────────────────────────────────────────────────── */}
        <Stack.Screen
          name="TypeTest"
          component={TypeTestScreen}
          options={{ headerShown: true, title: 'Type Ramp', headerStyle: { backgroundColor: colors.s1 }, headerTintColor: colors.t1 }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [fontsLoaded] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_700Bold,
    DMMono_400Regular,
    DMMono_500Medium,
  });

  if (!fontsLoaded) return null;

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AppContent />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
