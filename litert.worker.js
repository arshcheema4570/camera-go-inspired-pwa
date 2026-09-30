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

function merge(frames, mode) {
  const base = frames[0];
  const data = new Uint8ClampedArray(base.data);
  const threshold = mode === "night" ? 42 : 30;
  for (let i = 0; i < data.length; i += 4) {
    let r = 0, g = 0, b = 0, count = 0;
    for (const frame of frames) {
      const delta = Math.abs(frame.data[i] - base.data[i]) + Math.abs(frame.data[i + 1] - base.data[i + 1]) + Math.abs(frame.data[i + 2] - base.data[i + 2]);
      if (delta < threshold) { r += frame.data[i]; g += frame.data[i + 1]; b += frame.data[i + 2]; count += 1; }
    }
    if (count) { data[i] = r / count; data[i + 1] = g / count; data[i + 2] = b / count; }
  }
  return { width: base.width, height: base.height, data };
}

/* ------------------------------------------------------------------
   Finishing styles — Snapseed recipes mapped to algorithms.
   iPhone look: bright Smart-HDR balance, rescued highlights, lifted
     shadows, gentle S-contrast, warmth +3, natural saturation.
   Pixel look: deeper HDR contrast, stronger highlight recovery and
     shadow lift, higher micro-contrast (structure), slightly cool tone.
   Shared: clamped gray-world auto WB (cast removal only),
     micro-contrast (structure) + gated edge sharpening, vibrance.
   Portrait face tricks (lens blur / spotlight / skin smoothing) are
   intentionally omitted — no face landmarks in this pipeline.
   ------------------------------------------------------------------ */
const STYLES = {
  iphone: {
    exposure: 1.12, nightExposure: 1.28,
    shadowTarget: 0.18, shadowAmt: 0.22, shadowEdge: 0.32,
    knee: 0.72, kneeKeep: 0.72,
    contrast: 1.07,
    tempR: 1.018, tempB: 0.992,
    saturation: 1.07,
    microAmt: 0.5,
    sharpAmt: 1.0, nightSharpAmt: 0.55,
    sharpGate: 0.016, nightSharpGate: 0.035,
    vibrance: 0.10,
  },
  pixel: {
    exposure: 1.08, nightExposure: 1.28,
    shadowTarget: 0.21, shadowAmt: 0.34, shadowEdge: 0.34,
    knee: 0.68, kneeKeep: 0.60,
    contrast: 1.15,
    tempR: 0.996, tempB: 1.008,
    saturation: 1.05,
    microAmt: 0.7,
    sharpAmt: 1.0, nightSharpAmt: 0.55,
    sharpGate: 0.016, nightSharpGate: 0.035,
    vibrance: 0.15,
  },
};
function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function wbGains(data) {
  let sr = 0, sg = 0, sb = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) { sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; }
  const mr = sr / n / 255, mg = sg / n / 255, mb = sb / n / 255;
  const lum = mr * 0.2126 + mg * 0.7152 + mb * 0.0722;
  if (lum <= 0.001) return [1, 1, 1];
  const clamp = (v) => Math.max(0.85, Math.min(1.18, v));
  return [clamp(lum / mr), clamp(lum / mg), clamp(lum / mb)];
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

