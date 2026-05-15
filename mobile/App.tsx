import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import LotDetailScreen, { RootStackParamList } from './src/screens/LotDetailScreen';
import { theme } from './src/theme';

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <NavigationContainer>
      <StatusBar style="light" />
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: theme.card },
          headerTintColor: theme.text,
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: theme.bg },
        }}
      >
        <Stack.Screen
          name="LotDetail"
          component={LotDetailScreen}
          options={{ title: 'Parking Lot' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
