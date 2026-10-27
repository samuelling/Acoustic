// Acoustic — coupled string/body modal guitar engine.
// Runs in an AudioWorklet, on the main thread (ScriptProcessor fallback), or in Node for offline tests.
//
// Each string is a sum of its transverse modes, two per partial (one per polarization). Nothing about a mode's
// decay or pitch is hand-tuned: both come from physics evaluated at that mode's frequency.
//
//   frequency     f_k = k f0 sqrt(1 + B k^2),   B = pi^3 E d_core^4 / (64 T L^2)       (bending stiffness)
//   intrinsic     sigma_int = pi f (Q_air^-1 + Q_ve^-1 + Q_te^-1)                       (Valette & Cuesta)
//   bridge        ds = -(T/L) Y2(w_k)  (2x2, y = along the top, z = into it)            (Gough; Woodhouse)
//                 eig(ds) -> two complex shifts per partial: their real parts are the energy the bridge drains,
//                 their imaginary parts the pitch pull; eigenvectors say how the polarizations mix.
//   body          Y2(w) = sum_k  i w / (m_k (w_k^2 - w^2 + i w w_k / Q_k)) * r_k r_k^T  over body modes.
//
// The same body modes that drain the strings also radiate: the bridge force drives each body mode as a
// resonator, and their velocities are summed with radiation weights into two mic signals.
// A pick or finger loads the string sideways before it slips off; the force the bridge carried during that
// push vanishes at release, which rings the body's air and top modes (the "thump" under every note).

