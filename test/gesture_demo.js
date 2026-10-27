// Fretting-hand sounds demo: chord changes with position shifts, then legato melody slides.
// usage: node test/gesture_demo.js out.wav '{"preset":"dreadnought","room":"living","skill":0.4}'
const path = require('path');
require(path.join(__dirname, '../src/space.js')); require(path.join(__dirname, '../src/modal.js'));
require(path.join(__dirname, '../src/hand.js')); require(path.join(__dirname, '../src/strum.js'));
const { writeWav, convolve } = require('./render.js');
const SR = 48000, o = JSON.parse(process.argv[3] || '{}');
let now = 0; const tq = []; global.setTimeout = (f, ms) => { tq.push({ t: now + (ms || 0) / 1000, f }); }; global.clearTimeout = () => {};
let seed = o.seed || 21; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const eng = new GuitarEngine(SR);
const scene = { mics: o.mics || 'fret12', room: o.room, guitar: { pos: [2.8, 2.6, 0.95], yaw: 0 } };
eng.setParams({ preset: o.preset || 'dreadnought', scene, build: { hold: 'seated' }, noise: o.noise ?? 0.5 });
const se = new StrumEngine({ send: (evs) => evs.forEach(e => eng.post(e)), now: () => now, rng: rnd,
  options: { voicing: 'guitarize', skill: o.skill ?? 0.4, mode: o.mode || 'pick', legato: 'slide' } });
const plan = []; let t = 0.2;
const chord = (notes, len, v = 0.7) => { plan.push({ t, on: notes, v }); plan.push({ t: t + len - 0.12, off: notes }); t += len; };
const note = (m, len, overlap, v = 0.65) => { plan.push({ t, on: [m], v }); plan.push({ t: t + len + (overlap ? 0.04 : -0.05), off: [m] }); t += len; };
if (o.part !== 'melody') {
  // open G -> barre B minor at fret 2 -> barre C at fret 3 -> D at fret 5 -> back down to G: shifts along the neck
  for (const [c, L] of [[[43, 47, 50, 55, 59, 67], 1.1], [[47, 54, 59, 62, 66], 1.1], [[48, 55, 60, 64, 67], 1.1], [[50, 57, 62, 66, 69], 1.1], [[43, 47, 50, 55, 59, 67], 1.6]]) chord(c, L);
  t += 0.4;
}
if (o.part !== 'chords') {
  // a slow line on the wound D and A strings with slides, then up on the B string
  for (const [m, L, lg] of [[52, 0.5, 0], [55, 0.45, 1], [57, 0.7, 1], [55, 0.4, 1], [52, 0.9, 0], [45, 0.5, 0], [47, 0.4, 1], [50, 0.9, 1],
                             [64, 0.5, 0], [67, 0.5, 1], [69, 0.8, 1], [71, 0.5, 1], [69, 1.2, 1]]) note(m, L, lg);
}
const dur = t + 2.0, n = Math.round(dur * SR), L = new Float32Array(n), R = new Float32Array(n), F = new Float32Array(n), B = new Float32Array(n);
let pos = 0, pi = 0; plan.sort((a, b) => a.t - b.t);
while (pos < n) {
  now = pos / SR;
  while (pi < plan.length && plan[pi].t <= now) { const p = plan[pi++]; if (p.on) p.on.forEach(m => se.noteOn(m, p.v, now)); else p.off.forEach(m => se.noteOff(m)); }
  tq.sort((a, b) => a.t - b.t); while (tq.length && tq[0].t <= now) tq.shift().f();
  const blk = Math.min(128, n - pos); eng.render(L, R, blk, pos, F, B); pos += blk;
}
if (scene.room) { const ir = AcousticSpace.buildIRs(Object.assign({ hold: 'seated' }, scene), SR);
  for (const [feed, side] of [[F, 'front'], [B, 'back']]) { const yl = convolve(feed, ir[side][0]), yr = convolve(feed, ir[side][1]); for (let i = 0; i < n; i++) { L[i] += yl[i] * 2; R[i] += yr[i] * 2; } } }
let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
for (let i = 0; i < n; i++) { L[i] *= 0.85 / pk; R[i] *= 0.85 / pk; }
writeWav(process.argv[2], L, R, SR); console.log('gesture demo', dur.toFixed(1), 's');
