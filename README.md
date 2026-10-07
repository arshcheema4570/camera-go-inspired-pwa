# Lumen Camera

A minimal, offline-capable camera PWA for capturing photos in the browser. It keeps a simple viewfinder and a small set of practical controls rather than a full manual-camera interface.

**Try it:** [Lumen Camera](https://arshcheema4570.github.io/camera-go-inspired-pwa/)

## Features

- Live camera preview and photo capture, with the most recent capture available from the gallery control.
- Front/rear camera switching and a zoom slider where the device exposes those capabilities.
- Flash control: requests the camera’s synchronized photo flash when the browser exposes it; otherwise it offers a clearly labelled continuous rear torch when available. Front-camera captures can use a brief white screen flash.
- Two capture-finishing presets (Standard and Pro); the selected preset is retained on the device. Face detection is optional and skipped on browsers that do not support it.
- Offline app shell through a service worker. Camera access itself still requires a supported camera, permission, and a secure context such as HTTPS or localhost.

## Use and install

Open the link above in a current mobile browser and allow camera access when prompted. Use the browser’s **Install app** or **Add to Home Screen** option to install it. After the first visit, the app shell is cached for offline launch; live camera features still depend on the device and browser APIs being available.

## Scope

Lumen is intentionally not a manual/pro camera: it does not offer ISO, shutter-speed, focus, or exposure controls. It has no account or cloud service; capture processing is performed in the browser.

## Flash limitations

The browser and camera driver control hardware flash timing, metering, and any True Tone color adjustment. Lumen requests `fillLightMode: "flash"` only when the active camera reports that capability. A torch is continuous light, not a shutter-synchronized burst. The front-camera screen flash is a white overlay at the device’s current screen brightness; a web app cannot force system brightness or use the screen to illuminate a subject behind the rear camera. Pre-flash metering and subject-distance calculations are not exposed as app-controlled steps.
