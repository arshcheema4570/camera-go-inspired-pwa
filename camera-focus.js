// Capability-aware autofocus and tap-to-focus for the Lumen Camera viewfinder.
// Browsers without focus controls keep their native camera autofocus unchanged.
(function (global) {
  "use strict";

  class CameraFocusManager {
    constructor(track, video, reticle, status, onMessage = () => {}) {
      this.track = track;
      this.video = video;
      this.reticle = reticle;
      this.status = status;
      this.onMessage = onMessage;
      this.capabilities = {};
      this.focusModes = [];
      this.timer = null;
      this.hideTimer = null;
      try { this.capabilities = track.getCapabilities?.() || {}; } catch { /* native AF remains available */ }
      if (Array.isArray(this.capabilities.focusMode)) this.focusModes = this.capabilities.focusMode;

      this.onPointerUp = (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        const point = this.mapPointToFrame(event.clientX, event.clientY);
        this.requestAt(point);
      };
      this.onKeyDown = (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        this.requestAt({ x: 0.5, y: 0.5 });
      };
      video.addEventListener("pointerup", this.onPointerUp);
      video.addEventListener("keydown", this.onKeyDown);
    }

    supports(mode) {
      return this.focusModes.includes(mode);
    }

    async enableAutofocus() {
      if (!this.supports("continuous") || this.track.readyState !== "live") return false;
      try {
        await this.track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
        return true;
      } catch (error) {
        console.debug("Lumen: camera retained its native autofocus mode.", error?.name || "constraint rejected");
        return false;
      }
    }

    mapPointToFrame(clientX, clientY) {
      const rect = this.video.getBoundingClientRect();
      if (!rect.width || !rect.height || !this.video.videoWidth || !this.video.videoHeight) {
        return { x: 0.5, y: 0.5 };
      }

      // object-fit: cover crops one axis; account for that crop to map the
      // visible tap back into normalized source-frame coordinates.
      const frameRatio = this.video.videoWidth / this.video.videoHeight;
      const boxRatio = rect.width / rect.height;
      let x = (clientX - rect.left) / rect.width;
      let y = (clientY - rect.top) / rect.height;
      if (frameRatio > boxRatio) {
        const visibleWidth = rect.height * frameRatio;
        x = (x * rect.width + (visibleWidth - rect.width) / 2) / visibleWidth;
      } else {
        const visibleHeight = rect.width / frameRatio;
        y = (y * rect.height + (visibleHeight - rect.height) / 2) / visibleHeight;
      }
      x = Math.max(0, Math.min(1, x));
      y = Math.max(0, Math.min(1, y));
      if (this.video.classList.contains("mirrored")) x = 1 - x;
      return { x, y };
    }

    async requestAt(point) {
      if (this.track.readyState !== "live") return;
      this.showReticle(point, "searching");
      try {
        const result = await this.applyTapFocus(point);
        if (!result.supported) {
          this.showReticle(point, "unsupported");
          this.onMessage(result.message);
          return;
        }
        this.showReticle(point, "requested");
        this.onMessage(result.localized
          ? "Focus request sent"
          : "Autofocus is active; tap-to-focus is not exposed by this camera.");
      } catch (error) {
        this.showReticle(point, "failed");
        this.onMessage("This camera could not apply the focus request.");
        console.debug("Lumen: focus request rejected.", error?.name || "unknown error");
      }
    }

    async applyTapFocus(point) {
      if (this.track.readyState !== "live") return { supported: false, message: "Camera is not active." };

      // pointsOfInterest is not part of the broadly supported WebRTC API; use
      // it only when a browser explicitly reports the capability.
      if (this.capabilities.pointsOfInterest) {
        const constraint = { pointsOfInterest: [point] };
        if (this.supports("single-shot")) constraint.focusMode = "single-shot";
        await this.track.applyConstraints({ advanced: [constraint] });
        return { supported: true, localized: true };
      }

      if (this.supports("single-shot")) {
        await this.track.applyConstraints({ advanced: [{ focusMode: "single-shot" }] });
        if (this.supports("continuous")) {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.enableAutofocus(), 1200);
        }
        return { supported: true, localized: false };
      }

      if (this.supports("continuous")) {
        await this.enableAutofocus();
        return { supported: true, localized: false };
      }

      return {
        supported: false,
        message: "Autofocus is managed by your camera; tap-to-focus is not exposed by this browser.",
      };
    }

    showReticle(point, state) {
      this.reticle.style.setProperty("--focus-x", `${point.x * 100}%`);
      this.reticle.style.setProperty("--focus-y", `${point.y * 100}%`);
      this.reticle.classList.remove("is-searching", "is-requested", "is-failed", "is-unsupported");
      this.reticle.classList.add(`is-${state}`);
      this.status.textContent = state === "searching" ? "Requesting focus" :
        state === "requested" ? "Focus request sent" :
          state === "failed" ? "Focus request failed" : "Using camera-managed autofocus";
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => {
        this.reticle.classList.remove("is-searching", "is-requested", "is-failed", "is-unsupported");
      }, state === "searching" ? 1300 : 900);
    }

    destroy() {
      clearTimeout(this.timer);
      clearTimeout(this.hideTimer);
      this.video.removeEventListener("pointerup", this.onPointerUp);
      this.video.removeEventListener("keydown", this.onKeyDown);
      this.reticle.classList.remove("is-searching", "is-requested", "is-failed", "is-unsupported");
    }
  }

  global.CameraFocusManager = CameraFocusManager;
})(window);
