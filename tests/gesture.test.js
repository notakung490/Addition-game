const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../js/gesture.js');

// World landmarks produced by the MediaPipe hand model on its own sample photos
// (storage.googleapis.com/mediapipe-assets/*.jpg).
const fixtures = require('./fixtures/hands.json');
const hand = (name, i = 0) => fixtures[name][i].map(([x, y, z]) => ({ x, y, z }));

test('pointing finger is a gun, other hand shapes are not', () => {
  assert.equal(G.analyzeHand(hand('pointing_up')).isGun, true);
  assert.equal(G.analyzeHand(hand('pointing_up_rotated')).isGun, true);
  assert.equal(G.analyzeHand(hand('fist')).isGun, false);
  assert.equal(G.analyzeHand(hand('thumb_up')).isGun, false);
  assert.equal(G.analyzeHand(hand('right_hands', 0)).isGun, false); // open palm
  assert.equal(G.analyzeHand(hand('right_hands', 1)).isGun, false);
});

test('thumb up reads as cocked, thumb pressed on the hand reads as fired', () => {
  const { cockThreshold, fireThreshold } = G.CONFIG;
  assert.ok(G.thumbOpenness(hand('thumb_up')) > cockThreshold);
  assert.ok(G.thumbOpenness(hand('pointing_up')) < fireThreshold);
  assert.ok(G.thumbOpenness(hand('fist')) < fireThreshold);
});

test('trigger fires once when the thumb drops after being raised', () => {
  const trig = new G.TriggerDetector();
  const gun = (thumbOpen) => ({ isGun: true, thumbOpen });
  let t = 0;
  const step = (info) => trig.update(info, (t += 33));

  assert.equal(step(gun(0.2)), false, 'gun made with thumb already down must not fire');
  assert.equal(trig.state, 'aiming');
  assert.equal(step(gun(0.7)), false);
  assert.equal(trig.state, 'cocked');
  assert.equal(step(gun(0.45)), false, 'half-way down is not a shot');
  assert.equal(step(gun(0.2)), true, 'thumb down fires');
  assert.equal(step(gun(0.2)), false, 'holding the thumb down does not fire again');
  t += 400;
  assert.equal(step(gun(0.7)), false);
  assert.equal(step(gun(0.2)), true, 'cock and fire again');
});

test('trigger survives a short tracking dropout but resets after losing the gun', () => {
  const trig = new G.TriggerDetector();
  trig.update({ isGun: true, thumbOpen: 0.7 }, 0);
  trig.update(null, 100);
  assert.equal(trig.update({ isGun: true, thumbOpen: 0.2 }, 200), true);

  trig.update({ isGun: true, thumbOpen: 0.7 }, 1000);
  trig.update({ isGun: false, thumbOpen: 0.7 }, 1500);
  assert.equal(trig.state, 'idle');
  assert.equal(trig.update({ isGun: true, thumbOpen: 0.2 }, 1533), false);
});

test('trigger remembers when the thumb was last fully up, so a slow press aims from before it', () => {
  const trig = new G.TriggerDetector();
  // Thumb raised high: the press starts while it is still above the cock threshold.
  trig.update({ isGun: true, thumbOpen: 1.0 }, 0);
  trig.update({ isGun: true, thumbOpen: 1.02 }, 100); // tracking jitter
  trig.update({ isGun: true, thumbOpen: 0.85 }, 200); // press begins
  trig.update({ isGun: true, thumbOpen: 0.6 }, 300);
  trig.update({ isGun: true, thumbOpen: 0.45 }, 400);
  assert.equal(trig.update({ isGun: true, thumbOpen: 0.3 }, 500), true);
  assert.equal(trig.lastCockedAt, 100);
});

test('trigger enforces a minimum gap between shots', () => {
  const trig = new G.TriggerDetector();
  trig.update({ isGun: true, thumbOpen: 0.7 }, 0);
  assert.equal(trig.update({ isGun: true, thumbOpen: 0.2 }, 33), true);
  trig.update({ isGun: true, thumbOpen: 0.7 }, 66);
  assert.equal(trig.update({ isGun: true, thumbOpen: 0.2 }, 100), false);
  assert.equal(trig.update({ isGun: true, thumbOpen: 0.2 }, 500), true);
});

test('dwell fires after holding on one target and restarts when the target changes', () => {
  const dwell = new G.DwellDetector(1000);
  assert.deepEqual(dwell.update('a', 0), { progress: 0, fire: false });
  assert.equal(dwell.update('a', 500).progress, 0.5);
  assert.equal(dwell.update('a', 1000).fire, true);
  assert.equal(dwell.update('a', 1100).fire, false, 'fires only once per visit');
  dwell.update('b', 1200);
  assert.equal(dwell.update('b', 1700).fire, false);
  assert.equal(dwell.update('b', 2200).fire, true);
  assert.equal(dwell.update(null, 2300).progress, 0);
});

test('aim is mirrored and stretched from the central camera region', () => {
  const region = { x0: 0.2, x1: 0.8, y0: 0.1, y1: 0.7 };
  const center = G.mapAim({ x: 0.5, y: 0.4 }, region);
  assert.ok(Math.abs(center.x - 0.5) < 1e-9 && Math.abs(center.y - 0.5) < 1e-9);
  const right = G.mapAim({ x: 0.2, y: 0.1 }, region); // camera-left = user's right
  assert.equal(right.x, 1);
  assert.equal(right.y, 0);
  assert.deepEqual(G.mapAim({ x: 1.2, y: 1.5 }, region), { x: 0, y: 1 }, 'clamped to the screen');
});

test('one euro filter passes a constant through and smooths jitter', () => {
  const f = new G.OneEuroFilter(1, 0);
  assert.equal(f.filter(10, 0), 10);
  assert.equal(f.filter(10, 33), 10);
  const jittery = f.filter(11, 66);
  assert.ok(jittery > 10 && jittery < 11);
});

test('aim history returns the sample from just before the requested time', () => {
  const h = new G.AimHistory(500);
  h.push(0, 1, 1);
  h.push(100, 2, 2);
  h.push(200, 3, 3);
  assert.equal(h.at(150).x, 2);
  assert.equal(h.at(-50).x, 1, 'falls back to the oldest sample');
  h.push(900, 9, 9);
  assert.equal(h.samples.length, 1, 'old samples are dropped');
});
