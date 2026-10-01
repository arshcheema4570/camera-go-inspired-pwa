const MODEL_URL = "./models/enhancer.tflite";
const MAX_DIMENSION = 640;
const MAX_HEAP_BYTES = 100 * 1024 * 1024;
let runtime = null;
let runner = null;
let engine = "Fallback";
let status = "FALLBACK_MODE";
let initialized = false;

const report = (message) => self.postMessage({ type: "status", status, engine, message });

async function initialize() {
  if (initialized) return;
  initialized = true;
  try {
    const response = await fetch(MODEL_URL, { method: "HEAD", cache: "no-store" });
    if (!response.ok) { report("enhancer.tflite not found; using algorithmic fallback"); return; }
    runtime = await import("https://cdn.jsdelivr.net/npm/@litertjs/core@2.5.0/+esm");
    await runtime.loadLiteRt("https://cdn.jsdelivr.net/npm/@litertjs/core@2.5.0/wasm/");
    const accelerators = self.navigator?.gpu ? ["webgpu", "wasm"] : ["wasm"];
    let lastError;
    for (const accelerator of accelerators) {
      try {
        runner = await runtime.loadAndCompile(MODEL_URL, { accelerator });
        engine = accelerator === "webgpu" ? "LiteRT-WebGPU" : "LiteRT-XNNPACK";
        status = "MODEL_READY";
        report(`${engine} ready`);
        return;
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error("LiteRT accelerator unavailable");
  } catch (error) {
    runtime = null; runner = null; engine = "Fallback"; status = "FALLBACK_MODE";
    report(`LiteRT unavailable; using fallback (${error.message || "initialization failed"})`);
  }
}

function resize(image, targetWidth = 0, targetHeight = 0) {
  const scale = Math.min(1, MAX_DIMENSION / image.width, MAX_DIMENSION / image.height);
  const width = targetWidth || Math.max(32, Math.round(image.width * scale));
  const height = targetHeight || Math.max(32, Math.round(image.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sx = Math.min(image.width - 1, Math.floor(x * image.width / width));
    const sy = Math.min(image.height - 1, Math.floor(y * image.height / height));
    const source = (sy * image.width + sx) * 4;
    const target = (y * width + x) * 4;
    data[target] = image.data[source]; data[target + 1] = image.data[source + 1]; data[target + 2] = image.data[source + 2]; data[target + 3] = 255;
  }
  return { width, height, data };
}

/* Post-merge denoise, applied to the merged/fused frame (so both the WebGL
   and CPU finishing paths benefit from a single implementation):
   - Chroma denoise: Co/Cg chroma blurred heavily (r=8); luma untouched.
     Noise is far more visible in chroma than luma, so this is the
     cheapest large perceptual win.
   - Single-frame spatial denoise: when only one frame exists (takePhoto
     partially failed — the multi-frame paths already have temporal
     denoise), a small 3x3 edge-preserving bilateral on luma. Alpha
     (the noise-adaptive sharpen gate) is preserved throughout. */
function denoiseMerged(data, width, height, single) {
  const n = width * height;
  const Y = new Float32Array(n), Co = new Float32Array(n), Cg = new Float32Array(n);
  for (let p = 0; p < n; p += 1) {
    const i4 = p * 4;
    const r = data[i4] / 255, g = data[i4 + 1] / 255, b = data[i4 + 2] / 255;
    Y[p] = r * 0.25 + g * 0.5 + b * 0.25;
    Co[p] = r * 0.5 - b * 0.5;
    Cg[p] = -r * 0.25 + g * 0.5 - b * 0.25;
  }
  if (single) {
    const out = new Float32Array(n);
    const ss2 = 2 * 1.2 * 1.2, sr2 = 2 * 0.11 * 0.11; // spatial sigma 1.2px, range sigma ~28/255
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const p = y * width + x, yc = Y[p];
      let s = 0, sw = 0;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const xx = Math.min(width - 1, Math.max(0, x + dx)), yy = Math.min(height - 1, Math.max(0, y + dy));
        const q = yy * width + xx, dd = Y[q] - yc;
        const wt = Math.exp(-(dx * dx + dy * dy) / ss2 - (dd * dd) / sr2);
        s += Y[q] * wt; sw += wt;
      }
      out[p] = s / sw;
    }
    Y.set(out);
  }
  const CoB = blurLumaSeparable(Co, width, height, 8);
  const CgB = blurLumaSeparable(Cg, width, height, 8);
  for (let p = 0; p < n; p += 1) {
    const i4 = p * 4, y = Y[p], co = CoB[p], cg = CgB[p];
    data[i4] = (y + co - cg) * 255;
    data[i4 + 1] = (y + cg) * 255;
    data[i4 + 2] = (y - co - cg) * 255;
  }
}

/* ------------------------------------------------------------------
   Translational frame registration.
   Handheld burst frames are offset by a few pixels of micro-jitter.
   Averaging them unaligned smears edges, so each frame is registered to
   frame 0 with a hierarchical integer-translation search before the
   ghost-rejecting accumulation:
     1. Coarse: luma downsampled to 160x90, SAD grid search over [-8, 8].
     2. Fine: full-resolution luma, SAD over +/-10 px around the coarse
        estimate (stride-8 sampled), giving 1-px final precision — the
        16-px coarse grid alone would be too coarse for micro-jitter.
   ------------------------------------------------------------------ */
function lumaFull(data, width, height) {
  const luma = new Uint8Array(width * height);
  for (let i = 0, n = width * height; i < n; i += 1) {
    const o = i * 4;
    luma[i] = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8;
  }
  return luma;
}

function downsampleLuma(luma, width, height, dw, dh) {
  const out = new Uint8Array(dw * dh);
  const sx = width / dw, sy = height / dh;
  for (let y = 0; y < dh; y += 1) {
    const srcY = Math.min(height - 1, (y * sy) | 0) * width;
    for (let x = 0; x < dw; x += 1) out[y * dw + x] = luma[srcY + Math.min(width - 1, (x * sx) | 0)];
  }
  return out;
}

function sadShift(ref, tgt, w, h, dx, dy) {
  let sad = 0;
  const x0 = Math.max(0, -dx), x1 = Math.min(w, w - dx);
  const y0 = Math.max(0, -dy), y1 = Math.min(h, h - dy);
  for (let y = y0; y < y1; y += 1) {
    const rRow = y * w, tRow = (y + dy) * w;
    for (let x = x0; x < x1; x += 1) sad += Math.abs(ref[rRow + x] - tgt[tRow + x + dx]);
  }
  return sad;
}

function estimateShiftCoarse(refLuma, tgtLuma, width, height) {
  const dw = 160, dh = 90;
  const ref = downsampleLuma(refLuma, width, height, dw, dh);
  const tgt = downsampleLuma(tgtLuma, width, height, dw, dh);
  let bestDx = 0, bestDy = 0, bestSad = Infinity;
  for (let dy = -8; dy <= 8; dy += 1) for (let dx = -8; dx <= 8; dx += 1) {
    const sad = sadShift(ref, tgt, dw, dh, dx, dy);
    if (sad < bestSad) { bestSad = sad; bestDx = dx; bestDy = dy; }
  }
  return [bestDx * (width / dw), bestDy * (height / dh)];
}

function estimateShiftFine(refLuma, tgtLuma, width, height, estX, estY) {
  // 1-px refinement on stride-8 samples (whole-frame coverage, cheap).
  // Early termination: abandon a candidate as soon as it exceeds the best SAD.
  // Above 8MP (hardware stills) use stride 16 — shift precision stays 1px,
  // only the SAD sampling density drops.
  const stride = width * height > 8000000 ? 16 : 8, range = 10;
  const cx = Math.round(estX), cy = Math.round(estY);
  let bestDx = cx, bestDy = cy, bestSad = Infinity;
  for (let dy = -range; dy <= range; dy += 1) for (let dx = -range; dx <= range; dx += 1) {
    const sx = cx + dx, sy = cy + dy;
    let sad = 0;
    const x0 = Math.max(0, -sx), x1 = Math.min(width, width - sx);
    const y0 = Math.max(0, -sy), y1 = Math.min(height, height - sy);
    for (let y = y0; y < y1 && sad < bestSad; y += stride) {
      const rRow = y * width, tRow = (y + sy) * width;
      for (let x = x0; x < x1; x += stride) {
        sad += Math.abs(refLuma[rRow + x] - tgtLuma[tRow + x + sx]);
        if (sad >= bestSad) break;
      }
    }
    if (sad < bestSad) { bestSad = sad; bestDx = sx; bestDy = sy; }
  }
  return [bestDx, bestDy];
}

/* Merge with exposure bracketing + noise-adaptive soft weighting.

   Frames carry per-frame EVs (0 when bracketing is unsupported). Frames are
   grouped by EV; the group whose EV is closest to 0 is the registration
   reference. Within each EV group, frames are combined with soft robust
   (Cauchy) weights w = 1/(1+(d/d0)^2) against the group's own reference
   frame — a smooth generalization of the old binary include/exclude gate:
   sensor noise (small d) averages fully, ghosts (large d) fade to ~0
   without a hard cutoff. The per-pixel temporal std of luma feeds a
   noise-adaptive sharpen gate, packed into the alpha channel
   (byte = clamp(gate/0.1)*255) for the finishing stage.

   Across EV groups, Mertens-style exposure fusion merges the best-exposed
   parts of each: weight = wellExposedness * (contrast + e) * (saturation + e),
   normalized per pixel. When all EVs are equal this degrades gracefully to
   plain temporal averaging. */
function merge(frames, evs, mode) {
  const { width, height } = frames[0];
  const n = width * height;
  const evKeys = frames.map((f, i) => Math.round(((evs && evs[i]) || 0) * 10));
  const uniqEvs = [...new Set(evKeys)].sort((a, b) => a - b);
  let refKey = uniqEvs[0];
  for (const k of uniqEvs) if (Math.abs(k) < Math.abs(refKey)) refKey = k;
  const refIdx = evKeys.indexOf(refKey);

  // Register every frame to the reference frame; reference needs no shift.
  const shifts = new Array(frames.length).fill(null);
  shifts[refIdx] = [0, 0];
  if (frames.length > 1) {
    const refLuma = lumaFull(frames[refIdx].data, width, height);
    for (let k = 0; k < frames.length; k += 1) {
      if (k === refIdx) continue;
      const tgtLuma = lumaFull(frames[k].data, width, height);
      const [cx, cy] = estimateShiftCoarse(refLuma, tgtLuma, width, height);
      shifts[k] = estimateShiftFine(refLuma, tgtLuma, width, height, cx, cy);
    }
  }

  const threshold = mode === "night" ? 42 : 30;
  const d02 = threshold * threshold;
  const gateBase = mode === "night" ? 0.035 : 0.016;
  const GATE_K = 0.006, GATE_SCALE = 0.1;
  const groups = [];

  for (const key of uniqEvs) {
    const idxs = evKeys.map((k, i) => (k === key ? i : -1)).filter((i) => i >= 0);
    const gRef = frames[idxs[0]].data; // group's own reference (same EV)
    const acc = new Float32Array(n * 3);
    // Pass 1: soft-weighted temporal mean vs the group's reference frame.
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const p = y * width + x, i3 = p * 3, i4 = p * 4;
        let sr = 0, sg = 0, sb = 0, sw = 0;
        for (const k of idxs) {
          const sh = shifts[k];
          const tx = x + sh[0], ty = y + sh[1];
          if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
          const t = (ty * width + tx) * 4, f = frames[k].data;
          const d = Math.abs(f[t] - gRef[i4]) + Math.abs(f[t + 1] - gRef[i4 + 1]) + Math.abs(f[t + 2] - gRef[i4 + 2]);
          const w = 1 / (1 + (d * d) / d02);
          sr += f[t] * w; sg += f[t + 1] * w; sb += f[t + 2] * w; sw += w;
        }
        if (sw > 0) { acc[i3] = sr / sw; acc[i3 + 1] = sg / sw; acc[i3 + 2] = sb / sw; }
        else { acc[i3] = gRef[i4]; acc[i3 + 1] = gRef[i4 + 1]; acc[i3 + 2] = gRef[i4 + 2]; }
      }
    }
    // Pass 2: temporal std of luma -> per-pixel noise-adaptive sharpen gate.
    const gate = new Uint8Array(n);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const p = y * width + x, i3 = p * 3, i4 = p * 4;
        const lm = acc[i3] * 0.299 + acc[i3 + 1] * 0.587 + acc[i3 + 2] * 0.114;
        let v = 0, sw = 0;
        for (const k of idxs) {
          const sh = shifts[k];
          const tx = x + sh[0], ty = y + sh[1];
          if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
          const t = (ty * width + tx) * 4, f = frames[k].data;
          const d = Math.abs(f[t] - gRef[i4]) + Math.abs(f[t + 1] - gRef[i4 + 1]) + Math.abs(f[t + 2] - gRef[i4 + 2]);
          const w = 1 / (1 + (d * d) / d02);
          const l = f[t] * 0.299 + f[t + 1] * 0.587 + f[t + 2] * 0.114;
          v += w * (l - lm) * (l - lm); sw += w;
        }
        const s = sw > 0 ? Math.sqrt(v / sw) : 0;
        gate[p] = Math.round(Math.min(1, (gateBase + s * GATE_K) / GATE_SCALE) * 255);
      }
    }
    const data = new Uint8ClampedArray(n * 4);
    for (let p = 0; p < n; p += 1) {
      const i4 = p * 4, i3 = p * 3;
      data[i4] = acc[i3]; data[i4 + 1] = acc[i3 + 1]; data[i4 + 2] = acc[i3 + 2]; data[i4 + 3] = gate[p];
    }
    groups.push({ data });
  }

  // Single EV: the group image is the merge (alpha already holds the gate).
  if (groups.length === 1) return { width, height, data: groups[0].data };

  // Exposure fusion across EV groups: keep the best-exposed parts of each.
  const gLumas = groups.map((gr) => {
    const l = new Float32Array(n);
    for (let p = 0; p < n; p += 1) {
      const i4 = p * 4;
      l[p] = (gr.data[i4] * 0.299 + gr.data[i4 + 1] * 0.587 + gr.data[i4 + 2] * 0.114) / 255;
    }
    return l;
  });
  const gBlurs = gLumas.map((l) => blurLumaSeparable(l, width, height, 2));
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p += 1) {
    const i4 = p * 4;
    const ws = new Array(groups.length);
    let wsum = 0;
    for (let gi = 0; gi < groups.length; gi += 1) {
      const d = groups[gi].data, l = gLumas[gi][p];
      const dl = l - 0.5;
      const we = Math.exp(-(dl * dl) / 0.08); // well-exposedness, sigma 0.2
      const contrast = Math.abs(l - gBlurs[gi][p]);
      const r = d[i4] / 255, gg = d[i4 + 1] / 255, b = d[i4 + 2] / 255;
      const sat = Math.max(r, gg, b) - Math.min(r, gg, b);
      const w = we * (contrast + 0.03) * (sat + 0.10);
      ws[gi] = w; wsum += w;
    }
    let r = 0, g = 0, b = 0, ga = 0;
    for (let gi = 0; gi < groups.length; gi += 1) {
      const w = ws[gi] / wsum, d = groups[gi].data;
      r += d[i4] * w; g += d[i4 + 1] * w; b += d[i4 + 2] * w; ga += d[i4 + 3] * w;
    }
    out[i4] = r; out[i4 + 1] = g; out[i4 + 2] = b; out[i4 + 3] = ga;
  }
  return { width, height, data: out };
}

