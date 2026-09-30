const $ = (id) => document.getElementById(id);
const video = $("preview");
const canvas = $("captureCanvas");
const startButton = $("startButton");
const captureButton = $("captureButton");
const switchButton = $("switchButton");
const torchButton = $("torchButton");
const timerButton = $("timerButton");
const timerLabel = $("timerLabel");
const gridButton = $("gridButton");
const gridOverlay = $("gridOverlay");
const placeholder = $("previewPlaceholder");
const statusPill = $("statusPill");
const errorMessage = $("errorMessage");
const countdown = $("countdown");
const gallery = $("gallery");
const clearButton = $("clearButton");
const installButton = $("installButton");

let stream = null;
let facingMode = "environment";
let timerSeconds = 0;
let deferredInstall = null;
let videoReady = false;
const DB_NAME = "simple-camera";
const STORE = "photos";

const idb = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const setStatus = (text) => { statusPill.textContent = text; };
const showError = (text) => {
  errorMessage.textContent = text;
  errorMessage.classList.toggle("hidden", !text);
};

function waitForVideoFrame() {
  return new Promise((resolve) => {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
      resolve();
      return;
    }
    video.addEventListener("loadeddata", resolve, { once: true });
    setTimeout(resolve, 4000);
  });
}

function cameraError(error) {
  if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
    return "Camera permission was denied. In Chrome, open the lock icon beside the address, set Camera to Allow, then reload this page.";
  }
  if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
    return "ChromeOS could not find a camera. Check the Camera app, privacy switch, and Settings > Privacy and security > Camera.";
  }
  if (error.name === "NotReadableError" || error.name === "TrackStartError") {
    return "The camera is busy in another app. Close the Camera app or video-call tabs, then try again.";
  }
  if (error.name === "SecurityError") {
    return "Camera access was blocked by the browser. Use this HTTPS GitHub Pages address, not a downloaded file.";
  }
  return `Camera could not start: ${error.message || error.name || "unknown error"}`;
}

async function getCameraStream() {
  const preferred = {
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 1920 },
      height: { ideal: 1080 }
    },
    audio: false
  };
  try {
    return await navigator.mediaDevices.getUserMedia(preferred);
  } catch (error) {
    if (["OverconstrainedError", "ConstraintNotSatisfiedError"].includes(error.name)) {
      return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    throw error;
  }
}

async function cameraStart() {
  showError("");
  videoReady = false;
  captureButton.disabled = true;
  setStatus("Starting camera…");
  if (!window.isSecureContext) {
    showError("Camera access requires HTTPS. Open the published GitHub Pages address, not a local file.");
    setStatus("Secure connection required");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showError("This browser does not expose camera access. Update ChromeOS or use the built-in Camera app.");
    setStatus("Camera unavailable");
    return;
  }
  try {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = await getCameraStream();
    video.srcObject = stream;
    await video.play();
    await waitForVideoFrame();
    if (!video.videoWidth || !video.videoHeight) throw new Error("The camera opened but did not provide a video frame.");
    videoReady = true;
    placeholder.classList.add("hidden");
    captureButton.disabled = false;
    setStatus(facingMode === "environment" ? "Rear camera ready" : "Front camera ready");
    const track = stream.getVideoTracks()[0];
    const capabilities = track.getCapabilities?.() || {};
    torchButton.disabled = !capabilities.torch;
    video.classList.toggle("mirrored", facingMode === "user");
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    showError(cameraError(error));
    setStatus("Camera unavailable");
  }
}

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  videoReady = false;
  captureButton.disabled = true;
  setStatus("Camera off");
}

async function toggleTorch() {
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  const active = track.getSettings().torch === true;
  try {
    await track.applyConstraints({ advanced: [{ torch: !active }] });
    torchButton.setAttribute("aria-pressed", String(!active));
    torchButton.textContent = !active ? "Flash on" : "Flash";
  } catch {
    showError("Flash is not available on this camera.");
  }
}

function showFocus(event) {
  const bounds = video.getBoundingClientRect();
  const ring = $("focusRing");
  ring.style.left = `${event.clientX - bounds.left}px`;
  ring.style.top = `${event.clientY - bounds.top}px`;
  ring.classList.remove("hidden");
  void ring.offsetWidth;
  ring.classList.add("focus-ring");
}

async function takePhoto() {
  if (!stream || !videoReady || captureButton.disabled) return;
  if (timerSeconds) {
    for (let number = timerSeconds; number > 0; number -= 1) {
      countdown.textContent = number;
      countdown.classList.remove("hidden");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    countdown.classList.add("hidden");
  }
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    showError("The camera frame is not ready yet. Wait a moment and try again.");
    return;
  }
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (facingMode === "user") {
    context.translate(width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(video, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob) {
    showError("The photo could not be created. Try again after the preview is visible.");
    return;
  }
  await savePhoto(blob);
  setStatus("Photo saved");
  captureButton.animate([{ transform: "scale(1)" }, { transform: "scale(.9)" }, { transform: "scale(1)" }], { duration: 180 });
}

async function savePhoto(blob) {
  const database = await idb();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).add({ blob, createdAt: Date.now() });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  renderGallery();
}

async function deletePhoto(id) {
  const database = await idb();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  renderGallery();
}

async function readPhotos() {
  const database = await idb();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject(request.error);
  });
}

async function renderGallery() {
  const photos = await readPhotos();
  gallery.innerHTML = "";
  if (!photos.length) {
    gallery.innerHTML = '<p class="empty-state">Photos you take will appear here.</p>';
    return;
  }
  photos.forEach((photo) => {
    const card = document.createElement("article");
    card.className = "photo-card";
    const image = document.createElement("img");
    image.src = URL.createObjectURL(photo.blob);
    image.alt = `Photo taken ${new Date(photo.createdAt).toLocaleString()}`;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "×";
    button.setAttribute("aria-label", "Delete photo");
    button.onclick = () => deletePhoto(photo.id);
    card.append(image, button);
    gallery.append(card);
  });
}

async function clearPhotos() {
  if (!confirm("Delete all saved photos from this device?")) return;
  const database = await idb();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).clear();
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  renderGallery();
}

startButton.onclick = cameraStart;
captureButton.onclick = takePhoto;
switchButton.onclick = () => {
  facingMode = facingMode === "environment" ? "user" : "environment";
  cameraStart();
};
torchButton.onclick = toggleTorch;
video.onclick = showFocus;
gridButton.onclick = () => {
  const enabled = gridOverlay.classList.toggle("hidden") === false;
  gridButton.setAttribute("aria-pressed", String(enabled));
};
timerButton.onclick = () => {
  timerSeconds = timerSeconds === 0 ? 3 : timerSeconds === 3 ? 10 : 0;
  timerLabel.textContent = timerSeconds ? `${timerSeconds}s` : "Off";
  timerButton.setAttribute("aria-pressed", String(Boolean(timerSeconds)));
};
clearButton.onclick = clearPhotos;
window.addEventListener("beforeunload", stopCamera);
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstall = event;
  installButton.classList.remove("hidden");
});
installButton.onclick = async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  installButton.classList.add("hidden");
};
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
renderGallery();