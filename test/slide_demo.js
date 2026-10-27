// The same 3-fret slide (A string, fret 2 -> 5, then back) played many ways: soft, medium, hard, and the natural
// spread between repeats. usage: node test/slide_demo.js out.wav
const path = require('path');
require(path.join(__dirname, '../src/space.js')); require(path.join(__dirname, '../src/modal.js'));
require(path.join(__dirname, '../src/hand.js')); require(path.join(__dirname, '../src/strum.js'));
const { writeWav, convolve } = require('./render.js');
const SR = 48000;
let now = 0; const tq = []; global.setTimeout = (f, ms) => { tq.push({ t: now + (ms || 0) / 1000, f }); }; global.clearTimeout = () => {};
let seed = 17; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const eng = new GuitarEngine(SR), scene = { mics: 'fret12', room: 'living', guitar: { pos: [2.8, 2.6, 0.95], yaw: 0 } };
eng.setParams({ scene, build: { hold: 'seated' } });
const se = new StrumEngine({ send: (evs) => evs.forEach(e => eng.post(e)), now: () => now, rng: rnd, options: { skill: 0.5, legato: 'slide' } });
const plan = []; let t = 0.3;
// pairs: (start note, slide-to note, velocity of the slide-to key)
for (const v of [0.3, 0.3, 0.6, 0.6, 0.95, 0.95, 0.5, 0.75, 0.4, 0.85]) {
  plan.push({ t, on: 47, v: 0.7 }); plan.push({ t: t + 0.45, on: 50, v }); plan.push({ t: t + 0.49, off: 47 });
  plan.push({ t: t + 1.25, off: 50 }); t += 1.55;
}
const dur = t + 1.5, n = Math.round(dur * SR), L = new Float32Array(n), R = new Float32Array(n), F = new Float32Array(n), B = new Float32Array(n);
plan.sort((a, b) => a.t - b.t); let pos = 0, pi = 0;
while (pos < n) {
  now = pos / SR;
  while (pi < plan.length && plan[pi].t <= now) { const p = plan[pi++]; if (p.on) se.noteOn(p.on, p.v, now); else se.noteOff(p.off); }
  tq.sort((a, b) => a.t - b.t); while (tq.length && tq[0].t <= now) tq.shift().f();
  const blk = Math.min(128, n - pos); eng.render(L, R, blk, pos, F, B); pos += blk;
}
const ir = AcousticSpace.buildIRs(Object.assign({ hold: 'seated' }, scene), SR);
for (const [feed, side] of [[F, 'front'], [B, 'back']]) { const yl = convolve(feed, ir[side][0]), yr = convolve(feed, ir[side][1]); for (let i = 0; i < n; i++) { L[i] += yl[i] * 2; R[i] += yr[i] * 2; } }
let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
for (let i = 0; i < n; i++) { L[i] *= 0.85 / pk; R[i] *= 0.85 / pk; }
writeWav(process.argv[2], L, R, SR); console.log('slide demo', dur.toFixed(1), 's');
