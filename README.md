# Lumen Camera

Minimal offline camera PWA. No filters, no processing pipeline, no engines.

- Fullscreen native viewfinder (raw camera feed)
- Shutter button, flash (torch) toggle, front/back camera switch
- Capture saves the camera's own still (`ImageCapture.takePhoto()` at full
  sensor resolution) exactly as produced; canvas frame-grab fallback where
  `ImageCapture` is unavailable
- Every capture auto-saves the JPEG; tap-to-focus supported

Offline via service worker. No cloud, no account.
