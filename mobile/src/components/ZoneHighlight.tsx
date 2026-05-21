/**
 * ZoneHighlight — semi-transparent circle overlay on the map marking
 * the target zone centroid. Pulses gently when approaching.
 */

import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';
import { Circle } from 'react-native-maps';
import { useTheme } from '../theme';

interface Props {
  lat: number;
  lng: number;
  /** Radius in metres. Defaults to 30. */
  radius?: number;
  pulse?: boolean;
}

export default function ZoneHighlight({ lat, lng, radius = 30, pulse = false }: Props) {
  const { colors } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!pulse) {
      scale.setValue(1);
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.18, duration: 900, useNativeDriver: false }),
        Animated.timing(scale, { toValue: 1.00, duration: 900, useNativeDriver: false }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [pulse, scale]);

  return (
    <Circle
      center={{ latitude: lat, longitude: lng }}
      radius={radius}
      strokeColor={colors.a}
      fillColor={colors.ad}
      strokeWidth={1.5}
    />
  );
}
