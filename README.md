# Simple Camera

An original Camera Go-inspired browser PWA for Chromebook tablets such as the Acer Chromebook Tab 311. It is focused on taking and improving a photo on-device, without a gallery, cloud upload, or video editor.

## Features

- Photo, Portrait, and Night capture modes
- Rear/front camera switching
- Touch-friendly preview with focus indicator
- Timer, framing grid, flash when ChromeOS exposes torch support, and zoom when supported
- On-device enhancement panel after each capture
- Auto enhancement plus brightness, contrast, color, and sharpness controls
- Save the finished photo to the device Downloads folder
- No gallery and no cloud storage
- Offline PWA shell

## Run locally

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173/` in Chrome. Camera access requires a secure context: `localhost` is allowed, and the deployed GitHub Pages site works over HTTPS.

## Acer Chromebook Tab 311 notes

The app requests the rear camera at up to 1920×1080 and falls back to the camera settings ChromeOS provides. Flash and zoom depend on camera capabilities exposed by ChromeOS. The app disables unavailable controls instead of failing.
