// Legato demo: a phrase with hammer-ons, pull-offs, a trill and slides, played as overlapping single notes.
// usage: node test/legato_demo.js out.wav '{"preset":"dreadnought","room":"living"}'
const path = require('path');
require(path.join(__dirname, '../src/space.js')); require(path.join(__dirname, '../src/modal.js'));
require(path.join(__dirname, '../src/hand.js')); require(path.join(__dirname, '../src/strum.js'));
const { writeWav, convolve } = require('./render.js');
const SR = 48000, o = JSON.parse(process.argv[3] || '{}');
let now = 0; const tq = []; global.setTimeout = (f, ms) => { tq.push({ t: now + (ms || 0) / 1000, f }); }; global.clearTimeout = () => {};
let seed = o.seed || 4; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const eng = new GuitarEngine(SR), scene = { mics: 'fret12', room: o.room || 'living', guitar: { pos: [2.8, 2.6, 0.95], yaw: 0 } };
eng.setParams({ preset: o.preset || 'dreadnought', scene, build: { hold: 'seated' } });
const se = new StrumEngine({ send: (evs) => evs.forEach(e => eng.post(e)), now: () => now, rng: rnd, options: { skill: 0.7, legato: 'auto', mode: o.preset === 'classical' ? 'finger' : 'pick' } });
// [midi, length (s), velocity, legato into the next note?]
const line = [[50, 0.3, .7, 1], [52, 0.3, .55, 1], [54, 0.6, .55, 0],                       // hammer-ons up
  [57, 0.3, .7, 1], [55, 0.3, .55, 1], [54, 0.6, .5, 0],                                      // pull-offs down
  [55, 0.11, .7, 1], [57, .11, .5, 1], [55, .11, .5, 1], [57, .11, .5, 1], [55, .11, .5, 1], [57, .11, .5, 1], [55, .5, .5, 0],   // trill
  [52, 0.4, .7, 1], [59, 0.9, .7, 0],                                                         // slide up
  [59, 0.3, .75, 1], [57, 0.3, .5, 1], [55, 0.3, .5, 1], [52, 1.2, .6, 0]];                    // descending legato
const plan = []; let t = 0.3;
for (const [m, len, v, lg] of line) { plan.push({ t, on: m, v }); plan.push({ t: t + len + (lg ? 0.03 : -0.04), off: m }); t += len; }
const dur = t + 2, n = Math.round(dur * SR), L = new Float32Array(n), R = new Float32Array(n), F = new Float32Array(n), B = new Float32Array(n);
plan.sort((a, b) => a.t - b.t || (a.on ? -1 : 1)); let pos = 0, pi = 0;
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
writeWav(process.argv[2], L, R, SR); console.log('legato demo', dur.toFixed(1), 's');
