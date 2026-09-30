# Lumen Camera

Lumen Camera is a privacy-first camera PWA for Chromebook tablets. It captures locally, keeps the viewfinder and result framing synchronized, and processes images in a dedicated LiteRT worker with an algorithmic fallback.

## Processing architecture

```text
Camera stream -> video + WebGL preview shading
                    |
                    +-> bounded burst frames (<= 1280x720)
                         -> litert.worker.js
                            -> LiteRT WebGPU, when available
                            -> LiteRT XNNPACK/Wasm fallback
                            -> algorithmic fallback when model is absent
                         -> RGBA buffer -> local JPEG download
```

The main thread only captures frames and updates the UI. Pixel processing and model inference run in `litert.worker.js`. Transferable `ArrayBuffer` results avoid an additional copy. The worker downsamples inputs to a maximum 640-pixel dimension and releases LiteRT tensors after inference. The active backend and turnaround time are shown in the result panel.

## Optional LiteRT model

The repository intentionally works without a model. To enable neural enhancement, add a compatible LiteRT/TFLite model at:

```text
models/enhancer.tflite
```

The worker expects a standard vision input tensor in NHWC `[1, H, W, 3]` with normalized RGB float values. It also accepts NCHW models when the runtime reports that shape. Output tensors may be NHWC or NCHW and are converted back to RGBA automatically.

If the model is missing, corrupt, or incompatible, the UI remains operational in `FALLBACK_MODE` using local tone mapping, a 3×3 unsharp pass, and vibrance enhancement. No image is uploaded.

## Run locally

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173/` in Chrome. Camera access requires a secure context: `localhost` is allowed, and the deployed GitHub Pages site works over HTTPS.

For real LiteRT WebGPU/Wasm execution, serve the runtime binaries with the headers supported by your host:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

GitHub Pages can run the fallback and load the CDN runtime when available, but it does not provide custom response headers for a local deployment. The app therefore degrades safely instead of requiring cross-origin isolation.

## Verify the engine

1. Open the app and allow camera access.
2. Capture a photo and open the result panel.
3. Read the telemetry line: it reports `LiteRT-WebGPU`, `LiteRT-XNNPACK`, or `Fallback`, plus milliseconds.
4. In Chrome DevTools, inspect the **Console** and **Network** panels for `enhancer.tflite` and the LiteRT CDN module.
5. Remove or rename `models/enhancer.tflite` and reload to verify `FALLBACK_MODE` remains fully functional.

## Acer Chromebook guardrails

Capture is capped at 1280×720 with a 30 FPS target. Model tensors are capped below the 100 MB pipeline budget, LiteRT is configured for low-power acceleration, and the adaptive burst target reduces work when turnaround time exceeds the frame budget.
