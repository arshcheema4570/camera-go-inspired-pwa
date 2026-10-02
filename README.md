# Lumen Camera

Minimal offline camera PWA. No filters, no processing pipeline, no engines.

- Simple native viewfinder (raw camera feed)
- Shutter button, flashlight, front/back camera switch, and zoom slider
- Capture saves the camera's own still (`ImageCapture.takePhoto()` at full
  sensor resolution) exactly as produced; canvas frame-grab fallback where
  `ImageCapture` is unavailable
- Every capture auto-saves the JPEG
- On the rear camera, the flash button controls the real torch continuously for use as a flashlight
- On the front camera, the same button enables a white screen flash during capture
- The toggle state persists while switching cameras; rear cameras fall back to screen flash when no torch capability is exposed
- No pro mode, ISO/shutter/focus controls, leveler, filters, or color themes

Offline via service worker. No cloud, no account.
