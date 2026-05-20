import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { fonts, colors } from '../theme';

interface ConfidencePillProps {
  bboxSource: string | undefined;
}

type PillStyle = { bg: string; border: string; text: string; label: string };

function getPillStyle(bboxSource: string | undefined): PillStyle {
  switch (bboxSource) {
    case 'osm_union':
      return { bg: colors.ad, border: colors.ah, text: colors.a, label: 'High confidence' };
    case 'building_inferred':
      return { bg: 'rgba(240,147,10,0.12)', border: 'rgba(240,147,10,0.35)', text: '#F0930A', label: 'Est. boundary' };
    case 'low_osm_coverage':
      return { bg: 'rgba(255,255,255,0.06)', border: colors.bs, text: colors.t3, label: 'Low coverage' };
    default:
      return { bg: 'rgba(255,255,255,0.06)', border: colors.b, text: colors.t3, label: 'Unknown' };
  }
}

/**
 * ConfidencePill — indicates bbox_source on LotDetail.
 * CLAUDE.md open design decision: gate C uses static display pill;
 * expandable methodology sheet deferred to post-MVP.
 */
export default function ConfidencePill({ bboxSource }: ConfidencePillProps) {
  const { bg, border, text, label } = getPillStyle(bboxSource);
  return (
    <View style={[styles.pill, { backgroundColor: bg, borderColor: border }]}>
      <Text style={[styles.text, { color: text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    borderWidth: 0.5,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  text: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 10 * 0.06,
    textTransform: 'uppercase',
  },
});
