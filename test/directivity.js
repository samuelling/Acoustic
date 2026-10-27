// Measure the synth's own radiation pattern the way the TU Berlin lab measured a real guitar, and compare.
// An omni mic sits 2.06 m from the guitar in each of the 32 measured directions (anechoic, no room); the guitar plays
// single notes across its range at fortissimo; octave- and third-octave-band energies are normalized per band to a
// power average of 0 dB over the sphere, exactly as proto/directivity.py does for the measurement.
// usage: node test/directivity.js [preset] [hold] [--write]   (--write stores the correction table in data/)
const fs = require('fs'), path = require('path');
require(path.join(__dirname, '../src/space.js'));
require(path.join(__dirname, '../src/modal.js'));
const S = globalThis.AcousticSpace;
const SR = 48000;
const meas = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/guitar_directivity_measured.json')));
const preset = process.argv[2] || 'classical', hold = process.argv[3] || 'seated', write = process.argv.includes('--write');
const raw = process.env.RAW === '1' || write;   // the correction is always derived from the uncorrected model
const C0 = S.ACOUSTIC_CENTER;
const dirs = meas.dirs, W = meas.weights, R = meas.radius;

// notes E2..B5, each on the highest string that reaches it
const OPEN = [40, 45, 50, 55, 59, 64];
const notes = []; for (let m = 40; m <= 83; m += 3) notes.push(m);
const NOTE_T = 1.1, LEN = 1 << 20; // 21.8 s
const events = notes.map((m, i) => { let s = 0; for (let k = 0; k < 6; k++) if (OPEN[k] <= m && m - OPEN[k] <= 19) s = k; return { t: 0.05 + i * NOTE_T, type: 'pluck', s, midi: m, vel: 0.95, style: 'finger', pickPos: 0.18, dir: 1 }; });

function bandEnergies(x, centres, frac) {
  const re = new Float64Array(LEN), im = new Float64Array(LEN);
  re.set(x.subarray(0, Math.min(LEN, x.length))); S.fft(re, im, false);
  return centres.map(fc => {
    const lo = fc / 2 ** (frac / 2), hi = fc * 2 ** (frac / 2);
    let e = 0; for (let k = Math.ceil(lo * LEN / SR); k <= Math.floor(hi * LEN / SR); k++) e += re[k] * re[k] + im[k] * im[k];
    return e;
  });
}
function render(mics, preset) {
  const eng = new GuitarEngine(SR);
  eng.setParams({ preset, build: { hold }, scene: { mics: { mics }, rawRadiation: raw } });
  for (const e of events) eng.post(e);
  const n = LEN, L = new Float32Array(n), Rr = new Float32Array(n), F = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i += 128) eng.render(L, Rr, Math.min(128, n - i), i, F, B);
  return { L, R: Rr, F, B, norm: S.micNorm({ mics: { mics } }) };
}
const OCT = meas.octaves, TH = meas.thirds.filter(f => f >= 100);
const norm = (E) => { const nb = E[0].length, out = E.map(r => r.slice());
  for (let b = 0; b < nb; b++) { let m = 0; for (let j = 0; j < E.length; j++) m += W[j] * E[j][b]; for (let j = 0; j < E.length; j++) out[j][b] = 10 * Math.log10(E[j][b] / m); }
  return out; };
function measureModel(preset) {
const model = { oct: [], th: [] };
let feeds = null;
for (let i = 0; i < dirs.length; i += 2) {
  const mk = (u) => ({ p: [C0[0] + R * u[0], C0[1] + R * u[1], C0[2] + R * u[2]], aim: C0, pattern: 'omni' });
  const r = render([mk(dirs[i]), mk(dirs[i + 1])], preset);
  for (const [ch, j] of [[r.L, i], [r.R, i + 1]]) {
    model.oct[j] = bandEnergies(ch, OCT, 1).map(e => e / (r.norm * r.norm));
    model.th[j] = bandEnergies(ch, TH, 1 / 3).map(e => e / (r.norm * r.norm));
  }
  if (!feeds) feeds = { F: bandEnergies(r.F, OCT, 1), B: bandEnergies(r.B, OCT, 1) };
  process.stderr.write('.');
}
process.stderr.write('\n');
return { oct: norm(model.oct), th: norm(model.th), rho: OCT.map((_, b) => feeds.B[b] / feeds.F[b]) };
}
const M = measureModel(preset), mOct = M.oct, mTh = M.th;
const xOct = meas.octave_db, thIdx = TH.map(f => meas.thirds.indexOf(f)), xTh = meas.third_db.map(r => thIdx.map(k => r[k]));

