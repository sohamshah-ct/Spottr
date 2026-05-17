import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Animated, Modal, TextInput, Keyboard, Dimensions, Linking,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { api, Lot, PlaceResult } from '../services/api';
import { theme } from '../theme';
import type { RootStackParamList } from '../../App';
type HistoryEntry = { id: string; name: string };
type NearbyState  = 'init' | 'loading' | 'denied' | 'loaded' | 'empty' | 'error';

const HISTORY_KEY = '@spottr_history';
const NAME_KEY    = '@user_name';
const HARTFORD    = { lat: 41.7637, lng: -72.6851 };
const { height: SCREEN_H } = Dimensions.get('window');

// ── Pure helpers ──────────────────────────────────────────────────────────────

function getGreeting(): string {
  const h = new Date().getHours();
  if (h >= 5  && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 21) return 'Good evening';
  return 'Up late';
}

function isLateNight(): boolean {
  const h = new Date().getHours();
  return h >= 21 || h < 5;
}

function countColor(open: number): string {
  if (open > 50) return theme.green;
  if (open >= 10) return theme.amber;
  return theme.red;
}

function lotBadgeColor(lot: Lot): string {
  if (lot.spot_detection_status === 'fresh')  return theme.green;
  if (lot.spot_detection_status === 'cached') return theme.amber;
  return theme.ink3;
}

function fmtDist(m?: number): string {
  if (m == null) return '';
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}

function normalizeHistory(raw: any[]): HistoryEntry[] {
  return raw.map(e => typeof e === 'string' ? { id: e, name: 'Parking Lot' } : e);
}

async function getHistory(): Promise<HistoryEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    return raw ? normalizeHistory(JSON.parse(raw)) : [];
  } catch { return []; }
}

async function addToHistory(id: string, name: string): Promise<void> {
  try {
    const prev = await getHistory();
    const next = [{ id, name }, ...prev.filter(h => h.id !== id)].slice(0, 20);
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {}
}

// ── Shimmer hook ──────────────────────────────────────────────────────────────

function useShimmer(): Animated.Value {
  const anim = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 0.65, duration: 850, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0.3,  duration: 850, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);
  return anim;
}

// ── Quick Go Card ─────────────────────────────────────────────────────────────