/* ------------------------------------------------------------------
   Finishing styles — Snapseed recipes mapped to algorithms.
   iPhone look: bright Smart-HDR balance, rescued highlights, lifted
     shadows, gentle S-contrast, warmth +3, natural saturation.
   Pixel look: deeper HDR contrast, stronger highlight recovery and
     shadow lift, higher micro-contrast (structure), slightly cool tone.
   Shared: clamped gray-world auto WB (cast removal only),
     micro-contrast (structure) + gated edge sharpening.
   Portrait face tricks (lens blur / spotlight / skin smoothing) are
   intentionally omitted — no face landmarks in this pipeline.
   ------------------------------------------------------------------ */
/* Photo style: a single Pixel-inspired look.
   Color philosophy (v21 "true color"): the phone ISP already white-balanced
   and color-corrected the frames, so the pipeline must NOT re-interpret
   color. Tone mapping runs on luminance only (chroma-preserving luma-ratio
   scaling) so hue and saturation pass through exactly as captured; there are
   no saturation/vibrance boosts and no temperature shifts. Punch comes from
   luminance contrast, clarity, and edge sharpening — never from chroma. */
const STYLES = {
  pixel: {
    exposure: 1.08, nightExposure: 1.28,
    shadowTarget: 0.21, shadowAmt: 0.36, shadowEdge: 0.34,
    knee: 0.62, kneeKeep: 0.52, // soft highlight roll-off
    contrast: 1.15, // applied to luma only — punch without hue shift
    microAmt: 0.55,
    sharpAmt: 0.6, nightSharpAmt: 0.5,
    clarityAmt: 0.35, haloGate: 0.08,
    edgeRef: 0.12, sharpBase: 0.15,
    skinProtSharp: 0.50, skinProtMicro: 0.35, skinProtClar: 0.45,
  },
};
function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/* Specular-highlight white balance (replaces naive gray-world).
   Gray-world averages the whole frame, so a large colored wall drags the
   ambient tones with it. Specular and near-white highlights instead reflect
   the illuminant itself, so gains are estimated ONLY from pixels whose
   luminance falls in [0.78, 0.96] (bright but not clipped):
     gr = Gspec / Rspec, gb = Gspec / Bspec, green anchored at 1.0,
     tightly clamped to [0.91, 1.10] — cast removal only, never a look.
   If fewer than 0.1% of pixels qualify (e.g. dark night scenes), there is
   no trustworthy illuminant estimate, so gains stay neutral. */