function regions(db, label) {
  const sets = [['front', u => u[2] > 0.3], ['side', u => Math.abs(u[2]) <= 0.3], ['back', u => u[2] < -0.3], ['neck', u => u[0] > 0.5], ['tail', u => u[0] < -0.5]];
  for (const [name, f] of sets) {
    const row = OCT.map((_, b) => { let s = 0, w = 0; dirs.forEach((u, j) => { if (f(u)) { s += W[j] * 10 ** (db[j][b] / 10); w += W[j]; } }); return (10 * Math.log10(s / w)).toFixed(1).padStart(6); });
    console.log(`${label} ${name.padEnd(6)}${row.join(' ')}`);
  }
}
console.log(`preset ${preset}, hold ${hold}${raw ? ' (raw model)' : ''}`);
console.log('octave       ' + OCT.map(f => String(f).padStart(6)).join(' '));
regions(xOct, 'measured');
regions(mOct, 'model   ');
const err = OCT.map((_, b) => Math.sqrt(dirs.reduce((s, u, j) => s + W[j] * (mOct[j][b] - xOct[j][b]) ** 2, 0)));
console.log('rms error dB ' + err.map(e => e.toFixed(1).padStart(6)).join(' '));
const corr = (a, b) => { const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); };
console.log('pattern corr ' + OCT.map((_, b) => corr(mOct.map(r => r[b]), xOct.map(r => r[b])).toFixed(2).padStart(6)).join(' '));
const thErr = TH.map((_, b) => Math.sqrt(dirs.reduce((s, u, j) => s + W[j] * (mTh[j][b] - xTh[j][b]) ** 2, 0)));
console.log('third-octave rms error: ' + TH.map((f, b) => `${f}:${thErr[b].toFixed(1)}`).join(' '));
const rho = M.rho;
console.log('back/top feed power ratio dB ' + rho.map(x => (10 * Math.log10(x)).toFixed(1)).join(' '));
if (write) {
  // the systematic part only: average measured-minus-model over the three bodies (each keeps its own fine lobes;
  // space.js also interpolates the correction with a wide kernel)
  const bodies = ['classical', 'dreadnought', 'parlor'], Ms = { [preset]: M };
  for (const b of bodies) if (!Ms[b]) { console.log('measuring', b); Ms[b] = measureModel(b); }
  const corr = xOct.map((r, j) => r.map((x, b) => bodies.reduce((s, k) => s + x - Ms[k].oct[j][b], 0) / bodies.length));
  const rhoAvg = OCT.map((_, b) => Math.pow(10, bodies.reduce((s, k) => s + Math.log10(Ms[k].rho[b]), 0) / bodies.length));
  const out = { note: 'measured minus model (mean over bodies), dB, per measured direction (guitar-local) and octave band; see test/directivity.js',
    bodies, hold, octaves: OCT, corr_db: corr.map(r => r.map(x => +x.toFixed(2))),
    backFeedRatio: rhoAvg.map(x => +x.toPrecision(3)) };
  fs.writeFileSync(path.join(__dirname, '../data/directivity_correction.json'), JSON.stringify(out));
  console.log('wrote data/directivity_correction.json');
  // embed in src/space.js between the <directivity-data> markers
  const sp = path.join(__dirname, '../src/space.js'), src = fs.readFileSync(sp, 'utf8');
  const r2 = (a) => a.map(r => r.map(x => +x.toFixed(2)));
  const block = '// <directivity-data>\nconst DIR = ' + JSON.stringify({ dirs: dirs.map(u => u.map(x => +x.toFixed(4))), db: r2(xOct), corr: r2(out.corr_db), backFeed: out.backFeedRatio }) + ';\n// </directivity-data>';
  fs.writeFileSync(sp, src.replace(/\/\/ <directivity-data>[\s\S]*?\/\/ <\/directivity-data>/, block));
  console.log('updated src/space.js');
}
{ // the two poles (straight out of the top / straight out of the back): model vs measured
  let bi = 0, fi = 0; dirs.forEach((u, j) => { if (u[2] < dirs[bi][2]) bi = j; if (u[2] > dirs[fi][2]) fi = j; });
  const p = (n, a) => console.log(n.padEnd(16) + a.map(v => v.toFixed(1).padStart(6)).join(' '));
  p('front pole meas', xOct[fi]); p('front pole model', mOct[fi]); p('back pole meas', xOct[bi]); p('back pole model', mOct[bi]);
}
