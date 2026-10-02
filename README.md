# Lumen Camera

Minimal offline camera PWA. No processing pipeline controls, no engines.

- Simple native viewfinder (raw camera feed)
- Shutter button, flashlight, front/back camera switch, and zoom slider
- Capture saves the camera's own still (`ImageCapture.takePhoto()` at full
  sensor resolution); canvas frame-grab fallback where `ImageCapture` is unavailable
- An always-on background finishing filter is applied to every capture before
  save, chosen by the PRO toggle (top-right of the preview; choice persists):
  - **Standard** (default, the rock-solid v40 look): brightness +12,
    contrast +7, saturation +7, ambiance +20, highlights −20, shadows +15,
    warmth +2.5, structure +6, sharpening +12, face spotlight +10 with mild
    skin smoothing.
  - **Pro** (Pixel-HDR+-style): ambiance +22, highlights −30, shadows +22,
    contrast +15, structure +20, sharpening +12, temperature −5 (cooler,
    clinical), face spotlight +20 with subtle skin smoothing.
  Full sensor resolution and maximum JPEG quality are kept; Face Spotlight uses
  the platform FaceDetector API (skipped silently where unavailable); any filter
  failure falls back to the unfiltered camera still
- On the rear camera, the flash button controls the real torch continuously for use as a flashlight
- On the front camera, the same button enables a white screen flash during capture
- The toggle state persists while switching cameras; rear cameras fall back to screen flash when no torch capability is exposed
- No pro mode, ISO/shutter/focus controls, leveler, filters, or color themes

Offline via service worker. No cloud, no account.