function specularWBGains(data) {
  let sr = 0, sg = 0, sb = 0, n = 0;
  const total = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const l = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
    if (l >= 0.78 && l <= 0.96) { sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; n += 1; }
  }
  if (n < total * 0.001 || sr <= 0 || sb <= 0) return [1, 1, 1];
  const clamp = (v) => Math.max(0.91, Math.min(1.10, v));
  return [clamp((sg / n) / (sr / n)), 1, clamp((sg / n) / (sb / n))];
}

// ---- Face-aware skin processing (pico, MIT; cascade: vendor/pico/facefinder) ----
// Runs on the merged frame and builds a feathered skin mask so finishing can
// protect skin texture from over-sharpening. Color is not touched here.
let picoClassify = null;
async function ensureFaceDetector() {
  if (picoClassify) return true;
  try {
    if (typeof pico === "undefined") importScripts("vendor/pico/pico.js");
    const resp = await fetch("vendor/pico/facefinder");
    if (!resp.ok) return false;
    picoClassify = pico.unpack_cascade(new Int8Array(await resp.arrayBuffer()));
    return true;
  } catch (e) { console.warn("face detector unavailable:", e.message); return false; }
}

async function detectFaces(data, width, height) {
  if (!(await ensureFaceDetector())) return [];
  const scale = Math.min(1, 160 / width);
  const sw = Math.max(48, Math.round(width * scale));
  const sh = Math.max(36, Math.round(height * scale));
  const gray = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y += 1) {
    const sy = Math.min(height - 1, (y / scale) | 0);
    for (let x = 0; x < sw; x += 1) {
      const sx = Math.min(width - 1, (x / scale) | 0);
      const i = (sy * width + sx) * 4;
      gray[y * sw + x] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    }
  }
  const params = {
    shiftfactor: 0.1,
    minsize: Math.max(20, sw * 0.08),
    maxsize: sw * 0.9,
    scalefactor: 1.1,
  };
  let dets = pico.run_cascade({ pixels: gray, nrows: sh, ncols: sw, ldim: sw }, picoClassify, params);
  dets = pico.cluster_detections(dets, 0.2);
  const faces = [];
  for (const d of dets) {
    if (d[3] < 45) continue; // detection score gate (empirical)
    faces.push({ x: d[1] / scale, y: d[0] / scale, r: d[2] / 2 / scale });
  }
  return faces;
}

