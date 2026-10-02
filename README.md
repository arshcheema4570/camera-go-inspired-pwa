# Lumen Camera

Minimal offline camera PWA. No processing pipeline controls, no engines.

- Simple native viewfinder (raw camera feed)
- Shutter button, flashlight, front/back camera switch, and zoom slider
- Capture saves the camera's own still (`ImageCapture.takePhoto()` at full
  sensor resolution); canvas frame-grab fallback where `ImageCapture` is unavailable
- An always-on background finishing filter (Snapseed-style stack) is applied
  to every capture before save: brightness +12, contrast +7, saturation +7,
  ambiance +20, highlights −20, shadows +15, warmth +2.5, structure +6,
  sharpening +12, plus Face Spotlight (feathered face brighten + mild skin
  softening via the platform FaceDetector API — skipped silently where
  unavailable). No UI, no toggles; the viewfinder and controls are untouched
- Every capture auto-saves the JPEG
- On the rear camera, the flash button controls the real torch continuously for use as a flashlight
- On the front camera, the same button enables a white screen flash during capture
- The toggle state persists while switching cameras; rear cameras fall back to screen flash when no torch capability is exposed
- No pro mode, ISO/shutter/focus controls, leveler, filters, or color themes

Offline via service worker. No cloud, no account.
