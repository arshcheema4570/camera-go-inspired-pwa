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
const styleButton = $("styleButton");
const styleVal = $("styleVal");
let viewerObjectUrl = null;
let photoStyle = localStorage.getItem("lumen.photoStyle") === "pixel" ? "pixel" : "iphone";

const MAX_WIDTH = 1280;
const MAX_HEIGHT = 720;
const FRAME_BUDGET_MS = 33;
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

async function cameraStart() {
  showError("");
  videoReady = false;
  captureButton.disabled = true;
  setStatus("Starting camera…");
  if (!window.isSecureContext) { showError("Open the HTTPS GitHub Pages address to use the camera."); setStatus("HTTPS required"); return; }
  if (!navigator.mediaDevices?.getUserMedia) { showError("This browser does not expose camera access."); setStatus("Camera unavailable"); return; }
  try {
    stream?.getTracks().forEach((track) => track.stop());
    const constraints = { video: { facingMode: { ideal: facingMode }, width: { ideal: MAX_WIDTH, max: MAX_WIDTH }, height: { ideal: MAX_HEIGHT, max: MAX_HEIGHT }, frameRate: { ideal: 30, max: 60 } }, audio: false };
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
  const scale = Math.min(1, MAX_WIDTH / sourceWidth, MAX_HEIGHT / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale)); const height = Math.max(1, Math.round(sourceHeight * scale));
  captureCanvas.width = width; captureCanvas.height = height;
  const context = captureCanvas.getContext("2d", { willReadFrequently: true });
  context.save();
  if (facingMode === "user") { context.translate(width, 0); context.scale(-1, 1); }
  context.drawImage(video, 0, 0, width, height); context.restore();
  return context.getImageData(0, 0, width, height);
}

function processBurst(frames) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const handler = (event) => { if (event.data.id !== id) return; worker.removeEventListener("message", handler); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data); };
    worker.addEventListener("message", handler);
    worker.postMessage({ id, frames, mode, style: photoStyle }, frames.map((frame) => frame.data.buffer));
  });
}

async function captureBurst(count) {
  const frames = [];
  for (let index = 0; index < count; index += 1) { frames.push(captureFrame()); if (index < count - 1) await delay(45); }
  return processBurst(frames);
}

async function takePhoto() {
  if (!stream || !videoReady) return;
  if (timerSeconds) { for (let n = timerSeconds; n > 0; n -= 1) { countdown.textContent = n; countdown.hidden = false; await delay(1000); } countdown.hidden = true; }
  const count = mode === "night" ? Math.min(6, burstCount + 2) : mode === "portrait" ? Math.min(5, burstCount + 1) : burstCount;
  setStatus(`Capturing ${count}-frame ${mode} burst…`);
  setStage("Capturing…"); showProc(true); fireFlash();
  captureButton.disabled = true;
  try {
    const result = await captureBurst(count);
    captureCanvas.width = result.width; captureCanvas.height = result.height;
    captureCanvas.getContext("2d").putImageData(new ImageData(result.data, result.width, result.height), 0, 0);
    const blob = await new Promise((resolve) => captureCanvas.toBlob(resolve, "image/jpeg", 0.94));
    originalImage = await createImageBitmap(blob); processedBlob = blob;
    if (galleryObjectUrl) URL.revokeObjectURL(galleryObjectUrl);
    galleryObjectUrl = URL.createObjectURL(blob);
    galleryThumb.src = galleryObjectUrl; galleryThumb.classList.remove("hidden"); galleryThumbButton.querySelector(".gallery-empty")?.classList.add("hidden");
    if (result.elapsedMs > FRAME_BUDGET_MS) burstCount = Math.max(3, burstCount - 1); else if (burstCount < 6) burstCount += 1;
    setStatus(result.elapsedMs > FRAME_BUDGET_MS ? "Thermal guard active" : "Photo ready offline");
    toast(`Processed locally in ${result.elapsedMs} ms`);
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
styleVal.textContent = photoStyle === "pixel" ? "Pixel" : "iPhone";
styleButton.onclick = () => { photoStyle = photoStyle === "pixel" ? "iphone" : "pixel"; localStorage.setItem("lumen.photoStyle", photoStyle); styleVal.textContent = photoStyle === "pixel" ? "Pixel" : "iPhone"; setStatus(`${styleVal.textContent} look`); };
document.querySelectorAll(".mode").forEach((button) => button.onclick = () => { document.querySelectorAll(".mode").forEach((item) => { item.classList.remove("active"); item.setAttribute("aria-selected", "false"); }); button.classList.add("active"); button.setAttribute("aria-selected", "true"); mode = button.dataset.mode; setStatus(`${button.textContent} mode`); });
document.querySelectorAll(".zoom-shortcut").forEach((button) => button.onclick = () => { zoomRange.value = button.dataset.zoom; zoomRange.dispatchEvent(new Event("input")); document.querySelectorAll(".zoom-shortcut").forEach((item) => item.classList.toggle("active", item === button)); });
galleryThumbButton.onclick = openViewer;
viewerClose.onclick = closeViewer;
viewerSave.onclick = savePhoto;
viewerShare.onclick = sharePhoto;
video.addEventListener("resize", () => { if (videoReady && stream) lockSensorAspect(); });
window.addEventListener("beforeunload", stopCamera);
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
