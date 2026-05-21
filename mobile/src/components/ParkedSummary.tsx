/**
 * ParkedSummary — spot card shown on ParkedScreen.
 *
 * Displays:
 *   Zone description line (e.g. "Front zone · Costco South Windsor parking")
 *   Parked-at timestamp ("Parked at 2:47 PM")
 *   Optional time-saved badge
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme, fonts } from '../theme';

interface Props {
  description: string | null;
  parkedAt: number | null;       // epoch ms
  timeSavedMin: number | null;
}

function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${ampm}`;
}

export default function ParkedSummary({ description, parkedAt, timeSavedMin }: Props) {
  const { colors } = useTheme();

  return (
    <View style={[s.card, { backgroundColor: colors.s1, borderColor: colors.b }]}>
      {/* Zone / lot description */}
      <Text style={[s.desc, { color: colors.t1, fontFamily: fonts.sansMd }]} numberOfLines={2}>
        {description ?? 'Parking spot saved'}
      </Text>

      {/* Timestamp */}
      {parkedAt != null && (
        <View style={s.row}>
          <Text style={[s.rowLabel, { color: colors.t4, fontFamily: fonts.mono }]}>PARKED AT</Text>
          <Text style={[s.rowValue, { color: colors.t2, fontFamily: fonts.mono }]}>
            {formatTime(parkedAt)}
          </Text>
        </View>
      )}

      {/* Time saved — only shown when available */}
      {timeSavedMin != null && timeSavedMin > 0 && (
        <View style={[s.savedBadge, { backgroundColor: colors.ad, borderColor: colors.a }]}>
          <Text style={[s.savedText, { color: colors.a, fontFamily: fonts.sansMd }]}>
            Saved ~{timeSavedMin} min of circling
          </Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    borderRadius: 13,
    padding: 18,
    borderWidth: 0.5,
    gap: 10,
  },
  desc: {
    fontSize: 16,
    lineHeight: 16 * 1.3,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowLabel: {
    fontSize: 10,
    letterSpacing: 10 * 0.06,
    textTransform: 'uppercase',
  },
  rowValue: {
    fontSize: 13,
  },
  savedBadge: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignSelf: 'flex-start',
    marginTop: 2,
  },
  savedText: {
    fontSize: 13,
  },
});