(function (root) {
'use strict';
const TAU = Math.PI * 2;

// ---------------- instrument data ----------------
// strings (low E first): T newtons at standard pitch, mu kg/m, EI N m^2, wound,
//   Woodhouse damping: etaF (string friction), etaB new / used (bending loss; dirt in old windings raises it),
//   etaA (air, per rad/s), EA axial stiffness N
// Steel: D'Addario EJ16 tensions and unit weights; damping and EI from Woodhouse et al. 2012 (80/20 bronze).
// Nylon: D'Addario EJ45 normal tension; damping and inharmonicity from Woodhouse et al. 2012 (Pro Arte).
const PRESETS = {
  dreadnought: {
    name: 'Steel dreadnought', scale: 0.645,
    strings: [
      { T: 111, mu: 10.18e-3, EI: 534e-6, wound: 1, etaF: 5e-5, etaBn: 0.3e-2, etaBu: 3.8e-2, etaA: 1.7, EA: 29000 },
      { T: 129, mu: 6.554e-3, EI: 262e-6, wound: 1, etaF: 11e-5, etaBn: 0.4e-2, etaBu: 2.9e-2, etaA: 1.2, EA: 22700 },
      { T: 133, mu: 3.750e-3, EI: 204e-6, wound: 1, etaF: 9e-5, etaBn: 1.1e-2, etaBu: 4.1e-2, etaA: 1.3, EA: 17100 },
      { T: 134, mu: 2.089e-3, EI: 187e-6, wound: 1, etaF: 11e-5, etaBn: 1.8e-2, etaBu: 6.8e-2, etaA: 1.2, EA: 12300 },
      { T: 104, mu: 1.018e-3, EI: 267e-6, wound: 0, etaF: 6e-5, etaBn: 1.1e-2, etaBu: 1.1e-2, etaA: 1.0, EA: 25900 },
      { T: 104, mu: 0.572e-3, EI: 85e-6, wound: 0, etaF: 7e-5, etaBn: 0.7e-2, etaBu: 0.7e-2, etaA: 2.5, EA: 14600 }],
    damp: { fretted: 0.25 }, polDetune: 0.0016, airScale: 0.75, plainEtaF: 3.6e-4,
    body: {
      // f Hz, Q, effective mass kg normal to the top at the bridge, bridge-motion angle deg, radiation (1 monopole, small for dipoles)
      // Steel-string data: Russell (Hummingbird 103/188/203 Hz), Popp & Rossing (D-28: 102, 193-204 monopoles,
      // 376 dipole, 436 quadrupole); masses from mass-loading studies (Christensen; Iulius), Woodhouse 2004.
      // + share of the mode's motion in the back (0 top .. 1 back) + radiation pattern over the body regions
      modes: [[100, 26, 0.6, 2, 0.4, 0.3, 'A0'], [193, 32, 0.19, 6, 1.0, 0.15, 'T11a'], [204, 34, 0.24, -8, 0.9, 0.35, 'T11b'],
              [228, 40, 0.42, 14, 0.5, 0.8, 'back'], [292, 34, 0.7, 28, 0.55, 0.2, 'xdip'], [376, 36, 0.6, 32, 0.5, 0.15, 'ldip'],
              [436, 36, 0.8, -30, 0.45, 0.2, 'quad']],
      // above ~480 Hz: statistical modes (Woodhouse): Rayleigh spacing, uniform Q, log-normal masses
      hf: { f0: 480, f1: 9500, spacing: 38, qlo: 30, qhi: 80, mMed: 2.4, mSpread: 0.9, angSd: 30, seed: 3 },
      radFc: 250
    },
    radHP: 88, air: 11000, out: 9.0, lonQ: 350, lonGain: 0.05
  },
  parlor: {
    name: 'Steel parlor', scale: 0.62,
    strings: [
      { T: 103, mu: 10.18e-3, EI: 534e-6, wound: 1, etaF: 5e-5, etaBn: 0.3e-2, etaBu: 3.8e-2, etaA: 1.7, EA: 29000 },
      { T: 119, mu: 6.554e-3, EI: 262e-6, wound: 1, etaF: 11e-5, etaBn: 0.4e-2, etaBu: 2.9e-2, etaA: 1.2, EA: 22700 },
      { T: 123, mu: 3.750e-3, EI: 204e-6, wound: 1, etaF: 9e-5, etaBn: 1.1e-2, etaBu: 4.1e-2, etaA: 1.3, EA: 17100 },
      { T: 124, mu: 2.089e-3, EI: 187e-6, wound: 1, etaF: 11e-5, etaBn: 1.8e-2, etaBu: 6.8e-2, etaA: 1.2, EA: 12300 },
      { T: 96, mu: 1.018e-3, EI: 267e-6, wound: 0, etaF: 6e-5, etaBn: 1.1e-2, etaBu: 1.1e-2, etaA: 1.0, EA: 25900 },
      { T: 96, mu: 0.572e-3, EI: 85e-6, wound: 0, etaF: 7e-5, etaBn: 0.7e-2, etaBu: 0.7e-2, etaA: 2.5, EA: 14600 }],
    damp: { fretted: 0.25 }, polDetune: 0.0016, airScale: 0.75, plainEtaF: 3.6e-4,
    body: {
      modes: [[118, 22, 0.5, 2, 0.45, 0.3, 'A0'], [214, 30, 0.17, 6, 1.0, 0.15, 'T11a'], [230, 32, 0.22, -8, 0.9, 0.35, 'T11b'],
              [262, 38, 0.38, 14, 0.5, 0.8, 'back'], [330, 34, 0.6, 28, 0.55, 0.2, 'xdip'], [415, 36, 0.55, 32, 0.5, 0.15, 'ldip'],
              [480, 36, 0.7, -30, 0.45, 0.2, 'quad']],
      hf: { f0: 520, f1: 9500, spacing: 44, qlo: 30, qhi: 80, mMed: 2.2, mSpread: 0.9, angSd: 30, seed: 5 },
      radFc: 290
    },
    radHP: 108, air: 11000, out: 10.0, lonQ: 350, lonGain: 0.05
  },
  classical: {
    name: 'Nylon classical', scale: 0.65,
    strings: [
      { T: 63.1, mu: 5.50e-3, EI: 52e-6, wound: 1, etaF: 2e-5, etaBn: 2.0e-2, etaBu: 3.0e-2, etaA: 1.2, EA: 1500 },
      { T: 70.7, mu: 3.46e-3, EI: 39e-6, wound: 1, etaF: 7e-5, etaBn: 2.5e-2, etaBu: 3.5e-2, etaA: 0.9, EA: 1200 },
      { T: 69.4, mu: 1.91e-3, EI: 51e-6, wound: 1, etaF: 5e-5, etaBn: 2.0e-2, etaBu: 3.0e-2, etaA: 1.2, EA: 1000 },
      { T: 52.9, mu: 0.82e-3, EI: 280e-6, wound: 0, etaF: 14e-5, etaBn: 2.0e-2, etaBu: 2.4e-2, etaA: 1.7, EA: 9500 },
      { T: 53.5, mu: 0.52e-3, EI: 159e-6, wound: 0, etaF: 40e-5, etaBn: 2.0e-2, etaBu: 2.4e-2, etaA: 1.2, EA: 6900 },
      { T: 72.2, mu: 0.39e-3, EI: 131e-6, wound: 0, etaF: 40e-5, etaBn: 2.4e-2, etaBu: 2.8e-2, etaA: 1.5, EA: 5700 }],
    damp: { fretted: 0.25 }, polDetune: 0.002, airScale: 0.6, plainEtaF: 0,
    body: {
      // Woodhouse 2004 classical guitar fit: 91 Hz Q25, 205 Hz Q47, 225 Hz Q59; masses from his admittance peaks
      modes: [[91, 25, 0.6, 2, 0.45, 0.3, 'A0'], [205, 45, 0.13, 6, 1.0, 0.15, 'T11a'], [225, 55, 0.38, -10, 0.8, 0.7, 'back'],
              [280, 25, 0.6, 30, 0.55, 0.2, 'xdip'], [420, 40, 1.0, -28, 0.45, 0.15, 'ldip']],
      hf: { f0: 470, f1: 8500, spacing: 38, qlo: 30, qhi: 80, mMed: 2.8, mSpread: 0.9, angSd: 30, seed: 7 },
      radFc: 250
    },
    radHP: 85, air: 10000, out: 14.0, lonQ: 120, lonGain: 0.02
  }
};
const STD = [40, 45, 50, 55, 59, 64];

function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function gaussFrom(rng) { return (rng() + rng() + rng() + rng() - 2) * 1.2247; }
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ---------------- body ----------------
// ---------------- construction & contact ----------------
// Wood data (12% MC): density kg/m3, E along grain GPa, E across grain GPa, Q along grain, Q across grain.
// Wikipedia/USDA Wood Handbook moduli; damping from Bremaud et al. 2012, Yoshikawa, Haines (via Richardson),
// Stephens 2015. Reference build: Sitka spruce top, Indian rosewood back, thin nitro finish, standard X bracing.
const WOODS = {
  top: {
    sitka:      { name: 'Sitka spruce', rho: 425, E: 11.0, ER: 0.86, QL: 150, QR: 47 },
    adirondack: { name: 'Adirondack spruce', rho: 435, E: 10.8, ER: 0.86, QL: 150, QR: 47 },
    engelmann:  { name: 'Engelmann spruce', rho: 385, E: 9.4, ER: 1.20, QL: 150, QR: 47 },
    european:   { name: 'European spruce', rho: 405, E: 9.7, ER: 0.70, QL: 119, QR: 40 },
    cedar:      { name: 'Western red cedar', rho: 370, E: 7.7, ER: 0.62, QL: 139, QR: 45 },
    redwood:    { name: 'Redwood', rho: 415, E: 8.4, ER: 0.73, QL: 135, QR: 44 },
    mahogany:   { name: 'Mahogany top', rho: 590, E: 10.1, ER: 1.08, QL: 156, QR: 60 },
    koa:        { name: 'Koa top', rho: 610, E: 10.4, ER: 1.10, QL: 140, QR: 58 }
  },
  back: {
    indian:    { name: 'Indian rosewood', rho: 830, E: 11.5, ER: 2.4, QL: 137, QR: 90 },
    brazilian: { name: 'Brazilian rosewood', rho: 835, E: 13.9, ER: 2.8, QL: 170, QR: 100 },
    mahogany:  { name: 'Mahogany', rho: 590, E: 10.1, ER: 1.08, QL: 156, QR: 60 },
    sapele:    { name: 'Sapele', rho: 670, E: 12.0, ER: 1.25, QL: 120, QR: 55 },
    maple:     { name: 'Maple', rho: 705, E: 12.6, ER: 1.66, QL: 75, QR: 40 },
    koa:       { name: 'Koa', rho: 610, E: 10.4, ER: 1.10, QL: 140, QR: 58 },
    walnut:    { name: 'Walnut', rho: 610, E: 11.6, ER: 1.23, QL: 125, QR: 55 },
    cocobolo:  { name: 'Cocobolo', rho: 1095, E: 18.7, ER: 3.0, QL: 116, QR: 80 }
  }
};
// How a wood changes a plate depends on how it is thicknessed: a luthier thins each top to the same stiffness
// (h ~ E^-1/3, so mass ~ rho E^-1/3 changes, frequency barely), a factory keeps thickness (stiffness ~ E, mass ~ rho).
// In a steel-string top roughly half the low-mode stiffness is in the braces; the plate is ~3/4 of the moving mass.
function plateFactors(w, ref, style) {
  const re = w.E / ref.E, rr = w.rho / ref.rho, rER = w.ER / ref.ER;
  const h = style === 'factory' ? 1 : Math.pow(re, -1 / 3);
  const Kp = re * h * h * h, Mp = rr * h, KR = rER * h * h * h;
  return {
    low: { K: 0.5 + 0.5 * Kp, M: 0.25 + 0.75 * Mp },
    hf: { K: (0.35 + 0.65 * Kp) * Math.pow(KR / Math.max(1e-3, Kp), 0.22), M: 0.15 + 0.85 * Mp },
    lossL: 1 / w.QL - 1 / ref.QL, lossR: 1 / w.QR - 1 / ref.QR
  };
}
function constructionFactors(b) {
  const style = b.style === 'factory' ? 'factory' : 'luthier';
  const tw = WOODS.top[b.top] || WOODS.top.sitka, bw = WOODS.back[b.back] || WOODS.back.indian;
  const T = plateFactors(tw, WOODS.top.sitka, style);
  const Bk = plateFactors(bw, WOODS.back.indian, style);
  if (style === 'luthier') {
    // Carcagno et al. 2018: with the back thicknessed to compensate, back modes moved by only a few percent
    const cr = Math.sqrt(bw.E / bw.rho) / Math.sqrt(WOODS.back.indian.E / WOODS.back.indian.rho);
    const fb = 1 + Math.max(-0.02, Math.min(0.02, (cr - 1) * 0.5));
    Bk.low = { K: fb * fb, M: 1 }; Bk.hf = { K: fb * fb, M: 1 };
  }
  const hold = HOLDS[b.hold] || HOLDS.seated;
  // finish (Stephens 2015, thin nitro on Sitka): mass +7%, Q -7% low modes, -30% cross-grain modes;
  // values below are relative to the reference thin nitro. Thick poly ~2x the film: about twice the effect.
  const fin = b.finish === 'poly' ? { M: 1.07, qLow: 0.92, qHf: 0.7 } : b.finish === 'none' ? { M: 0.935, qLow: 1.07, qHf: 1.35 } : { M: 1, qLow: 1, qHf: 1 };
  // bracing (no published measurements; luthier lore, kept small): scalloping lowers stiffness of the low modes
  const br = b.bracing === 'scalloped' ? { K: 0.9, M: 0.98 } : b.bracing === 'forward' ? { K: 0.94, M: 1 } : { K: 1, M: 1 };
  return {
    hold,
    // multipliers for one mode, given its back share p, a 0..1 "high frequency / cross-grain" weight, and low/stat
    mode(p, hf, isLow) {
      const tL = isLow ? T.low : { K: T.low.K * (1 - hf) + T.hf.K * hf, M: T.low.M * (1 - hf) + T.hf.M * hf };
      const bL = isLow ? Bk.low : { K: Bk.low.K * (1 - hf) + Bk.hf.K * hf, M: Bk.low.M * (1 - hf) + Bk.hf.M * hf };
      const topK = tL.K * (isLow || hf < 0.5 ? br.K : 1), topM = tL.M * fin.M * br.M;
      const K = Math.pow(topK, 1 - p) * Math.pow(bL.K, p), M = Math.pow(topM, 1 - p) * Math.pow(bL.M, p);
      // wood loss is ~20-30% of a mode's total loss: add the change in the wood's own loss (along grain for low
      // modes, across grain as frequency rises)
      const dTop = T.lossL * (1 - hf) + T.lossR * hf, dBack = Bk.lossL * (1 - hf) + Bk.lossR * hf;
      const dq = (1 - p) * dTop * 0.3 + p * dBack * 0.3;
      const qFin = (1 - p) * (fin.qLow * (1 - hf) + fin.qHf * hf) + p;
      return { f: Math.sqrt(K / M), m: M, dq, qMul: qFin, rad: Math.pow(1 / M, isLow ? 1 : 0.5) };
    }
  };
}

// Player contact (Le Carrou, Pate & Chomette 2019: damping always rises, frequencies move < 2-5%; Woodhouse 2004:
// low-mode damping depends strongly on how the guitar is held, little above ~300 Hz). Back-dominated modes take the
// most: torso against the back roughly halves their Q; A0 and T(1,1) gain ~20-30% damping.
const HOLDS = {
  stand:  { name: 'On a stand', back: 0, top: 0, fshift: 0 },
  seated: { name: 'Held, seated', back: 0.03, top: 0.002, fshift: -0.012 },
  firm:   { name: 'Hugged close', back: 0.05, top: 0.004, fshift: -0.02 }
};

// Region patterns of the low modes over [hole, bridge, bass, treble, tail, upper, back] (volume-velocity shares)
const REGION_PATTERNS = {
  A0:   [0.55, 0.10, 0.10, 0.10, 0.05, 0.02, 0.08],   // air pumping through the soundhole, top and back breathing in phase
  T11a: [-0.25, 0.30, 0.25, 0.25, 0.15, 0.05, -0.10], // top monopole, soundhole air out of phase
  T11b: [0.15, 0.30, 0.20, 0.20, 0.12, 0.03, -0.35],  // top monopole coupled to the back
  back: [0.10, -0.08, -0.06, -0.06, -0.04, 0.0, 0.80], // back plate monopole
  xdip: [0.0, 0.0, 0.45, -0.45, 0.0, 0.0, 0.05],       // cross dipole: bass vs treble halves
  ldip: [-0.15, 0.20, 0.10, 0.10, 0.35, -0.30, 0.0],   // long dipole: below vs above the bridge
  quad: [0.0, 0.0, 0.30, -0.30, -0.20, 0.20, 0.0]
};
const NREG = 7, REG_BACK = 6;

class Body {
  constructor(spec, sr, sizeScale, eco, build) {
    const rng = makeRng(spec.hf.seed || 1);
    const K = constructionFactors(build || {});
    const f = [], Q = [], m = [], th = [], rad = [], pb = [], pat = [];
    for (const md of spec.modes) {
      f.push(md[0] * sizeScale); Q.push(md[1]); m.push(md[2]); th.push(md[3] * Math.PI / 180); rad.push(md[4]);
      pb.push(md[5] ?? 0.2); pat.push(REGION_PATTERNS[md[6]] || REGION_PATTERNS.T11a);
    }
    const nLow = f.length;
    const H = spec.hf;
    // Rayleigh-distributed spacings with mean H.spacing (Woodhouse's statistical high-frequency body)
    let fr = H.f0;
    const region = [];
    while (fr < H.f1) {
      const g1 = gaussFrom(rng), g2 = gaussFrom(rng);
      fr += H.spacing * (2 / Math.PI) * Math.sqrt(g1 * g1 + g2 * g2) * 1.0;
      f.push(fr * sizeScale);
      Q.push(H.qlo + (H.qhi - H.qlo) * rng());
      m.push(Math.min(14, Math.max(0.15, H.mMed * Math.exp(gaussFrom(rng) * H.mSpread))));
      th.push(gaussFrom(rng) * H.angSd * Math.PI / 180);
      // radiation efficiency of plate modes rises with frequency (toward coincidence)
      rad.push((rng() < 0.5 ? -1 : 1) * (0.8 + 0.4 * rng()) * Math.pow(fr / 500, H.radTilt ?? 0.35));
      // where the mode mostly lives: back plate for some, otherwise one region of the top
      const back = rng() < 0.3;
      pb.push(back ? 0.6 + 0.4 * rng() : 0.25 * rng());
      region.push(back ? REG_BACK : 1 + Math.floor(rng() * 5));
    }
    const n = f.length;
    // construction (woods, bracing, finish) and the player's contact reshape every mode by its top/back share
    for (let i = 0; i < n; i++) {
      const p = pb[i], hf = Math.min(1, Math.max(0, (f[i] - 400) / 3000));
      const F = K.mode(p, hf, i < nLow);
      f[i] *= F.f;
      m[i] *= F.m;
      // loss factors add: 1/Q = 1/Q0 (scaled by finish) + change in wood loss + the player's contact
      let invQ = 1 / (Q[i] * F.qMul) + F.dq + (K.hold.back * p + K.hold.top * (1 - p)) * (i < nLow ? 1 : 1 - 0.5 * hf);
      Q[i] = 1 / Math.max(1 / 400, invQ);
      f[i] *= 1 + K.hold.fshift * p;
      rad[i] *= F.rad;
    }
    this.n = n; this.nLow = nLow;
    this.f = Float64Array.from(f); this.Q = Float64Array.from(Q); this.m = Float64Array.from(m);
    this.cz = Float64Array.from(th.map(Math.cos)); this.sy = Float64Array.from(th.map(Math.sin));
    this.K = K;
    // radiating bank: every mode below 1.5 kHz, every 2nd to 4 kHz, every 4th above (each stands in for the skipped)
    const keep = [], stride = [];
    for (let i = 0; i < n; i++) {
      const st = this.f[i] < 1500 ? 1 : this.f[i] < 4000 ? (eco ? 3 : 2) : (eco ? 8 : 4);
      if (i < nLow || (i - nLow) % st === 0) { keep.push(i); stride.push(i < nLow ? 1 : st); }
    }
    const nr = keep.length;
    this.nr = nr;
    this.b0 = new Float64Array(nr); this.a1 = new Float64Array(nr); this.a2 = new Float64Array(nr);
    this.z1 = new Float64Array(nr); this.z2 = new Float64Array(nr);
    this.lowW = new Float64Array(nLow * NREG);      // region weights of the low modes
    this.hw = new Float64Array(nr); this.hreg = new Int32Array(nr);
    for (let q = 0; q < nr; q++) {
      const i = keep[q];
      const w = TAU * Math.min(this.f[i], sr * 0.45) / sr;
      const al = Math.sin(w) / (2 * this.Q[i]), a0 = 1 + al;
      this.b0[q] = al / a0; this.a1[q] = -2 * Math.cos(w) / a0; this.a2[q] = (1 - al) / a0;
      // normalized bandpass -> modal velocity per unit generalized force: x Q/(m w)
      const vel = this.Q[i] / (this.m[i] * TAU * this.f[i]) * Math.sqrt(stride[q]) * (stride[q] > 1 ? 1.2 : 1);
      const r = rad[i] * this.cz[i] * vel;
      if (i < nLow) for (let k = 0; k < NREG; k++) this.lowW[i * NREG + k] = r * pat[i][k] * 1.6;
      else { this.hw[q] = r; this.hreg[q] = region[i - nLow]; }
    }
    // force projection per radiating mode: generalized force = Fz cos(th) + Fy sin(th)
    this.pz = new Float64Array(nr); this.py = new Float64Array(nr);
    for (let q = 0; q < nr; q++) { this.pz[q] = this.cz[keep[q]]; this.py[q] = this.sy[keep[q]]; }
    // first-order radiation highpass (Woodhouse: R = (i w/wc)/(1 + i w/wc)), applied per region
    this.radC = Math.exp(-TAU * (spec.radFc || 250) / sr);
    this.xz1 = 0; this.xz2 = 0; this.xy1 = 0; this.xy2 = 0;
  }
  // 2x2 bridge admittance at angular frequency w. Returns [yyRe,yyIm, yzRe,yzIm, zzRe,zzIm]
  Y(w, out) {
    let yyR = 0, yyI = 0, yzR = 0, yzI = 0, zzR = 0, zzI = 0;
    const w2 = w * w;
    for (let k = 0; k < this.n; k++) {
      const wk = TAU * this.f[k];
      const re = this.m[k] * (wk * wk - w2), im = this.m[k] * w * wk / this.Q[k];
      const den = re * re + im * im;
      const yr = (w * im) / den, yi = (w * re) / den;
      const c = this.cz[k], sn = this.sy[k];
      zzR += yr * c * c; zzI += yi * c * c;
      yyR += yr * sn * sn; yyI += yi * sn * sn;
      yzR += yr * sn * c; yzI += yi * sn * c;
    }
    out[0] = yyR; out[1] = yyI; out[2] = yzR; out[3] = yzI; out[4] = zzR; out[5] = zzI;
    return out;
  }
  reset() { this.z1.fill(0); this.z2.fill(0); this.xz1 = this.xz2 = this.xy1 = this.xy2 = 0; }
}

// ---------------- string voice: a set of modal components ----------------
const MAXC = 2 * 200;
class Voice {
  constructor() {
    this.n = 0;
    this.k = new Int32Array(MAXC);          // partial number
    this.w = new Float64Array(MAXC);         // rad/s
    this.sig = new Float64Array(MAXC);       // decay rate 1/s (positive)
    this.vy = new Float64Array(MAXC); this.vz = new Float64Array(MAXC); // real eigenvector
    this.c1 = new Float64Array(MAXC); this.c2 = new Float64Array(MAXC);
    this.y1 = new Float64Array(MAXC); this.y2 = new Float64Array(MAXC);
    this.wy = new Float64Array(MAXC); this.wz = new Float64Array(MAXC); // bridge force per unit modal disp.
    this.gin = new Float64Array(MAXC);       // sympathetic input gain
    this.single = new Uint8Array(MAXC);      // 1 = one component stands for both polarizations
    this.act = new Int32Array(MAXC); this.nact = 0;
    this.L = 0.645; this.T = 100; this.EA = 1e4; this.midi = 40;
    this.extra = 0; this.extraTarget = 0; this.extraRate = 0; // added damping (mute, palm) in 1/s at 1 kHz units
    this.detune = 0; this.appliedDetune = 0; this.appliedExtra = -1;
    this.energy = 0;
    this.live = false;
  }
}

class GString {
  constructor(idx) {
    this.idx = idx;
    this.voices = [new Voice(), new Voice(), new Voice()];
    this.cur = 0;
    this.open = STD[idx]; this.midi = STD[idx]; this.fret = 0;
    this.releaseAt = -1;
    this.env = 0;
    this.out = 0;
    this.lastU = 0;
    // longitudinal modes: f_Ln = n/(2L) sqrt(EA/mu); driven by tension fluctuations
    this.lonN = 0; this.lonC1 = new Float64Array(4); this.lonC2 = new Float64Array(4);
    this.lonY1 = new Float64Array(4); this.lonY2 = new Float64Array(4); this.lonG = 0;
    this.lonIn = new Float64Array(4); this.lonT = 100; this.lonEA = 1e4;
    this.f2lp = 0;
    this.ownRing = new Float64Array(128);
  }
  get v() { return this.voices[this.cur]; }
}

class GuitarEngine {
  constructor(sr) {
    this.sr = sr;
    this.rng = makeRng(12345);
    this.strings = []; for (let i = 0; i < 6; i++) this.strings.push(new GString(i));
    this.clock = 0;
    this.queue = [];
    this.params = {
      preset: 'dreadnought', tuning: STD.slice(), capo: 0, brightness: 0.55, body: 1.0, bodySize: 1.0,
      sympathetic: 0.5, noise: 0.5, width: 1.0, gain: 1.0, override: null, quality: 'high',
      build: { top: 'sitka', back: 'indian', bracing: 'standard', finish: 'nitro', hold: 'seated', style: 'luthier' },
      scene: { mics: 'fret12', hold: 'seated' }
    };
    this.bend = 0; this.bendTarget = 0;
    this.RING = 16384; this.RMASK = this.RING - 1;
    this.bodyIn = new Float64Array(this.RING);    // extra force into the body (pick noise etc.)
    this.dirL = new Float64Array(this.RING); this.dirR = new Float64Array(this.RING);
    this.staticZ = 0; this.staticY = 0;           // released pick load (decays slowly)
    this.radL = this.radR = this.radXL = this.radXR = 0;
    this.yTmp = new Float64Array(6);
    this.blockCount = 0;
    this.dcL = 0; this.dcR = 0; this.dcxL = 0; this.dcxR = 0;
    this.airL = 0; this.airR = 0;
    this.rh = new Float64Array(8);
    this.cplLP = 0; this.cplHP = 0; this.lastF = 0;
    this.cplRing = new Float64Array(128); this.U = new Float64Array(64);
    this.RL = 2048; this.regRing = new Float64Array(7 * this.RL); this.regW = 0;
    this.regS = new Float64Array(7); this.regHP = new Float64Array(7); this.regX = new Float64Array(7);
    this.mD = new Float64Array(14); this.mG = new Float64Array(14); this.mN = new Float64Array(14); this.mS = new Float64Array(14);
    this.mC = new Float64Array(14); this.mI = new Float64Array(14); this.mLP = new Float64Array(14); this.nm = 1;
    this.rhF = new Float64Array(8); this.feedF = 0; this.feedB = 0; this.sceneDirty = true;
    this.FY = []; this.FZ = []; for (let j = 0; j < 6; j++) { this.FY.push(new Float64Array(64)); this.FZ.push(new Float64Array(64)); }
    this.setPreset('dreadnought');
  }

  // ---------- parameters ----------
  setParams(p) {
    let rebuild = false, retune = false;
    for (const k in p) {
      if (k === 'preset' || k === 'bodySize' || k === 'override' || k === 'quality' || k === 'build') rebuild = true;
      if (k === 'scene') this.sceneDirty = true;
      if (k === 'tuning' || k === 'capo' || k === 'brightness') retune = true;
      this.params[k] = p[k];
    }
    if (rebuild) this.setPreset(this.params.preset);
    else if (retune) this.retuneAll();
  }
  setPreset(name) {
    const base = PRESETS[name] || PRESETS.dreadnought;
    this.params.preset = PRESETS[name] ? name : 'dreadnought';
    const ov = this.params.override || {};
    this.P = Object.assign({}, base, ov, { body: Object.assign({}, base.body, ov.body || {}), damp: Object.assign({}, base.damp, ov.damp || {}) });
    if (ov.body && ov.body.hf) this.P.body.hf = Object.assign({}, base.body.hf, ov.body.hf);
    this.body = new Body(this.P.body, this.sr, 1 / Math.max(0.7, Math.min(1.4, this.params.bodySize)), this.params.quality === 'eco', this.params.build);
    const sr = this.sr;
    { const w = TAU * this.P.radHP / sr, q = 0.75, al = Math.sin(w) / (2 * q), a0 = 1 + al, cw = Math.cos(w);
      this.rhb0 = (1 + cw) / 2 / a0; this.rhb1 = -(1 + cw) / a0; this.rhb2 = this.rhb0; this.rha1 = -2 * cw / a0; this.rha2 = (1 - al) / a0; }
    this.airC = Math.exp(-TAU * this.P.air / sr);
    this.Ybuf = new Float64Array(6);
    this.modeCache = new Map();
    this.retuneAll();
  }
  retuneAll() {
    const tun = this.params.tuning, capo = this.params.capo | 0;
    for (let i = 0; i < 6; i++) {
      const s = this.strings[i];
      s.open = tun[i] + capo;
      if (!s.v.live) { s.midi = s.open; s.fret = 0; this.loadModes(s.v, i, s.open); }
    }
  }

  // Physical string data for string i at its current open pitch (tension follows the tuning).
  stringPhys(i) {
    const P = this.P, sp = P.strings[i];
    const fstd = mtof(STD[i]);
    const mu = sp.mu;
    const fopen = mtof(this.params.tuning[i]);
    const Tstd = sp.T;
    const T = Tstd * Math.pow(fopen / fstd, 2) * (mu * Math.pow(2 * P.scale * fstd, 2) / Tstd); // T = mu (2 L f)^2
    return Object.assign({}, sp, { T, fopen });
  }

  // Longitudinal resonances of string i at its sounding length (stiff core, full string mass).
  setupLongitudinal(s, midi) {
    const ph = this.stringPhys(s.idx), sr = this.sr;
    const L = this.P.scale * Math.pow(2, -(midi - this.params.tuning[s.idx]) / 12);
    const cL = Math.sqrt(ph.EA / ph.mu), f1 = cL / (2 * L);
    s.lonN = 0;
    for (let n = 1; n <= 4; n++) {
      const f = n * f1; if (f > sr * 0.42) break;
      const r = Math.exp(-Math.PI * f / (this.P.lonQ || 350) / sr);
      s.lonC1[n - 1] = 2 * r * Math.cos(TAU * f / sr); s.lonC2[n - 1] = r * r; s.lonN = n;
      s.lonIn[n - 1] = (1 - r) / n; // unity-ish resonance gain, higher axial modes weaker
    }
    // wound strings couple far more (windings rub; core and wrap move differently)
    s.lonG = (this.P.lonGain || 0) * (ph.wound ? 1 : 0.35);
    s.lonT = ph.T; s.lonEA = ph.EA;
  }

  // Build the modal components of string i sounding `midi` into voice v.
  loadModes(v, i, midi) {
    const key = i + ':' + midi.toFixed(3) + ':' + this.params.tuning[i] + ':' + this.params.brightness + ':' + this.params.quality;
    let M = this.modeCache.get(key);
    if (!M) { M = this.computeModes(i, midi); if (this.modeCache.size > 400) this.modeCache.clear(); this.modeCache.set(key, M); }
    const n = M.n;
    v.n = n; v.L = M.L; v.T = M.T; v.EA = M.EA; v.midi = midi;
    v.k.set(M.k.subarray(0, n)); v.w.set(M.w.subarray(0, n)); v.sig.set(M.sig.subarray(0, n));
    v.vy.set(M.vy.subarray(0, n)); v.vz.set(M.vz.subarray(0, n));
    v.wy.set(M.wy.subarray(0, n)); v.wz.set(M.wz.subarray(0, n)); v.gin.set(M.gin.subarray(0, n)); v.single.set(M.single.subarray(0, n));
    v.y1.fill(0, 0, n); v.y2.fill(0, 0, n);
    v.extra = 0; v.extraTarget = 0; v.appliedExtra = -1; v.detune = 0; v.appliedDetune = 0;
    v.nact = 0; v.energy = 0;
    this.updateCoefs(v, true);
    this.setupLongitudinal(this.strings[i], midi);
  }

  computeModes(i, midi) {
    const P = this.P, sr = this.sr, ph = this.stringPhys(i);
    const capo = this.params.capo | 0;
    const fret = midi - this.params.tuning[i];            // from the nut, capo included
    const L = P.scale * Math.pow(2, -fret / 12);
    const f0 = mtof(midi);
    const T = ph.T;
    const B = Math.PI * Math.PI * ph.EI / (T * L * L);
    const fmax = Math.min(sr * 0.45, this.params.quality === 'eco' ? 7000 : 11000);
    const out = { n: 0, L, T, EA: ph.EA, B, f0, k: new Int32Array(MAXC), w: new Float64Array(MAXC), sig: new Float64Array(MAXC),
      vy: new Float64Array(MAXC), vz: new Float64Array(MAXC), wy: new Float64Array(MAXC), wz: new Float64Array(MAXC), gin: new Float64Array(MAXC), single: new Uint8Array(MAXC) };
    // string age: brightness 1 = new strings, 0 = old (dirt in the windings raises bending loss)
    const br = this.params.brightness, age = Math.max(0, Math.min(1, 1 - br));
    const etaB = ph.etaBn * Math.pow(ph.etaBu / ph.etaBn, age);
    const Y = this.Ybuf;
    const fretted = fret - capo > 0.5;
    const pd = P.polDetune || 0, D = P.damp;
    let c = 0;
    for (let k = 1; c < MAXC - 1; k++) {
      const f = k * f0 * Math.sqrt(1 + B * k * k);
      if (f > fmax) break;
      const w = TAU * f;
      // intrinsic damping (Woodhouse): loss factor weighted by tension vs bending energy; T60 = 13.8/(w eta)
      const kk = k * Math.PI / L, bend = ph.EI * kk * kk;
      // Woodhouse's etaA was fitted on whole guitars (it carries some body loss we now model explicitly): scale it;
      // plain strings get extra friction loss calibrated to recorded steel-string notes (P.plainEtaF)
      const etaF = ph.wound ? ph.etaF : Math.max(ph.etaF, (P.plainEtaF || 0) * (0.6 + 0.8 * age));
      const eta = (T * (etaF + (P.airScale ?? 1) * ph.etaA / w) + bend * etaB) / (T + bend);
      let sInt = w * eta / 2;
      if (fretted) sInt += D.fretted * (1 + f / 2000); // fingertip and neck losses on fretted notes
      // bridge coupling: ds = -(T/L) Y2(w), eigen-decomposed
      this.body.Y(w, Y);
      const s = -T / L;
      // the normal (z) polarization sits slightly sharp: the string's effective length differs at the saddle
      const aR = s * Y[0], aI = s * Y[1], bR = s * Y[2], bI = s * Y[3], dR = s * Y[4], dI = s * Y[5] + pd * w;
      // eigenvalues of [[a,b],[b,d]]: (a+d)/2 +- sqrt(((a-d)/2)^2 + b^2)
      const hR = (aR - dR) / 2, hI = (aI - dI) / 2;
      const qR = hR * hR - hI * hI + bR * bR - bI * bI, qI = 2 * hR * hI + 2 * bR * bI;
      const mag = Math.sqrt(Math.hypot(qR, qI)), ang = Math.atan2(qI, qR) / 2;
      const rR = mag * Math.cos(ang), rI = mag * Math.sin(ang);
      const mR = (aR + dR) / 2, mI = (aI + dI) / 2;
      const lam = [[mR + rR, mI + rI], [mR - rR, mI - rI]];
      // above ~2.5 kHz polarization beating is inaudible: keep one component (the slower-decaying one, which
      // dominates what is heard) with the excitation of both
      const single = f > 2500;
      const jOrder = single ? (lam[0][0] > lam[1][0] ? [0] : [1]) : [0, 1];
      for (const j of jOrder) {
        const lR = lam[j][0], lI = lam[j][1];
        // eigenvector from either row of (A - l I): (b, l - a) or (l - d, b); take the larger
        let e1R = bR, e1I = bI, e2R = lR - aR, e2I = lI - aI;
        const n1 = e1R * e1R + e1I * e1I + e2R * e2R + e2I * e2I;
        const f1R = lR - dR, f1I = lI - dI;
        const n2 = f1R * f1R + f1I * f1I + bR * bR + bI * bI;
        if (n2 > n1) { e1R = f1R; e1I = f1I; e2R = bR; e2I = bI; }
        if (Math.max(n1, n2) < 1e-40) { e1R = j === 0 ? 1 : 0; e2R = j === 0 ? 0 : 1; e1I = e2I = 0; }
        // rotate so the dominant entry is real, then keep real parts
        const dom = Math.hypot(e1R, e1I) >= Math.hypot(e2R, e2I) ? [e1R, e1I] : [e2R, e2I];
        const ph2 = -Math.atan2(dom[1], dom[0]), cr = Math.cos(ph2), ci = Math.sin(ph2);
        let vy = e1R * cr - e1I * ci, vz = e2R * cr - e2I * ci;
        const nn = Math.hypot(vy, vz) || 1; vy /= nn; vz /= nn;
        out.k[c] = k; out.w[c] = w + lI; out.sig[c] = Math.max(0.02, sInt - lR);
        out.vy[c] = vy; out.vz[c] = vz;
        const Fk = T * k * Math.PI / L;
        out.wy[c] = Fk * vy; out.wz[c] = Fk * vz;
        out.gin[c] = 2 * w * w / (k * Math.PI) / (sr * sr) * vz * (k % 2 ? 1 : -1); // moving bridge end drives the mode
        out.single[c] = single ? 1 : 0;
        if (single) { out.vy[c] = Math.SQRT1_2; out.vz[c] = Math.SQRT1_2; const Fk = T * k * Math.PI / L; out.wy[c] = Fk * Math.SQRT1_2; out.wz[c] = Fk * Math.SQRT1_2; }
        c++;
      }
    }
    out.n = c;
    return out;
  }

  // recompute resonator coefficients for current detune and added damping
  updateCoefs(v, force) {
    if (!force && Math.abs(v.detune - v.appliedDetune) < 2e-6 && Math.abs(v.extra - v.appliedExtra) < 0.05) return;
    const sr = this.sr, bendR = this.bend === 0 ? 1 : Math.pow(2, this.bend / 12);
    const dt = (1 + v.detune) * bendR;
    const ex = v.extra;
    for (let c = 0; c < v.n; c++) {
      const f = v.w[c] / TAU;
      const sig = v.sig[c] + ex * (0.35 + f / 1000);
      const r = Math.exp(-sig / sr);
      v.c1[c] = 2 * r * Math.cos(v.w[c] * dt / sr);
      v.c2[c] = r * r;
    }
    v.appliedDetune = v.detune; v.appliedExtra = ex; v.appliedBend = this.bend;
  }

  // ---------- events ----------
  post(ev) {
    const at = ev.t == null ? this.clock : Math.max(this.clock, Math.round(ev.t * this.sr));
    ev._at = at;
    const q = this.queue; let i = q.length;
    while (i > 0 && q[i - 1]._at > at) i--;
    q.splice(i, 0, ev);
  }
  post2(ev) { const q = this.queue; let i = q.length; while (i > 0 && q[i - 1]._at > ev._at) i--; q.splice(i, 0, ev); }
  // the pick slides along the string for a few ms before it slips off; returns that lead time in samples
  preScrape(ev) {
    const style = ev.style || 'pick';
    const vel = Math.max(0.02, Math.min(1, ev.vel == null ? 0.7 : ev.vel));
    const pre = Math.round((style === 'pick' ? 0.0025 : 0.0012) * this.sr);
    const wound = this.P.strings[ev.s] && this.P.strings[ev.s].wound;
    const amt = this.params.noise * vel * (style === 'pick' ? 0.12 : 0.04) * (wound ? 1 : 0.5);
    if (amt <= 0) return pre;
    const start = this.clock & this.RMASK;
    let p1 = 0, p2 = 0;
    for (let i = 0; i < pre; i++) {
      const r = this.rng() * 2 - 1, hp = r - 2 * p1 + p2; p2 = p1; p1 = r;
      this.bodyIn[(start + i) & this.RMASK] += hp * amt * (i / pre);
    }
    return pre;
  }
  handle(ev) {
    switch (ev.type) {
      case 'pluck':
        if (!ev._staged) { ev._staged = true; const pre = this.preScrape(ev); if (pre > 0) { ev.t = null; ev._at = this.clock + pre; this.post2(ev); break; } }
        this.pluck(ev); break;
      case 'damp': this.dampString(ev); break;
      case 'squeak': this.squeak(ev); break;
      case 'bend': this.bendTarget = ev.value; break;
      case 'params': this.setParams(ev.params); break;
      case 'allOff': for (const s of this.strings) this.dampString({ s: s.idx, time: 0.08 }); break;
      case 'panic': for (const s of this.strings) for (const v of s.voices) { v.y1.fill(0); v.y2.fill(0); v.nact = 0; v.live = false; } this.body.reset(); break;
    }
  }

  pluck(ev) {
    const s = this.strings[ev.s]; if (!s) return;
    const P = this.P, sr = this.sr;
    const vel = Math.max(0.02, Math.min(1, ev.vel == null ? 0.7 : ev.vel));
    const midi = ev.midi == null ? s.open : ev.midi;
    let v = s.v;
    if (Math.abs(midi - v.midi) > 0.01 || !v.n) {
      // new fret: the old vibration is stopped by the moving finger; it decays in its own voice
      const old = v;
      old.extraTarget = Math.max(old.extraTarget, 70); old.extraRate = 0.5; old.extra = Math.max(old.extra, 25);
      this.updateCoefs(old, true);
      s.cur = this.quietestVoice(s); v = s.v;
      this.loadModes(v, ev.s, midi);
    } else {
      // pick lands on a ringing string: it stops part of the motion
      const kc = ev.style === 'pick' ? 0.62 - 0.32 * vel : 0.5 - 0.3 * vel;
      for (let c = 0; c < v.n; c++) { v.y1[c] *= kc; v.y2[c] *= kc; }
    }
    s.midi = midi; s.fret = Math.round(midi - s.open);
    s.releaseAt = -1;
    v.live = true;
    // damping state
    if (ev.dead) { v.extraTarget = 140; v.extra = 140; v.extraRate = 1; }
    else if (ev.palm) { v.extraTarget = 9; v.extra = 9; v.extraRate = 1; }
    else { v.extraTarget = 0; v.extra = Math.min(v.extra, 2); v.extraRate = 0.3; }
    this.updateCoefs(v, true);

    // ---- excitation: triangular displacement h at x_p, released over tau, contact width w, direction theta
    const style = ev.style || 'pick';
    const dir = ev.dir < 0 ? -1 : 1;
    const L = v.L;
    const pickPos = (ev.pickPos == null ? 0.2 : ev.pickPos) * P.scale * (1 + (this.rng() - 0.5) * 0.06);
    const xp = Math.max(0.02 * L, Math.min(0.5 * L, pickPos));
    const h = (0.0003 + 0.0032 * Math.pow(vel, 1.3)) * (ev.dead ? 0.5 : 1) * (style === 'thumb' ? 1.1 : 1);
    const br = this.params.brightness;
    let tau, width, theta;
    if (style === 'pick') { tau = 1.6e-4 * (1.5 - vel) * (1.3 - 0.6 * br); width = 0.0015; theta = 0.18 + 0.12 * this.rng(); }
    else if (style === 'thumb') { tau = 1.1e-3 * (1.4 - 0.6 * vel); width = 0.012; theta = 0.5 + 0.2 * this.rng(); }
    else { tau = 6e-4 * (1.4 - 0.6 * vel); width = 0.008; theta = 0.65 + 0.25 * this.rng(); }
    if (this.params.preset === 'classical' && style !== 'pick') tau *= 0.5; // nails
    if (ev.bright != null) tau /= Math.max(0.2, ev.bright);
    if (ev.dead) tau *= 2;
    const ct = Math.cos(theta), st = Math.sin(theta);
    const base = 2 * h * L * L / (Math.PI * Math.PI * xp * (L - xp)) * dir;
    for (let c = 0; c < v.n;) {
      const k = v.k[c];
      let a = base * Math.sin(k * Math.PI * xp / L) / (k * k);
      const sx = k * width / (2 * L);
      a *= sx > 1e-6 ? Math.sin(Math.PI * sx) / (Math.PI * sx) : 1;
      const x = v.w[c] * tau / 2.2;
      a /= Math.sqrt(1 + x * x * x * x);
      if (v.single[c]) { this.addOsc(v, c, a); c += 1; continue; }
      // split the (y,z) push between the two eigen-components of this partial
      const y1 = v.vy[c], z1 = v.vz[c], y2 = v.vy[c + 1], z2 = v.vz[c + 1];
      const det = y1 * z2 - y2 * z1;
      let p1, p2;
      if (Math.abs(det) > 1e-6) { p1 = (ct * z2 - st * y2) / det; p2 = (st * y1 - ct * z1) / det; }
      else { p1 = ct * y1 + st * z1; p2 = 0; }
      this.addOsc(v, c, a * p1);
      this.addOsc(v, c + 1, a * p2);
      c += 2;
    }
    this.rebuildActive(v);
    // the bridge load the pick held is released: relative to the pre-loaded body this is a step of -F_static
    const Fs = v.T * h / xp * dir;
    this.staticZ -= Fs * st; this.staticY -= Fs * ct;
    // release click: pick or nail leaving the string, straight into the body
    const nAmt = this.params.noise * vel * (style === 'pick' ? 0.45 : 0.15) * (ev.dead ? 2 : 1);
    if (nAmt > 0) {
      const start = this.clock & this.RMASK, nl = Math.round(0.004 * sr);
      const wound = this.P.strings[ev.s].wound;
      let p1 = 0, p2 = 0;
      for (let i = 0; i < nl; i++) {
        const r = this.rng() * 2 - 1, hp = r - 2 * p1 + p2; p2 = p1; p1 = r;
        this.bodyIn[(start + i) & this.RMASK] += hp * nAmt * Math.exp(-i / (0.0009 * sr)) * (wound ? 1 : 0.5);
      }
    }
  }

  // the voice slot (other than the current one) with the least remaining vibration
  quietestVoice(s) {
    let best = -1, bestE = Infinity;
    for (let i = 0; i < s.voices.length; i++) {
      if (i === s.cur) continue;
      const v = s.voices[i];
      let e = 0;
      for (let q = 0; q < v.nact; q++) { const c = v.act[q]; e += v.y1[c] * v.y1[c] + v.y2[c] * v.y2[c]; }
      if (e < bestE) { bestE = e; best = i; }
    }
    return best;
  }

  addOsc(v, c, a) {
    if (a === 0) return;
    const r = Math.sqrt(v.c2[c]);
    const cw = v.c1[c] / (2 * r);
    v.y1[c] += a; v.y2[c] += a * cw / r;
  }

  rebuildActive(v) {
    let n = 0;
    for (let c = 0; c < v.n; c++) {
      const y1 = v.y1[c], y2 = v.y2[c];
      if (y1 * y1 + y2 * y2 > 2e-15) v.act[n++] = c;
    }
    v.nact = n;
  }

  dampString(ev) {
    const s = this.strings[ev.s]; if (!s) return;
    const time = ev.time == null ? 0.07 : ev.time;
    for (const v of s.voices) { v.extraTarget = 45; v.extraRate = Math.min(1, 128 / (Math.max(0.005, time) * this.sr)); }
    s.releaseAt = this.clock + Math.round((0.45 + time * 3) * this.sr);
    const amt = this.params.noise * 0.06 * Math.min(1, s.env * 10);
    if (amt > 1e-4) {
      const at = this.clock & this.RMASK; let p = 0;
      for (let k = 0; k < 400; k++) { const r = this.rng() * 2 - 1; this.bodyIn[(at + k) & this.RMASK] += (r - p) * amt * Math.exp(-k / 90); p = r; }
    }
  }

  squeak(ev) {
    const s = this.strings[ev.s]; if (!s) return;
    const amt = (ev.amt == null ? 0.5 : ev.amt) * this.params.noise;
    if (amt < 0.01) return;
    if (!this.P.strings[ev.s].wound) return;
    const sr = this.sr, dur = 0.06 + 0.12 * this.rng();
    const n = Math.min(this.RING - 64, Math.round(dur * sr));
    const start = (ev._at || this.clock) & this.RMASK;
    const f1 = 1800 + 2400 * this.rng(), f2 = f1 * (0.6 + 0.8 * this.rng());
    let z1 = 0, z2 = 0, ph = 0;
    const rate = 120 + 260 * this.rng();
    const pan = (s.idx - 2.5) / 6;
    const lvl = this.params.preset === 'classical' ? 0.6 : 1;
    for (let k = 0; k < n; k++) {
      const t = k / n, f = f1 + (f2 - f1) * t;
      const w = TAU * f / sr, al = Math.sin(w) / 12, a0 = 1 + al;
      const y = (al / a0) * (this.rng() * 2 - 1) + (2 * Math.cos(w) / a0) * z1 - ((1 - al) / a0) * z2;
      z2 = z1; z1 = y;
      ph += rate / sr;
      const env = Math.sin(Math.PI * t) ** 2;
      const val = y * (0.5 + 0.5 * Math.cos(TAU * ph)) * env * amt * 0.025 * lvl;
      this.dirL[(start + k) & this.RMASK] += val * (1 - pan);
      this.dirR[(start + k) & this.RMASK] += val * (1 + pan);
    }
  }

  // ---------- per-block control: tension modulation, damping ramps, culling ----------
  control() {
    this.bend += (this.bendTarget - this.bend) * 0.25;
    for (const s of this.strings) {
      let envSum = 0;
      for (const v of s.voices) {
        if (!v.nact) continue;
        // amplitude of each active component from its two states; tension rises with sum of slope^2
        let slope2 = 0, n = 0;
        const sr = this.sr;
        for (let i = 0; i < v.nact; i++) {
          const c = v.act[i];
          const y1 = v.y1[c], y2 = v.y2[c];
          const r = Math.sqrt(v.c2[c]), cw = v.c1[c] / (2 * r), sw2 = Math.max(1e-6, 1 - cw * cw);
          const yp = y2 * r;
          const a2 = (y1 * y1 + yp * yp - 2 * y1 * yp * cw) / sw2;
          if (a2 > 2e-15) v.act[n++] = c;
          const kk = v.k[c] * Math.PI / v.L;
          slope2 += kk * kk * a2;
        }
        v.nact = n;
        if (!n) { if (v !== s.v) v.live = false; continue; }
        // dT = EA/8 * sum (k pi/L)^2 A^2 ; df/f = dT / 2T
        v.detune = v.EA * slope2 / 8 / (2 * v.T);
        if (v.detune > 0.02) v.detune = 0.02;
        envSum += Math.sqrt(slope2) * v.T;
        if (v.extra !== v.extraTarget) {
          v.extra += (v.extraTarget - v.extra) * v.extraRate;
          if (Math.abs(v.extra - v.extraTarget) < 0.05) v.extra = v.extraTarget;
        }
        const bendChanged = v.appliedBend !== this.bend && Math.abs(this.bend - (v.appliedBend || 0)) > 1e-4;
        this.updateCoefs(v, bendChanged);
      }
      s.env = s.env * 0.7 + 0.3 * envSum * 0.03;
      // finger lifted: string becomes a free open string again
      if (s.releaseAt >= 0 && this.clock >= s.releaseAt) {
        s.releaseAt = -1;
        const v = s.v;
        if (Math.abs(v.midi - s.open) > 0.01) { s.cur = this.quietestVoice(s); this.loadModes(s.v, s.idx, s.open); s.midi = s.open; s.fret = 0; }
        else { v.extraTarget = 0; v.extraRate = 0.2; }
        s.v.live = false;
      }
    }
  }

  // ---------- render ----------
  render(outL, outR, n, offset = 0, outF = null, outB = null) {
    if (this.sceneDirty) this.setupScene();
    let done = 0;
    while (done < n) {
      while (this.queue.length && this.queue[0]._at <= this.clock) this.handle(this.queue.shift());
      let seg = n - done;
      if (this.queue.length) seg = Math.max(1, Math.min(seg, this.queue[0]._at - this.clock));
      // control-rate work every 64 samples
      const toCtl = 64 - (this.clock & 63);
      seg = Math.min(seg, toCtl);
      this.renderSeg(outL, outR, offset + done, seg, outF, outB);
      done += seg;
      if ((this.clock & 63) === 0) this.control();
    }
  }

  renderSeg(outL, outR, off, n, outF, outB) {
    const S = this.strings, B = this.body, nb = B.nr;
    const b0 = B.b0, a1 = B.a1, a2 = B.a2, gL = B.gL, gR = B.gR, z1 = B.z1, z2 = B.z2, pz = B.pz, py = B.py;
    const gy = 0.3, bodyAmt = this.params.body, gain = this.params.gain * this.P.out;
    const width = this.params.width;
    const symp = this.params.sympathetic * 1.2e-6; // bridge compliance, m/N
    const sr = this.sr, CD = 64, CM = 127;          // sympathetic coupling arrives through a 64-sample delay
    const stDecay = Math.exp(-1 / (0.6 * sr));
    const lpC = 1 - Math.exp(-TAU * 3000 / sr), hpC = Math.exp(-TAU * 60 / sr);
    const ring = this.cplRing, t0 = this.clock;
    // 1) strings, oscillator-major: each component runs the whole segment from registers
    for (let j = 0; j < 6; j++) {
      const s = S[j], FY = this.FY[j], FZ = this.FZ[j], U = this.U;
      FY.fill(0, 0, n); FZ.fill(0, 0, n);
      const own = s.ownRing;
      let anyU = false;
      if (symp > 0) for (let i = 0; i < n; i++) {
        const k = (t0 + i - CD) & CM;
        const u = symp * (ring[k] - own[k]); U[i] = u; if (u !== 0) anyU = true;
      }
      for (let vv = 0; vv < 3; vv++) {
        const v = s.voices[vv];
        const na = v.nact; if (!na) continue;
        const act = v.act, c1a = v.c1, c2a = v.c2, y1a = v.y1, y2a = v.y2, wya = v.wy, wza = v.wz, gina = v.gin;
        for (let q = 0; q < na; q++) {
          const c = act[q];
          const c1 = c1a[c], c2 = c2a[c], wy = wya[c], wz = wza[c];
          let y1 = y1a[c], y2 = y2a[c];
          if (anyU) {
            const g = gina[c];
            for (let i = 0; i < n; i++) { const y = c1 * y1 - c2 * y2 + g * U[i]; y2 = y1; y1 = y; FY[i] += wy * y; FZ[i] += wz * y; }
          } else {
            for (let i = 0; i < n; i++) { const y = c1 * y1 - c2 * y2; y2 = y1; y1 = y; FY[i] += wy * y; FZ[i] += wz * y; }
          }
          y1a[c] = y1; y2a[c] = y2;
        }
      }
    }
    // 2) per sample: longitudinal modes, coupling ring, body, radiation, output
    for (let i = 0; i < n; i++) {
      const tIdx = (t0 + i) & this.RMASK;
      let Ftot = 0, Fy = 0, Fz = 0;
      for (let j = 0; j < 6; j++) {
        const s = S[j];
        const sy = this.FY[j][i], sz = this.FZ[j][i];
        let own = sz + gy * sy, lo = 0;
        if (s.lonN && s.lonG) {
          const sl = own / s.lonT, f2 = s.lonEA * 0.5 * sl * sl;
          s.f2lp += (f2 - s.f2lp) * 0.002;
          const drive = (f2 - s.f2lp) * s.lonG;
          for (let q = 0; q < s.lonN; q++) {
            const y = s.lonC1[q] * s.lonY1[q] - s.lonC2[q] * s.lonY2[q] + drive * s.lonIn[q];
            s.lonY2[q] = s.lonY1[q]; s.lonY1[q] = y; lo += y;
          }
          own += lo;
        }
        s.ownRing[(t0 + i) & CM] = own; s.out = own;
        Fy += sy; Fz += sz + lo; Ftot += own;
      }
      // band-limited total bridge force for the sympathetic ring
      this.cplLP += (Ftot - this.cplLP) * lpC;
      this.cplHP = hpC * this.cplHP + (1 - hpC) * this.cplLP;
      ring[(t0 + i) & CM] = this.cplLP - this.cplHP;
      // body: each mode driven by the bridge force projected on its direction of motion; the released pick
      // load appears as a step relative to the pre-loaded body
      this.staticZ *= stDecay; this.staticY *= stDecay;
      const inZ = Fz + this.staticZ + this.bodyIn[tIdx], inY = Fy + this.staticY; this.bodyIn[tIdx] = 0;
      const dz = inZ - B.xz2; B.xz2 = B.xz1; B.xz1 = inZ;
      const dy = inY - B.xy2; B.xy2 = B.xy1; B.xy1 = inY;
      // modal velocities -> volume velocity of each radiating region
      const RS = this.regS; RS.fill(0);
      const nLow = B.nLow, lowW = B.lowW, hw = B.hw, hreg = B.hreg;
      for (let q = 0; q < nb; q++) {
        const y = b0[q] * (pz[q] * dz + py[q] * dy) - a1[q] * z1[q] - a2[q] * z2[q];
        z2[q] = z1[q]; z1[q] = y;
        if (q < nLow) { const o = q * 7; for (let k = 0; k < 7; k++) RS[k] += lowW[o + k] * y; }
        else RS[hreg[q]] += hw[q] * y;
      }
      // each region radiates through Woodhouse's first-order highpass; keep its history for the mic delays
      const rc = B.radC, RL = this.RL, wpos = this.regW;
      let front = 0, back = 0;
      for (let k = 0; k < 7; k++) {
        const x = RS[k] * bodyAmt;
        const h = rc * (this.regHP[k] + x - this.regX[k]); this.regX[k] = x; this.regHP[k] = h;
        this.regRing[k * RL + wpos] = h;
        if (k === 6) back = h; else front += h;
      }
      // direct sound at each mic: every region at its own delay and gain, near-field gradient term for directional
      // mics (proximity effect), and a diffraction lowpass when the region faces away (body / head shadow)
      let L = 0, R = 0;
      const nm = this.nm, mD = this.mD, mG = this.mG, mN = this.mN, mS = this.mS, mI = this.mI, mLP = this.mLP, mC = this.mC;
      for (let m = 0; m < nm; m++) {
        let acc = 0;
        for (let k = 0; k < 7; k++) {
          const j = m * 7 + k;
          let pos = wpos - mD[j]; if (pos < 0) pos += RL;
          const i0 = pos | 0, fr = pos - i0, i1 = i0 + 1 === RL ? 0 : i0 + 1;
          const x = this.regRing[k * RL + i0] * (1 - fr) + this.regRing[k * RL + i1] * fr;
          mI[j] = mI[j] * 0.9993 + x / sr;
          const y = mG[j] * x + mN[j] * mI[j];
          mLP[j] += (y - mLP[j]) * mC[j];
          acc += y + (mLP[j] - y) * mS[j];
        }
        if (m === 0) L = acc; else R = acc;
      }
      if (nm === 1) R = L;
      this.regW = wpos + 1 === RL ? 0 : wpos + 1;
      this.feedF = front; this.feedB = back;
      { const r = this.rh;
        const yl = this.rhb0 * L + this.rhb1 * r[0] + this.rhb2 * r[1] - this.rha1 * r[2] - this.rha2 * r[3];
        r[1] = r[0]; r[0] = L; r[3] = r[2]; r[2] = yl; L = yl;
        const yr = this.rhb0 * R + this.rhb1 * r[4] + this.rhb2 * r[5] - this.rha1 * r[6] - this.rha2 * r[7];
        r[5] = r[4]; r[4] = R; r[7] = r[6]; r[6] = yr; R = yr; }
      this.airL = this.airC * this.airL + (1 - this.airC) * L;
      this.airR = this.airC * this.airR + (1 - this.airC) * R;
      L = this.airL + this.dirL[tIdx]; R = this.airR + this.dirR[tIdx];
      this.dirL[tIdx] = 0; this.dirR[tIdx] = 0;
      const yL = L - this.dcxL + 0.9995 * this.dcL; this.dcxL = L; this.dcL = yL;
      const yR = R - this.dcxR + 0.9995 * this.dcR; this.dcxR = R; this.dcR = yR;
      let oL = yL * gain, oR = yR * gain;
      if (!(oL === oL) || !(oR === oR)) { this.panicReset(); oL = oR = 0; }
      outL[off + i] = oL; outR[off + i] = oR;
      if (outF) {
        // room feeds: top-side and back-side radiation (source strength at 1 m), same sub-A0 rolloff
        const r = this.rhF; let F = this.feedF, Bk = this.feedB;
        const yf = this.rhb0 * F + this.rhb1 * r[0] + this.rhb2 * r[1] - this.rha1 * r[2] - this.rha2 * r[3];
        r[1] = r[0]; r[0] = F; r[3] = r[2]; r[2] = yf;
        const yb = this.rhb0 * Bk + this.rhb1 * r[4] + this.rhb2 * r[5] - this.rha1 * r[6] - this.rha2 * r[7];
        r[5] = r[4]; r[4] = Bk; r[7] = r[6]; r[6] = yb;
        outF[off + i] = yf * gain; outB[off + i] = yb * gain;
      }
    }
    this.clock += n;
  }

  // Direct-path coefficients for the current mics, from the scene (AcousticSpace when present)
  setupScene() {
    this.sceneDirty = false;
    const sc = Object.assign({}, this.params.scene || {}, { hold: (this.params.build || {}).hold || 'seated' });
    const S = root.AcousticSpace;
    const coefs = S ? S.directCoefs(sc, this.sr)
      : [[0.17, 0.20, 0.25, 0.25, 0.3, 0.2, 0.3].map((d, k) => ({ delay: d / 343 * this.sr, gP: 1 / d, gB: 0, gNear: 0, shadow: k === 6 ? 0.8 : 0 }))];
    this.nm = Math.min(2, coefs.length);
    const ears = S && S.expandMics(sc.mics || 'fret12').some(m => m.ear);
    const norm = S ? S.micNorm(sc) : 1;
    for (let m = 0; m < this.nm; m++) for (let k = 0; k < 7; k++) {
      const c = coefs[m][k], j = m * 7 + k;
      this.mD[j] = Math.min(this.RL - 4, Math.max(1, c.delay));
      this.mG[j] = (c.gP + c.gB) * norm * 2.0;      // norm: preamp gain for this setup's distance
      this.mN[j] = c.gNear * norm * 2.0;
      this.mS[j] = c.shadow;
      this.mC[j] = 1 - Math.exp(-TAU * (ears ? 1400 : 380) / this.sr);
    }
  }

  panicReset() {
    for (const s of this.strings) for (const v of s.voices) { v.y1.fill(0); v.y2.fill(0); v.nact = 0; }
    this.body.reset(); this.staticZ = this.staticY = 0; this.radL = this.radR = this.radXL = this.radXR = 0; this.cplLP = this.cplHP = 0; this.lastF = 0; this.rh.fill(0);
    this.regRing.fill(0); this.regHP.fill(0); this.regX.fill(0); this.mI.fill(0); this.mLP.fill(0); this.rhF.fill(0);
  }

  meters() {
    return this.strings.map(s => ({ e: Math.min(1, s.env), fret: s.fret, midi: s.midi, active: s.v.live }));
  }
}

root.GuitarEngine = GuitarEngine;
root.GUITAR_PRESETS = PRESETS;
root.GUITAR_WOODS = WOODS;
root.GUITAR_HOLDS = HOLDS;

if (typeof registerProcessor === 'function' && typeof AudioWorkletProcessor !== 'undefined') {
  class GuitarProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.eng = new GuitarEngine(sampleRate);
      this.meterCount = 0;
      this.port.onmessage = (m) => { const d = m.data; if (Array.isArray(d)) for (const ev of d) this.eng.post(ev); else this.eng.post(d); };
    }
    process(inputs, outputs) {
      const out = outputs[0], L = out[0], R = out[1] || out[0];
      if (this.eng.clock === 0) this.eng.clock = Math.round(currentTime * sampleRate);
      this.eng.render(L, R, L.length, 0, out[2] || null, out[3] || null);
      if (++this.meterCount >= 12) { this.meterCount = 0; this.port.postMessage({ meters: this.eng.meters() }); }
      return true;
    }
  }
  registerProcessor('acoustic-guitar', GuitarProcessor);
}
})(typeof globalThis !== 'undefined' ? globalThis : this);
