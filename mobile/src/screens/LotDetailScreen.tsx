import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  SafeAreaView,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { api, Lot, LotRow, RowsResponse } from '../services/api';
import { theme } from '../theme';

// Navigation types
export type RootStackParamList = {
  LotDetail: { lotId: string; lotName?: string };
};
type Props = NativeStackScreenProps<RootStackParamList, 'LotDetail'>;

// Helper: format detection age
function formatAge(seconds: number | null): string {
  if (seconds === null || seconds < 0) return '';
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

// Freshness badge
function FreshnessBadge({ seconds, cached }: { seconds: number | null; cached: boolean }) {
  const label = formatAge(seconds);
  if (!label) return null;
  const isStale = seconds !== null && seconds > 3600;
  return (
    <View style={[styles.badge, isStale ? styles.badgeStale : styles.badgeFresh]}>
      <Text style={[styles.badgeText, isStale ? styles.badgeTextStale : styles.badgeTextFresh]}>
        {cached ? `Cached ${label}` : label}
      </Text>
    </View>
  );
}

// Row card
function RowCard({ row }: { row: LotRow }) {
  const pct = row.total > 0 ? Math.round(((row.total - row.open) / row.total) * 100) : 0;
  const fillColor = pct > 85 ? theme.error : pct > 60 ? theme.warning : theme.accent;
  return (
    <View style={styles.rowCard}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowLabel}>Row {row.label}</Text>
        <Text style={styles.rowCount}>
          <Text style={{ color: theme.accent }}>{row.open}</Text>
          <Text style={styles.textMuted}> / {row.total} open</Text>
        </Text>
      </View>
      <View style={styles.barBg}>
        <View style={[styles.barFill, { width: `${pct}%` as any, backgroundColor: fillColor }]} />
      </View>
    </View>
  );
}

// Loading screen shown during fresh Modal detection (cache miss)
function AnalyzingScreen({ lotName }: { lotName?: string }) {
  return (
    <View style={styles.centerFlex}>
      <ActivityIndicator size="large" color={theme.accent} />
      <Text style={styles.analyzingTitle}>Analyzing parking lot from satellite...</Text>
      {lotName ? <Text style={styles.analyzingSubtitle}>{lotName}</Text> : null}
      <Text style={styles.analyzingHint}>~3 seconds — checking real-time availability</Text>
    </View>
  );
}

// Main screen
export default function LotDetailScreen({ route, navigation }: Props) {
  const { lotId, lotName } = route.params;
  const [data, setData] = useState<RowsResponse | null>(null);
  const [lot, setLot] = useState<Lot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    try {
      if (!isRefresh) setLoading(true);
      setError(null);
      const [rowsRes, lotRes] = await Promise.all([
        api.getLotRows(lotId),
        api.getLot(lotId),
      ]);
      setData(rowsRes);
      setLot(lotRes);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load lot data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [lotId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (lot?.name) navigation.setOptions({ title: lot.name });
  }, [lot, navigation]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load(true);
  }, [load]);

  // Loading state — shown while Modal runs (fresh detection can take ~1-3s)
  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <AnalyzingScreen lotName={lotName} />
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centerFlex}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => load()}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const totalOpen = data?.rows.reduce((sum, r) => sum + r.open, 0) ?? 0;
  const totalSpaces = data?.spaces_total ?? 0;
  const isGridFallback = data?.source === 'grid_fallback';
  const isLowConfidence = (data?.confidence ?? 0) < 0.5;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />
        }
      >
        {/* Header card */}
        <View style={styles.headerCard}>
          <Text style={styles.lotName}>{lot?.name ?? `Lot ${lotId.slice(0, 8)}`}</Text>
          {lot?.address ? <Text style={styles.address}>{lot.address}</Text> : null}
          <View style={styles.headerMeta}>
            <Text style={styles.openCount}>
              <Text style={{ color: theme.accent, fontSize: 28, fontWeight: '700' }}>{totalOpen}</Text>
              <Text style={styles.textMuted}> / {totalSpaces} spots open</Text>
            </Text>
            {/* Freshness badge: "Just now" / "Xm ago" / "Xh ago" */}
            <FreshnessBadge
              seconds={data?.detection_age_seconds ?? null}
              cached={data?.cached ?? false}
            />
          </View>
        </View>

        {/* Low-confidence warning: shown when source=grid_fallback or confidence < 0.5 */}
        {(isLowConfidence || isGridFallback) ? (
          <View style={styles.warningBanner}>
            <Text style={styles.warningText}>
              Spot positions may be approximate — satellite stripe detection unavailable for this lot.
            </Text>
          </View>
        ) : null}

        {/* Rows list */}
        {data && data.rows.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Rows</Text>
            {data.rows.map((row) => (
              <RowCard key={row.label} row={row} />
            ))}
          </View>
        ) : (
          <View style={styles.emptyState}>
            <Text style={styles.textMuted}>No row data available.</Text>
          </View>
        )}

        {/* Debug footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Source: {data?.source ?? '—'}{data?.modal_duration_ms != null ? ` · ${data.modal_duration_ms}ms` : ''}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  scrollContent: { paddingBottom: 40 },
  centerFlex: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  emptyState: { alignItems: 'center', padding: 40 },

  analyzingTitle: { color: theme.text, fontSize: 18, fontWeight: '600', marginTop: 16 },
  analyzingSubtitle: { color: theme.textMuted, fontSize: 14 },
  analyzingHint: { color: theme.textDim, fontSize: 12, textAlign: 'center' },

  errorText: { color: theme.error, fontSize: 14, textAlign: 'center' },
  retryBtn: {
    marginTop: 12, paddingHorizontal: 24, paddingVertical: 10,
    borderRadius: 8, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border,
  },
  retryText: { color: theme.accent, fontWeight: '600' },

  headerCard: {
    margin: 16, padding: 20, backgroundColor: theme.card,
    borderRadius: 16, borderWidth: 1, borderColor: theme.border,
  },
  lotName: { color: theme.text, fontSize: 22, fontWeight: '700' },
  address: { color: theme.textMuted, fontSize: 13, marginTop: 4 },
  headerMeta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 12, flexWrap: 'wrap', gap: 8,
  },
  openCount: { color: theme.text, fontSize: 16 },
  textMuted: { color: theme.textMuted, fontSize: 14 },

  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  badgeFresh: { backgroundColor: '#00FF8520', borderWidth: 1, borderColor: '#00FF8540' },
  badgeStale: { backgroundColor: '#FFA50020', borderWidth: 1, borderColor: '#FFA50040' },
  badgeText: { fontSize: 11, fontWeight: '600' },
  badgeTextFresh: { color: theme.accent },
  badgeTextStale: { color: theme.warning },

  warningBanner: {
    marginHorizontal: 16, marginBottom: 8, padding: 12,
    backgroundColor: '#FFA50015', borderRadius: 10, borderWidth: 1, borderColor: '#FFA50030',
  },
  warningText: { color: theme.warning, fontSize: 12 },

  section: { marginHorizontal: 16, marginTop: 8 },
  sectionTitle: {
    color: theme.textMuted, fontSize: 12, fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10,
  },

  rowCard: {
    backgroundColor: theme.card, borderRadius: 12, padding: 16,
    marginBottom: 8, borderWidth: 1, borderColor: theme.border,
  },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  rowLabel: { color: theme.text, fontWeight: '600', fontSize: 15 },
  rowCount: { fontSize: 14 },
  barBg: { height: 6, backgroundColor: theme.border, borderRadius: 3, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 3 },

  footer: { marginTop: 24, alignItems: 'center' },
  footerText: { color: theme.textDim, fontSize: 11 },
});
