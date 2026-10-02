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
let viewerObjectUrl = null;

let stream = null;
let facingMode = "environment";
let activeFacingMode = "environment";
let videoReady = false;
let processedBlob = null;
let flashEnabled = false;
let wakeLock = null;
let startRequest = 0;

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
const fireScreenFlash = () => {
  screenFlash.classList.remove("fire");
  void screenFlash.offsetWidth;
  screenFlash.classList.add("fire");
};
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

async function cameraStart() {
  const requestId = ++startRequest;
  showError("");
  videoReady = false;
  captureButton.disabled = true;
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
    videoReady = true;
    placeholder.classList.add("hidden");
    captureButton.disabled = false;
    const track = stream.getVideoTracks()[0];
    zoomTrack = track;
    const caps = track.getCapabilities?.() || {};
    activeFacingMode = track.getSettings?.().facingMode || facingMode;
    video.classList.toggle("mirrored", activeFacingMode === "user");
    updateFlashUi(caps);
    if (flashEnabled && activeFacingMode === "environment" && caps.torch) {
      try { await setTorch(true); } catch { showError("The flashlight is not available on this camera."); }
    }
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
  } catch (error) {
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

function updateFlashUi(caps = {}) {
  const isFront = activeFacingMode === "user";
  const usesScreen = isFront || !caps.torch;
  flashButton.disabled = false;
  flashButton.setAttribute("aria-checked", String(flashEnabled));
  flashButton.setAttribute("aria-label", usesScreen
    ? `Screen flash ${flashEnabled ? "on" : "off"}`
    : `Flashlight ${flashEnabled ? "on" : "off"}`);
  flashButton.title = usesScreen
    ? `Screen flash ${flashEnabled ? "on" : "off"}`
    : `Flashlight ${flashEnabled ? "on" : "off"}`;
  flashButton.querySelector(".flash-toggle-label").textContent = flashEnabled ? "On" : "Off";
}

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  videoReady = false;
}

async function toggleFlash() {
  if (!stream || flashButton.disabled) return;
  const nextState = !flashEnabled;
  try {
    const caps = stream.getVideoTracks()[0].getCapabilities?.() || {};
    const usesScreen = activeFacingMode === "user" || !caps.torch;
    if (!usesScreen) await setTorch(nextState);
    flashEnabled = nextState;
    updateFlashUi(caps);
    toast(usesScreen
      ? (flashEnabled ? "Screen flash on" : "Screen flash off")
      : (flashEnabled ? "Flashlight on" : "Flashlight off"), 1800);
  } catch {
    showError("The flashlight is not available on this camera.");
  }
}

async function setTorch(on) {
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  await track.applyConstraints({ advanced: [{ torch: on }] });
}

async function takePhoto() {
  if (!stream || !videoReady) return;
  captureButton.disabled = true;
  setStage("Capturing…");
  showProc(true);
  const track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities?.() || {};
  const currentFacing = track.getSettings?.().facingMode || activeFacingMode || facingMode;
  const useScreenFlash = flashEnabled && (currentFacing === "user" || !caps.torch);
  let imageCapture = null;
  try { if (window.ImageCapture) imageCapture = new ImageCapture(track); } catch { imageCapture = null; }
  let torchRaisedForCapture = false;
  let imageFlashConfigured = false;
  try {
    if (useScreenFlash) {
      await requestScreenWakeLock();
      fireScreenFlash();
      await new Promise((resolve) => setTimeout(resolve, 150));
    } else if (flashEnabled && currentFacing === "environment" && caps.torch) {
      // Prefer a hardware flash mode when the browser exposes it.
      if (!track.getSettings?.().torch && imageCapture?.setOptions) {
        try {
          await imageCapture.setOptions({ fillLightMode: "flash" });
          imageFlashConfigured = true;
        } catch { /* use torch fallback */ }
      }
      if (!track.getSettings?.().torch && !imageFlashConfigured) {
        await setTorch(true);
        torchRaisedForCapture = true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    let blob = null;
    if (imageCapture) {
      try { blob = await imageCapture.takePhoto(); }
      catch { blob = null; }
    }
    if (!blob) {
      // Fallback: grab the current viewfinder frame (video resolution).
      captureCanvas.width = video.videoWidth;
      captureCanvas.height = video.videoHeight;
      const ctx = captureCanvas.getContext("2d");
      if (currentFacing === "user") { ctx.translate(captureCanvas.width, 0); ctx.scale(-1, 1); }
      ctx.drawImage(video, 0, 0);
      blob = await new Promise((resolve) => captureCanvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    }
    if (!blob) throw new Error("Photo encoding failed");
    // Always-on background finishing filter (Snapseed-style stack).
    // Runs silently here; the viewfinder and controls are untouched.
    // Any failure falls back to the camera's own still.
    setStage("Applying filter…");
    try {
      const filtered = await window.LumenFilter?.applyFilter(blob);
      if (filtered) blob = filtered;
    } catch { /* keep the original capture */ }
    processedBlob = blob;
    updateGalleryThumb(blob);
    savePhoto(blob);
  } catch (error) {
    showError(`Capture failed: ${error.message || error.name}`);
  } finally {
    if (torchRaisedForCapture) {
      try { await setTorch(false); } catch { /* camera may have stopped */ }
    }
    if (useScreenFlash) await releaseScreenWakeLock();
    captureButton.disabled = false;
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
galleryThumbButton.onclick = openViewer;
viewerOverlay.onclick = closeViewer;
window.addEventListener("beforeunload", stopCamera);
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
