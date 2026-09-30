# Lumen Camera

Lumen Camera is an original, privacy-first Camera Go-inspired browser PWA for Chromebook tablets such as the Acer Chromebook Tab 311. It captures photos locally, processes short bursts off the UI thread, and saves the result directly to the device.

## Features

- Photo, Portrait, and Night capture modes
- Rear/front camera switching, timer, framing grid, torch, and supported zoom
- 1280×720 capture ceiling with 30 FPS target to protect low-power hardware
- WebGL low-latency viewfinder enhancement with a plain-video fallback
- Worker-based burst merge, tone mapping, and detail enhancement
- Adaptive burst count: reduces work when processing exceeds a 33 ms frame budget
- Offline PWA shell with no third-party runtime dependency or cloud upload
- Landscape-primary standalone installation metadata for ChromeOS
- Saves finished photos to the device Downloads folder

## Architecture

```text
Camera stream -> video element -> WebGL viewfinder shader
                    |
                    +-> bounded canvas frame (<= 1280x720)
                         -> 3–6 frame burst
                         -> processing-worker.js
                            - motion-tolerant merge
                            - local contrast / tone mapping
                            - unsharp detail enhancement
                         -> JPEG preview -> local download
```

The worker keeps the main thread free for camera input and UI. Six 1280×720 RGBA frames use roughly 22 MB before temporary buffers, staying well below the 120 MB pipeline target.

## Run locally

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173/` in Chrome. Camera access requires a secure context: `localhost` is allowed, and the deployed GitHub Pages site works over HTTPS.

## Acer Chromebook notes

The app requests up to 1280×720 at 30 FPS and falls back to the camera settings ChromeOS provides. Torch and zoom depend on camera capabilities. All photo processing is local; the service worker caches the complete app shell for offline use after the first load.
