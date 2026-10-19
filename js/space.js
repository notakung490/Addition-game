// Starfield for the space background. Each star layer is a single 1px element
// whose box-shadows are the stars, so twinkling is just an opacity animation
// on three elements and costs almost nothing next to the hand tracking.
(function () {
  'use strict';

  const LAYERS = [
    { selector: '.stars-far', perMegapixel: 260 },
    { selector: '.stars-mid', perMegapixel: 70 },
    { selector: '.stars-near', perMegapixel: 22 },
  ];
  const COLORS = ['#ffffff', '#ffffff', '#ffffff', '#cfe0ff', '#ffe7c2', '#e9d5ff'];

  function paint() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const { selector, perMegapixel } of LAYERS) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const count = Math.round((w * h * perMegapixel) / 1e6);
      const stars = [];
      for (let i = 0; i < count; i++) {
        const color = COLORS[Math.floor(Math.random() * COLORS.length)];
        stars.push(`${Math.round(Math.random() * w)}px ${Math.round(Math.random() * h)}px ${color}`);
      }
      el.style.boxShadow = stars.join(',');
    }
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(paint, 200);
  });
  paint();
})();
