import React from 'react';
import { Text } from 'react-native';
import { useTheme, fonts } from '../theme';

interface FreshnessLabelProps {
  label: string;
  style?: object;
}

/**
 * FreshnessLabel — mono 11px t3, always.
 * Spec: .lcf { font-family: var(--m); font-size: 11px; color: var(--t3);
 *               text-align: right; margin-top: 2px; }
 */
export default function FreshnessLabel({ label, style }: FreshnessLabelProps) {
  const { colors } = useTheme();
  return (
    <Text
      style={[{ fontFamily: fonts.mono, fontSize: 11, color: colors.t3, textAlign: 'right', marginTop: 2 }, style]}
      numberOfLines={1}
    >
      {label}
    </Text>
  );
}
