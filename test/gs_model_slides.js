// Render GuitarSet's real slides through the synth (same string, frets and timing) for gs_squeak.py --model.
// usage: node test/gs_model_slides.js <slides.json> <outdir> [max] [params-json]
const fs = require('fs'), path = require('path');
require(path.join(__dirname, '../src/space.js')); require(path.join(__dirname, '../src/modal.js'));
const { writeWav } = require('./render.js');
const [, , sj, outdir, maxN, pj] = process.argv;
const slides = JSON.parse(fs.readFileSync(sj)), params = pj ? JSON.parse(pj) : {};
const SR = 44100, OPEN = [40, 45, 50, 55];
let k = 0;
const pick = slides.filter((s, i) => i % Math.max(1, Math.floor(slides.length / (+maxN || 120))) === 0).slice(0, +maxN || 120);
for (const sl of pick) {
  const eng = new GuitarEngine(SR);
  eng.setParams(Object.assign({ scene: { mics: 'fret12' } }, params));
  const a = Math.round(sl.from), b = Math.round(sl.to), dur = sl.t1 - sl.t0;
  if (a < 1 || b < 1 || a === b) continue;
  eng.post({ t: 0.05, type: 'pluck', s: sl.string, midi: OPEN[sl.string] + a, vel: 0.7, style: 'pick' });
  eng.post({ t: 0.6, type: 'glide', s: sl.string, from: OPEN[sl.string] + a, to: OPEN[sl.string] + b, dur, skew: 0.5, pressure: 0.75 });
  // log the synth's own pitch track (fret steps as they happen) for the analysis mask
  const steps = [[0, a]], fs0 = eng.fretStep.bind(eng);
  eng.fretStep = (ev) => { steps.push([eng.clock / SR, a + ev.shift]); fs0(ev); };
  const n = Math.round((0.6 + dur + 0.5) * SR), L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i += 128) eng.render(L, R, Math.min(128, n - i), i);
  const base = `${sl.file}_${sl.t0.toFixed(3)}`;
  writeWav(path.join(outdir, base + '.wav'), L, R, SR);
  fs.writeFileSync(path.join(outdir, base + '.json'), JSON.stringify({ string: sl.string, steps }));
  k++;
}
console.log('rendered', k, 'model slides');