function buildSkinMask(faces, width, height) {
  const mw = Math.max(1, Math.ceil(width / 4)), mh = Math.max(1, Math.ceil(height / 4));
  const mask = new Float32Array(mw * mh);
  for (const f of faces) {
    const cx = f.x / 4, cy = f.y / 4;
    const rx = Math.max(2, (f.r * 0.9) / 4), ry = Math.max(2, (f.r * 1.15) / 4);
    const x0 = Math.max(0, Math.floor(cx - rx * 2)), x1 = Math.min(mw - 1, Math.ceil(cx + rx * 2));
    const y0 = Math.max(0, Math.floor(cy - ry * 2)), y1 = Math.min(mh - 1, Math.ceil(cy + ry * 2));
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      const d2 = dx * dx + dy * dy;
      if (d2 >= 4) continue;
      const t = Math.max(0, 1 - d2 / 4);
      const v = t * t * (3 - 2 * t);
      const idx = y * mw + x;
      if (v > mask[idx]) mask[idx] = v;
    }
  }
  return { data: mask, width: mw, height: mh };
}

async function facePass(data, width, height) {
  // Faces are detected only to build the skin mask, which finishing uses to
  // protect skin texture from over-sharpening. Color is deliberately left
  // alone: the ISP's white balance is trusted (see "true color" note above).
  const faces = await detectFaces(data, width, height);
  const skinMask = buildSkinMask(faces, width, height);
  return { faces, skinMask };
}

