// Render a strummed progression through the real strum engine + DSP, with a .strums label file.
// usage: node test/render_strums.js out.wav out.strums [bpm]
const fs = require('fs'), path = require('path');
require(path.join(__dirname, '../src/space.js'));
require(path.join(__dirname, process.env.ENGINE === 'legacy' ? 'legacy_waveguide.js' : '../src/modal.js'));
require(path.join(__dirname, '../src/strum.js'));
const { writeWav } = require('./render.js');
const SR = 48000, bpm = +(process.argv[4] || 100), e8 = 60 / bpm / 2;
let now = 0; const tq = [];
global.setTimeout = (f, ms) => { tq.push({ t: now + (ms || 0) / 1000, f }); return tq.length; };
global.clearTimeout = () => {};
const eng = new GuitarEngine(SR);
const labels = [];
const se = new StrumEngine({ send: (evs) => { for (const e of evs) { eng.post(e); if (e.type === 'pluck' && !labels.find(l => Math.abs(l.t - e.t) < 0.08)) labels.push({ t: e.t, d: e.dir > 0 ? 'D' : 'U' }); } }, now: () => now, options: { voicing: 'played' } });
const C = [48, 52, 55, 60, 64], G = [43, 47, 50, 55, 59, 67], Am = [45, 52, 57, 60, 64], F = [41, 48, 53, 57, 60, 65];
const evs = []; let t = 0.3;
// pattern per bar: D . D U . U D U  (8ths)
const pat = [1, 0, 1, 1, 0, 1, 1, 1];
for (let bar = 0; bar < 8; bar++) {
  const ch = [C, G, Am, F][bar % 4];
  pat.forEach((on, i) => { if (on) evs.push({ t: t + i * e8 + (Math.random() - 0.5) * 0.01, ch, vel: i % 2 ? 0.62 : 0.8 }); });
  t += 8 * e8;
}
const total = t + 2;
const n = Math.round(total * SR), L = new Float32Array(n), R = new Float32Array(n);
let pos = 0, ei = 0;
const held = [];
while (pos < n) {
  now = pos / SR;
  while (ei < evs.length && evs[ei].t <= now) { const e = evs[ei++]; for (const h of held.splice(0)) se.noteOff(h); e.ch.forEach(m => se.noteOn(m, e.vel, now)); held.push(...e.ch); setTimeout(() => {}, 0); }
  // release keys 70% into the eighth (keyboard-like detache)
  for (let i = tq.length - 1; i >= 0; i--) if (tq[i].t <= now) { const q = tq.splice(i, 1)[0]; q.f(); }
  const blk = Math.min(128, n - pos);
  eng.render(L, R, blk, pos); pos += blk;
}
let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]));
for (let i = 0; i < n; i++) { L[i] /= peak * 1.1; R[i] /= peak * 1.1; }
writeWav(process.argv[2], L, R, SR);
fs.writeFileSync(process.argv[3], labels.sort((a, b) => a.t - b.t).map(l => `${l.t.toFixed(4)}\t${l.d}\tN`).join('\n') + '\n');
console.log('strums', labels.length, 'D', labels.filter(l => l.d === 'D').length, 'U', labels.filter(l => l.d === 'U').length);
