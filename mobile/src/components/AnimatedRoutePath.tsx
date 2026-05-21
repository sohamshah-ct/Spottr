/**
 * AnimatedRoutePath — dashed polyline from current position to zone centroid.
 *
 * Renders a react-native-maps Polyline with a dashed stroke pattern.
 * The path animates opacity in/out whenever `visible` changes.
 */

import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';
import { Polyline } from 'react-native-maps';
import { useTheme } from '../theme';

interface Props {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  visible?: boolean;
}

export default function AnimatedRoutePath({ fromLat, fromLng, toLat, toLng, visible = true }: Props) {
  const { colors } = useTheme();
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [visible, opacity]);

  if (!visible && (opacity as any)._value === 0) return null;

  return (
    <Polyline
      coordinates={[
        { latitude: fromLat, longitude: fromLng },
        { latitude: toLat,   longitude: toLng },
      ]}
      strokeColor={colors.a}
      strokeWidth={2.5}
      lineDashPattern={[8, 6]}
    />
  );
}
