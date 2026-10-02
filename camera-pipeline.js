// Lumen Camera — pure native capture. No pipeline, no worker, no engines, no filters.
// The viewfinder shows the raw camera feed. A capture is the camera's own still
// (ImageCapture.takePhoto() at full sensor resolution), saved exactly as produced.
// Canvas frame-grab is the fallback where ImageCapture is unavailable.

const $ = (id) => document.getElementById(id);

const video = $("preview");
const captureCanvas = $("captureCanvas");
const startButton = $("startButton");
const captureButton = $("captureButton");
const switchButton = $("switchButton");
const flashButton = $("flashButton");
const placeholder = $("previewPlaceholder");
const errorMessage = $("errorMessage");
const flashZap = $("flashZap");
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
let videoReady = false;
let processedBlob = null;
let flashEnabled = false;

const JPEG_QUALITY = 0.95;

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
const fireFlash = () => {
  flashZap.classList.remove("fire");
  void flashZap.offsetWidth;
  flashZap.classList.add("fire");
};
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
  showError("");
  videoReady = false;
  captureButton.disabled = true;
  if (!window.isSecureContext) { showError("Open the HTTPS GitHub Pages address to use the camera."); return; }
  if (!navigator.mediaDevices?.getUserMedia) { showError("This browser does not expose camera access."); return; }
  try {
    stream?.getTracks().forEach((track) => track.stop());
    const constraints = {
      video: { facingMode: { ideal: facingMode }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    };
    try { stream = await navigator.mediaDevices.getUserMedia(constraints); }
    catch (error) { if (error.name !== "OverconstrainedError") throw error; stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
    video.srcObject = stream;
    await video.play();
    await waitFrame();
    if (!video.videoWidth) throw new Error("No video frame was received");
    videoReady = true;
    video.classList.toggle("mirrored", facingMode === "user");
    placeholder.classList.add("hidden");
    captureButton.disabled = false;
    const track = stream.getVideoTracks()[0];
    zoomTrack = track;
    const caps = track.getCapabilities?.() || {};
    // Rear cameras use the real torch. Front cameras use the screen as flash.
    flashButton.disabled = !caps.torch && facingMode !== "user";
    flashEnabled = false;
    flashButton.setAttribute("aria-pressed", "false");
    flashButton.setAttribute("aria-label", facingMode === "user" ? "Screen flash off" : "Flashlight off");
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
    zoomTrack.applyConstraints({ advanced: [{ zoom: zoomVal }] }).catch(() => {});
  }
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
    if (facingMode !== "user") await setTorch(nextState);
    flashEnabled = nextState;
    flashButton.setAttribute("aria-pressed", String(flashEnabled));
    flashButton.setAttribute("aria-label", facingMode === "user"
      ? (flashEnabled ? "Screen flash on" : "Screen flash off")
      : (flashEnabled ? "Flashlight on" : "Flashlight off"));
    flashButton.classList.toggle("off", !flashEnabled);
    toast(facingMode === "user"
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
  const useScreenFlash = facingMode === "user" && flashEnabled;
  try {
    if (useScreenFlash) {
      fireFlash();
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    let blob = null;
    if (window.ImageCapture) {
      try { blob = await new ImageCapture(stream.getVideoTracks()[0]).takePhoto(); }
      catch { blob = null; }
    }
    if (!blob) {
      // Fallback: grab the current viewfinder frame (video resolution).
      captureCanvas.width = video.videoWidth;
      captureCanvas.height = video.videoHeight;
      const ctx = captureCanvas.getContext("2d");
      if (facingMode === "user") { ctx.translate(captureCanvas.width, 0); ctx.scale(-1, 1); }
      ctx.drawImage(video, 0, 0);
      blob = await new Promise((resolve) => captureCanvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    }
    if (!blob) throw new Error("Photo encoding failed");
    processedBlob = blob;
    updateGalleryThumb(blob);
    savePhoto(blob);
  } catch (error) {
    showError(`Capture failed: ${error.message || error.name}`);
  } finally {
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