function QuickGoCard({ lotId, onPress }: { lotId: string; onPress: () => void }) {
  const [info, setInfo] = useState<{ name: string; open: number } | null>(null);
  const [live, setLive] = useState(false);
  const shimmer = useShimmer();

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const [lot, rows] = await Promise.all([api.getLot(lotId), api.getLotRows(lotId)]);
        if (!dead) {
          const open = rows.rows.reduce((s, r) => s + r.open, 0);
          setInfo({ name: lot.name ?? 'Parking Lot', open });
        }
      } catch {}
      if (!dead) setLive(true);
    })();
    return () => { dead = true; };
  }, [lotId]);

  const color = info ? countColor(info.open) : theme.ink3;

  return (
    <TouchableOpacity style={s.qgCard} onPress={onPress} activeOpacity={0.75}>
      {!live ? (
        <>
          <Animated.View style={[s.qgSkelName, { opacity: shimmer }]} />
          <Animated.View style={[s.qgSkelNum,  { opacity: shimmer }]} />
          <Animated.Text style={[s.qgStatus,   { opacity: shimmer }]}>checking...</Animated.Text>
        </>
      ) : (
        <>
          <Text style={s.qgName} numberOfLines={1}>{info?.name ?? 'Parking Lot'}</Text>
          <Text style={[s.qgNum, { color }]}>{info != null ? info.open : '?'}</Text>
          <Text style={s.qgStatus}>{info != null ? 'open now' : 'tap to check'}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

// ── Quick Go Skeleton ─────────────────────────────────────────────────────────

function QuickGoSkel({ shimmer }: { shimmer: Animated.Value }) {
  return (
    <Animated.View style={[s.qgCard, { opacity: shimmer }]}>
      <View style={s.qgSkelName} />
      <View style={s.qgSkelNum}  />
      <View style={{ width: 42, height: 7, borderRadius: 3, backgroundColor: theme.surface3 }} />
    </Animated.View>
  );
}

// ── Nearby Row ────────────────────────────────────────────────────────────────

function NearbyRow({ lot, onPress }: { lot: Lot; onPress: () => void }) {
  const color  = lotBadgeColor(lot);
  const dist   = fmtDist(lot.distance_meters);
  const status = lot.spot_detection_status === 'fresh'  ? 'Live'
               : lot.spot_detection_status === 'cached' ? 'Cached'
               : 'Monitoring';
  const meta = [dist, status].filter(Boolean).join('  ·  ');

  return (
    <TouchableOpacity style={s.nearRow} onPress={onPress} activeOpacity={0.75}>
      <View style={[s.nearBadge, { backgroundColor: color + '22' }]}>
        <Text style={[s.nearBadgeNum, { color }]} numberOfLines={1}>
          {lot.total_spaces ?? '?'}
        </Text>
      </View>
      <View style={s.nearMid}>
        <Text style={s.nearName} numberOfLines={1}>{lot.name ?? 'Parking Lot'}</Text>
        <Text style={s.nearMeta} numberOfLines={1}>{meta}</Text>
      </View>
      <Text style={s.nearChevron}>›</Text>
    </TouchableOpacity>
  );
}

// ── Nearby Skeleton Row ───────────────────────────────────────────────────────

function NearbySkelRow({ shimmer }: { shimmer: Animated.Value }) {
  return (
    <Animated.View style={[s.nearRow, { opacity: shimmer }]}>
      <View style={[s.nearBadge, { backgroundColor: theme.surface3 }]} />
      <View style={s.nearMid}>
        <View style={{ width: '62%', height: 10, borderRadius: 4, backgroundColor: theme.surface3, marginBottom: 6 }} />
        <View style={{ width: '38%', height: 8,  borderRadius: 3, backgroundColor: theme.surface3 }} />
      </View>
    </Animated.View>
  );
}

// ── Action Card (denied / empty / error states) ───────────────────────────────

function ActionCard({
  title, body, errorMsg, btnLabel, onPress,
}: {
  title: string; body?: string; errorMsg?: string;
  btnLabel: string; onPress: () => void;
}) {
  return (
    <View style={s.actionCard}>
      <Text style={s.actionTitle}>{title}</Text>
      {errorMsg
        ? <Text style={s.actionError}>{errorMsg}</Text>
        : body
        ? <Text style={s.actionBody}>{body}</Text>
        : null
      }
      <TouchableOpacity style={s.actionBtn} onPress={onPress} activeOpacity={0.85}>
        <Text style={s.actionBtnText}>{btnLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Search Sheet ──────────────────────────────────────────────────────────────

interface SearchSheetProps {
  visible: boolean; onClose: () => void;
  userLat?: number; userLng?: number;
  onSelectLot: (id: string, name: string) => void;
}

function SearchSheet({ visible, onClose, userLat, userLng, onSelectLot }: SearchSheetProps) {
  const insets                    = useSafeAreaInsets();
  const [rendered, setRendered]   = useState(false);
  const [query, setQuery]         = useState('');
  const [recent, setRecent]       = useState<HistoryEntry[]>([]);
  const [results, setResults]     = useState<PlaceResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [noParking, setNoParking] = useState<string | null>(null); // place name when lots=0
  const sheetY   = useRef(new Animated.Value(SCREEN_H)).current;
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      sheetY.setValue(SCREEN_H);
      setRendered(true);
      Animated.spring(sheetY, {
        toValue: 0, tension: 65, friction: 11, useNativeDriver: true,
      }).start();
      getHistory().then(h => setRecent(h.slice(0, 5)));
      setTimeout(() => inputRef.current?.focus(), 320);
    } else if (rendered) {
      Keyboard.dismiss();
      Animated.spring(sheetY, {
        toValue: SCREEN_H, tension: 65, friction: 11, useNativeDriver: true,
      }).start(() => { setRendered(false); setQuery(''); setResults([]); setNoParking(null); });
    }
  }, [visible]);

  const onChangeText = (text: string) => {
    setQuery(text);
    setNoParking(null);
    if (debounce.current) clearTimeout(debounce.current);
    if (!text.trim()) { setResults([]); return; }
    debounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api.searchPlaces(text, userLat, userLng);
        setResults(res.results.slice(0, 8));
      } catch { setResults([]); }
      setSearching(false);
    }, 300);
  };

  const onSelectPlace = async (place: PlaceResult) => {
    if (place.lat == null || place.lng == null) return;
    Keyboard.dismiss();
    setSearching(true);
    setNoParking(null);
    try {
      const res = await api.getLotsNear(place.lat, place.lng, 800);
      if (res.lots.length === 0) {
        setNoParking(place.mainText);
        setSearching(false);
        return;
      }
      const lot = res.lots[0];
      setSearching(false);
      onSelectLot(lot.id, lot.name ?? place.mainText);
    } catch {
      setSearching(false);
    }
  };

  if (!rendered) return null;

  const showRecent  = !query.trim() && recent.length > 0;
  const showResults = !!query.trim();

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' }}>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose} />
        <Animated.View
          style={[s.sheet, { transform: [{ translateY: sheetY }], paddingBottom: insets.bottom + 8 }]}
        >
          <View style={s.sheetHandle} />

          <View style={s.sheetInputRow}>
            <TextInput
              ref={inputRef}
              style={s.sheetInput}
              placeholder="Search any address or place…"
              placeholderTextColor={theme.ink3}
              value={query}
              onChangeText={onChangeText}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
            />
            {query.length > 0 && (
              <TouchableOpacity
                onPress={() => { setQuery(''); setResults([]); setNoParking(null); }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={s.sheetClear}>✕</Text>
              </TouchableOpacity>
            )}
          </View>

          <ScrollView
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
          >
            {showRecent && (
              <>
                <Text style={[s.sectionTitle, { marginHorizontal: 0, marginTop: 16 }]}>RECENT</Text>
                {recent.map(h => (
                  <TouchableOpacity
                    key={h.id}
                    style={s.sheetResultRow}
                    onPress={() => onSelectLot(h.id, h.name)}
                    activeOpacity={0.75}
                  >
                    <View style={s.sheetResultIcon}>
                      <Text style={{ color: theme.ink3, fontSize: 11, fontWeight: '700' }}>P</Text>
                    </View>
                    <Text style={s.sheetResultName} numberOfLines={1}>{h.name}</Text>
                    <Text style={s.nearChevron}>›</Text>
                  </TouchableOpacity>
                ))}
              </>
            )}

            {showResults && searching && (
              <Text style={[s.actionBody, { textAlign: 'center', marginTop: 32 }]}>Searching…</Text>
            )}

            {showResults && !searching && noParking && (
              <View style={{ marginTop: 32, alignItems: 'center', gap: 6 }}>
                <Text style={[s.actionBody, { textAlign: 'center' }]}>
                  No parking found near "{noParking}"
                </Text>
                <Text style={[s.nearMeta, { textAlign: 'center' }]}>
                  Try a different address or zoom out.
                </Text>
              </View>
            )}

            {showResults && !searching && !noParking && results.length === 0 && (
              <Text style={[s.actionBody, { textAlign: 'center', marginTop: 32 }]}>
                Nothing matched "{query}"
              </Text>
            )}

            {showResults && !searching && !noParking && results.map(place => (
              <TouchableOpacity
                key={place.place_id}
                style={s.sheetResultRow}
                onPress={() => onSelectPlace(place)}
                activeOpacity={0.75}
              >
                <View style={s.sheetResultIcon}>
                  <Text style={{ color: theme.ink3, fontSize: 11, fontWeight: '700' }}>P</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.sheetResultName} numberOfLines={1}>{place.mainText}</Text>
                  {!!place.secondaryText && (
                    <Text style={s.nearMeta} numberOfLines={1}>{place.secondaryText}</Text>
                  )}
                </View>
                <Text style={s.nearChevron}>›</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets    = useSafeAreaInsets();
  const shimmer   = useShimmer();

  const [userName,    setUserName]    = useState<string | null>(null);
  const [subtitle,    setSubtitle]    = useState('Find parking near you');
  const [quickIds,    setQuickIds]    = useState<string[]>([]);
  const [quickReady,  setQuickReady]  = useState(false);
  const [nearbyState, setNearbyState] = useState<NearbyState>('init');
  const [nearbyLots,  setNearbyLots]  = useState<Lot[]>([]);
  const [nearbyError, setNearbyError] = useState('');
  const [userLoc,     setUserLoc]     = useState<{ lat: number; lng: number } | null>(null);
  const [searchOpen,  setSearchOpen]  = useState(false);
  const quickReadyRef = useRef(false);

  const goToLot = useCallback((id: string, name?: string | null) => {
    const n = name ?? 'Parking Lot';
    addToHistory(id, n);
    navigation.navigate('LotDetail', { lotId: id, lotName: n });
  }, [navigation]);

  const fetchNearby = useCallback(async (lat: number, lng: number): Promise<Lot[]> => {
    setNearbyState('loading');
    setNearbyError('');
    try {
      const res  = await api.getLotsNear(lat, lng);
      const lots = res.lots.slice(0, 10);
      setNearbyLots(lots);
      setNearbyState(lots.length === 0 ? 'empty' : 'loaded');
      if (isLateNight()) {
        setSubtitle('Most lots quiet right now');
      } else {
        const near = lots.filter(l => (l.distance_meters ?? Infinity) < 1609).length;
        if (near > 0) setSubtitle(`${near} lot${near === 1 ? '' : 's'} open within a mile`);
      }
      return lots;
    } catch (e: any) {
      setNearbyError(e.message ?? 'Could not load nearby lots');
      setNearbyState('error');
      return [];
    }
  }, []);

  const retryNearby = useCallback(() => {
    const loc = userLoc ?? HARTFORD;
    fetchNearby(loc.lat, loc.lng);
  }, [userLoc, fetchNearby]);

  useEffect(() => {
    let alive = true;
    (async () => {
      // 1. Name
      const name = await AsyncStorage.getItem(NAME_KEY);
      if (alive && name) setUserName(name);

      // 2. History → seed Quick Go early if we have enough
      const history = await getHistory();
      const histIds = history.slice(0, 3).map(h => h.id);
      if (alive && histIds.length > 0) {
        setQuickIds(histIds);
        if (histIds.length >= 3) {
          setQuickReady(true);
          quickReadyRef.current = true;
        }
      }

      // 3. Location permission
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (!alive) return;

      if (status !== 'granted') {
        setNearbyState('denied');
        // Fill Quick Go from Hartford fallback if not already ready
        if (!quickReadyRef.current) {
          try {
            const res  = await api.getLotsNear(HARTFORD.lat, HARTFORD.lng);
            const fill = res.lots.slice(0, Math.max(0, 3 - histIds.length)).map(l => l.id);
            if (alive) {
              setQuickIds([...histIds, ...fill].slice(0, 3));
              setQuickReady(true);
              quickReadyRef.current = true;
            }
          } catch {
            if (alive) { setQuickReady(true); quickReadyRef.current = true; }
          }
        }
        return;
      }

      // 4. Location granted
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (!alive) return;
        const { latitude: lat, longitude: lng } = loc.coords;
        setUserLoc({ lat, lng });
        const lots = await fetchNearby(lat, lng);
        if (!alive) return;
        const fill = lots.slice(0, Math.max(0, 3 - histIds.length)).map(l => l.id);
        setQuickIds([...histIds, ...fill].slice(0, 3));
        setQuickReady(true);
        quickReadyRef.current = true;
      } catch {
        if (!alive) return;
        // GPS unavailable — show Hartford area
        let hartfordLots: Lot[] = [];
        try {
          const res = await api.getLotsNear(HARTFORD.lat, HARTFORD.lng);
          hartfordLots = res.lots;
        } catch {}
        if (!alive) return;
        const lots = hartfordLots.slice(0, 10);
        setNearbyLots(lots);
        setNearbyState(lots.length === 0 ? 'empty' : 'loaded');
        const fill = lots.slice(0, Math.max(0, 3 - histIds.length)).map(l => l.id);
        setQuickIds([...histIds, ...fill].slice(0, 3));
        setQuickReady(true);
        quickReadyRef.current = true;
      }
    })();
    return () => { alive = false; };
  }, []);

  const greeting  = getGreeting();
  const lateNight = isLateNight();

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.scrollContent, { paddingBottom: 48 + insets.bottom }]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Header ── */}
        <View style={s.header}>
          {userName != null && <Text style={s.greetLabel}>{greeting}</Text>}
          <Text style={s.greetMain}>{userName ?? greeting}</Text>
          <Text style={s.greetSub}>
            {lateNight ? 'Most lots quiet right now' : subtitle}
          </Text>
        </View>

        {/* ── Search Bar ── */}
        <TouchableOpacity
          style={s.searchBar}
          onPress={() => setSearchOpen(true)}
          activeOpacity={0.8}
        >
          <Text style={s.searchBarIcon}>{String.fromCodePoint(0x2315)}</Text>
          <Text style={s.searchBarPlaceholder}>Search parking lots…</Text>
        </TouchableOpacity>

        {/* ── Quick Go — always 3 cards ── */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>QUICK GO</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.qgRow}
          >
            {!quickReady
              ? [0, 1, 2].map(i => <QuickGoSkel key={i} shimmer={shimmer} />)
              : quickIds.map(id => (
                  <QuickGoCard key={id} lotId={id} onPress={() => goToLot(id)} />
                ))
            }
          </ScrollView>
        </View>

        {/* ── Nearby — full state machine ── */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>NEARBY</Text>

          {(nearbyState === 'init' || nearbyState === 'loading') && (
            <>
              {[0, 1, 2].map(i => <NearbySkelRow key={i} shimmer={shimmer} />)}
              {nearbyState === 'init' && (
                <Text style={s.nearFinding}>Finding parking near you…</Text>
              )}
            </>
          )}

          {nearbyState === 'denied' && (
            <ActionCard
              title="Location access needed"
              body="Allow SPOTTR to see parking lots near you"
              btnLabel="Enable location"
              onPress={() => Linking.openSettings()}
            />
          )}

          {nearbyState === 'error' && (
            <ActionCard
              title="Couldn't load nearby lots"
              errorMsg={nearbyError}
              btnLabel="Try again"
              onPress={retryNearby}
            />
          )}

          {nearbyState === 'empty' && (
            <ActionCard
              title="No parking lots nearby"
              body="Try searching for a specific place"
              btnLabel="Search"
              onPress={() => setSearchOpen(true)}
            />
          )}

          {nearbyState === 'loaded' &&
            nearbyLots.map((lot, idx) => (
              <React.Fragment key={lot.id}>
                <NearbyRow lot={lot} onPress={() => goToLot(lot.id, lot.name)} />
                {idx < nearbyLots.length - 1 && <View style={s.nearDivider} />}
              </React.Fragment>
            ))
          }
        </View>
      </ScrollView>

      <SearchSheet
        visible={searchOpen}
        onClose={() => setSearchOpen(false)}
        userLat={userLoc?.lat}
        userLng={userLoc?.lng}
        onSelectLot={(id, name) => {
          setSearchOpen(false);
          goToLot(id, name);
        }}
      />
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  // Layout
  safe:          { flex: 1, backgroundColor: theme.bg },
  scroll:        { flex: 1 },
  scrollContent: {},

  // Header
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4 },
  greetLabel: {
    color: theme.ink3,
    fontSize: 11,
    fontWeight: '400',
    letterSpacing: 1.5,
    marginBottom: 2,
  },
  greetMain: {
    color: theme.ink,
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 34,
  },
  greetSub: {
    color: theme.ink2,
    fontSize: 14,
    marginTop: 6,
    lineHeight: 20,
  },

  // Search bar
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 4,
    backgroundColor: theme.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border2,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
  },
  searchBarIcon:        { color: theme.ink3, fontSize: 18 },
  searchBarPlaceholder: { color: theme.ink3, fontSize: 15, flex: 1 },

  // Section
  section: { marginTop: 24 },
  sectionTitle: {
    color: theme.ink3,
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1.3,
    textTransform: 'uppercase',
    marginHorizontal: 20,
    marginBottom: 12,
  },

  // Quick Go
  qgRow: { paddingHorizontal: 16, gap: 10, paddingBottom: 4 },
  qgCard: {
    width: 110,
    height: 100,
    backgroundColor: theme.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    padding: 12,
    justifyContent: 'space-between',
  },
  qgName:    { color: theme.ink2, fontSize: 10, lineHeight: 14 },
  qgNum:     { fontSize: 28, fontWeight: '700', lineHeight: 32 },
  qgStatus:  { color: theme.ink3, fontSize: 9 },
  qgSkelName: {
    width: '75%', height: 8, borderRadius: 3, backgroundColor: theme.surface3,
  },
  qgSkelNum: {
    width: '50%', height: 24, borderRadius: 4, backgroundColor: theme.surface3,
  },

  // Nearby
  nearRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginHorizontal: 4,
  },
  nearBadge: {
    width: 44,
    height: 44,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    flexShrink: 0,
  },
  nearBadgeNum: { fontSize: 13, fontWeight: '700' },
  nearMid:      { flex: 1 },
  nearName:     { color: theme.ink,  fontSize: 13, fontWeight: '600' },
  nearMeta:     { color: theme.ink2, fontSize: 10, marginTop: 3 },
  nearChevron:  { color: theme.ink3, fontSize: 18, marginLeft: 8 },
  nearDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.05)',
    marginHorizontal: 16,
  },
  nearFinding: {
    color: theme.ink3,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 12,
    marginBottom: 4,
  },

  // Action card (denied / empty / error)
  actionCard: {
    marginHorizontal: 16,
    backgroundColor: theme.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: theme.border,
  },
  actionTitle:   { color: theme.ink,  fontSize: 14, fontWeight: '600', marginBottom: 6 },
  actionBody:    { color: theme.ink2, fontSize: 12, lineHeight: 18, marginBottom: 14 },
  actionError:   { color: theme.red,  fontSize: 11, lineHeight: 16, marginBottom: 14 },
  actionBtn:     { backgroundColor: theme.green, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  actionBtnText: { color: '#080A0F', fontSize: 12, fontWeight: '700' },

  // Search Sheet
  sheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    height: SCREEN_H * 0.85,
    paddingTop: 12,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    backgroundColor: theme.ink3,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 16,
  },
  sheetInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 4,
    backgroundColor: theme.surface2,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border2,
    paddingHorizontal: 14,
  },
  sheetInput: {
    flex: 1,
    color: theme.ink,
    fontSize: 15,
    paddingVertical: 13,
  },
  sheetClear: { color: theme.ink3, fontSize: 13, paddingHorizontal: 4 },
  sheetResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  sheetResultIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: theme.surface2,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  sheetResultName: { color: theme.ink, fontSize: 14, fontWeight: '500', flex: 1 },
});
