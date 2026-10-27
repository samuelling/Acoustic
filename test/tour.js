// Audio tour: one short phrase rendered under several settings, concatenated with gaps.
// usage: node test/tour.js out.wav '<json array of params objects>'
const path = require('path');
require(path.join(__dirname, '../src/space.js'));
require(path.join(__dirname, '../src/modal.js'));
require(path.join(__dirname, '../src/strum.js'));
const { writeWav, convolve } = require('./render.js');
const SR = 48000;
function phrase(params) {
  let seed = 11; Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let now = 0; const tq = [];
  global.setTimeout = (f, ms) => { tq.push({ t: now + (ms || 0) / 1000, f }); return tq.length; }; global.clearTimeout = () => {};
  const eng = new GuitarEngine(SR); eng.setParams(params);
  const se = new StrumEngine({ send: (evs) => evs.forEach(e => eng.post(e)), now: () => now, options: { voicing: 'played' }, rng: Math.random });
  const C = [48, 52, 55, 60, 64], G = [43, 47, 50, 55, 59, 67], Am = [45, 52, 57, 60, 64], Em = [40, 47, 52, 55, 59, 64];
  const ev = []; let t = 0.2; const e8 = 0.27;
  for (const ch of [C, G, Am]) { [[0, .85], [2, .7], [3, .6], [5, .62], [6, .8], [7, .6]].forEach(([i, v]) => ev.push({ t: t + i * e8, ch, v, d: e8 * 0.9 })); t += 8 * e8; }
  ev.push({ t, ch: Em, v: 0.85, d: 2.2 }); t += 0.7;
  for (const m of [64, 67, 71]) { ev.push({ t, ch: [m], v: 0.6, d: 1.4 }); t += 0.3; }
  const rtTail = params.scene && params.scene.room ? Math.max(...AcousticSpace.eyring(AcousticSpace.ROOMS[params.scene.room]).rt.slice(2, 5)) * 0.9 : 0;
  const dur = t + Math.max(2.6, rtTail), n = Math.round(dur * SR);
  const L = new Float32Array(n), R = new Float32Array(n), F = new Float32Array(n), B = new Float32Array(n);
  let pos = 0, ei = 0; const offs = [];
  while (pos < n) {
    now = pos / SR;
    while (ei < ev.length && ev[ei].t <= now) { const e = ev[ei++]; e.ch.forEach(m => se.noteOn(m, e.v, now)); offs.push({ t: now + e.d, ch: e.ch }); }
    for (let i = offs.length - 1; i >= 0; i--) if (offs[i].t <= now) { offs[i].ch.forEach(m => se.noteOff(m)); offs.splice(i, 1); }
    for (let i = tq.length - 1; i >= 0; i--) if (tq[i].t <= now) { const q = tq.splice(i, 1)[0]; q.f(); }
    const blk = Math.min(128, n - pos); eng.render(L, R, blk, pos, F, B); pos += blk;
  }
  const sc = params.scene;
  if (sc && sc.room) {
    const ir = AcousticSpace.buildIRs(Object.assign({ hold: (params.build || {}).hold || 'seated' }, sc), SR);
    for (const [feed, side] of [[F, 'front'], [B, 'back']]) {
      const yl = convolve(feed, ir[side][0]), yr = convolve(feed, ir[side][1]);
      for (let i = 0; i < n; i++) { L[i] += yl[i] * 2.0; R[i] += yr[i] * 2.0; }
    }
  }
  return [L, R];
}
const list = JSON.parse(process.argv[3]);
const parts = list.map(p => phrase(p));
const gap = Math.round(0.5 * SR);
const total = parts.reduce((a, p) => a + p[0].length + gap, 0);
const L = new Float32Array(total), R = new Float32Array(total);
let o = 0, pk = 0;
for (const [l, r] of parts) { L.set(l, o); R.set(r, o); o += l.length + gap; }
for (let i = 0; i < total; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
for (let i = 0; i < total; i++) { L[i] *= 0.85 / pk; R[i] *= 0.85 / pk; }
writeWav(process.argv[2], L, R, SR);
console.log('tour', list.length, 'parts', (total / SR).toFixed(1), 's');
