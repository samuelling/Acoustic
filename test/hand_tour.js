// Right-hand styles: hold a chord progression through the strum engine in 'pattern' mode and render it.
// usage: node test/hand_tour.js out.wav '[{"style":"travis","bpm":100,"bars":2, "chords":[[43,47,50,55,59,67],...], "params":{...}}, ...]'
const path = require('path');
require(path.join(__dirname, '../src/space.js'));
require(path.join(__dirname, '../src/modal.js'));
require(path.join(__dirname, '../src/lines.js')); require(path.join(__dirname, '../src/hand.js'));
require(path.join(__dirname, '../src/strum.js'));
const { writeWav } = require('./render.js');
const SR = 48000;
const PROG = { G: [43, 47, 50, 55, 59, 67], C: [48, 52, 55, 60, 64], D: [50, 57, 62, 66], Em: [40, 47, 52, 55, 59, 64], Am: [45, 52, 57, 60, 64], E: [40, 47, 52, 56, 59, 64], F: [41, 48, 53, 57, 60, 65] };
function take(spec, seedBase) {
  let seed = seedBase; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let now = 0; const tq = [];
  global.setTimeout = (f, ms) => { tq.push({ t: now + (ms || 0) / 1000, f }); return tq.length; }; global.clearTimeout = () => {};
  const eng = new GuitarEngine(SR); eng.setParams(Object.assign({ scene: { mics: 'fret12' } }, spec.params || {}));
  const opts = Object.assign({ mode: 'pattern', voicing: 'guitarize', style: spec.style, bpm: spec.bpm, skill: spec.skill ?? 0.6, brushes: spec.brushes ?? 1 }, spec.options || {});
  const se = new StrumEngine({ send: (evs) => evs.forEach(e => eng.post(e)), now: () => now, options: opts, rng: rnd });
  const S = HAND_STYLES[spec.style], barLen = 60 / spec.bpm * (spec.barBeats || Math.max(4, S.beats >= 12 ? 12 : 4));
  const chords = (spec.chords || ['G', 'C', 'D', 'G']).map(c => typeof c === 'string' ? PROG[c] : c);
  const ev = []; let t = 0.15;
  for (const ch of chords) { ev.push({ on: t, off: t + barLen * (spec.bars || 1) - 0.03, ch, v: spec.vel ?? 0.7 }); t += barLen * (spec.bars || 1); }
  const dur = t + 2.2, n = Math.round(dur * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  let pos = 0, ei = 0; const offs = [];
  while (pos < n) {
    now = pos / SR;
    while (ei < ev.length && ev[ei].on <= now) { const e = ev[ei++]; e.ch.forEach(m => se.noteOn(m, e.v, now)); offs.push(e); }
    for (let i = offs.length - 1; i >= 0; i--) if (offs[i].off <= now) { offs[i].ch.forEach(m => se.noteOff(m)); offs.splice(i, 1); }
    tq.sort((a, b) => a.t - b.t);
    while (tq.length && tq[0].t <= now) tq.shift().f();
    const blk = Math.min(128, n - pos); eng.render(L, R, blk, pos); pos += blk;
  }
  return [L, R];
}
if (require.main === module) {
  const list = JSON.parse(process.argv[3]);
  const parts = list.map((p, i) => take(p, 7 + i));
  const gap = Math.round(0.6 * SR), total = parts.reduce((a, p) => a + p[0].length + gap, 0);
  const L = new Float32Array(total), R = new Float32Array(total); let o = 0, pk = 0;
  for (const [l, r] of parts) { L.set(l, o); R.set(r, o); o += l.length + gap; }
  for (let i = 0; i < total; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  for (let i = 0; i < total; i++) { L[i] *= 0.85 / pk; R[i] *= 0.85 / pk; }
  writeWav(process.argv[2], L, R, SR);
  console.log('hand tour', list.length, 'parts', (total / SR).toFixed(1), 's');
}
module.exports = { take };
