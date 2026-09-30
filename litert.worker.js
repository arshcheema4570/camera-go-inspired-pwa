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
   Finishing chain (runs on the merged burst in the fallback path):
     1. Filmic dynamic-range mapping (Hable curve): rolls off highlights,
        deepens the toe, and boosts midtone contrast so the image "pops".
     2. Local micro-contrast: unsharp mask on luma against a small-radius
        blurred neighborhood — adds texture bite without halos.
     3. Edge sharpening: stronger unsharp mask with a noise gate so flat
        areas (sky, skin) are not sharpened into grain.
   ------------------------------------------------------------------ */
function hable(x) {
  const A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
const HABLE_WHITE = hable(1.0);

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

function fallback(image, mode = "photo") {
  const { width, height, data } = image;
  const count = width * height;
  const luma = new Float32Array(count);
  const out = new Uint8ClampedArray(count * 4);
  const exposure = mode === "night" ? 1.3 : 1.05;

  // Pass 1: filmic tone map per channel + luma
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    const r = Math.min(1, hable((data[o] / 255) * exposure) / HABLE_WHITE);
    const g = Math.min(1, hable((data[o + 1] / 255) * exposure) / HABLE_WHITE);
    const b = Math.min(1, hable((data[o + 2] / 255) * exposure) / HABLE_WHITE);
    out[o] = r * 255; out[o + 1] = g * 255; out[o + 2] = b * 255; out[o + 3] = 255;
    luma[i] = r * 0.2126 + g * 0.7152 + b * 0.0722;
  }

  // Pass 2: blurred luma neighborhood for micro-contrast
  const blur = blurLumaSeparable(luma, width, height, 2);

  // Pass 3: micro-contrast + gated edge sharpening + vibrance
  const microAmt = 0.42;
  const sharpAmt = mode === "night" ? 0.55 : 1.0;
  const sharpGate = mode === "night" ? 0.035 : 0.016;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const o = i * 4;
      const l = luma[i];
      const micro = (l - blur[i]) * microAmt;
      const xm = x > 0 ? i - 1 : i, xp = x < width - 1 ? i + 1 : i;
      const ym = y > 0 ? i - width : i, yp = y < height - 1 ? i + width : i;
      const neigh = (luma[xm] + luma[xp] + luma[ym] + luma[yp]) * 0.25;
      let sharp = (l - neigh) * sharpAmt;
      if (sharp > -sharpGate && sharp < sharpGate) sharp = 0;
      const delta = micro + sharp;
      const r = out[o] / 255, g = out[o + 1] / 255, b = out[o + 2] / 255;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      const vib = 1 + (1 - Math.min(1, sat * 2.4)) * 0.14;
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
  const { id, frames, mode } = event.data;
  const started = performance.now();
  try {
    await initialize();
    const merged = merge(frames, mode);
    const image = runner ? await neural(merged) : { ...merged, data: fallback(merged, mode) };
    const elapsedMs = Math.round(performance.now() - started);
    self.postMessage({ id, type: "result", width: image.width, height: image.height, data: image.data, elapsedMs, engine, status }, [image.data.buffer]);
  } catch (error) {
    const merged = merge(frames, mode); const data = fallback(merged, mode);
    self.postMessage({ id, type: "result", width: merged.width, height: merged.height, data, elapsedMs: Math.round(performance.now() - started), engine: "Fallback", status: "FALLBACK_MODE", warning: error.message }, [data.buffer]);
  }
};

initialize();
