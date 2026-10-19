// Webcam + MediaPipe Hand Landmarker. Everything runs on the player's device;
// no video leaves the browser.
(function () {
  'use strict';

  const MEDIAPIPE_VERSION = '0.10.21';
  const MEDIAPIPE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
  const MODEL_URL =
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
  const VIDEO_SIZE = { width: { ideal: 640 }, height: { ideal: 480 } };

  class HandTracker {
    // onFrame(hand, timeMs) is called for every camera frame; hand is null when no hand is visible,
    // otherwise { landmarks, world } (image coordinates 0..1 and 3D world coordinates in metres).
    constructor(video, onFrame) {
      this.video = video;
      this.onFrame = onFrame;
      this.landmarker = null;
      this.modelPromise = null;
      this.stream = null;
      this.running = false;
      this.lastVideoTime = -1;
    }

    // onStatus('camera' | 'model') reports progress for the loading screen.
    // deviceId picks a specific camera; without it the browser's default camera is used.
    async start(onStatus = () => {}, deviceId = null) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw Object.assign(new Error('getUserMedia unavailable'), { name: 'NoCameraSupport' });
      }
      onStatus('camera');
      const camera = this.openCamera(deviceId).then((stream) => {
        onStatus('model');
        return stream;
      });
      // Download the model while the camera permission prompt is open. If the camera
      // is refused the download carries on, so a retry is quick.
      if (!this.modelPromise) {
        this.modelPromise = this.loadModel();
        this.modelPromise.catch(() => {
          this.modelPromise = null;
        });
      }
      this.stream = await camera;
      try {
        this.landmarker = await this.modelPromise;
      } catch (err) {
        this.stop();
        throw err;
      }
      await this.attachStream();
      this.running = true;
      this.loop();
    }

    // Opens the given camera, or the default one when it is not given or no longer plugged in.
    async openCamera(deviceId) {
      if (deviceId) {
        try {
          return await this.getStream({ deviceId: { exact: deviceId } });
        } catch (err) {
          if (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError') throw err;
        }
      }
      return this.getStream({ facingMode: 'user' });
    }

    getStream(constraints) {
      return navigator.mediaDevices.getUserMedia({ video: { ...VIDEO_SIZE, ...constraints }, audio: false });
    }

    async attachStream() {
      this.video.srcObject = this.stream;
      await this.video.play();
      this.lastVideoTime = -1;
    }

    // Cameras on this device as { deviceId, label }. Labels are only filled in
    // once the player has allowed camera access.
    async listCameras() {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput').map(({ deviceId, label }) => ({ deviceId, label }));
    }

    currentCameraId() {
      const track = this.stream && this.stream.getVideoTracks()[0];
      return (track && track.getSettings().deviceId) || null;
    }

    // Swaps to another camera while the game keeps running. If that camera
    // can't be opened, the previous one comes back and the error is rethrown.
    async switchCamera(deviceId) {
      if (!this.running) return;
      const previous = this.currentCameraId();
      this.stream.getTracks().forEach((track) => track.stop());
      let error = null;
      try {
        this.stream = await this.getStream({ deviceId: { exact: deviceId } });
      } catch (err) {
        error = err;
        this.stream = await this.openCamera(previous);
      }
      if (!this.running) return this.stop(); // stopped while the new camera was opening
      await this.attachStream();
      if (error) throw error;
    }

    async loadModel() {
      const vision = await import(`${MEDIAPIPE_URL}/vision_bundle.mjs`);
      const fileset = await vision.FilesetResolver.forVisionTasks(`${MEDIAPIPE_URL}/wasm`);
      const options = (delegate) => ({
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      try {
        return await vision.HandLandmarker.createFromOptions(fileset, options('GPU'));
      } catch (err) {
        console.warn('GPU delegate unavailable, falling back to CPU', err);
        return vision.HandLandmarker.createFromOptions(fileset, options('CPU'));
      }
    }

    loop() {
      if (!this.running) return;
      const video = this.video;
      if (video.readyState >= 2 && video.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = video.currentTime;
        const now = performance.now();
        const result = this.landmarker.detectForVideo(video, now);
        const hand = result.landmarks && result.landmarks.length
          ? { landmarks: result.landmarks[0], world: result.worldLandmarks[0] }
          : null;
        this.onFrame(hand, now);
      }
      requestAnimationFrame(() => this.loop());
    }

    // Turns the camera off (and its light) but keeps the model loaded for next time.
    stop() {
      this.running = false;
      if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.video.srcObject = null;
    }
  }

  window.HandTracker = HandTracker;
})();
