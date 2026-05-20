/**
 * SearchScreen.tsx — Gate C rebuild
 *
 * Full-screen search: small map strip at top, search sheet below.
 * Spec: spottr-finalframe.html SCREEN 05
 *
 * Flow:
 *   1. Screen opens with TextInput auto-focused
 *   2. User types → debounced searchPlaces() → show suggestions
 *   3. Tap suggestion → getLotsNear(place) → navigate LotDetail
 *   4. Dismiss (back or tap ×) → go back to Home
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator, Platform,
} from 'react-native';
import MapView, { UrlTile } from 'react-native-maps';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { api, type PlaceResult, type Lot } from '../services/api';
import { colors, fonts } from '../theme';
import type { RootStackParamList } from '../../App';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAPBOX_TOKEN = (process.env as any).EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
const MAPBOX_TILE_URL = `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${MAPBOX_TOKEN}`;
const RECENT_SEARCHES_KEY = '@spottr_recent_searches';
const MAX_RECENT = 5;
const DEBOUNCE_MS = 280;

// ── Types ─────────────────────────────────────────────────────────────────────

type Nav = NativeStackNavigationProp<RootStackParamList, 'Search'>;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadRecentSearches(): Promise<PlaceResult[]> {
  try {
    const raw = await AsyncStorage.getItem(RECENT_SEARCHES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function saveRecentSearch(place: PlaceResult, existing: PlaceResult[]): Promise<void> {
  try {
    const filtered = existing.filter(p => p.place_id !== place.place_id);
    const next = [place, ...filtered].slice(0, MAX_RECENT);
    await AsyncStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SearchScreen() {
  const nav = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [recentSearches, setRecentSearches] = useState<PlaceResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [userLoc, setUserLoc] = useState<{ lat: number; lng: number } | null>(null);

  // Get user location for proximity-biased search results
  useEffect(() => {
    Location.getLastKnownPositionAsync().then(pos => {
      if (pos) setUserLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    }).catch(() => {});
  }, []);

  // Load recent searches
  useEffect(() => {
    loadRecentSearches().then(setRecentSearches);
  }, []);

  // Auto-focus input
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(t);
  }, []);

  // Debounced search
  const handleQueryChange = useCallback((text: string) => {
    setQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!text.trim()) { setResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const resp = await api.searchPlaces(text.trim(), userLoc?.lat, userLoc?.lng);
        setResults(resp.results);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);
  }, [userLoc]);

  // Tap a result → resolve lot → navigate
  const handleSelect = useCallback(async (place: PlaceResult, isRecent = false) => {
    if (!isRecent) {
      const updated = await loadRecentSearches();
      await saveRecentSearch(place, updated);
      setRecentSearches([place, ...updated.filter(p => p.place_id !== place.place_id)].slice(0, MAX_RECENT));
    }
    try {
      const lat = place.lat ?? userLoc?.lat ?? 41.8;
      const lng = place.lng ?? userLoc?.lng ?? -72.56;
      const resp = await api.getLotsNear(lat, lng, 800, place.mainText, place.place_id);
      const lot = resp.lots[0] ?? null;
      if (lot) {
        nav.navigate('LotDetail', { lotId: lot.id, lotName: lot.name ?? place.mainText, lot });
      }
    } catch (err) {
      console.warn('[SearchScreen] handleSelect error:', err);
    }
  }, [nav, userLoc]);

  const displayItems = query.trim() ? results : recentSearches;
  const showRecent = !query.trim() && recentSearches.length > 0;
  const sectionLabel = showRecent ? 'recent' : (results.length > 0 ? 'suggestions' : null);

  const mapRegion = userLoc
    ? { latitude: userLoc.lat, longitude: userLoc.lng, latitudeDelta: 0.03, longitudeDelta: 0.03 }
    : { latitude: 41.8, longitude: -72.56, latitudeDelta: 0.05, longitudeDelta: 0.05 };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* ── Map strip (130px per spec .sea .mw{height:130px}) ────────────── */}
      <MapView
        style={styles.mapStrip}
        region={mapRegion}
        showsUserLocation
        showsMyLocationButton={false}
        showsCompass={false}
        rotateEnabled={false}
        scrollEnabled={false}
        zoomEnabled={false}
        pitchEnabled={false}
      >
        {!!MAPBOX_TOKEN && (
          <UrlTile urlTemplate={MAPBOX_TILE_URL} maximumZ={19} flipY={false} tileSize={256} />
        )}
      </MapView>

      {/* ── Search sheet ─────────────────────────────────────────────────── */}
      <View style={styles.sheet}>
        {/* Drag handle */}
        <View style={styles.handle} />

        {/* Active search bar (.seaa) */}
        <View style={styles.activeBar}>
          <Text style={styles.searchIcon}>⌕</Text>
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={query}
            onChangeText={handleQueryChange}
            placeholder="Search lots, malls, campuses…"
            placeholderTextColor={colors.t3}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => { setQuery(''); setResults([]); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.clearBtn}>✕</Text>
            </TouchableOpacity>
          )}
          {loading && <ActivityIndicator size="small" color={colors.a} style={{ marginLeft: 8 }} />}
        </View>

        {/* Dismiss button */}
        <TouchableOpacity style={styles.cancelBtn} onPress={() => nav.goBack()}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>

        {/* Section label */}
        {sectionLabel && (
          <Text style={styles.slab}>{sectionLabel}</Text>
        )}

        {/* Results list (.sr rows) */}
        <FlatList
          data={displayItems}
          keyExtractor={item => item.place_id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const isRecent = !query.trim();
            return (
              <TouchableOpacity
                style={styles.resultRow}
                onPress={() => handleSelect(item, isRecent)}
                activeOpacity={0.7}
              >
                <Text style={[styles.resultIcon, isRecent && styles.resultIconDim]}>
                  {isRecent ? '○' : '◎'}
                </Text>
                <View style={styles.resultText}>
                  <Text style={styles.resultName} numberOfLines={1}>{item.mainText}</Text>
                  <Text style={styles.resultAddr} numberOfLines={1}>{item.secondaryText}</Text>
                </View>
              </TouchableOpacity>
            );
          }}
          style={styles.resultsList}
        />
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },

  // Map strip
  mapStrip: {
    height: 130,
    width: '100%',
  },

  // Sheet (.seasht)
  sheet: {
    flex: 1,
    backgroundColor: colors.s1,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    marginTop: -24,
    paddingHorizontal: 18,
    paddingTop: 10,
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 12,
  },

  // Active search bar (.seaa)
  activeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.s2,
    borderWidth: 0.5,
    borderColor: colors.a,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 11 : 8,
    marginTop: 4,
    marginBottom: 4,
  },
  searchIcon: {
    fontSize: 18,
    color: colors.a,
    marginRight: 10,
    fontFamily: fonts.sans,
  },
  input: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.t1,
    padding: 0,
  },
  clearBtn: {
    fontSize: 13,
    color: colors.t3,
    marginLeft: 4,
  },

  // Cancel button
  cancelBtn: {
    alignSelf: 'flex-end',
    marginTop: 2,
    marginBottom: 4,
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  cancelText: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.a,
  },

  // Section label (.slab)
  slab: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.t3,
    letterSpacing: 11 * 0.06,
    textTransform: 'lowercase',
    marginTop: 14,
    marginBottom: 6,
  },

  // Result rows (.sr)
  resultsList: {
    flex: 1,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.b,
  },
  resultIcon: {
    fontSize: 18,
    color: colors.t3,
    marginTop: 2,
    fontFamily: fonts.sans,
  },
  resultIconDim: {
    color: colors.t4,
  },
  resultText: {
    flex: 1,
  },
  resultName: {
    fontFamily: fonts.sansMd,
    fontSize: 14,
    color: colors.t1,
    marginBottom: 2,
  },
  resultAddr: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.t3,
  },
});
