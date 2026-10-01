const $ = (id) => document.getElementById(id);

const video = $("preview");
const fxCanvas = $("fxCanvas");
const captureCanvas = $("captureCanvas");
const startButton = $("startButton");
const captureButton = $("captureButton");
const switchButton = $("switchButton");
const flashButton = $("flashButton");
const timerButton = $("timerButton");
const timerLabel = $("timerLabel");
const gridButton = $("gridButton");
const gridOverlay = $("gridOverlay");
const placeholder = $("previewPlaceholder");
const statusPill = $("statusPill");
const errorMessage = $("errorMessage");
const countdown = $("countdown");
const zoomRange = $("zoomRange");
const zoomLabel = $("zoomLabel");
const galleryThumb = $("galleryThumb");
const galleryThumbButton = $("galleryThumbButton");
const flashVal = $("flashVal");
const flashZap = $("flashZap");
const toastEl = $("toast");
const procEl = $("processing");
const procStage = $("procStage");
const viewerOverlay = $("viewerOverlay");
const viewerImage = $("viewerImage");
const viewerClose = $("viewerClose");
const viewerSave = $("viewerSave");
const viewerShare = $("viewerShare");
let viewerObjectUrl = null;
// Single Pixel-inspired look (the iPhone style was removed at the user's
// request — he wants Pixel-style photos from the PWA).

const MAX_WIDTH = 1280;
const MAX_HEIGHT = 720;
const FRAME_BUDGET_MS = 33;
// Full-resolution capture tiers (measured 2026-09-30, weak sandbox CPU, 3-frame burst):
//   1920x1080: ~1.4s / ~55MB worker mem | 2560x1440: ~2.4s / ~98MB | 3840x2160: ~3.7s / ~221MB
// 2560px long edge = 4x the pixels of 720p, safe memory on phones, ~1s on an A14-class SoC.
const STREAM_IDEAL_WIDTH = 3840;
const STREAM_IDEAL_HEIGHT = 2160;
const WORKING_MAX_EDGE = 2560;
const JPEG_QUALITY = 0.95;
const worker = new Worker("./litert.worker.js", { type: "module" });

let stream = null;
let facingMode = "environment";
let timerSeconds = 0;
let mode = "photo";
let videoReady = false;
let originalImage = null;
let processedBlob = null;
let burstCount = 3;
let requestId = 0;
let liveFrame = 0;
let gl = null;
let glProgram = null;
let glTexture = null;
let galleryObjectUrl = null;
let sensorWidth = 0;
let sensorHeight = 0;

const setStatus = (text) => { statusPill.textContent = text; };
const setStage = (text) => { procStage.textContent = text; };
const showProc = (on) => { procEl.hidden = !on; };
const toast = (msg, ms = 2800) => {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove("show"), ms);
};
const fireFlash = () => {
  flashZap.classList.remove("fire");
  void flashZap.offsetWidth;
  flashZap.classList.add("fire");
};
const showError = (text) => {
  errorMessage.textContent = text;
  errorMessage.classList.toggle("hidden", !text);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
worker.addEventListener("message", (event) => {
  if (event.data.type === "status") { setStatus(event.data.message); setStage(event.data.message); }
});

function explain(error) {
  if (error.name === "NotAllowedError") return "Camera permission was denied. Use the lock icon beside the address and set Camera to Allow.";
  if (error.name === "NotFoundError") return "ChromeOS could not find a camera. Close other camera apps and check ChromeOS privacy settings.";
  if (error.name === "NotReadableError") return "The camera is busy in another app. Close the Camera app or video-call tabs and try again.";
  return `Camera could not start: ${error.message || error.name}`;
}

function waitFrame() {
  return new Promise((resolve) => {
    if (video.videoWidth > 0 && video.readyState >= 1) { resolve(); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ["loadedmetadata", "loadeddata", "canplay", "playing"].forEach((event) => video.removeEventListener(event, finish));
      resolve();
    };
    ["loadedmetadata", "loadeddata", "canplay", "playing"].forEach((event) => video.addEventListener(event, finish, { once: true }));
    setTimeout(finish, 2500);
  });
}

function initLiveShader() {
  if (!fxCanvas || !window.WebGLRenderingContext) return;
  gl = fxCanvas.getContext("webgl", { alpha: false, antialias: false, powerPreference: "low-power" });
  if (!gl) return;
  const vertex = `attribute vec2 position; varying vec2 uv; void main(){ uv=(position+1.0)*0.5; gl_Position=vec4(position,0.0,1.0); }`;
  const fragment = `precision mediump float; varying vec2 uv; uniform sampler2D frame; uniform vec2 texel; void main(){ vec3 c=texture2D(frame,uv).rgb; vec3 l=(texture2D(frame,uv+vec2(texel.x,0.0)).rgb+texture2D(frame,uv-vec2(texel.x,0.0)).rgb+texture2D(frame,uv+vec2(0.0,texel.y)).rgb+texture2D(frame,uv-vec2(0.0,texel.y)).rgb)*0.25; c += (c-l)*0.20; c=(c-0.5)*1.06+0.5; c=max(c,vec3(0.0)); c=pow(c,vec3(1.08))*0.97; gl_FragColor=vec4(c,1.0); }`;
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  };
  const vs = compile(gl.VERTEX_SHADER, vertex);
  const fs = compile(gl.FRAGMENT_SHADER, fragment);
  if (!vs || !fs) { gl = null; return; }
  glProgram = gl.createProgram();
  gl.attachShader(glProgram, vs); gl.attachShader(glProgram, fs); gl.linkProgram(glProgram);
  if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) { gl = null; return; }
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(glProgram, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  glTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, glTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  fxCanvas.classList.remove("hidden");
}