function skinMaskBytes(mask) {
  const out = new Uint8Array(mask.data.length);
  for (let i = 0; i < out.length; i += 1) out[i] = Math.round(Math.min(1, mask.data[i]) * 255);
  return { data: out, width: mask.width, height: mask.height };
}

function sampleSkinMask(skin, x, y) {
  if (!skin) return 0;
  const mx = Math.min(skin.width - 1, (x / 4) | 0), my = Math.min(skin.height - 1, (y / 4) | 0);
  return skin.data[my * skin.width + mx];
}

function blurLumaSeparable(luma, width, height, radius) {
  const tmp = new Float32Array(luma.length);
  const out = new Float32Array(luma.length);
  const div = 2 * radius + 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let acc = 0;
    for (let x = -radius; x <= radius; x += 1) acc += luma[row + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x += 1) {
      tmp[row + x] = acc / div;
      acc += luma[row + Math.min(width - 1, x + radius + 1)] - luma[row + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let acc = 0;
    for (let y = -radius; y <= radius; y += 1) acc += tmp[Math.min(height - 1, Math.max(0, y)) * width + x];
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = acc / div;
      acc += tmp[Math.min(height - 1, y + radius + 1) * width + x] - tmp[Math.max(0, y - radius) * width + x];
    }
  }
  return out;
}

