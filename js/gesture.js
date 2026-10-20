// Finger-gun gesture recognition on top of MediaPipe hand landmarks.
//
//   aim  = where the tip of the index finger is
//   gun  = index finger straight, ring + pinky curled (middle finger may do either)
//   fire = thumb goes from up (hammer cocked) to down against the hand (hammer falls)
//
// Pure functions and small state machines only, so it can be unit-tested in Node.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Gesture = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // MediaPipe hand landmark indices: [MCP, PIP, DIP, TIP] per finger.
  const WRIST = 0;
  const THUMB_TIP = 4;
  const INDEX = [5, 6, 7, 8];
  const MIDDLE = [9, 10, 11, 12];
  const RING = [13, 14, 15, 16];
  const PINKY = [17, 18, 19, 20];

  const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
  ];

  // Tuning knobs. Press "D" in the game to see the live values.
  const CONFIG = {
    straightMaxBend: 50, // index counts as straight below this bend (degrees)
    curledMinBend: 70, // ring / pinky count as curled above this bend (degrees)
    cockThreshold: 0.5, // thumbOpen above this = thumb up, hammer cocked
    fireThreshold: 0.38, // thumbOpen below this (after cocking) = fire
    minShotGapMs: 350, // no machine-gunning
    pullSlack: 0.08, // thumb this far below its peak = the press has started
    peakDecayPerSec: 0.5, // lets the remembered peak forget tracking spikes
    gunGraceMs: 250, // keep the trigger state through short tracking dropouts
  };

  function sub(a, b) {
    return { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) };
  }
  function len(v) {
    return Math.hypot(v.x, v.y, v.z);
  }
  function dist(a, b) {
    return len(sub(a, b));
  }
  function angleDeg(u, v) {
    const d = len(u) * len(v);
    if (!d) return 0;
    const cos = (u.x * v.x + u.y * v.y + u.z * v.z) / d;
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  }

  // How far a finger is bent: angle between its first bone and the line to its tip.
  // ~0 when straight, ~90+ when curled into the palm.
  function fingerBend(lm, finger) {
    const [mcp, pip, , tip] = finger;
    return angleDeg(sub(lm[pip], lm[mcp]), sub(lm[tip], lm[pip]));
  }

  function tipFolded(lm, finger) {
    return dist(lm[WRIST], lm[finger[3]]) < dist(lm[WRIST], lm[finger[1]]);
  }

  function isStraight(lm, finger, cfg = CONFIG) {
    return fingerBend(lm, finger) < cfg.straightMaxBend && !tipFolded(lm, finger);
  }

  function isCurled(lm, finger, cfg = CONFIG) {
    return fingerBend(lm, finger) > cfg.curledMinBend || tipFolded(lm, finger);
  }

  // Thumb tip distance to the side of the hand (index/middle base), relative to
  // palm size. Thumb up ~0.6+, thumb pressed down ~0.3 or less.
  function thumbOpenness(lm) {
    const palm = dist(lm[WRIST], lm[MIDDLE[0]]) || 1;
    const tip = lm[THUMB_TIP];
    const near = Math.min(
      dist(tip, lm[INDEX[0]]),
      dist(tip, lm[INDEX[1]]),
      dist(tip, lm[MIDDLE[0]]),
      dist(tip, lm[MIDDLE[1]])
    );
    return near / palm;
  }

  // lm: 21 landmarks with x, y, z. World landmarks (metres) work best because
  // they don't shrink when the finger points at the camera.
  function analyzeHand(lm, cfg = CONFIG) {
    const indexBend = fingerBend(lm, INDEX);
    const isGun = isStraight(lm, INDEX, cfg) && isCurled(lm, RING, cfg) && isCurled(lm, PINKY, cfg);
    return { isGun, indexBend, thumbOpen: thumbOpenness(lm) };
  }

  // idle (no gun) -> aiming (gun, thumb not up yet) -> cocked (thumb up) -> fires when the thumb drops.
  // You must lift the thumb again before the next shot, so a gun made with the
  // thumb already down never fires by accident.
  class TriggerDetector {
    constructor(cfg = CONFIG) {
      this.cfg = cfg;
      this.reset();
    }

    reset() {
      this.state = 'idle';
      this.lastGunAt = -Infinity;
      this.lastShotAt = -Infinity;
      this.lastCockedAt = -Infinity; // last frame the thumb was fully up, i.e. just before the press began
      this.lastFrameAt = 0;
      this.peak = 0;
    }

    // info: result of analyzeHand, or null when no hand. Returns true on the frame a shot fires.
    update(info, t) {
      const c = this.cfg;
      if (!info || !info.isGun) {
        if (t - this.lastGunAt > c.gunGraceMs) this.state = 'idle';
        return false;
      }
      this.lastGunAt = t;
      const dt = (t - this.lastFrameAt) / 1000;
      this.lastFrameAt = t;
      if (this.state === 'cocked') {
        // Relative to this player's own thumb-up level, so a press is caught as
        // soon as it starts even when the thumb was raised high.
        this.peak = Math.max(info.thumbOpen, this.peak - c.peakDecayPerSec * dt);
        if (info.thumbOpen >= this.peak - c.pullSlack) this.lastCockedAt = t;
        if (info.thumbOpen < c.fireThreshold && t - this.lastShotAt >= c.minShotGapMs) {
          this.state = 'aiming';
          this.lastShotAt = t;
          return true;
        }
        return false;
      }
      this.state = info.thumbOpen > c.cockThreshold ? 'cocked' : 'aiming';
      if (this.state === 'cocked') {
        this.peak = info.thumbOpen;
        this.lastCockedAt = t;
      }
      return false;
    }
  }

  // Alternative trigger: keep aiming at the same target for `durationMs`.
  class DwellDetector {
    constructor(durationMs) {
      this.duration = durationMs;
      this.reset();
    }

    reset() {
      this.target = null;
      this.since = 0;
      this.done = false;
    }

    update(target, t) {
      if (target !== this.target) {
        this.target = target;
        this.since = t;
        this.done = false;
      }
      if (!target || this.done) return { progress: 0, fire: false };
      const progress = Math.min(1, (t - this.since) / this.duration);
      if (progress >= 1) this.done = true;
      return { progress, fire: progress >= 1 };
    }
  }

  // One Euro filter (Casiez et al. 2012): smooth when the hand is still, responsive when it moves.
  class OneEuroFilter {
    constructor(minCutoff = 1.0, beta = 0, dCutoff = 1.0) {
      this.minCutoff = minCutoff;
      this.beta = beta;
      this.dCutoff = dCutoff;
      this.reset();
    }

    reset() {
      this.x = null;
      this.dx = 0;
      this.t = 0;
    }

    static alpha(cutoff, dt) {
      const tau = 1 / (2 * Math.PI * cutoff);
      return 1 / (1 + tau / dt);
    }

    filter(x, tMs) {
      if (this.x === null) {
        this.x = x;
        this.t = tMs;
        return x;
      }
      const dt = Math.max(1e-3, (tMs - this.t) / 1000);
      this.t = tMs;
      const dx = (x - this.x) / dt;
      this.dx += OneEuroFilter.alpha(this.dCutoff, dt) * (dx - this.dx);
      const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
      this.x += OneEuroFilter.alpha(cutoff, dt) * (x - this.x);
      return this.x;
    }
  }

  // Recent aim positions, so a shot can use where the finger pointed just
  // before the thumb moved (dropping the thumb jolts the hand a little).
  class AimHistory {
    constructor(keepMs = 500) {
      this.keepMs = keepMs;
      this.samples = [];
    }

    push(t, x, y) {
      this.samples.push({ t, x, y });
      while (this.samples.length > 1 && t - this.samples[0].t > this.keepMs) this.samples.shift();
    }

    at(t) {
      let best = this.samples[0] || null;
      for (const s of this.samples) {
        if (s.t > t) break;
        best = s;
      }
      return best;
    }

    clear() {
      this.samples = [];
    }
  }

  // MediaPipe labels handedness as if the image were mirrored (selfie view). The
  // webcam frames the game gives it are not mirrored, so its "Left" is the
  // player's right hand. Low-confidence guesses are ignored.
  function playerHand(handedness, minScore = 0.7) {
    if (!handedness || handedness.score < minScore) return null;
    if (handedness.categoryName === 'Left') return 'right';
    if (handedness.categoryName === 'Right') return 'left';
    return null;
  }

  // Which hand the player is using. The first confident guess is taken at once;
  // after that the other hand has to show up for `holdMs` before it switches,
  // so a few mislabelled frames don't move the aim area around.
  class HandSide {
    constructor(holdMs = 800) {
      this.holdMs = holdMs;
      this.reset();
    }

    reset() {
      this.side = null;
      this.candidate = null;
      this.since = 0;
    }

    update(side, t) {
      if (!side) {
        // no confident guess this frame: tells us nothing either way
      } else if (side === this.side) {
        this.candidate = null;
      } else if (!this.side) {
        this.side = side;
      } else if (side !== this.candidate) {
        this.candidate = side;
        this.since = t;
      } else if (t - this.since >= this.holdMs) {
        this.side = side;
        this.candidate = null;
      }
      return this.side;
    }
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  // Camera point (0..1, un-mirrored) -> screen point (0..1). Mirrored so moving
  // the hand right moves the crosshair right, and a central region of the camera
  // view covers the whole screen so you don't have to reach to the edges.
  function mapAim(pt, region) {
    return {
      x: clamp01((1 - pt.x - region.x0) / (region.x1 - region.x0)),
      y: clamp01((pt.y - region.y0) / (region.y1 - region.y0)),
    };
  }

  return {
    CONFIG,
    HAND_CONNECTIONS,
    INDEX,
    MIDDLE,
    RING,
    PINKY,
    fingerBend,
    isStraight,
    isCurled,
    thumbOpenness,
    analyzeHand,
    TriggerDetector,
    DwellDetector,
    OneEuroFilter,
    AimHistory,
    HandSide,
    playerHand,
    mapAim,
  };
});
