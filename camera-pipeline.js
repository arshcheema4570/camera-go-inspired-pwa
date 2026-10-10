// Lumen Camera — pure native capture, plus an always-on background finishing
// filter (lumen-filter.js) applied to every capture before save. No worker,
// no engines, no UI controls for the filter: the viewfinder shows the raw
// camera feed. A capture is the camera's own still
// (ImageCapture.takePhoto() at full sensor resolution), finished silently
// with the Snapseed-style stack, then saved. Canvas frame-grab is the
// fallback where ImageCapture is unavailable.

const $ = (id) => document.getElementById(id);

const video = $("preview");
const captureCanvas = $("captureCanvas");
const startButton = $("startButton");
const captureButton = $("captureButton");
const switchButton = $("switchButton");
const flashButton = $("flashButton");
const placeholder = $("previewPlaceholder");
const errorMessage = $("errorMessage");
const screenFlash = $("screenFlash");
const toastEl = $("toast");
const procEl = $("processing");
const procStage = $("procStage");
const zoomSlider = $("zoomSlider");
const zoomLabel = $("zoomLabel");
const galleryThumb = $("galleryThumb");
const galleryThumbButton = $("galleryThumbButton");
const viewerOverlay = $("viewerOverlay");
const viewerImage = $("viewerImage");
const focusReticle = $("focusReticle");
const focusStatus = $("focusStatus");
let viewerObjectUrl = null;

let stream = null;
let facingMode = "environment";
let activeFacingMode = "environment";
let videoReady = false;
let processedBlob = null;
let flashEnabled = false;
let photoFlashAvailable = false;
let torchAvailable = false;
let wakeLock = null;
let startRequest = 0;
let focusManager = null;

// Fallback path (used where the browser has no ImageCapture, e.g. iPhone Safari):
// the most the platform gives a web page is the video track's own frame, so we
// keep every pixel of it and encode at maximum JPEG quality before the filter
// runs. No crop.
const JPEG_QUALITY = 1.0;

const toast = (msg, ms = 2800) => {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove("show"), ms);
};
const showError = (text) => {
  errorMessage.textContent = text;
  errorMessage.classList.toggle("hidden", !text);
};
const showProc = (on) => { procEl.hidden = !on; };
const setStage = (text) => { procStage.textContent = text; };
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
async function raiseScreenFlash() {
  screenFlash.classList.remove("fade");
  screenFlash.classList.add("active");
  // Keep a solid white frame on screen long enough for the display and the
  // front camera's auto-exposure to react before requesting the capture.
  await nextFrame();
  await nextFrame();
  await new Promise((resolve) => setTimeout(resolve, 180));
}
function lowerScreenFlash() {
  screenFlash.classList.remove("active");
  screenFlash.classList.add("fade");
  setTimeout(() => screenFlash.classList.remove("fade"), 240);
}
function waitForNextVideoFrame() {
  return new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback === "function") {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(finish, 400);
      video.requestVideoFrameCallback(finish);
    } else {
      requestAnimationFrame(() => setTimeout(resolve, 80));
    }
  });
}
async function requestScreenWakeLock() {
  if (!navigator.wakeLock?.request) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch { wakeLock = null; }
}
async function releaseScreenWakeLock() {
  try { await wakeLock?.release(); } catch { /* already released */ }
  wakeLock = null;
}
function explain(error) {
  if (error.name === "NotAllowedError") return "Camera permission was denied. Use the lock icon beside the address and set Camera to Allow.";
  if (error.name === "NotFoundError") return "No camera was found. Close other camera apps and try again.";
  if (error.name === "NotReadableError") return "The camera is busy in another app. Close it and try again.";
  return `Camera could not start: ${error.message || error.name}`;
}
function waitFrame() {
  return new Promise((resolve) => {
    if (video.videoWidth > 0 && video.readyState >= 1) { resolve(); return; }
    const finish = () => { video.removeEventListener("loadeddata", finish); resolve(); };
    video.addEventListener("loadeddata", finish, { once: true });
    setTimeout(finish, 3000);
  });
}