function fallback(image, mode = "photo", style = "pixel") {
  const S = STYLES[style] || STYLES.pixel;
  const { width, height, data } = image;
  const count = width * height;
  // Face-aware gains (computed once per burst in onmessage); fall back to
  // plain specular WB when the face pass did not run.
  // Specular-highlight white balance. Self-limiting: when the ISP already
  // nailed WB the highlights are neutral and the gains come out ~[1,1,1].
  const [gr, gg, gb] = specularWBGains(data);
  const skin = image.skin || null;
  const exposure = mode === "night" ? S.nightExposure : S.exposure;
  const luma = new Float32Array(count);
  const out = new Uint8ClampedArray(count * 4);

  // Pass 1: WB, then chroma-preserving tone map. Exposure, highlight knee,
  // contrast, and shadow lift run on LUMA ONLY; RGB is scaled by the luma
  // ratio, so hue and saturation pass through exactly as the ISP captured
  // them ("true color"). A gentle per-channel knee afterwards rolls off
  // clipping highlights film-style instead of hard-clipping them.
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    const r0 = (data[o] / 255) * gr;
    const g0 = (data[o + 1] / 255) * gg;
    const b0 = (data[o + 2] / 255) * gb;
    const L = r0 * 0.2126 + g0 * 0.7152 + b0 * 0.0722;
    let Lp = L * exposure;
    if (Lp > S.knee) Lp = S.knee + (Lp - S.knee) * S.kneeKeep;
    Lp = (Lp - 0.5) * S.contrast + 0.5;
    Lp += (S.shadowTarget - Lp) * S.shadowAmt * smoothstep(S.shadowEdge, 0.0, Lp);
    const s = L > 1e-6 ? Math.max(0, Lp / L) : 0;
    let r = r0 * s, g = g0 * s, b = b0 * s;
    // Hue-perfect highlight guard: if any channel would clip, scale all three
    // by the max — chromaticity is preserved exactly, never hue-shifted.
    const m = Math.max(r, g, b);
    if (m > 1) { r /= m; g /= m; b /= m; }
    const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
    luma[i] = l;
    out[o] = Math.max(0, Math.min(255, r * 255));
    out[o + 1] = Math.max(0, Math.min(255, g * 255));
    out[o + 2] = Math.max(0, Math.min(255, b * 255));
    out[o + 3] = 255;
  }

  // Pass 2: blurred luma neighborhood (structure + ambiance local contrast)
  const blur = blurLumaSeparable(luma, width, height, 2);

  // Pass 3: clarity (medium-scale local contrast, halo-clamped) +
  // micro-contrast + gradient-weighted, noise-gated edge sharpening.
  // All detail is luma-only, so it never shifts hue or saturation.
  // The sharpen gate is per-pixel, from the merge's temporal-variance estimate
  // packed in the alpha channel (byte = clamp(gate/0.1)*255).
  const sharpAmt = mode === "night" ? S.nightSharpAmt : S.sharpAmt;
  const blurMed = blurLumaSeparable(luma, width, height, 8);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const o = i * 4;
      const l = luma[i];
      const xm = x > 0 ? i - 1 : i, xp = x < width - 1 ? i + 1 : i;
      const ym = y > 0 ? i - width : i, yp = y < height - 1 ? i + width : i;
      const neigh = (luma[xm] + luma[xp] + luma[ym] + luma[yp]) * 0.25;
      const gx = luma[xp] - luma[xm], gy = luma[yp] - luma[ym];
      const edgeW = Math.min(1, Math.sqrt(gx * gx + gy * gy) / S.edgeRef);
      // Detail enhancement follows edge presence: in flat noisy areas the
      // gradient is just noise, so micro-contrast is scaled down and the
      // sharpening (already noise-gated via alpha) drops to a low floor.
      // Inside the face mask, detail is further dialed back so skin keeps
      // its natural texture instead of being over-sharpened.
      const sk = sampleSkinMask(skin, x, y);
      const micro = (l - blur[i]) * S.microAmt * Math.max(0.2, Math.min(1, edgeW * 2)) * (1 - sk * S.skinProtMicro);
      const clar = Math.max(-S.haloGate, Math.min(S.haloGate, (l - blurMed[i]) * S.clarityAmt)) * (1 - sk * S.skinProtClar);
      let sharp = (l - neigh) * sharpAmt * (S.sharpBase + (1 - S.sharpBase) * edgeW) * (1 - sk * S.skinProtSharp);
      const gate = (data[o + 3] / 255) * 0.1;
      if (sharp > -gate && sharp < gate) sharp = 0;
      const delta = micro + sharp + clar;
      const r = out[o] / 255, g = out[o + 1] / 255, b = out[o + 2] / 255;
      // Detail is luma-only (added equally to all channels): chroma is never
      // touched, so local contrast can't shift hue or saturation.
      out[o]     = Math.max(0, Math.min(255, (r + delta) * 255));
      out[o + 1] = Math.max(0, Math.min(255, (g + delta) * 255));
      out[o + 2] = Math.max(0, Math.min(255, (b + delta) * 255));
    }
  }
  return out;
}

