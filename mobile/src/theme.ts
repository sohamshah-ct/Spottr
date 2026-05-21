/**
 * theme.ts — Spottr design tokens
 * Canonical values match spottr-finalframe.html CSS variables exactly.
 * Legacy token names are preserved as aliases so existing screens
 * compile without modification (they will be updated screen-by-screen
 * through Checkpoints 2 and 3).
 */

import React, {
  createContext, useContext, useState,
  useEffect, useCallback, type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Color palette — dark canonical (spec §02) ─────────────────────────────────

const DARK_PALETTE = {
  // ── Spec canonical tokens (CSS var name → RN token name) ──────────────
  bg:  '#0A0A0A',               // --bg  true OLED black
  s1:  '#121212',               // --s1  sheets
  s2:  '#1A1A1A',               // --s2  inputs
  s3:  '#222222',               // --s3  raised surfaces

  b:   'rgba(255,255,255,0.08)', // --b   default border
  bs:  'rgba(255,255,255,0.16)', // --bs  strong border

  t1:  '#ffffff',                // --t1  primary text
  t2:  'rgba(255,255,255,0.65)', // --t2  secondary text
  t3:  'rgba(255,255,255,0.42)', // --t3  tertiary text
  t4:  'rgba(255,255,255,0.28)', // --t4  quaternary text

  a:   '#34D399',                // --a   accent (Tailwind emerald-400)
  ah:  '#10B981',                // --ah  accent hover/pressed
  ad:  'rgba(52,211,153,0.18)', // --ad  accent dim (tinted background)
  af:  'rgba(52,211,153,0.08)', // --af  accent faint (very dim tinted)

  // ── Status colors used by lot-detail occupancy logic ─────────────────
  warn:       '#F0930A',
  warnBg:     'rgba(240,147,10,0.10)',
  warnBorder: 'rgba(240,147,10,0.25)',
  full:       '#E63946',
  fullBg:     'rgba(230,57,70,0.08)',
  fullBorder: 'rgba(230,57,70,0.22)',

  // ── Misc ──────────────────────────────────────────────────────────────
  blue:   '#2563EB',
  blue08: 'rgba(37,99,235,0.08)',

  // ── Legacy aliases — keep existing screen imports compiling ───────────
  // (progressively removed as each screen is rewritten in Checkpoint 2-3)
  sf:         '#121212',
  sf2:        '#1A1A1A',
  sf3:        '#222222',
  ink:        '#ffffff',
  ink2:       'rgba(255,255,255,0.65)',
  ink3:       'rgba(255,255,255,0.42)',
  ink4:       'rgba(255,255,255,0.28)',
  bd:         'rgba(255,255,255,0.08)',
  bd2:        'rgba(255,255,255,0.16)',
  open:       '#34D399',
  openBg:     'rgba(52,211,153,0.18)',
  openBorder: 'rgba(52,211,153,0.30)',
  surface:    '#121212',
  surface2:   '#1A1A1A',
  surface3:   '#222222',
  border:     'rgba(255,255,255,0.08)',
  border2:    'rgba(255,255,255,0.16)',
  green:      '#34D399',
  greenDim:   'rgba(52,211,153,0.18)',
  greenGlow:  'rgba(52,211,153,0.20)',
  amber:      '#F0930A',
  amberDim:   'rgba(240,147,10,0.10)',
  red:        '#E63946',
  redDim:     'rgba(230,57,70,0.08)',
  card:       '#121212',
  text:       '#ffffff',
  textMuted:  'rgba(255,255,255,0.65)',
  textDim:    'rgba(255,255,255,0.42)',
  accent:     '#34D399',
  accentDim:  'rgba(52,211,153,0.18)',
  warning:    '#F0930A',
  error:      '#E63946',
  success:    '#34D399',
} as const;

// ── Light palette — deferred to Task 08; mirrors dark with inverted surfaces ──

const LIGHT_PALETTE = {
  bg:  '#F5F5F5',
  s1:  '#FFFFFF',
  s2:  '#EBEBEB',
  s3:  '#E0E0E0',

  b:   'rgba(0,0,0,0.08)',
  bs:  'rgba(0,0,0,0.16)',

  t1:  '#0A0A0A',
  t2:  'rgba(0,0,0,0.65)',
  t3:  'rgba(0,0,0,0.42)',
  t4:  'rgba(0,0,0,0.28)',

  a:   '#34D399',
  ah:  '#10B981',
  ad:  'rgba(52,211,153,0.18)',
  af:  'rgba(52,211,153,0.08)',

  warn:       '#F0930A',
  warnBg:     'rgba(240,147,10,0.10)',
  warnBorder: 'rgba(240,147,10,0.25)',
  full:       '#E63946',
  fullBg:     'rgba(230,57,70,0.08)',
  fullBorder: 'rgba(230,57,70,0.22)',

  blue:   '#2563EB',
  blue08: 'rgba(37,99,235,0.08)',

  sf:         '#FFFFFF',
  sf2:        '#EBEBEB',
  sf3:        '#E0E0E0',
  ink:        '#0A0A0A',
  ink2:       'rgba(0,0,0,0.65)',
  ink3:       'rgba(0,0,0,0.42)',
  ink4:       'rgba(0,0,0,0.28)',
  bd:         'rgba(0,0,0,0.08)',
  bd2:        'rgba(0,0,0,0.16)',
  open:       '#34D399',
  openBg:     'rgba(52,211,153,0.18)',
  openBorder: 'rgba(52,211,153,0.30)',
  surface:    '#FFFFFF',
  surface2:   '#EBEBEB',
  surface3:   '#E0E0E0',
  border:     'rgba(0,0,0,0.08)',
  border2:    'rgba(0,0,0,0.16)',
  green:      '#34D399',
  greenDim:   'rgba(52,211,153,0.18)',
  greenGlow:  'rgba(52,211,153,0.20)',
  amber:      '#F0930A',
  amberDim:   'rgba(240,147,10,0.10)',
  red:        '#E63946',
  redDim:     'rgba(230,57,70,0.08)',
  card:       '#FFFFFF',
  text:       '#0A0A0A',
  textMuted:  'rgba(0,0,0,0.65)',
  textDim:    'rgba(0,0,0,0.42)',
  accent:     '#34D399',
  accentDim:  'rgba(52,211,153,0.18)',
  warning:    '#F0930A',
  error:      '#E63946',
  success:    '#34D399',
} as const;

export type Colors = { [K in keyof typeof DARK_PALETTE]: string };
export const darkColors  = DARK_PALETTE;
export const lightColors = LIGHT_PALETTE as unknown as Colors;

// Static export for screens not yet migrated to the hook
export const theme = DARK_PALETTE;
export const colors = DARK_PALETTE;
export type Theme = Colors;

// ── Font families ─────────────────────────────────────────────────────────────
// DM Sans: body copy — weights 400 and 500 only.
// DM Sans 700 (Bold): WORDMARK ONLY (SplashScreen), nowhere else.
// DM Mono: technical labels — timestamps, coordinates, all-caps section labels.

export const fonts = {
  // Canonical spec names
  sans:     'DMSans_400Regular',
  sansMd:   'DMSans_500Medium',
  sansBold: 'DMSans_700Bold',   // wordmark only — do not use elsewhere
  mono:     'DMMono_400Regular',
  monoMd:   'DMMono_500Medium',

  // Legacy names — kept for existing screens, map to same values
  regular:  'DMSans_400Regular',
  medium:   'DMSans_500Medium',
  bold:     'DMSans_700Bold',
  black:    'DMSans_700Bold',   // was 900Black; spec has no 900 — map to 700
  monoBold: 'DMMono_500Medium',
} as const;

// ── Dynamic theme context ─────────────────────────────────────────────────────

interface ThemeCtx {
  colors: Colors;
  isDark:  boolean;
  toggle:  () => void;
}

const ThemeContext = createContext<ThemeCtx>({
  colors: DARK_PALETTE,
  isDark:  true,
  toggle:  () => {},
});

const STORAGE_KEY = '@theme_mode';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(val => {
      if (val === 'light') setIsDark(false);
    }).catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    setIsDark(prev => {
      const next = !prev;
      AsyncStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light').catch(() => {});
      return next;
    });
  }, []);

  const value: ThemeCtx = {
    colors: isDark ? (DARK_PALETTE as unknown as Colors) : (LIGHT_PALETTE as unknown as Colors),
    isDark,
    toggle,
  };

  return React.createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme(): ThemeCtx {
  return useContext(ThemeContext);
}
