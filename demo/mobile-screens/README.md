# Mobile Screen Reference

Spottr's mobile app was built with React Native (Expo SDK 54) and implements a
complete parking navigation loop across six screens.

## Screens (not captured before archiving)

Device screenshots were not captured before the project was archived. The app
required a physical iOS/Android device with a valid Expo Go build, which was not
available for screenshot capture at archive time.

## Screen inventory (by source file)

| Screen | File | Description |
|--------|------|-------------|
| 01 — Home | `mobile/src/screens/HomeScreen.tsx` | MapView with lot pins + BottomSheet at 30/60/95% snap points. Nearby lots sorted by distance. |
| 02 — Search | `mobile/src/screens/SearchScreen.tsx` | Map strip + Google Places autocomplete + recent searches list. |
| 03 — Lot Detail | `mobile/src/screens/LotDetailScreen.tsx` | Lot bbox MapView + BigNumberCount + FreshnessLabel + ZoneThumbnail rows + "Take me there" CTA + ConfidencePill. |
| 04 — AI Map | `mobile/src/screens/LotDetailScreen.tsx` | AI Map toggle: CTECO 7.6 cm/px base tile (CT lots) or Mapbox z20 (non-CT) + detected spot circles (green = open, red = occupied, r=1.2m). |
| 05 — Driving | `mobile/src/screens/DrivingScreen.tsx` | Zone centroid on map + dashed path + live 30s availability poll. Transitions to Reroute if lot fills. |
| 06 — Parked | `mobile/src/screens/ParkedScreen.tsx` | Parked confirmation + Find My Car deeplink (Apple Maps / Google Maps) + Done button. |

## Architecture reference

The parking navigation state machine lives in
`mobile/src/services/parkingStateMachine.ts` (Zustand store + GPS watcher + dwell
detection). State transitions: `idle → searching → navigating → approaching →
parked`. The Driving → Parked transition fires after GPS dwell for ≥30s within
100m of lot centroid.