function fallback(image, mode = "photo", style = "iphone") {
  const S = STYLES[style] || STYLES.iphone;
  const { width, height, data } = image;
  const count = width * height;
  const [gr, gg, gb] = wbGains(data);
  const exposure = mode === "night" ? S.nightExposure : S.exposure;
  const luma = new Float32Array(count);
  const out = new Uint8ClampedArray(count * 4);

  // Pass 1: WB -> exposure -> highlight knee -> contrast ->
  //         shadow lift -> temperature -> saturation
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    let r = (data[o] / 255) * gr * exposure;
    let g = (data[o + 1] / 255) * gg * exposure;
    let b = (data[o + 2] / 255) * gb * exposure;
    // highlights: soft knee rescues bright detail (HDR)
    if (r > S.knee) r = S.knee + (r - S.knee) * S.kneeKeep;
    if (g > S.knee) g = S.knee + (g - S.knee) * S.kneeKeep;
    if (b > S.knee) b = S.knee + (b - S.knee) * S.kneeKeep;
    // contrast: S-curve punch
    r = (r - 0.5) * S.contrast + 0.5;
    g = (g - 0.5) * S.contrast + 0.5;
    b = (b - 0.5) * S.contrast + 0.5;
    // shadows: smooth lift of dark areas (applied after contrast so it survives)
    r += (S.shadowTarget - r) * S.shadowAmt * smoothstep(S.shadowEdge, 0.0, r);
    g += (S.shadowTarget - g) * S.shadowAmt * smoothstep(S.shadowEdge, 0.0, g);
    b += (S.shadowTarget - b) * S.shadowAmt * smoothstep(S.shadowEdge, 0.0, b);
    // temperature: iPhone warmth vs Pixel clinical cool
    r *= S.tempR; b *= S.tempB;
    const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
    // saturation around luma
    r = l + (r - l) * S.saturation;
    g = l + (g - l) * S.saturation;
    b = l + (b - l) * S.saturation;
    luma[i] = r * 0.2126 + g * 0.7152 + b * 0.0722;
    out[o] = Math.max(0, Math.min(255, r * 255));
    out[o + 1] = Math.max(0, Math.min(255, g * 255));
    out[o + 2] = Math.max(0, Math.min(255, b * 255));
    out[o + 3] = 255;
  }

  // Pass 2: blurred luma neighborhood (structure + ambiance local contrast)
  const blur = blurLumaSeparable(luma, width, height, 2);

  // Pass 3: micro-contrast + gated edge sharpening + vibrance
  const sharpAmt = mode === "night" ? S.nightSharpAmt : S.sharpAmt;
  const sharpGate = mode === "night" ? S.nightSharpGate : S.sharpGate;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const o = i * 4;
      const l = luma[i];
      const micro = (l - blur[i]) * S.microAmt;
      const xm = x > 0 ? i - 1 : i, xp = x < width - 1 ? i + 1 : i;
      const ym = y > 0 ? i - width : i, yp = y < height - 1 ? i + width : i;
      const neigh = (luma[xm] + luma[xp] + luma[ym] + luma[yp]) * 0.25;
      let sharp = (l - neigh) * sharpAmt;
      if (sharp > -sharpGate && sharp < sharpGate) sharp = 0;
      const delta = micro + sharp;
      const r = out[o] / 255, g = out[o + 1] / 255, b = out[o + 2] / 255;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      const vib = 1 + (1 - Math.min(1, sat * 2.4)) * S.vibrance;
      out[o]     = Math.max(0, Math.min(255, (l + (r - l) * vib + delta) * 255));
      out[o + 1] = Math.max(0, Math.min(255, (l + (g - l) * vib + delta) * 255));
      out[o + 2] = Math.max(0, Math.min(255, (l + (b - l) * vib + delta) * 255));
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
  const { id, frames, mode, style } = event.data;
  const started = performance.now();
  try {
    await initialize();
    const merged = merge(frames, mode);
    const image = runner ? await neural(merged) : { ...merged, data: fallback(merged, mode, style) };
    const elapsedMs = Math.round(performance.now() - started);
    self.postMessage({ id, type: "result", width: image.width, height: image.height, data: image.data, elapsedMs, engine, status }, [image.data.buffer]);
  } catch (error) {
    const merged = merge(frames, mode); const data = fallback(merged, mode, style);
    self.postMessage({ id, type: "result", width: merged.width, height: merged.height, data, elapsedMs: Math.round(performance.now() - started), engine: "Fallback", status: "FALLBACK_MODE", warning: error.message }, [data.buffer]);
  }
};

initialize();
