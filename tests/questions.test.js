const test = require('node:test');
const assert = require('node:assert/strict');
const { makeQuestion, makeQuestionSet, makeDistractors } = require('../js/questions.js');

// Small deterministic PRNG so failures are reproducible.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('questions use two-digit numbers and have 4 distinct choices including the answer', () => {
  const rng = seeded(1);
  for (let i = 0; i < 5000; i++) {
    const q = makeQuestion(rng);
    assert.ok(q.a >= 10 && q.a <= 99, `a=${q.a}`);
    assert.ok(q.b >= 10 && q.b <= 99, `b=${q.b}`);
    assert.equal(q.answer, q.a + q.b);
    assert.equal(q.choices.length, 4);
    assert.equal(new Set(q.choices).size, 4, `duplicate choices ${q.choices}`);
    assert.equal(q.choices.filter((c) => c === q.answer).length, 1);
    assert.ok(q.choices.every((c) => Number.isInteger(c) && c > 0), `bad choice in ${q.choices}`);
  }
});

test('every pair of operands gets valid distractors', () => {
  for (let a = 10; a <= 99; a++) {
    for (let b = 10; b <= 99; b++) {
      const d = makeDistractors(a, b, seeded(a * 100 + b));
      assert.equal(d.length, 3);
      assert.equal(new Set([a + b, ...d]).size, 4);
    }
  }
});

test('the first distractor is the carry mistake', () => {
  assert.equal(makeDistractors(47, 38, seeded(2))[0], 75); // forgot to carry: 85 - 10
  assert.equal(makeDistractors(42, 31, seeded(2))[0], 83); // no carry needed: 73 + 10
});

test('the correct answer lands in every position', () => {
  const rng = seeded(3);
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const q = makeQuestion(rng);
    seen.add(q.choices.indexOf(q.answer));
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
});

test('a question set has no repeated pairs', () => {
  const set = makeQuestionSet(10, seeded(4));
  assert.equal(set.length, 10);
  const keys = set.map((q) => [q.a, q.b].sort().join('+'));
  assert.equal(new Set(keys).size, 10);
});
