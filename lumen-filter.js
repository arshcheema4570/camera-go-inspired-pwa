// Lumen Camera — always-on background finishing filter (Snapseed-style stack).
// Applied to every capture after the camera's still is decoded, before save.
// Runs silently: no UI, no toggles, no viewfinder change.
//
// Stack (midpoints of the spec'd ranges):
//   Brightness +12, Contrast +7, Saturation +7, Ambiance +20,
//   Highlights -20, Shadows +15, Warmth +2.5,
//   Structure +6 (wide-radius micro-contrast on luminance),
//   Sharpening +12 (narrow-radius unsharp on luminance),
//   Face Spotlight: feathered elliptical brighten + mild texture softening per
//   detected face, via the platform FaceDetector API (no bundled model).

(function () {
  "use strict";

  const P = {
    brightness: 12,
    contrast: 7,
    saturation: 7,
    ambiance: 20,
    highlights: -20,
    shadows: 15,
    warmth: 2.5,
    structure: 6,
    sharpening: 12,
    faceBrighten: 10,
  };

  const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  // ---- Pass 1: global per-pixel adjustments --------------------------------
  function globalPass(data) {
    const bOff = P.brightness * 1.2; // +14.4 at spec midpoint
    const c = P.contrast;
    const cFactor = (259 * (c + 255)) / (255 * (259 - c)); // ~1.056 at +7
    const hlAmt = (-P.highlights / 100) * 0.6; // up to -12% pull-down at white
    const shLift = P.shadows * 1.2; // up to +18 lift at black
    const vibAmt = (P.ambiance / 100) * 0.9; // vibrance: desaturated pixels gain most
    const satF = 1 + P.saturation / 100; // 1.07
    const warmR = P.warmth * 1.2, warmG = P.warmth * 0.35, warmB = -P.warmth * 0.9;

    for (let i = 0; i < data.length; i += 4) {
      let r = data[i], g = data[i + 1], b = data[i + 2];

      // Brightness + contrast
      r += bOff; g += bOff; b += bOff;
      r = (r - 128) * cFactor + 128;
      g = (g - 128) * cFactor + 128;
      b = (b - 128) * cFactor + 128;

      // Highlights rescue + shadow lift (tone curve on luminance)
      const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      if (L > 0.5) {
        const f = 1 - (L - 0.5) * 2 * hlAmt;
        r *= f; g *= f; b *= f;
      } else {
        const lift = (0.5 - L) * 2 * shLift;
        r += lift; g += lift; b += lift;
      }

      // Ambiance (vibrance) + saturation around luminance
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const satRatio = mx > 1 ? (mx - mn) / mx : 0;
      const k = satF * (1 + vibAmt * (1 - satRatio));
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      r = lum + (r - lum) * k;
      g = lum + (g - lum) * k;
      b = lum + (b - lum) * k;

      // Warmth: gentle toward warm
      r += warmR; g += warmG; b += warmB;

      data[i] = clamp255(r);
      data[i + 1] = clamp255(g);
      data[i + 2] = clamp255(b);
    }
  }

  // ---- Separable box blur (Uint8 luminance -> Float32 plane) -----------------
  // tmp is a scratch Float32Array(w*h) reused across calls.
  function boxBlur(lum, w, h, radius, out, tmp) {
    const r = Math.max(1, Math.round(radius));
    const win = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += lum[row + (x < 0 ? 0 : x > w - 1 ? w - 1 : x)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / win;
        const xOut = x - r < 0 ? 0 : x - r > w - 1 ? w - 1 : x - r;
        const xIn = x + r + 1 < 0 ? 0 : x + r + 1 > w - 1 ? w - 1 : x + r + 1;
        acc += lum[row + xIn] - lum[row + xOut];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) {
        const yy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
        acc += tmp[yy * w + x];
      }
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / win;
        const yOut = y - r < 0 ? 0 : y - r > h - 1 ? h - 1 : y - r;
        const yIn = y + r + 1 < 0 ? 0 : y + r + 1 > h - 1 ? h - 1 : y + r + 1;
        acc += tmp[yIn * w + x] - tmp[yOut * w + x];
      }
    }
  }

  // ---- Pass 2: local detail (structure + sharpening on luminance) -----------
  function applyDetail(data, lum, blur, amount) {
    for (let p = 0, i = 0; p < lum.length; p++, i += 4) {
      const d = (lum[p] - blur[p]) * amount;
      if (d !== 0) {
        data[i] = clamp255(data[i] + d);
        data[i + 1] = clamp255(data[i + 1] + d);
        data[i + 2] = clamp255(data[i + 2] + d);
      }
    }
  }

  // ---- Face detection (platform API; skipped silently if unavailable) --------
  async function detectFaces(bitmap) {
    try {
      if (typeof FaceDetector === "undefined") return [];
      const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
      const cw = Math.max(1, Math.round(bitmap.width * scale));
      const ch = Math.max(1, Math.round(bitmap.height * scale));
      const c = document.createElement("canvas");
      c.width = cw; c.height = ch;
      c.getContext("2d").drawImage(bitmap, 0, 0, cw, ch);
      const det = new FaceDetector({ fastMode: true, maxDetectedFaces: 5 });
      const faces = await det.detect(c);
      return faces.map((f) => {
        const b = f.boundingBox;
        return {
          x: b.x / scale, y: b.y / scale,
          w: b.width / scale, h: b.height / scale,
        };
      });
    } catch {
      return [];
    }
  }

  // ---- Face Spotlight: feathered brighten + mild texture softening ----------
  function applyFaceSpotlight(data, lum, wideBlur, faces, w, h) {
    const brighten = P.faceBrighten;
    for (const f of faces) {
      const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
      const rx = f.w * 0.62, ry = f.h * 0.72;
      const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(w - 1, Math.ceil(cx + rx));
      const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(h - 1, Math.ceil(cy + ry));
      for (let y = y0; y <= y1; y++) {
        const ny = (y - cy) / ry;
        for (let x = x0; x <= x1; x++) {
          const nx = (x - cx) / rx;
          const e = nx * nx + ny * ny;
          if (e >= 1) continue;
          const mask = (1 - e) * (1 - e); // smooth feather to the ellipse edge
          const p = y * w + x;
          const i = p * 4;
          // brighten + pull slightly toward local average (softens skin texture)
          const d = (brighten + (wideBlur[p] - lum[p]) * 0.22) * mask;
          data[i] = clamp255(data[i] + d);
          data[i + 1] = clamp255(data[i + 1] + d);
          data[i + 2] = clamp255(data[i + 2] + d);
        }
      }
    }
  }

  // ---- Entry point ----------------------------------------------------------
  async function applyFilter(blob) {
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" }).catch(
      () => createImageBitmap(blob)
    );
    const w = bitmap.width, h = bitmap.height;

    const faces = await detectFaces(bitmap);

    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();

    const img = ctx.getImageData(0, 0, w, h);
    const data = img.data;

    globalPass(data);

    // Luminance plane + two detail blurs (buffer reused between them).
    const lum = new Uint8Array(w * h);
    for (let p = 0, i = 0; p < lum.length; p++, i += 4) {
      lum[p] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
    }
    const blur = new Float32Array(w * h);
    const tmp = new Float32Array(w * h);

    // Structure: wide-radius micro-contrast
    boxBlur(lum, w, h, Math.max(2, Math.round(Math.min(w, h) * 0.008)), blur, tmp);
    applyDetail(data, lum, blur, (P.structure / 100) * 1.4);

    // Sharpening: narrow-radius unsharp
    boxBlur(lum, w, h, 2, blur, tmp);
    applyDetail(data, lum, blur, (P.sharpening / 100) * 1.1);

    if (faces.length) applyFaceSpotlight(data, lum, blur, faces, w, h);

    ctx.putImageData(img, 0, 0);
    // Full resolution, maximum JPEG quality: the pixel math requires one
    // re-encode, so we keep it as lossless as the JPEG format allows.
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 1.0));
  }

  window.LumenFilter = { applyFilter };
})();
