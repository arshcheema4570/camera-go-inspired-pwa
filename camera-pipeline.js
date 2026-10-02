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
const flashVal = $("flashVal");
const placeholder = $("previewPlaceholder");
const errorMessage = $("errorMessage");
const flashZap = $("flashZap");
const toastEl = $("toast");
const procEl = $("processing");
const procStage = $("procStage");
const focusRing = $("focusRing");
const zoomDial = $("zoomDial");
const zoomStrip = $("zoomStrip");
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
    const caps = track.getCapabilities?.() || {};
    flashButton.disabled = !caps.torch;
    // Rotary zoom dial: device range if exposed, otherwise hidden.
    if (caps.zoom) {
      zoomMin = Math.max(1, caps.zoom.min || 1);
      zoomMax = Math.min(8, caps.zoom.max || 4);
      zoomVal = 1;
      buildZoomDial();
      zoomDial.closest(".zoomdial-wrap").classList.remove("hidden");
    } else {
      zoomDial.closest(".zoomdial-wrap").classList.add("hidden");
    }
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    showError(explain(error));
  }
}

// ---------- rotary zoom dial ----------
// A ticked strip you drag like a knob. 140px of drag = 1x. The strip moves
// with the finger; the mint line marks the current value.
const PX_PER_ZOOM = 140;
let zoomMin = 1, zoomMax = 4, zoomVal = 1;
let zoomTrack = null;
let dialDragging = false, dialStartX = 0, dialStartZoom = 1;

function buildZoomDial() {
  zoomTrack = stream?.getVideoTracks()[0] || null;
  const dialW = zoomDial.clientWidth || 280;
  zoomStrip.innerHTML = "";
  const totalW = (zoomMax - zoomMin) * PX_PER_ZOOM + dialW;
  zoomStrip.style.width = `${totalW}px`;
  // Phase the minor ticks so they line up under the integer majors.
  zoomStrip.style.backgroundPosition = `${dialW / 2}px 0`;
  for (let z = Math.ceil(zoomMin); z <= Math.floor(zoomMax); z++) {
    const tick = document.createElement("div");
    tick.className = "major-tick";
    tick.style.left = `${dialW / 2 + (z - zoomMin) * PX_PER_ZOOM}px`;
    zoomStrip.appendChild(tick);
  }
  positionZoomDial();
}

function positionZoomDial() {
  const dialW = zoomDial.clientWidth || 280;
  const x = dialW / 2 - (zoomVal - zoomMin) * PX_PER_ZOOM;
  zoomStrip.style.transform = `translateX(${x}px)`;
  zoomLabel.textContent = `${zoomVal.toFixed(1)}×`;
  zoomDial.setAttribute("aria-valuenow", zoomVal.toFixed(1));
  zoomDial.setAttribute("aria-valuetext", `${zoomVal.toFixed(1)} times zoom`);
}

function applyZoom(z) {
  zoomVal = Math.round(Math.min(zoomMax, Math.max(zoomMin, z)) * 10) / 10;
  positionZoomDial();
  if (zoomTrack?.readyState === "live") {
    zoomTrack.applyConstraints({ advanced: [{ zoom: zoomVal }] }).catch(() => {});
  }
}

zoomDial.addEventListener("pointerdown", (event) => {
  dialDragging = true;
  dialStartX = event.clientX;
  dialStartZoom = zoomVal;
  zoomDial.setPointerCapture(event.pointerId);
});
zoomDial.addEventListener("pointermove", (event) => {
  if (!dialDragging) return;
  applyZoom(dialStartZoom - (event.clientX - dialStartX) / PX_PER_ZOOM);
});
const endDialDrag = () => { dialDragging = false; };
zoomDial.addEventListener("pointerup", endDialDrag);
zoomDial.addEventListener("pointercancel", endDialDrag);
zoomDial.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft" || event.key === "ArrowDown") { applyZoom(zoomVal - 0.1); event.preventDefault(); }
  if (event.key === "ArrowRight" || event.key === "ArrowUp") { applyZoom(zoomVal + 0.1); event.preventDefault(); }
});
let zoomRebuildT = 0;
window.addEventListener("resize", () => {
  clearTimeout(zoomRebuildT);
  zoomRebuildT = setTimeout(() => { if (zoomTrack) buildZoomDial(); }, 200);
});

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  videoReady = false;
}

async function toggleFlash() {
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  const on = track.getSettings().torch === true;
  try {
    await track.applyConstraints({ advanced: [{ torch: !on }] });
    flashButton.setAttribute("aria-pressed", String(!on));
    flashButton.classList.toggle("off", on);
    flashVal.textContent = !on ? "on" : "off";
  } catch { showError("Flash is not available on this camera."); }
}

async function showFocus(event) {
  if (!stream) return;
  const rect = video.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  focusRing.style.left = `${event.clientX - rect.left}px`;
  focusRing.style.top = `${event.clientY - rect.top}px`;
  focusRing.classList.remove("hidden");
  setTimeout(() => focusRing.classList.add("hidden"), 900);
  try {
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.() || {};
    if (caps.focusMode?.includes("single-shot")) {
      await track.applyConstraints({ advanced: [{ focusMode: "single-shot", pointsOfInterest: [{ x, y }] }] });
    }
  } catch { /* focus not supported — ring is feedback only */ }
}

async function takePhoto() {
  if (!stream || !videoReady) return;
  captureButton.disabled = true;
  setStage("Capturing…");
  showProc(true);
  fireFlash();
  try {
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
video.onclick = showFocus;
window.addEventListener("beforeunload", stopCamera);
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
