// Game flow, UI and wiring between hand tracking and the board.
(function () {
  'use strict';

  const TOTAL_QUESTIONS = 10;
  // Part of the camera view that covers the screen. The top is kept well below the
  // top of the frame so aiming at the top row doesn't mean raising the hand to eye level.
  const AIM_REGION = { x0: 0.15, x1: 0.85, y0: 0.24, y1: 0.8 };
  // The aim area also moves toward the side of the hand in use (in camera-width
  // units), where that hand naturally rests, so the far-side targets don't need a
  // reach across the body. Without it the bottom target opposite the hand was
  // the hardest one to hit.
  const HAND_SHIFT = 0.1;
  const HAND_SHIFT_EASE_MS = 300;
  const SHOT_LOOKBACK_MS = 120; // aim from at least this long before the shot
  const DWELL_MS = 1500;
  const HIT_SLOP = 0.15; // targets are 15% more forgiving than they look
  const NEXT_DELAY_OK_MS = 1200;
  const NEXT_DELAY_WRONG_MS = 2400;
  const BEST_KEY = 'addition-gun-best';
  const CAMERA_KEY = 'addition-gun-camera';

  const { makeQuestionSet } = window.MathQuestions;
  const G = window.Gesture;
  const Sound = window.Sound;

  const $ = (sel) => document.querySelector(sel);
  const body = document.body;
  const ui = {
    answers: [...document.querySelectorAll('.answer')],
    qa: $('#qa'),
    qb: $('#qb'),
    question: $('#question'),
    hudIndex: $('#hud-index'),
    hudScore: $('#hud-score'),
    hudStreak: $('#hud-streak'),
    hudStreakWrap: $('#hud-streak-wrap'),
    dots: $('#dots'),
    readyTarget: $('#ready-target'),
    readyHint: $('#ready-hint'),
    toast: $('#toast'),
    crosshair: $('#crosshair'),
    crosshairSvg: $('#crosshair svg'),
    dwellRing: $('#dwell-ring'),
    video: $('#cam-video'),
    canvas: $('#cam-canvas'),
    camStatus: $('#cam-status'),
    camPicker: $('#cam-picker'),
    camSelect: $('#cam-select'),
    camError: $('#cam-error'),
    loadingText: $('#loading-text'),
    loadingError: $('#loading-error'),
    loadingErrorText: $('#loading-error-text'),
    fx: $('#fx'),
    debug: $('#debug'),
    bestLine: $('#best-line'),
    stars: [...document.querySelectorAll('#stars svg')],
    resultMsg: $('#result-msg'),
    rCorrect: $('#r-correct'),
    rScore: $('#r-score'),
    rStreak: $('#r-streak'),
    rTime: $('#r-time'),
    rBest: $('#r-best'),
    btnAgain: $('#btn-again'),
    btnHome: $('#btn-home'),
    btnMute: $('#btn-mute'),
  };

  const state = {
    phase: 'menu', // menu | loading | ready | playing | feedback | over
    input: 'hand', // hand | mouse
    fireMode: 'thumb', // thumb | dwell
    questions: [],
    index: 0,
    score: 0,
    correct: 0,
    streak: 0,
    bestStreak: 0,
    results: [],
    startedAt: 0,
    questionStartedAt: 0,
    nextTimer: 0,
  };

  const tracker = new window.HandTracker(ui.video, onHandFrame);
  const trigger = new G.TriggerDetector();
  const dwell = new G.DwellDetector(DWELL_MS);
  const smoothX = new G.OneEuroFilter(1.2, 12);
  const smoothY = new G.OneEuroFilter(1.2, 12);
  const aimHistory = new G.AimHistory(1000);
  const handSide = new G.HandSide();
  let regionShift = 0;
  let lastHandAt = 0;
  let hovered = null;
  let camStatusKey = '';

  // ---------- phases ----------

  function setPhase(phase) {
    state.phase = phase;
    body.dataset.phase = phase;
    if (phase !== 'playing' && phase !== 'feedback') hideToast();
  }

  function showMenu() {
    clearTimeout(state.nextTimer);
    tracker.stop();
    resetAim();
    ui.bestLine.textContent = bestScore() ? `· สถิติสูงสุด ${bestScore().toLocaleString()} คะแนน` : '';
    setPhase('menu');
  }

  async function startWithHand() {
    Sound.unlock();
    state.input = 'hand';
    body.dataset.input = 'hand';
    state.fireMode = document.querySelector('input[name="fire-mode"]:checked').value;
    body.dataset.fire = state.fireMode;
    ui.readyHint.textContent =
      state.fireMode === 'thumb'
        ? 'ทำมือเป็นรูปปืน เล็งที่เป้า แล้วพับนิ้วโป้งลงเพื่อยิง'
        : 'ทำมือเป็นรูปปืน แล้วเล็งค้างไว้ที่เป้าจนวงกลมเต็ม';
    if (tracker.running) return setPhase('ready');

    ui.loadingError.hidden = true;
    ui.loadingText.textContent = 'กำลังขออนุญาตใช้กล้อง...';
    setPhase('loading');
    try {
      await tracker.start((step) => {
        if (step === 'model') ui.loadingText.textContent = 'กำลังโหลดตัวตรวจจับมือ (ครั้งแรกอาจใช้เวลาสักครู่)...';
      }, savedCamera().deviceId);
    } catch (err) {
      console.error(err);
      if (state.phase === 'loading') showLoadingError(err);
      return;
    }
    if (state.phase !== 'loading') return tracker.stop(); // player left while it was loading
    await restoreSavedCamera();
    if (state.phase !== 'loading') return tracker.stop();
    sizePreviewCanvas();
    fillCameraPicker();
    setPhase('ready');
  }

  // ---------- camera picker ----------

  // Laptops paired with a phone (Continuity Camera, Phone Link) often make the
  // phone the default camera, so let the player pick and remember the choice.
  async function fillCameraPicker() {
    let cameras = [];
    try {
      cameras = await tracker.listCameras();
    } catch (err) {
      console.warn(err);
    }
    const current = tracker.currentCameraId();
    ui.camSelect.replaceChildren(
      ...cameras.map((cam, i) => {
        const option = new Option(cameraName(cam.label, i), cam.deviceId, false, cam.deviceId === current);
        option.dataset.label = cam.label;
        return option;
      })
    );
    ui.camPicker.hidden = cameras.length < 2;
  }

  // Camera ids can change between visits (e.g. "allow this time" permissions),
  // so if the saved id didn't open the saved camera, find it again by name.
  async function restoreSavedCamera() {
    const saved = savedCamera();
    if (!saved.label) return;
    try {
      const cameras = await tracker.listCameras();
      const current = cameras.find((cam) => cam.deviceId === tracker.currentCameraId());
      if (current && current.label === saved.label) return;
      const match = cameras.find((cam) => cam.label === saved.label);
      if (match) await tracker.switchCamera(match.deviceId);
    } catch (err) {
      console.warn('Could not restore the saved camera', err);
    }
  }

  function savedCamera() {
    try {
      return JSON.parse(loadSetting(CAMERA_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function cameraName(label, i) {
    const name = label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '');
    return name ? `กล้อง: ${name}` : `กล้องที่ ${i + 1}`;
  }

  async function changeCamera() {
    const deviceId = ui.camSelect.value;
    ui.camSelect.disabled = true;
    ui.camError.hidden = true;
    try {
      await tracker.switchCamera(deviceId);
      const label = ui.camSelect.selectedOptions[0].dataset.label;
      saveSetting(CAMERA_KEY, JSON.stringify({ deviceId, label }));
    } catch (err) {
      console.error(err);
      ui.camError.textContent = 'เปิดกล้องนี้ไม่ได้ ลองเลือกกล้องอื่น';
      ui.camError.hidden = false;
    }
    ui.camSelect.disabled = false;
    ui.camSelect.blur(); // so the 1-4 answer keys don't scroll the list
    resetAim();
    sizePreviewCanvas();
    fillCameraPicker();
  }

  function showLoadingError(err) {
    const messages = {
      NotAllowedError: 'ไม่ได้รับอนุญาตให้ใช้กล้อง กรุณากดอนุญาตกล้องที่แถบที่อยู่ของเบราว์เซอร์ แล้วลองอีกครั้ง',
      NotFoundError: 'ไม่พบกล้องในเครื่องนี้',
      NotReadableError: 'กล้องถูกใช้งานโดยโปรแกรมอื่นอยู่ ปิดโปรแกรมนั้นก่อนแล้วลองอีกครั้ง',
      NoCameraSupport: 'เบราว์เซอร์นี้ใช้กล้องไม่ได้ ต้องเปิดผ่าน https หรือ localhost และใช้ Chrome, Edge, Safari หรือ Firefox รุ่นใหม่',
    };
    ui.loadingErrorText.textContent =
      messages[err && err.name] || 'โหลดตัวตรวจจับมือไม่สำเร็จ ตรวจสอบการเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง';
    ui.loadingText.textContent = 'เปิดกล้องไม่สำเร็จ';
    ui.loadingError.hidden = false;
  }

  function startWithMouse() {
    Sound.unlock();
    tracker.stop();
    resetAim();
    state.input = 'mouse';
    body.dataset.input = 'mouse';
    startGame();
  }

  function startGame() {
    clearTimeout(state.nextTimer);
    Object.assign(state, {
      questions: makeQuestionSet(TOTAL_QUESTIONS),
      index: 0,
      score: 0,
      correct: 0,
      streak: 0,
      bestStreak: 0,
      results: [],
      startedAt: performance.now(),
    });
    ui.dots.innerHTML = '<li></li>'.repeat(TOTAL_QUESTIONS);
    showQuestion();
  }

  function showQuestion() {
    const q = state.questions[state.index];
    ui.qa.textContent = q.a;
    ui.qb.textContent = q.b;
    ui.answers.forEach((el, i) => {
      el.querySelector('.num').textContent = q.choices[i];
      el.className = 'target answer';
      el.setAttribute('aria-label', `คำตอบ ${q.choices[i]}`);
      void el.offsetWidth; // restart the pop-in animation
      el.classList.add('pop');
    });
    ui.question.classList.remove('pop');
    void ui.question.offsetWidth;
    ui.question.classList.add('pop');
    dwell.reset();
    renderHud();
    state.questionStartedAt = performance.now();
    setPhase('playing');
  }

  function chooseAnswer(slot) {
    if (state.phase !== 'playing') return;
    const q = state.questions[state.index];
    const el = ui.answers[slot];
    const ok = q.choices[slot] === q.answer;
    const seconds = (performance.now() - state.questionStartedAt) / 1000;
    setPhase('feedback');
    state.results.push(ok);

    if (ok) {
      state.correct++;
      state.streak++;
      state.bestStreak = Math.max(state.bestStreak, state.streak);
      const speedBonus = Math.max(0, Math.round(50 * (1 - seconds / 15)));
      const streakBonus = Math.min(50, (state.streak - 1) * 10);
      const points = 100 + speedBonus + streakBonus;
      state.score += points;
      el.classList.add('hit');
      burst(el);
      const r = el.getBoundingClientRect();
      floatText(r.left + r.width / 2, r.top, `+${points}`);
      Sound.correct();
      showToast(state.streak >= 3 ? `ถูกต้อง! ต่อเนื่อง ${state.streak} ข้อ` : 'ถูกต้อง!', 'good');
    } else {
      state.streak = 0;
      el.classList.add('miss');
      ui.answers[q.choices.indexOf(q.answer)].classList.add('reveal');
      Sound.wrong();
      showToast(`ยังไม่ถูกนะ  ${q.a} + ${q.b} = ${q.answer}`, 'bad');
    }
    renderHud();
    state.nextTimer = setTimeout(nextQuestion, ok ? NEXT_DELAY_OK_MS : NEXT_DELAY_WRONG_MS);
  }

  function nextQuestion() {
    state.index++;
    if (state.index >= TOTAL_QUESTIONS) finish();
    else showQuestion();
  }

  function finish() {
    const seconds = Math.round((performance.now() - state.startedAt) / 1000);
    const stars = state.correct >= 9 ? 3 : state.correct >= 7 ? 2 : state.correct >= 4 ? 1 : 0;
    const previousBest = bestScore();
    const isBest = state.score > previousBest;
    if (isBest) saveBest(state.score);

    ui.stars.forEach((s, i) => s.classList.toggle('on', i < stars));
    ui.resultMsg.textContent = [
      'ไม่เป็นไร ลองใหม่อีกครั้งนะ',
      'เก่งขึ้นแล้ว ฝึกอีกนิด!',
      'เก่งมาก!',
      'สุดยอดนักแม่นปืนเลขบวก!',
    ][stars];
    ui.rCorrect.textContent = `${state.correct}/${TOTAL_QUESTIONS}`;
    ui.rScore.textContent = state.score.toLocaleString();
    ui.rStreak.textContent = `${state.bestStreak} ข้อ`;
    ui.rTime.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    ui.rBest.hidden = !isBest || state.score === 0;
    if (stars >= 2) Sound.fanfare();
    setPhase('over');
  }

  function renderHud() {
    ui.hudIndex.textContent = `${Math.min(state.index + 1, TOTAL_QUESTIONS)}/${TOTAL_QUESTIONS}`;
    ui.hudScore.textContent = state.score.toLocaleString();
    ui.hudStreak.textContent = state.streak;
    ui.hudStreakWrap.classList.toggle('hot', state.streak >= 3);
    [...ui.dots.children].forEach((dot, i) => {
      dot.className = i < state.results.length ? (state.results[i] ? 'ok' : 'no') : i === state.index ? 'now' : '';
    });
  }

  // ---------- shooting ----------

  // Elements that can be shot in the current phase.
  function shootables() {
    if (state.phase === 'playing') return ui.answers;
    if (state.phase === 'ready') return [ui.readyTarget];
    if (state.phase === 'over') return [ui.btnAgain, ui.btnHome];
    return [];
  }

  function hitTest(x, y) {
    let best = null;
    let bestDist = Infinity;
    for (const el of shootables()) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const inside = el.classList.contains('target')
        ? Math.hypot(x - cx, y - cy) <= (r.width / 2) * (1 + HIT_SLOP)
        : Math.abs(x - cx) <= (r.width / 2) * (1 + HIT_SLOP) && Math.abs(y - cy) <= (r.height / 2) * (1 + HIT_SLOP) + 8;
      const d = Math.hypot(x - cx, y - cy);
      if (inside && d < bestDist) {
        best = el;
        bestDist = d;
      }
    }
    return best;
  }

  function shoot(x, y, target) {
    Sound.bang();
    muzzleFlash(x, y);
    ui.crosshairSvg.classList.remove('recoil');
    void ui.crosshairSvg.offsetWidth;
    ui.crosshairSvg.classList.add('recoil');
    const el = target === undefined ? hitTest(x, y) : target;
    if (!el) return bulletHole(x, y);
    if (el.classList.contains('answer')) chooseAnswer(Number(el.dataset.slot));
    else el.click();
  }

  // ---------- hand input ----------

  function resetAim() {
    smoothX.reset();
    smoothY.reset();
    aimHistory.clear();
    trigger.reset();
    handSide.reset();
    regionShift = 0;
    dwell.reset();
    setHover(null);
    ui.crosshair.className = 'crosshair';
    clearPreview();
  }

  function onHandFrame(hand, t) {
    drawPreview(hand);
    const active = ['ready', 'playing', 'feedback', 'over'].includes(state.phase);
    if (!hand || !active) {
      trigger.update(null, t);
      dwell.update(null, t);
      smoothX.reset();
      smoothY.reset();
      setHover(null);
      setDwellProgress(0);
      ui.crosshair.className = 'crosshair';
      setCamStatus('none', 'ไม่เห็นมือ ยกมือขึ้นให้กล้องเห็น');
      return updateDebug(null);
    }

    const info = G.analyzeHand(hand.world && hand.world.length ? hand.world : hand.landmarks);
    const side = handSide.update(G.playerHand(hand.handedness), t);
    const targetShift = side === 'right' ? HAND_SHIFT : side === 'left' ? -HAND_SHIFT : 0;
    regionShift += (targetShift - regionShift) * Math.min(1, (t - lastHandAt) / HAND_SHIFT_EASE_MS);
    lastHandAt = t;
    const region = { ...AIM_REGION, x0: AIM_REGION.x0 + regionShift, x1: AIM_REGION.x1 + regionShift };
    const aim = G.mapAim(hand.landmarks[8], region);
    const x = smoothX.filter(aim.x, t) * window.innerWidth;
    const y = smoothY.filter(aim.y, t) * window.innerHeight;
    aimHistory.push(t, x, y);
    const target = info.isGun ? hitTest(x, y) : null;
    setHover(target);

    const wasCocked = trigger.state === 'cocked';
    let shot = null;
    if (state.fireMode === 'thumb') {
      if (trigger.update(info, t)) {
        // Aim from before the thumb started moving: pressing it down drags the hand.
        const p = aimHistory.at(Math.min(trigger.lastCockedAt, t - SHOT_LOOKBACK_MS)) || { x, y };
        shot = { x: p.x, y: p.y, target: undefined };
      } else if (!wasCocked && trigger.state === 'cocked') {
        Sound.cock();
      }
      setDwellProgress(0);
    } else {
      trigger.update(info, t); // keeps the crosshair colours consistent
      const d = dwell.update(target, t);
      setDwellProgress(d.progress);
      if (d.fire) shot = { x, y, target };
    }

    const cocked = state.fireMode === 'thumb' ? trigger.state === 'cocked' : info.isGun;
    ui.crosshair.className = 'crosshair visible' + (info.isGun ? ' gun' : '') + (cocked ? ' cocked' : '') + (target ? ' over' : '');
    ui.crosshair.style.transform = `translate(${x}px, ${y}px)`;

    if (!info.isGun) setCamStatus('pose', 'ทำมือเป็นรูปปืน: ชูนิ้วชี้ กำนิ้วอื่น');
    else if (state.fireMode === 'dwell') setCamStatus('ready', 'เล็งค้างไว้ที่เป้าเพื่อยิง');
    else if (trigger.state === 'cocked') setCamStatus('ready', 'พร้อมยิง! พับนิ้วโป้งลง');
    else setCamStatus('pose', 'ยกนิ้วโป้งขึ้นเพื่อง้างปืน');

    updateDebug(info, side);
    if (shot) shoot(shot.x, shot.y, shot.target);
  }

  function setHover(el) {
    if (hovered === el) return;
    if (hovered) hovered.classList.remove('aimed');
    hovered = el;
    if (el) el.classList.add('aimed');
  }

  function setDwellProgress(p) {
    ui.dwellRing.style.strokeDashoffset = String(100 - p * 100);
  }

  function setCamStatus(tone, text) {
    const key = tone + text;
    if (key === camStatusKey) return;
    camStatusKey = key;
    ui.camStatus.dataset.tone = tone;
    ui.camStatus.textContent = text;
  }

  function sizePreviewCanvas() {
    ui.canvas.width = ui.video.videoWidth || 640;
    ui.canvas.height = ui.video.videoHeight || 480;
  }

  function clearPreview() {
    ui.canvas.getContext('2d').clearRect(0, 0, ui.canvas.width, ui.canvas.height);
  }

  function drawPreview(hand) {
    const ctx = ui.canvas.getContext('2d');
    const w = ui.canvas.width;
    const h = ui.canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!hand) return;
    const p = hand.landmarks;
    ctx.lineWidth = Math.max(2, w / 160);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    for (const [a, b] of G.HAND_CONNECTIONS) {
      ctx.moveTo(p[a].x * w, p[a].y * h);
      ctx.lineTo(p[b].x * w, p[b].y * h);
    }
    ctx.stroke();
    p.forEach((pt, i) => {
      ctx.fillStyle = i === 8 ? '#facc15' : i === 4 ? '#38bdf8' : '#f43f5e';
      ctx.beginPath();
      ctx.arc(pt.x * w, pt.y * h, i === 8 || i === 4 ? w / 45 : w / 90, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function updateDebug(info, side) {
    if (ui.debug.hidden) return;
    ui.debug.textContent = info
      ? `gun        ${info.isGun}\nindexBend  ${info.indexBend.toFixed(0)}°\nthumbOpen  ${info.thumbOpen.toFixed(2)}  (cock > ${G.CONFIG.cockThreshold}, fire < ${G.CONFIG.fireThreshold})\ntrigger    ${trigger.state}\nhand       ${side || '?'}  (aim shift ${regionShift >= 0 ? '+' : ''}${regionShift.toFixed(2)})`
      : 'no hand';
  }

  // ---------- effects ----------

  function spawn(className, x, y, props = {}) {
    const el = document.createElement('div');
    el.className = className;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v);
    el.addEventListener('animationend', () => el.remove(), { once: true });
    ui.fx.appendChild(el);
    return el;
  }

  function muzzleFlash(x, y) {
    spawn('flash', x, y);
  }

  function bulletHole(x, y) {
    spawn('hole', x, y);
  }

  function burst(target) {
    const r = target.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2 + Math.random() * 0.4;
      const distance = r.width * (0.6 + Math.random() * 0.5);
      spawn('spark', cx, cy, {
        '--dx': `${Math.cos(angle) * distance}px`,
        '--dy': `${Math.sin(angle) * distance}px`,
        '--hue': String(Math.floor(Math.random() * 60) + 30),
      });
    }
  }

  function floatText(x, y, text) {
    spawn('float-text', x, y).textContent = text;
  }

  function showToast(text, tone) {
    ui.toast.textContent = text;
    ui.toast.dataset.tone = tone;
    ui.toast.classList.add('show');
  }

  function hideToast() {
    ui.toast.classList.remove('show');
  }

  // ---------- storage ----------

  function bestScore() {
    return Number(loadSetting(BEST_KEY)) || 0;
  }

  function saveBest(score) {
    saveSetting(BEST_KEY, String(score));
  }

  function loadSetting(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function saveSetting(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      /* private mode: the setting just isn't remembered */
    }
  }

  // ---------- events ----------

  $('#btn-start-hand').addEventListener('click', startWithHand);
  $('#btn-start-mouse').addEventListener('click', startWithMouse);
  $('#btn-retry').addEventListener('click', startWithHand);
  $('#btn-fallback-mouse').addEventListener('click', startWithMouse);
  $('#btn-quit').addEventListener('click', showMenu);
  ui.btnHome.addEventListener('click', showMenu);
  ui.btnAgain.addEventListener('click', startGame);
  ui.readyTarget.addEventListener('click', () => {
    if (state.phase !== 'ready') return;
    burst(ui.readyTarget);
    Sound.correct();
    startGame();
  });

  // Mouse / touch: clicking an answer shoots it.
  ui.answers.forEach((el) => {
    el.addEventListener('click', (e) => {
      if (state.phase !== 'playing') return;
      const r = el.getBoundingClientRect();
      const fromPointer = e.detail > 0; // detail is 0 for keyboard activation
      shoot(fromPointer ? e.clientX : r.left + r.width / 2, fromPointer ? e.clientY : r.top + r.height / 2, el);
    });
  });

  ui.camSelect.addEventListener('change', changeCamera);
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (tracker.running) fillCameraPicker();
    });
  }

  ui.btnMute.addEventListener('click', toggleMute);
  function toggleMute() {
    ui.btnMute.classList.toggle('muted', Sound.toggleMute());
  }

  document.querySelectorAll('input[name="fire-mode"]').forEach((input) => {
    input.addEventListener('change', () => (body.dataset.fire = input.value));
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    const slot = ['1', '2', '3', '4'].indexOf(e.key);
    if (slot >= 0 && state.phase === 'playing') {
      const r = ui.answers[slot].getBoundingClientRect();
      shoot(r.left + r.width / 2, r.top + r.height / 2, ui.answers[slot]);
    } else if (e.key === 'd' || e.key === 'D') {
      ui.debug.hidden = !ui.debug.hidden;
    } else if (e.key === 'm' || e.key === 'M') {
      toggleMute();
    } else if (e.key === 'Escape' && state.phase !== 'menu') {
      showMenu();
    }
  });

  if (new URLSearchParams(location.search).has('debug')) ui.debug.hidden = false;
  ui.loadingError.hidden = true;
  body.dataset.fire = state.fireMode;
  showMenu();
})();
