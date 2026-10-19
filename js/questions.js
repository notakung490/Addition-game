// Two-digit addition questions with 4 multiple-choice answers.
// Works both in the browser (window.MathQuestions) and in Node (require) for tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MathQuestions = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 10;
  const MAX = 99;
  const CHOICES = 4;

  function randInt(rng, min, max) {
    return min + Math.floor(rng() * (max - min + 1));
  }

  function shuffle(list, rng) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Wrong answers that look like real mistakes, so the right one can't be
  // spotted without actually adding:
  //  1. the carry mistake (forgot to carry, or carried when there was nothing to carry)
  //  2. a tens-digit slip (same ones digit as the answer)
  //  3. a ones-digit slip
  function makeDistractors(a, b, rng) {
    const answer = a + b;
    const hasCarry = (a % 10) + (b % 10) >= 10;
    const groups = [
      [hasCarry ? answer - 10 : answer + 10],
      shuffle([answer + 10, answer - 10, answer + 20, answer - 20], rng),
      shuffle([answer + 1, answer - 1, answer + 2, answer - 2, answer + 9, answer - 9, answer + 11, answer - 11], rng),
    ];
    const picked = [];
    const ok = (v) => v > 0 && v !== answer && !picked.includes(v);
    for (const group of groups) {
      const v = group.find(ok);
      if (v !== undefined) picked.push(v);
    }
    // Safety net; the groups above always provide enough for sums of 20..198.
    for (let d = 3; picked.length < CHOICES - 1; d++) {
      if (ok(answer + d)) picked.push(answer + d);
    }
    return picked;
  }

  function makeQuestion(rng = Math.random) {
    const a = randInt(rng, MIN, MAX);
    const b = randInt(rng, MIN, MAX);
    const answer = a + b;
    const choices = shuffle([answer, ...makeDistractors(a, b, rng)], rng);
    return { a, b, answer, choices };
  }

  // A game's worth of questions with no repeated pair (a + b and b + a count as the same).
  function makeQuestionSet(count, rng = Math.random) {
    const seen = new Set();
    const set = [];
    while (set.length < count) {
      const q = makeQuestion(rng);
      const key = Math.min(q.a, q.b) + '+' + Math.max(q.a, q.b);
      if (seen.has(key)) continue;
      seen.add(key);
      set.push(q);
    }
    return set;
  }

  return { makeQuestion, makeQuestionSet, makeDistractors, MIN, MAX, CHOICES };
});
