// Offline renderer: runs the exact DSP used in the browser and writes WAV files for analysis.
// usage: node test/render.js <scenario> <out.wav> [json-params]
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '../src/space.js'));
require(path.join(__dirname, process.env.ENGINE === 'legacy' ? 'legacy_waveguide.js' : '../src/modal.js'));

const SR = 48000;

function writeWav(file, L, R, sr) {
  // 32-bit float WAV so quiet tails are not buried in quantization noise
  const n = L.length, buf = Buffer.alloc(44 + n * 8);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 8, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 8, 28); buf.writeUInt16LE(8, 32); buf.writeUInt16LE(32, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 8, 40);
  for (let i = 0; i < n; i++) { buf.writeFloatLE(L[i], 44 + i * 8); buf.writeFloatLE(R[i], 48 + i * 8); }
  fs.writeFileSync(file, buf);
}

// FFT convolution of x with h (whole signal)
function convolve(x, h) {
  const { fft } = globalThis.AcousticSpace;
  let N = 1; while (N < x.length + h.length) N <<= 1;
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  ar.set(x); br.set(h); fft(ar, ai, false); fft(br, bi, false);
  for (let k = 0; k < N; k++) { const r = ar[k] * br[k] - ai[k] * bi[k], i = ar[k] * bi[k] + ai[k] * br[k]; ar[k] = r; ai[k] = i; }
  fft(ar, ai, true);
  return ar.subarray(0, x.length);
}

// Render events; with params.scene.room set, the room impulse responses are applied to the top/back feeds as the
// browser's ConvolverNodes would.
function render(events, seconds, params) {
  const eng = new GuitarEngine(SR);
  if (params) eng.setParams(params);
  for (const e of events) eng.post(e);
  const n = Math.round(seconds * SR), L = new Float32Array(n), R = new Float32Array(n);
  const F = new Float32Array(n), Bk = new Float32Array(n);
  const block = 128;
  for (let i = 0; i < n; i += block) eng.render(L, R, Math.min(block, n - i), i, F, Bk);
  const scene = params && params.scene;
  if (scene && scene.room) {
    const ir = globalThis.AcousticSpace.buildIRs(Object.assign({ hold: (params.build || {}).hold || 'seated' }, scene), SR);
    const wet = params.wet ?? 1;
    for (const [feed, side] of [[F, 'front'], [Bk, 'back']]) {
      const yl = convolve(feed, ir[side][0]), yr = convolve(feed, ir[side][1] && ir[side][1].some(v => v) ? ir[side][1] : ir[side][0]);
      for (let i = 0; i < n; i++) { L[i] += wet * yl[i] * 2.0; R[i] += wet * yr[i] * 2.0; }
    }
  }
  let peak = 0, nan = false;
  for (let i = 0; i < n; i++) { const a = Math.abs(L[i]); if (a > peak) peak = a; if (a !== a) nan = true; }
  return { L, R, peak, nan };
}

const scenarios = {
  // single note: midi on a given string
  note: (o) => [{ t: 0.05, type: 'pluck', s: o.s ?? 0, midi: o.midi ?? 40, vel: o.vel ?? 0.75, style: o.style ?? 'pick', pickPos: o.pickPos ?? 0.2, dir: 1 }],
  strumG: (o) => {
    const frets = [3, 2, 0, 0, 0, 3], open = [40, 45, 50, 55, 59, 64];
    return frets.map((f, i) => ({ t: 0.05 + i * 0.008, type: 'pluck', s: i, midi: open[i] + f, vel: 0.8 - i * 0.03, style: 'pick', pickPos: 0.2, dir: 1 }));
  },
};

if (require.main === module) {
  const [, , scen, out, json] = process.argv;
  const o = json ? JSON.parse(json) : {};
  const ev = scenarios[scen](o);
  const r = render(ev, o.seconds ?? 4, o.params);
  writeWav(out, r.L, r.R, SR);
  console.log(JSON.stringify({ out, peak: +r.peak.toFixed(4), nan: r.nan }));
}
module.exports = { render, writeWav, SR, scenarios, convolve };
