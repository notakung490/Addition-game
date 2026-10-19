// Sound effects synthesized with Web Audio, so the game needs no audio files.
(function () {
  'use strict';

  let ctx = null;
  let muted = false;

  // Must first be called from a click/tap: browsers block audio until the user interacts.
  function audio() {
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      ctx = new Ctx();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, start, duration, { type = 'sine', gain = 0.2, endFreq = freq } = {}) {
    const ac = audio();
    if (!ac || muted) return;
    const t0 = ac.currentTime + start;
    const osc = ac.createOscillator();
    const amp = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + duration);
    amp.gain.setValueAtTime(gain, t0);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(amp).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function bang() {
    const ac = audio();
    if (!ac || muted) return;
    const t0 = ac.currentTime;
    const length = Math.floor(ac.sampleRate * 0.25);
    const buffer = ac.createBuffer(1, length, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
    const noise = ac.createBufferSource();
    noise.buffer = buffer;
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2800, t0);
    filter.frequency.exponentialRampToValueAtTime(300, t0 + 0.2);
    const amp = ac.createGain();
    amp.gain.value = 0.5;
    noise.connect(filter).connect(amp).connect(ac.destination);
    noise.start(t0);
    tone(140, 0, 0.18, { type: 'triangle', gain: 0.45, endFreq: 45 });
  }

  function correct() {
    tone(660, 0, 0.12, { type: 'triangle', gain: 0.25 });
    tone(880, 0.1, 0.12, { type: 'triangle', gain: 0.25 });
    tone(1320, 0.2, 0.25, { type: 'triangle', gain: 0.25 });
  }

  function wrong() {
    tone(220, 0, 0.18, { type: 'square', gain: 0.12, endFreq: 180 });
    tone(165, 0.18, 0.32, { type: 'square', gain: 0.12, endFreq: 110 });
  }

  function cock() {
    tone(1800, 0, 0.03, { type: 'square', gain: 0.05, endFreq: 1200 });
  }

  function fanfare() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.13, 0.3, { type: 'triangle', gain: 0.22 }));
  }

  window.Sound = {
    unlock: audio,
    bang,
    correct,
    wrong,
    cock,
    fanfare,
    toggleMute() {
      muted = !muted;
      return muted;
    },
    get muted() {
      return muted;
    },
  };
})();
