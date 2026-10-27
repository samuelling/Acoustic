// A/B demo: the same performance through the strum engine and a chosen DSP engine.
// usage: ENGINE=legacy|modal node test/demo.js out.wav
const path = require('path');
require(path.join(__dirname, process.env.ENGINE === 'legacy' ? 'legacy_waveguide.js' : '../src/modal.js'));
require(path.join(__dirname, '../src/strum.js'));
const { writeWav } = require('./render.js');
const SR = 48000;
let seed = 7; Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647; // same humanization both runs
let now = 0; const tq = [];
global.setTimeout = (f, ms) => { tq.push({ t: now + (ms || 0) / 1000, f }); return tq.length; }; global.clearTimeout = () => {};
const eng = new GuitarEngine(SR);
const se = new StrumEngine({ send: (evs) => evs.forEach(e => eng.post(e)), now: () => now, options: { voicing: 'played' }, rng: Math.random });
const ev = []; // {t, notes, vel, dur, mode}
const C = [48, 52, 55, 60, 64], G = [43, 47, 50, 55, 59, 67], Am = [45, 52, 57, 60, 64], F = [41, 48, 53, 57, 60, 65], Em = [40, 47, 52, 55, 59, 64];
let t = 0.4; const e8 = 0.3;
// single notes: open low E, D, high E
for (const m of [40, 50, 64]) { ev.push({ t, notes: [m], vel: 0.75, dur: 1.8, mode: 'pick' }); t += 2.0; }
// strummed progression, D D U U D U
for (const ch of [C, G, Am, F]) {
  [[0, .85], [2, .7], [3, .6], [5, .6], [6, .8], [7, .62]].forEach(([i, v]) => ev.push({ t: t + i * e8, notes: ch, vel: v, dur: e8 * 0.9, mode: 'pick' }));
  t += 8 * e8;
}
ev.push({ t, notes: Em, vel: 0.9, dur: 3.5, mode: 'pick' }); t += 4.0;
// fingerpicked arpeggio over C and Am: bass + treble notes, let ring
for (const [bass, up] of [[48, [55, 60, 64, 60]], [45, [52, 57, 60, 57]], [43, [50, 55, 59, 55]], [48, [55, 60, 64, 67]]]) {
  ev.push({ t, notes: [bass], vel: 0.7, dur: 2.2, mode: 'finger' });
  up.forEach((m, i) => ev.push({ t: t + (i + 1) * 0.26, notes: [m], vel: 0.55, dur: 1.4, mode: 'finger' }));
  t += 1.3;
}
t += 3;
const n = Math.round(t * SR), L = new Float32Array(n), R = new Float32Array(n);
let pos = 0, ei = 0; const offs = [];
ev.sort((a, b) => a.t - b.t);
while (pos < n) {
  now = pos / SR;
  while (ei < ev.length && ev[ei].t <= now) {
    const e = ev[ei++]; se.set({ mode: e.mode, letRing: e.mode === 'finger' });
    e.notes.forEach(m => se.noteOn(m, e.vel, now)); offs.push({ t: now + e.dur, notes: e.notes });
  }
  for (let i = offs.length - 1; i >= 0; i--) if (offs[i].t <= now) { offs[i].notes.forEach(m => se.noteOff(m)); offs.splice(i, 1); }
  for (let i = tq.length - 1; i >= 0; i--) if (tq[i].t <= now) { const q = tq.splice(i, 1)[0]; q.f(); }
  const blk = Math.min(128, n - pos); eng.render(L, R, blk, pos); pos += blk;
}
let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
for (let i = 0; i < n; i++) { L[i] *= 0.8 / pk; R[i] *= 0.8 / pk; }
writeWav(process.argv[2], L, R, SR);
console.log('rendered', t.toFixed(1), 's');