function makeTensor(image, shape) {
  const nhwc = shape.length === 4 && shape[3] === 3;
  const height = nhwc ? shape[1] : shape[2];
  const width = nhwc ? shape[2] : shape[3];
  const tensor = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const source = (y * image.width + x) * 4;
    const pixel = y * width + x;
    if (nhwc) { tensor[pixel * 3] = image.data[source] / 255; tensor[pixel * 3 + 1] = image.data[source + 1] / 255; tensor[pixel * 3 + 2] = image.data[source + 2] / 255; }
    else { tensor[pixel] = image.data[source] / 255; tensor[width * height + pixel] = image.data[source + 1] / 255; tensor[2 * width * height + pixel] = image.data[source + 2] / 255; }
  }
  return new runtime.Tensor("float32", tensor, shape);
}

function tensorToImage(value, fallbackImage) {
  const dims = value.shape || value.dims || [];
  if (dims.length !== 4 || dims[0] !== 1) return { ...fallbackImage, data: fallback(fallbackImage) };
  const nhwc = dims[3] === 3;
  const height = nhwc ? dims[1] : dims[2];
  const width = nhwc ? dims[2] : dims[3];
  if (!width || !height || width * height * 4 > MAX_HEAP_BYTES) return { ...fallbackImage, data: fallback(fallbackImage) };
  const raw = value.data;
  const output = new Uint8ClampedArray(width * height * 4);
  const plane = width * height;
  for (let i = 0; i < plane; i += 1) {
    const read = (channel) => { const valueAt = nhwc ? raw[i * 3 + channel] : raw[channel * plane + i]; return Math.max(0, Math.min(255, Math.round(valueAt <= 1 ? valueAt * 255 : valueAt))); };
    output[i * 4] = read(0); output[i * 4 + 1] = read(1); output[i * 4 + 2] = read(2); output[i * 4 + 3] = 255;
  }
  return { width, height, data: output };
}

