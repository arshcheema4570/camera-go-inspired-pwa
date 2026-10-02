# Lumen Camera

Minimal offline camera PWA. No filters, no processing pipeline, no engines.

- Simple native viewfinder (raw camera feed)
- Shutter button, flash (torch) toggle, front/back camera switch, and zoom slider
- Capture saves the camera's own still (`ImageCapture.takePhoto()` at full
  sensor resolution) exactly as produced; canvas frame-grab fallback where
  `ImageCapture` is unavailable
- Every capture auto-saves the JPEG
- No pro mode, ISO/shutter/focus controls, leveler, filters, or color themes

Offline via service worker. No cloud, no account.