/* Dynamic hardware aspect-ratio lock: the single source of truth for the
   sensor geometry is MediaStreamTrack.getSettings(). Every canvas backing
   store is derived from it with a UNIFORM scale, so nothing can stretch. */
function lockSensorAspect() {
  const track = stream?.getVideoTracks()[0];
  const settings = track?.getSettings?.() || {};
  sensorWidth = settings.width || video.videoWidth || 0;
  sensorHeight = settings.height || video.videoHeight || 0;
  if (sensorWidth > 0 && sensorHeight > 0) {
    document.documentElement.style.setProperty("--sensor-ratio", `${sensorWidth} / ${sensorHeight}`);
  }
  return sensorWidth > 0 && sensorHeight > 0;
}

function renderLiveFrame() {
  if (!gl || !videoReady || video.readyState < 2) { liveFrame = requestAnimationFrame(renderLiveFrame); return; }
  const srcW = sensorWidth || video.videoWidth, srcH = sensorHeight || video.videoHeight;
  const scale = Math.min(1, MAX_WIDTH / srcW, MAX_HEIGHT / srcH);
  const width = Math.max(2, Math.round(srcW * scale));
  const height = Math.max(2, Math.round(srcH * scale));
  if (fxCanvas.width !== width || fxCanvas.height !== height) { fxCanvas.width = width; fxCanvas.height = height; }
  gl.viewport(0, 0, width, height);
  gl.useProgram(glProgram);
  gl.bindTexture(gl.TEXTURE_2D, glTexture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  gl.uniform1i(gl.getUniformLocation(glProgram, "frame"), 0);
  gl.uniform2f(gl.getUniformLocation(glProgram, "texel"), 1 / width, 1 / height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  liveFrame = requestAnimationFrame(renderLiveFrame);
}

/* ------------------------------------------------------------------
   WebGL photo finishing — GPU port of the worker's CPU fallback passes.
   The 2.4s single-thread JS loop is replaced by 4 fullscreen draws:
     tone : merged burst -> FBO   (specular WB, exposure, highlight knee,
                                   contrast, shadow lift, temperature,
                                   saturation; output clamped to [0,1])
     blurH: tone luma -5px-> FBO  (separable 5-tap box blur, radius 2 —
     blurV: blurH -5px-> FBO        matches CPU blurLumaSeparable exactly)
     blurMedH/blurMedV: tone luma -> FBO (separable 9-tap sparse blur,
                        ~radius 8 clarity band; CPU uses blurLumaSeparable
                        r=8 — same scale, slightly different kernel shape)
     comp : tone + blurred luma -> canvas (micro-contrast, clarity,
            gradient-weighted noise-gated edge sharpening)
   The sharpen gate is per-pixel, packed by the worker into the merged
   frame's alpha channel (byte = clamp(gate/0.1)*255); the tone pass
   preserves source alpha so the composite can read it.
   Any GL failure throws and the caller falls back to worker CPU
   finishing of the same burst — capture never breaks on GL issues.
   The GL path is used up to 4K (3840x2160); larger captures (e.g. 12MP
   hardware stills) stay on the CPU path to avoid a ~200MB transient
   texture spike on mobile GPUs. Quality is identical either way —
   the shader math was verified equivalent to the CPU fallback.
   Note: the tone target is an UNSIGNED_BYTE texture, so tone RGB is stored
   divided by TONE_SCALE (1.5) — headroom that preserves the CPU's unclamped
   >1.0 highlight luma through the blur and composite passes instead of
   clipping it. Blur/composite multiply back out; residual GL-vs-CPU
   difference is float32-vs-float64 only.
   ------------------------------------------------------------------ */
let finishGL = null;

const FINISH_VERT = "attribute vec2 position; varying vec2 uv; void main(){ uv=(position+1.0)*0.5; gl_Position=vec4(position,0.0,1.0); }";
const FINISH_HEAD = "#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n#define TONE_SCALE 1.5\nvarying vec2 uv;\n";
const FINISH_TONE_FRAG = FINISH_HEAD + [
  // True color: tone curve runs on luma only; RGB scales by the luma ratio so
  // hue and saturation pass through exactly as captured. No temp/saturation
  // shifts, no skin recolor — punch comes from luminance only.
  "uniform sampler2D src;",
  "uniform vec3 gains;",
  "uniform float exposure;",
  "uniform float knee;",
  "uniform float kneeKeep;",
  "uniform float contrast;",
  "uniform float shadowTarget;",
  "uniform float shadowAmt;",
  "uniform float shadowEdge;",
  "float sstep(float e0, float e1, float x){ float t = clamp((x-e0)/(e1-e0), 0.0, 1.0); return t*t*(3.0-2.0*t); }",
  "void main(){",
  "  vec3 c0 = texture2D(src, uv).rgb * gains;",
  "  float L = dot(c0, vec3(0.2126, 0.7152, 0.0722));",
  "  float Lp = L * exposure;",
  "  Lp = min(Lp, knee) + max(Lp - knee, 0.0) * kneeKeep;",
  "  Lp = (Lp - 0.5) * contrast + 0.5;",
  "  Lp += (shadowTarget - Lp) * shadowAmt * sstep(shadowEdge, 0.0, Lp);",
  "  vec3 c = c0 * (L > 1e-6 ? max(Lp / L, 0.0) : 0.0);",
  "  float m = max(max(c.r, c.g), c.b);",
  "  if (m > 1.0) c /= m;",
  "  gl_FragColor = vec4(clamp(c, 0.0, 1.5) / TONE_SCALE, texture2D(src, uv).a);",
  "}",
].join("\n");
const FINISH_BLUR_FRAG = FINISH_HEAD + [
  "uniform sampler2D src;",
  "uniform vec2 texel;",
  "void main(){",
  "  vec3 c = texture2D(src, uv).rgb;",
  "  c += texture2D(src, uv + texel).rgb + texture2D(src, uv - texel).rgb;",
  "  c += texture2D(src, uv + texel * 2.0).rgb + texture2D(src, uv - texel * 2.0).rgb;",
  "  float l = dot(c, vec3(0.2126, 0.7152, 0.0722)) / 5.0 * TONE_SCALE;",
  "  gl_FragColor = vec4(l, l, l, 1.0);",
  "}",
].join("\n");
const FINISH_BLURMED_FRAG = FINISH_HEAD + [
  "uniform sampler2D src;",
  "uniform vec2 texel;",
  "void main(){",
  "  vec3 c = texture2D(src, uv).rgb;",
  "  c += texture2D(src, uv + texel * 2.0).rgb + texture2D(src, uv - texel * 2.0).rgb;",
  "  c += texture2D(src, uv + texel * 4.0).rgb + texture2D(src, uv - texel * 4.0).rgb;",
  "  c += texture2D(src, uv + texel * 6.0).rgb + texture2D(src, uv - texel * 6.0).rgb;",
  "  c += texture2D(src, uv + texel * 8.0).rgb + texture2D(src, uv - texel * 8.0).rgb;",
  "  float l = dot(c, vec3(0.2126, 0.7152, 0.0722)) / 9.0 * TONE_SCALE;",
  "  gl_FragColor = vec4(l, l, l, 1.0);",
  "}",
].join("\n");
const FINISH_COMP_FRAG = FINISH_HEAD + [
  "uniform sampler2D tone;",
  "uniform sampler2D blurLuma;",
  "uniform sampler2D blurMed;",
  "uniform sampler2D skinMask;",
  "uniform vec2 texel;",
  "uniform float microAmt;",
  "uniform float sharpAmt;",
  "uniform float clarityAmt;",
  "uniform float haloGate;",
  "uniform float edgeRef;",
  "uniform float sharpBase;",
  "uniform float sharpClamp;",
  "uniform float skinProtSharp;",
  "uniform float skinProtMicro;",
  "uniform float skinProtClar;",
  "float tl(vec2 p){ return dot(texture2D(tone, p).rgb * TONE_SCALE, vec3(0.2126, 0.7152, 0.0722)); }",
  "void main(){",
  "  vec4 t4 = texture2D(tone, uv);",
  "  vec3 tc = t4.rgb * TONE_SCALE;",
  "  vec3 c = min(tc, vec3(1.0));",
  "  float l = dot(tc, vec3(0.2126, 0.7152, 0.0722));",
  "  float b = texture2D(blurLuma, uv).r;",
  "  float bm = texture2D(blurMed, uv).r;",
  "  float skin = texture2D(skinMask, uv).r;",
  "  float gx = tl(uv + vec2(texel.x, 0.0)) - tl(uv - vec2(texel.x, 0.0));",
  "  float gy = tl(uv + vec2(0.0, texel.y)) - tl(uv - vec2(0.0, texel.y));",
  "  float edgeW = clamp(sqrt(gx * gx + gy * gy) / edgeRef, 0.0, 1.0);",
  "  float micro = (l - b) * microAmt * max(0.2, min(1.0, edgeW * 2.0)) * (1.0 - skin * skinProtMicro);",
  "  float clar = clamp((l - bm) * clarityAmt, -haloGate, haloGate) * (1.0 - skin * skinProtClar);",
  "  float ln = (tl(uv + vec2(texel.x, 0.0)) + tl(uv - vec2(texel.x, 0.0))",
  "            + tl(uv + vec2(0.0, texel.y)) + tl(uv - vec2(0.0, texel.y))) * 0.25;",
  "  float sharp = (l - ln) * sharpAmt * (sharpBase + (1.0 - sharpBase) * edgeW) * (1.0 - skin * skinProtSharp);",
  "  float gate = t4.a * 0.1;",
  "  if (abs(sharp) < gate) sharp = 0.0;",
  "  sharp = clamp(sharp, -sharpClamp, sharpClamp);",
  "  if (abs(micro) < gate * 0.5) micro = 0.0;",
  "  float delta = micro + sharp + clar;",
  // Detail is luma-only: chroma passes through untouched (true color).
  "  gl_FragColor = vec4(clamp(c + delta, 0.0, 1.0), 1.0);",
  "}",
].join("\n");

function finishCompile(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`Finish shader failed: ${gl.getShaderInfoLog(sh)}`);
  return sh;
}
function finishProgram(gl, fragSrc) {
  const prog = gl.createProgram();
  gl.attachShader(prog, finishCompile(gl, gl.VERTEX_SHADER, FINISH_VERT));
  gl.attachShader(prog, finishCompile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Finish link failed: ${gl.getProgramInfoLog(prog)}`);
  return prog;
}
function finishTexture(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
function finishTarget(gl, w, h) {
  const tex = finishTexture(gl, w, h);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Finish FBO incomplete");
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo };
}

function initFinishGL(width, height) {
  if (!window.WebGLRenderingContext) throw new Error("WebGL not supported");
  if (width * height > 3840 * 2160) throw new Error(`Capture ${width}x${height} exceeds the 4K WebGL finish budget; CPU path handles it`);
  if (!finishGL) {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL context creation failed");
    const progTone = finishProgram(gl, FINISH_TONE_FRAG);
    const progBlur = finishProgram(gl, FINISH_BLUR_FRAG);
    const progBlurMed = finishProgram(gl, FINISH_BLURMED_FRAG);
    const progComp = finishProgram(gl, FINISH_COMP_FRAG);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = (p, n) => gl.getUniformLocation(p, n);
    finishGL = {
      gl, canvas, maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      prog: { tone: progTone, blur: progBlur, blurMed: progBlurMed, comp: progComp },
      uni: {
        tone: { src: loc(progTone, "src"), gains: loc(progTone, "gains"), exposure: loc(progTone, "exposure"), knee: loc(progTone, "knee"), kneeKeep: loc(progTone, "kneeKeep"), contrast: loc(progTone, "contrast"), shadowTarget: loc(progTone, "shadowTarget"), shadowAmt: loc(progTone, "shadowAmt"), shadowEdge: loc(progTone, "shadowEdge"), position: gl.getAttribLocation(progTone, "position") },
        blur: { src: loc(progBlur, "src"), texel: loc(progBlur, "texel"), position: gl.getAttribLocation(progBlur, "position") },
        blurMed: { src: loc(progBlurMed, "src"), texel: loc(progBlurMed, "texel"), position: gl.getAttribLocation(progBlurMed, "position") },
        comp: { tone: loc(progComp, "tone"), blurLuma: loc(progComp, "blurLuma"), blurMed: loc(progComp, "blurMed"), skinMask: loc(progComp, "skinMask"), texel: loc(progComp, "texel"), microAmt: loc(progComp, "microAmt"), sharpAmt: loc(progComp, "sharpAmt"), clarityAmt: loc(progComp, "clarityAmt"), haloGate: loc(progComp, "haloGate"), edgeRef: loc(progComp, "edgeRef"), sharpBase: loc(progComp, "sharpBase"), sharpClamp: loc(progComp, "sharpClamp"), skinProtSharp: loc(progComp, "skinProtSharp"), skinProtMicro: loc(progComp, "skinProtMicro"), skinProtClar: loc(progComp, "skinProtClar"), position: gl.getAttribLocation(progComp, "position") },
      },
      quad, tex: {}, tgt: {}, w: 0, h: 0,
    };
  }
  const F = finishGL, gl = F.gl;
  if (width > F.maxTex || height > F.maxTex) throw new Error(`Capture ${width}x${height} exceeds MAX_TEXTURE_SIZE ${F.maxTex}`);
  if (F.w !== width || F.h !== height) {
    F.canvas.width = width; F.canvas.height = height;
    for (const k of Object.keys(F.tex)) gl.deleteTexture(F.tex[k]);
    for (const k of Object.keys(F.tgt)) gl.deleteFramebuffer(F.tgt[k].fbo);
    F.tex = { src: finishTexture(gl, width, height) };
    F.tgt = { tone: finishTarget(gl, width, height), blurA: finishTarget(gl, width, height), blurB: finishTarget(gl, width, height), blurMedA: finishTarget(gl, width, height), blurMedB: finishTarget(gl, width, height) };
    F.w = width; F.h = height;
  }
  return F;
}

function finishDraw(F, progKey, fbo, setup) {
  const gl = F.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, F.w, F.h);
  gl.useProgram(F.prog[progKey]);
  gl.bindBuffer(gl.ARRAY_BUFFER, F.quad);
  const pos = F.uni[progKey].position;
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
  setup();
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.disableVertexAttribArray(pos);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

async function finishPhotoWebGL(result) {
  const { width, height, data, params } = result;
  if (!params) throw new Error("WebGL finish params missing");
  const F = initFinishGL(width, height);
  const gl = F.gl, U = F.uni;
  gl.bindTexture(gl.TEXTURE_2D, F.tex.src);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  const tx = 1 / width, ty = 1 / height;
  // Skin mask texture (1/4 res, RGBA, LINEAR for free feathering). Uploaded
  // with FLIP_Y like the source so uv coordinates line up with the frame.
  const sm = params.skinMask && params.skinMask.data ? params.skinMask : { data: new Uint8Array([0]), width: 1, height: 1 };
  if (!F.tex.skin || F.skinW !== sm.width || F.skinH !== sm.height) {
    if (F.tex.skin) gl.deleteTexture(F.tex.skin);
    const st = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, st);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    F.tex.skin = st; F.skinW = sm.width; F.skinH = sm.height;
  }
  const smRgba = new Uint8Array(sm.width * sm.height * 4);
  for (let si = 0; si < sm.data.length; si += 1) { smRgba[si * 4] = sm.data[si]; smRgba[si * 4 + 3] = 255; }
  gl.bindTexture(gl.TEXTURE_2D, F.tex.skin);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sm.width, sm.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, smRgba);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  finishDraw(F, "tone", F.tgt.tone.fbo, () => {
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, F.tex.src);
    gl.uniform1i(U.tone.src, 0);
    gl.uniform3f(U.tone.gains, params.gains[0], params.gains[1], params.gains[2]);
    gl.uniform1f(U.tone.exposure, params.exposure);
    gl.uniform1f(U.tone.knee, params.knee);
    gl.uniform1f(U.tone.kneeKeep, params.kneeKeep);
    gl.uniform1f(U.tone.contrast, params.contrast);
    gl.uniform1f(U.tone.shadowTarget, params.shadowTarget);
    gl.uniform1f(U.tone.shadowAmt, params.shadowAmt);
    gl.uniform1f(U.tone.shadowEdge, params.shadowEdge);
  });
  finishDraw(F, "blur", F.tgt.blurA.fbo, () => {
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, F.tgt.tone.tex);
    gl.uniform1i(U.blur.src, 0);
    gl.uniform2f(U.blur.texel, tx, 0);
  });
  finishDraw(F, "blur", F.tgt.blurB.fbo, () => {
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, F.tgt.blurA.tex);
    gl.uniform1i(U.blur.src, 0);
    gl.uniform2f(U.blur.texel, 0, ty);
  });
  finishDraw(F, "blurMed", F.tgt.blurMedA.fbo, () => {
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, F.tgt.tone.tex);
    gl.uniform1i(U.blurMed.src, 0);
    gl.uniform2f(U.blurMed.texel, tx, 0);
  });
  finishDraw(F, "blurMed", F.tgt.blurMedB.fbo, () => {
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, F.tgt.blurMedA.tex);
    gl.uniform1i(U.blurMed.src, 0);
    gl.uniform2f(U.blurMed.texel, 0, ty);
  });
  finishDraw(F, "comp", null, () => {
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, F.tgt.tone.tex);
    gl.uniform1i(U.comp.tone, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, F.tgt.blurB.tex);
    gl.uniform1i(U.comp.blurLuma, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, F.tgt.blurMedB.tex);
    gl.uniform1i(U.comp.blurMed, 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, F.tex.skin);
    gl.uniform1i(U.comp.skinMask, 3);
    gl.uniform2f(U.comp.texel, tx, ty);
    gl.uniform1f(U.comp.microAmt, params.microAmt);
    gl.uniform1f(U.comp.sharpAmt, params.sharpAmt);
    gl.uniform1f(U.comp.clarityAmt, params.clarityAmt);
    gl.uniform1f(U.comp.haloGate, params.haloGate);
    gl.uniform1f(U.comp.edgeRef, params.edgeRef);
    gl.uniform1f(U.comp.sharpBase, params.sharpBase);
    gl.uniform1f(U.comp.sharpClamp, params.sharpClamp);
    gl.uniform1f(U.comp.skinProtSharp, params.skinProtSharp || 0);
    gl.uniform1f(U.comp.skinProtMicro, params.skinProtMicro || 0);
    gl.uniform1f(U.comp.skinProtClar, params.skinProtClar || 0);
  });
  gl.activeTexture(gl.TEXTURE0);
  const blob = await new Promise((resolve) => F.canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new Error("Canvas toBlob returned null");
  return blob;
}

async function cameraStart() {
  showError("");
  videoReady = false;
  bracketEvsCache = undefined; // re-probe exposure bracketing for the new stream
  captureButton.disabled = true;
  setStatus("Starting camera…");
  if (!window.isSecureContext) { showError("Open the HTTPS GitHub Pages address to use the camera."); setStatus("HTTPS required"); return; }
  if (!navigator.mediaDevices?.getUserMedia) { showError("This browser does not expose camera access."); setStatus("Camera unavailable"); return; }
  try {
    stream?.getTracks().forEach((track) => track.stop());
    const constraints = { video: { facingMode: { ideal: facingMode }, width: { ideal: STREAM_IDEAL_WIDTH }, height: { ideal: STREAM_IDEAL_HEIGHT }, frameRate: { ideal: 30, max: 60 } }, audio: false };
    try { stream = await navigator.mediaDevices.getUserMedia(constraints); }
    catch (error) { if (error.name !== "OverconstrainedError") throw error; stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
    video.srcObject = stream;
    await video.play(); await waitFrame();
    if (!video.videoWidth) throw new Error("No video frame was received");
    lockSensorAspect();
    videoReady = true;
    placeholder.classList.add("hidden"); captureButton.disabled = false;
    setStatus(facingMode === "environment" ? "Rear camera ready" : "Front camera ready");
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings?.() || {};
    video.classList.add("live-feed");
    video.classList.toggle("mirrored", facingMode === "user");
    fxCanvas.classList.toggle("mirrored", facingMode === "user");
    const caps = track.getCapabilities?.() || {};
    flashButton.disabled = !caps.torch;
    if (caps.zoom) { zoomRange.disabled = false; zoomRange.min = caps.zoom.min || 1; zoomRange.max = Math.min(caps.zoom.max || 1, 4); zoomRange.step = caps.zoom.step || 0.1; zoomRange.value = track.getSettings().zoom || caps.zoom.min || 1; zoomLabel.textContent = `${Number(zoomRange.value).toFixed(1)}×`; }
    if (!gl) initLiveShader();
    if (gl && !liveFrame) renderLiveFrame();
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop()); stream = null; showError(explain(error)); setStatus("Camera unavailable");
  }
}

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop()); stream = null; videoReady = false;
  cancelAnimationFrame(liveFrame);
  liveFrame = 0;
}

async function toggleFlash() {
  if (!stream) return;
  const track = stream.getVideoTracks()[0]; const on = track.getSettings().torch === true;
  try { await track.applyConstraints({ advanced: [{ torch: !on }] }); flashButton.setAttribute("aria-pressed", String(!on)); flashButton.classList.toggle("off", on); flashVal.textContent = !on ? "on" : "off"; }
  catch { showError("Flash is not available on this camera."); }
}

async function setZoom() {
  if (!stream) return;
  try { await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: Number(zoomRange.value) }] }); zoomLabel.textContent = `${Number(zoomRange.value).toFixed(1)}×`; } catch {}
}

function showFocus(event) {
  const rect = video.getBoundingClientRect(); const ring = $("focusRing");
  ring.style.left = `${event.clientX - rect.left}px`; ring.style.top = `${event.clientY - rect.top}px`;
  ring.classList.remove("hidden"); void ring.offsetWidth; ring.classList.add("focus-ring");
}

function captureFrame() {
  const sourceWidth = sensorWidth || video.videoWidth; const sourceHeight = sensorHeight || video.videoHeight;
  const longEdge = Math.max(sourceWidth, sourceHeight);
  const scale = Math.min(1, WORKING_MAX_EDGE / longEdge);
  const width = Math.max(1, Math.round(sourceWidth * scale)); const height = Math.max(1, Math.round(sourceHeight * scale));
  captureCanvas.width = width; captureCanvas.height = height;
  const context = captureCanvas.getContext("2d", { willReadFrequently: true });
  context.save();
  if (facingMode === "user") { context.translate(width, 0); context.scale(-1, 1); }
  context.drawImage(video, 0, 0, width, height); context.restore();
  return context.getImageData(0, 0, width, height);
}

/* Full-resolution hardware still (Chromium: ChromeOS / Android / desktop Chrome).
   ImageCapture.takePhoto() fires the physical sensor at its maximum still-image
   resolution (e.g. 12MP), bypassing the video pipeline entirely. Not implemented
   in Safari/Firefox — window.ImageCapture is undefined there, so this cleanly
   returns null and the caller falls back to the native video buffer. */
async function captureHardwareStill() {
  if (!window.ImageCapture) return null;
  try {
    const track = stream.getVideoTracks()[0];
    const imageCapture = new ImageCapture(track);
    const photoBlob = await imageCapture.takePhoto();
    const bitmap = await createImageBitmap(photoBlob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (facingMode === "user") { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch (error) {
    console.warn("ImageCapture.takePhoto() unavailable, falling back to video buffer:", error);
    return null;
  }
}

/* Multi-still burst: 5 takePhoto() frames ~300ms apart, merged with the
   existing registration. This gives the hardware-still path true temporal
   denoise at full sensor resolution (previously: single frame, zero
   temporal denoise). Per-shot refocus/re-exposure is acceptable for static
   scenes; any per-shot failure just yields fewer frames, and zero frames
   falls back to the video-buffer burst. */
const STILL_BURST_COUNT = 5, STILL_BURST_GAP_MS = 300, STILL_SHOT_TIMEOUT_MS = 2500;

/* Exposure bracketing: capture frames at different EVs and fuse the best-
   exposed parts of each (Mertens-style). Probed once per camera start;
   when unsupported we gracefully degrade to single-EV capture. */
const BRACKET_EVS = [-2, -1, 0, 1, 2];
const EV_SETTLE_MS = 300;
let bracketEvsCache; // undefined = unprobed
async function setExposureComp(ev) {
  const track = stream?.getVideoTracks()[0];
  try { await track.applyConstraints({ advanced: [{ exposureCompensation: ev }] }); return true; }
  catch (error) { console.warn("exposureCompensation rejected:", error.message); return false; }
}
async function probeBracketSupport() {
  if (bracketEvsCache !== undefined) return bracketEvsCache;
  bracketEvsCache = null;
  const track = stream?.getVideoTracks()[0];
  if (track?.applyConstraints) {
    const caps = track.getCapabilities?.() || {};
    const ec = caps.exposureCompensation;
    if (ec && isFinite(ec.min) && isFinite(ec.max)) {
      const step = ec.step || 0.5;
      const snap = (v) => Math.round(v / step) * step;
      const evs = BRACKET_EVS.map(snap).filter((v) => v >= ec.min && v <= ec.max);
      if (evs.length >= 2) { bracketEvsCache = evs; return evs; }
    }
    // Runtime probe: some devices accept the constraint without advertising it.
    try {
      await track.applyConstraints({ advanced: [{ exposureCompensation: -1 }] });
      await delay(150);
      const v = track.getSettings?.().exposureCompensation;
      await track.applyConstraints({ advanced: [{ exposureCompensation: 0 }] });
      if (typeof v === "number" && v < -0.5) bracketEvsCache = BRACKET_EVS;
    } catch (error) { /* unsupported */ }
  }
  return bracketEvsCache;
}
async function captureBracketedStills(bracketEvs) {
  // bracketEvs: e.g. [-2,-1,0,1,2] (snapped to device range) or null (legacy:
  // same-EV stills for temporal denoise). Always takes STILL_BURST_COUNT (5)
  // photos; when the device bracket range yields fewer EVs, pad with extra
  // base-exposure frames so EV~0 gets true temporal denoising.
  let evList;
  if (bracketEvs) {
    evList = [...bracketEvs];
    const baseEv = bracketEvs.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
    while (evList.length < STILL_BURST_COUNT) evList.splice(Math.ceil(evList.length / 2), 0, baseEv);
  } else {
    evList = new Array(STILL_BURST_COUNT).fill(0);
  }
  const frames = [], evs = [];
  try {
    for (let i = 0; i < evList.length; i += 1) {
      if (bracketEvs) { await setExposureComp(evList[i]); await delay(EV_SETTLE_MS); }
      else if (i > 0) await delay(STILL_BURST_GAP_MS);
      try {
        const frame = await Promise.race([
          captureHardwareStill(),
          delay(STILL_SHOT_TIMEOUT_MS).then(() => { throw new Error("takePhoto timeout"); }),
        ]);
        if (frame) { frames.push(frame); evs.push(bracketEvs ? evList[i] : 0); }
      } catch (error) { console.warn(`Hardware still ${i + 1} failed:`, error.message); break; }
    }
  } finally {
    if (bracketEvs) await setExposureComp(0); // always leave the preview at neutral exposure
  }
  return { frames, evs };
}
async function captureBracketedVideo(count, bracketEvs) {
  const frames = [], evs = [];
  const evList = bracketEvs || [0];
  const perEv = bracketEvs ? Math.max(1, Math.min(2, Math.round(count / evList.length))) : count;
  try {
    for (const ev of evList) {
      if (bracketEvs) { await setExposureComp(ev); await delay(EV_SETTLE_MS); }
      for (let i = 0; i < perEv; i += 1) {
        frames.push(captureFrame());
        evs.push(bracketEvs ? ev : 0);
        if (i < perEv - 1) await delay(45);
      }
    }
  } finally {
    if (bracketEvs) await setExposureComp(0);
  }
  return { frames, evs };
}
async function captureHardwareStills() {
  // Kept for compatibility; captureBurst now uses captureBracketedStills.
  const { frames } = await captureBracketedStills(null);
  return frames;
}

function processBurst(frames, evs, finish = "cpu") {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const handler = (event) => { if (event.data.id !== id) return; worker.removeEventListener("message", handler); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data); };
    worker.addEventListener("message", handler);
    // WebGL path: structured-clone the frames (no transfer) so the main thread
    // retains them for the CPU fallback if GL finishing fails.
    const transfer = finish === "cpu" ? frames.map((frame) => frame.data.buffer) : [];
    worker.postMessage({ id, frames, evs, mode, style: "pixel", finish }, transfer);
  });
}

function finishedImageToBlob(result) {
  captureCanvas.width = result.width; captureCanvas.height = result.height;
  captureCanvas.getContext("2d").putImageData(new ImageData(result.data, result.width, result.height), 0, 0);
  return new Promise((resolve) => captureCanvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
}

async function captureBurst(count, finish = "webgl") {
  const bracketEvs = await probeBracketSupport();
  // Option A: bracketed hardware stills at full sensor resolution — different
  // exposures per shot, fused in the worker (temporal denoise + HDR fusion).
  let frames = [], evs = [], hardwareStill = false;
  if (window.ImageCapture) {
    ({ frames, evs } = await captureBracketedStills(bracketEvs));
    hardwareStill = frames.length > 0;
  }
  // Option B: bracketed burst from the full native video buffer
  // (videoWidth/videoHeight — never the CSS preview size), merged at WORKING_MAX_EDGE.
  if (!frames.length) ({ frames, evs } = await captureBracketedVideo(count, bracketEvs));
  const result = await processBurst(frames, evs, finish);
  result.frameCount = frames.length;
  result.hardwareStill = hardwareStill;
  result.bracketed = !!bracketEvs && new Set(evs).size > 1;
  if (finish === "webgl") { result.frames = frames; result.evs = evs; } // retained for CPU fallback
  return result;
}

async function takePhoto() {
  if (!stream || !videoReady) return;
  if (timerSeconds) { for (let n = timerSeconds; n > 0; n -= 1) { countdown.textContent = n; countdown.hidden = false; await delay(1000); } countdown.hidden = true; }
  const count = mode === "night" ? Math.min(6, burstCount + 2) : mode === "portrait" ? Math.min(5, burstCount + 1) : burstCount;
  setStatus(`Capturing ${mode} photo…`);
  setStage("Capturing…"); showProc(true); fireFlash();
  captureButton.disabled = true;
  try {
    const result = await captureBurst(count, "webgl");
    let blob;
    if (result.pendingFinish) {
      try { blob = await finishPhotoWebGL(result); }
      catch (error) {
        console.warn("WebGL finishing failed, falling back to CPU:", error);
        blob = await finishedImageToBlob(await processBurst(result.frames, result.evs, "cpu"));
      }
    } else {
      blob = await finishedImageToBlob(result);
    }
    if (!blob) throw new Error("Photo encoding failed");
    originalImage = await createImageBitmap(blob); processedBlob = blob;
    if (galleryObjectUrl) URL.revokeObjectURL(galleryObjectUrl);
    galleryObjectUrl = URL.createObjectURL(blob);
    galleryThumb.src = galleryObjectUrl; galleryThumb.classList.remove("hidden"); galleryThumbButton.querySelector(".gallery-empty")?.classList.add("hidden");
    if (!result.hardwareStill) { if (result.elapsedMs > FRAME_BUDGET_MS) burstCount = Math.max(3, burstCount - 1); else if (burstCount < 6) burstCount += 1; }
    setStatus(result.hardwareStill ? `${result.frameCount} hardware stills merged` : result.elapsedMs > FRAME_BUDGET_MS ? "Thermal guard active" : "Photo ready offline");
    toast(`${result.width}×${result.height} · ${result.frameCount} frame${result.frameCount === 1 ? "" : "s"}${result.bracketed ? " · HDR" : ""} · ${result.elapsedMs} ms`);
  } catch (error) { showError(`Photo processing failed: ${error.message}`); setStatus("Processing unavailable"); }
  finally { captureButton.disabled = false; showProc(false); }
}

function openViewer() {
  if (!processedBlob) return;
  if (viewerObjectUrl) URL.revokeObjectURL(viewerObjectUrl);
  viewerObjectUrl = URL.createObjectURL(processedBlob);
  viewerImage.src = viewerObjectUrl;
  viewerOverlay.classList.remove("hidden");
}
function closeViewer() { viewerOverlay.classList.add("hidden"); }
function savePhoto() {
  if (!processedBlob) return;
  const url = URL.createObjectURL(processedBlob);
  const link = document.createElement("a");
  link.href = url; link.download = `lumen-camera-${Date.now()}.jpg`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Photo saved");
}
async function sharePhoto() {
  if (!processedBlob) return;
  const file = new File([processedBlob], `lumen-camera-${Date.now()}.jpg`, { type: "image/jpeg" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch { /* dismissed */ }
  }
  savePhoto();
}

startButton.onclick = cameraStart;
captureButton.onclick = takePhoto;
switchButton.onclick = () => { facingMode = facingMode === "environment" ? "user" : "environment"; cameraStart(); };
flashButton.onclick = toggleFlash;
zoomRange.oninput = setZoom;
video.onclick = showFocus;
gridButton.onclick = () => { const on = !gridOverlay.classList.toggle("hidden"); gridButton.setAttribute("aria-pressed", String(on)); gridButton.classList.toggle("off", !on); };
timerButton.onclick = () => { timerSeconds = timerSeconds === 0 ? 3 : timerSeconds === 3 ? 10 : 0; timerLabel.textContent = timerSeconds ? `${timerSeconds}s` : "Off"; timerButton.setAttribute("aria-pressed", String(Boolean(timerSeconds))); timerButton.classList.toggle("off", !timerSeconds); };
document.querySelectorAll(".mode").forEach((button) => button.onclick = () => { document.querySelectorAll(".mode").forEach((item) => { item.classList.remove("active"); item.setAttribute("aria-selected", "false"); }); button.classList.add("active"); button.setAttribute("aria-selected", "true"); mode = button.dataset.mode; setStatus(`${button.textContent} mode`); });
document.querySelectorAll(".zoom-shortcut").forEach((button) => button.onclick = () => { zoomRange.value = button.dataset.zoom; zoomRange.dispatchEvent(new Event("input")); document.querySelectorAll(".zoom-shortcut").forEach((item) => item.classList.toggle("active", item === button)); });
galleryThumbButton.onclick = openViewer;
viewerClose.onclick = closeViewer;
viewerSave.onclick = savePhoto;
viewerShare.onclick = sharePhoto;
video.addEventListener("resize", () => { if (videoReady && stream) lockSensorAspect(); });
window.addEventListener("beforeunload", stopCamera);
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