async function neural(image) {
  const inputDetails = runner.getInputDetails?.()[0] || {};
  const shape = inputDetails.shape || [1, image.height, image.width, 3];
  const nhwc = shape[3] === 3;
  const height = Math.max(32, Math.min(MAX_DIMENSION, shape[nhwc ? 1 : 2] || image.height));
  const width = Math.max(32, Math.min(MAX_DIMENSION, shape[nhwc ? 2 : 3] || image.width));
  const prepared = resize(image, width, height);
  const tensor = makeTensor(prepared, nhwc ? [1, height, width, 3] : [1, 3, height, width]);
  try {
    const outputs = await runner.run(tensor);
    const output = Array.isArray(outputs) ? outputs[0] : outputs[Object.keys(outputs)[0]];
    return tensorToImage(output, prepared);
  } finally { tensor.delete?.(); tensor.dispose?.(); }
}

self.onmessage = async (event) => {
  const { id, frames, evs, mode, style, finish } = event.data;
  const started = performance.now();
  try {
    await initialize();
    const merged = merge(frames, evs, mode);
    denoiseMerged(merged.data, merged.width, merged.height, frames.length === 1);
    // Face-aware skin pass (once per burst): detect faces and build the
    // feathered skin mask that finishing uses to protect skin texture.
    const fp = await facePass(merged.data, merged.width, merged.height);
    merged.skin = fp.skinMask;
    merged.faceCount = fp.faces.length;
    if (!runner && finish === "webgl") {
      // WebGL finishing runs on the main thread: hand over the merged frame
      // plus specular WB gains and fully-resolved style params. The CPU
      // fallback() stays as the automatic safety net if GL fails.
      const S = STYLES[style] || STYLES.pixel;
      const [gr, gg, gb] = specularWBGains(merged.data);
      const params = {
        gains: [gr, gg, gb],
        exposure: mode === "night" ? S.nightExposure : S.exposure,
        knee: S.knee, kneeKeep: S.kneeKeep, contrast: S.contrast,
        shadowTarget: S.shadowTarget, shadowAmt: S.shadowAmt, shadowEdge: S.shadowEdge,
        microAmt: S.microAmt,
        sharpAmt: mode === "night" ? S.nightSharpAmt : S.sharpAmt,
        clarityAmt: S.clarityAmt, haloGate: S.haloGate,
        edgeRef: S.edgeRef, sharpBase: S.sharpBase,
        skinProtSharp: S.skinProtSharp, skinProtMicro: S.skinProtMicro, skinProtClar: S.skinProtClar,
        skinMask: skinMaskBytes(fp.skinMask),
        faceCount: fp.faces.length,
      };
      const elapsedMs = Math.round(performance.now() - started);
      self.postMessage({ id, type: "result", width: merged.width, height: merged.height, data: merged.data, params, pendingFinish: true, elapsedMs, engine, status }, [merged.data.buffer]);
      return;
    }
    const image = runner ? await neural(merged) : { ...merged, data: fallback(merged, mode, style) };
    const elapsedMs = Math.round(performance.now() - started);
    self.postMessage({ id, type: "result", width: image.width, height: image.height, data: image.data, elapsedMs, engine, status }, [image.data.buffer]);
  } catch (error) {
    const merged = merge(frames, evs, mode); const data = fallback(merged, mode, style);
    self.postMessage({ id, type: "result", width: merged.width, height: merged.height, data, elapsedMs: Math.round(performance.now() - started), engine: "Fallback", status: "FALLBACK_MODE", warning: error.message }, [data.buffer]);
  }
};

initialize();
