import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme, fonts } from '../theme';

interface ConfidencePillProps {
  bboxSource: string | undefined;
}

/**
 * ConfidencePill — indicates bbox_source on LotDetail.
 * CLAUDE.md open design decision: gate C uses static display pill;
 * expandable methodology sheet deferred to post-MVP.
 */
export default function ConfidencePill({ bboxSource }: ConfidencePillProps) {
  const { colors } = useTheme();

  type PillStyle = { bg: string; border: string; text: string; label: string };

  function getPillStyle(): PillStyle {
    switch (bboxSource) {
      case 'osm_union':
        return { bg: colors.ad, border: colors.ah, text: colors.a, label: 'High confidence' };
      case 'building_inferred':
        return { bg: colors.warnBg, border: colors.warnBorder, text: colors.warn, label: 'Est. boundary' };
      case 'low_osm_coverage':
        return { bg: 'rgba(255,255,255,0.06)', border: colors.bs, text: colors.t3, label: 'Low coverage' };
      default:
        return { bg: 'rgba(255,255,255,0.06)', border: colors.b, text: colors.t3, label: 'Unknown' };
    }
  }

  const { bg, border, text, label } = getPillStyle();

  return (
    <View style={[s.pill, { backgroundColor: bg, borderColor: border }]}>
      <Text style={[s.text, { color: text }]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
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
