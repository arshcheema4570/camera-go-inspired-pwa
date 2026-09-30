# Simple Camera

An original Camera Go-inspired browser PWA for Chromebook tablets such as the Acer Chromebook Tab 311. It uses browser camera APIs and stores captured photos locally on the device.

## Features

- Rear/front camera switching
- Touch-friendly camera preview
- Photo capture to local IndexedDB storage
- Recent-photo gallery with delete and clear controls
- Framing grid
- 3-second and 10-second timer
- Flash toggle when the camera exposes torch support
- Focus indicator
- Installable/offline PWA shell
- No Google Camera code, assets, branding, or cloud upload

## Run locally

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173/` in Chrome. Camera access requires a secure context: `localhost` is allowed, and a deployed HTTPS GitHub Pages site works.

## Acer Chromebook Tab 311 notes

The app requests the rear camera at up to 1920×1080 and accepts whatever resolution ChromeOS provides. Some controls, especially flash and focus, depend on the camera capabilities exposed by ChromeOS. The app disables unavailable controls rather than failing.