function supportsTorch(value) {
  return value === true || (Array.isArray(value) && value.includes(true));
}
async function getPhotoFillLightModes(track) {
  if (typeof window.ImageCapture !== "function") return [];
  try {
    const capture = new ImageCapture(track);
    const capabilities = await capture.getPhotoCapabilities();
    return Array.isArray(capabilities?.fillLightMode) ? capabilities.fillLightMode : [];
  } catch { return []; }
}

async function cameraStart() {
  const requestId = ++startRequest;
  showError("");
  videoReady = false;
  focusManager?.destroy();
  focusManager = null;
  captureButton.disabled = true;
  flashEnabled = false;
  photoFlashAvailable = false;
  torchAvailable = false;
  updateFlashUi();
  if (!window.isSecureContext) { showError("Open the HTTPS GitHub Pages address to use the camera."); return; }
  if (!navigator.mediaDevices?.getUserMedia) { showError("This browser does not expose camera access."); return; }
  try {
    const oldTrack = stream?.getVideoTracks()[0];
    if (oldTrack?.getCapabilities?.().torch && oldTrack.getSettings?.().torch) {
      try { await oldTrack.applyConstraints({ advanced: [{ torch: false }] }); } catch { /* stopping below is enough */ }
    }
    stream?.getTracks().forEach((track) => track.stop());
    const constraints = {
      video: { facingMode: { ideal: facingMode }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    };
    try { stream = await navigator.mediaDevices.getUserMedia(constraints); }
    catch (error) { if (error.name !== "OverconstrainedError") throw error; stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
    if (requestId !== startRequest) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    video.srcObject = stream;
    await video.play();
    await waitFrame();
    if (!video.videoWidth) throw new Error("No video frame was received");
    const track = stream.getVideoTracks()[0];
    zoomTrack = track;
    const caps = track.getCapabilities?.() || {};
    focusManager = new window.CameraFocusManager(track, video, focusReticle, focusStatus, (message) => {
      if (message) toast(message, 2200);
    });
    await focusManager.enableAutofocus();
    if (requestId !== startRequest) return;
    activeFacingMode = track.getSettings?.().facingMode || facingMode;
    video.classList.toggle("mirrored", activeFacingMode === "user");
    photoFlashAvailable = (await getPhotoFillLightModes(track)).includes("flash");
    if (requestId !== startRequest) return;
    torchAvailable = supportsTorch(caps.torch);
    videoReady = true;
    placeholder.classList.add("hidden");
    updateFlashUi();
    // Show the simple zoom slider only when the camera exposes zoom.
    if (caps.zoom) {
      zoomMin = Math.max(1, caps.zoom.min || 1);
      zoomMax = Math.min(8, caps.zoom.max || 4);
      zoomVal = 1;
      zoomSlider.min = zoomMin;
      zoomSlider.max = zoomMax;
      zoomSlider.value = zoomVal;
      zoomSlider.closest(".zoom-control").classList.remove("hidden");
    } else {
      zoomSlider.closest(".zoom-control").classList.add("hidden");
    }
    captureButton.disabled = false;
  } catch (error) {
    focusManager?.destroy();
    focusManager = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    zoomTrack = null;
    placeholder.classList.remove("hidden");
    captureButton.disabled = true;
    showError(explain(error));
  }
}

let zoomMin = 1, zoomMax = 4, zoomVal = 1;
let zoomTrack = null;
zoomSlider.addEventListener("input", () => applyZoom(Number(zoomSlider.value)));

function updateZoomUi() {
  zoomSlider.value = zoomVal;
  zoomLabel.textContent = `${zoomVal.toFixed(1)}×`;
}

function applyZoom(z) {
  zoomVal = Math.round(Math.min(zoomMax, Math.max(zoomMin, z)) * 10) / 10;
  updateZoomUi();
  if (zoomTrack?.readyState === "live") {
    zoomTrack.applyConstraints({ advanced: [{ zoom: zoomVal }] })
      .then(() => {
        // Read back the zoom the camera actually applied; if the device
        // silently ignored the request, show the true value, not the dial's.
        const actual = zoomTrack.getSettings?.().zoom;
        if (typeof actual === "number" && Math.abs(actual - zoomVal) > 0.05) {
          zoomVal = Math.round(actual * 10) / 10;
          positionZoomDial();
        }
      })
      .catch(() => {});
  }
}

function currentFlashMode() {
  if (activeFacingMode === "user") return "screen";
  if (photoFlashAvailable) return "photo";
  if (torchAvailable) return "torch";
  return "unavailable";
}
function updateFlashUi() {
  const mode = currentFlashMode();
  if (mode === "unavailable") flashEnabled = false;
  const name = { screen: "Screen flash", photo: "Photo flash", torch: "Torch" }[mode];
  flashButton.disabled = !stream || !videoReady || mode === "unavailable";
  flashButton.setAttribute("aria-checked", String(flashEnabled));
  const state = flashEnabled ? "on" : "off";
  const description = mode === "screen"
    ? `${name} ${state}; used during capture`
    : mode === "photo"
      ? `${name} ${state}; requested from the camera during capture`
      : mode === "torch"
        ? `Torch ${state}; continuous light, not a synchronized photo flash`
        : "Rear flash unavailable in this browser";
  flashButton.setAttribute("aria-label", description);
  flashButton.title = description;
  flashButton.dataset.mode = mode;
  flashButton.querySelector(".flash-toggle-label").textContent =
    mode === "unavailable" ? "N/A" : `${mode === "screen" ? "Screen" : mode === "photo" ? "Flash" : "Torch"} ${state === "on" ? "On" : "Off"}`;
}

function stopCamera() {
  focusManager?.destroy();
  focusManager = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  videoReady = false;
}

const proButton = $("proButton");
let proFilter = false;
try { proFilter = localStorage.getItem("lumen-pro-filter") === "1"; } catch { /* storage unavailable */ }
function updateProUi() {
  proButton.setAttribute("aria-checked", String(proFilter));
  const label = `Pro filter ${proFilter ? "on" : "off"}`;
  proButton.setAttribute("aria-label", label);
  proButton.title = label;
}
function togglePro() {
  proFilter = !proFilter;
  try { localStorage.setItem("lumen-pro-filter", proFilter ? "1" : "0"); } catch { /* storage unavailable */ }
  updateProUi();
  toast(proFilter ? "Pro filter on" : "Standard filter", 1600);
}
updateProUi();

async function toggleFlash() {
  const mode = currentFlashMode();
  if (!stream || !videoReady || flashButton.disabled || mode === "unavailable") return;
  const nextState = !flashEnabled;
  try {
    if (mode === "torch") await setTorch(nextState);
    flashEnabled = nextState;
    updateFlashUi();
    const message = mode === "screen"
      ? `Screen flash ${nextState ? "on for the next capture" : "off"}`
      : mode === "photo"
        ? `Photo flash ${nextState ? "on" : "off"}`
        : `Continuous torch ${nextState ? "on" : "off"}`;
    toast(message, 2200);
  } catch {
    flashEnabled = false;
    updateFlashUi();
    showError("The camera torch is not available on this camera.");
  }
}

async function setTorch(on) {
  if (!stream || !torchAvailable) throw new Error("Torch unavailable");
  const track = stream.getVideoTracks()[0];
  await track.applyConstraints({ advanced: [{ torch: on }] });
}

async function takePhoto() {
  if (!stream || !videoReady) return;
  captureButton.disabled = true;
  setStage("Capturing…");
  showProc(true);
  const track = stream.getVideoTracks()[0];
  const currentFacing = track.getSettings?.().facingMode || activeFacingMode || facingMode;
  const mode = currentFacing === "user" ? "screen" : photoFlashAvailable ? "photo" : torchAvailable ? "torch" : "unavailable";
  const useScreenFlash = flashEnabled && mode === "screen";
  const usePhotoFlash = flashEnabled && mode === "photo";
  let imageCapture = null;
  try { if (window.ImageCapture) imageCapture = new ImageCapture(track); } catch { imageCapture = null; }
  let screenFlashRaised = false;
  let captureWarning = "";
  try {
    if (useScreenFlash) {
      await requestScreenWakeLock();
      screenFlashRaised = true;
      await raiseScreenFlash();
    }
    if (usePhotoFlash && !imageCapture) {
      captureWarning = "Still-photo flash is unavailable; this photo may be unlit.";
    }
    let blob = null;
    if (imageCapture) {
      try {
        blob = usePhotoFlash
          ? await imageCapture.takePhoto({ fillLightMode: "flash" })
          : await imageCapture.takePhoto();
      } catch {
        if (usePhotoFlash) captureWarning = "The camera rejected hardware flash; this photo may be unlit.";
        blob = null;
      }
    }
    if (!blob) {
      // Fallback: grab the current viewfinder frame (video resolution).
      if (useScreenFlash) await waitForNextVideoFrame();
      captureCanvas.width = video.videoWidth;
      captureCanvas.height = video.videoHeight;
      const ctx = captureCanvas.getContext("2d");
      if (currentFacing === "user") { ctx.translate(captureCanvas.width, 0); ctx.scale(-1, 1); }
      ctx.drawImage(video, 0, 0);
      blob = await new Promise((resolve) => captureCanvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    }
    if (!blob) throw new Error("Photo encoding failed");
    // The display flash should end as soon as the sensor exposure is done,
    // not remain white while the slower image-finishing filter runs.
    if (screenFlashRaised) {
      lowerScreenFlash();
      screenFlashRaised = false;
      await releaseScreenWakeLock();
    }
    // Always-on background finishing filter (Snapseed-style stack).
    // Runs silently here; the viewfinder and controls are untouched.
    // Any failure falls back to the camera's own still.
    setStage(proFilter ? "Applying pro filter…" : "Applying filter…");
    try {
      const filtered = await window.LumenFilter?.applyFilter(blob, proFilter ? "pro" : "standard");
      if (filtered) blob = filtered;
    } catch { /* keep the original capture */ }
    processedBlob = blob;
    updateGalleryThumb(blob);
    savePhoto(blob);
    if (captureWarning) toast(captureWarning, 4200);
  } catch (error) {
    showError(`Capture failed: ${error.message || error.name}`);
  } finally {
    if (screenFlashRaised) lowerScreenFlash();
    if (useScreenFlash) await releaseScreenWakeLock();
    captureButton.disabled = !videoReady;
    showProc(false);
  }
}

function savePhoto(blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `lumen-camera-${Date.now()}.jpg`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Photo saved");
}

function updateGalleryThumb(blob) {
  if (viewerObjectUrl) URL.revokeObjectURL(viewerObjectUrl);
  viewerObjectUrl = URL.createObjectURL(blob);
  galleryThumb.src = viewerObjectUrl;
  galleryThumb.classList.remove("hidden");
  galleryThumbButton.querySelector(".gallery-empty")?.classList.add("hidden");
}

function openViewer() {
  if (!viewerObjectUrl) { toast("No photos yet"); return; }
  viewerImage.src = viewerObjectUrl;
  viewerOverlay.classList.remove("hidden");
}

function closeViewer() { viewerOverlay.classList.add("hidden"); }

startButton.onclick = cameraStart;
captureButton.onclick = takePhoto;
switchButton.onclick = () => { facingMode = facingMode === "environment" ? "user" : "environment"; cameraStart(); };
flashButton.onclick = toggleFlash;
proButton.onclick = togglePro;
galleryThumbButton.onclick = openViewer;
viewerOverlay.onclick = closeViewer;
window.addEventListener("beforeunload", stopCamera);
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
