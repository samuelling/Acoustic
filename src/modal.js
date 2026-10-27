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
// strings: [tension N at standard pitch, outer diameter m, core diameter m, wound]
const PRESETS = {
  dreadnought: {
    name: 'Steel dreadnought', scale: 0.645, E: 2.0e11, rho: 7850,
    strings: [[107, 0.00135, 0.00043, 1], [125, 0.00107, 0.00038, 1], [132, 0.00081, 0.00033, 1],
              [132, 0.00061, 0.00028, 1], [103, 0.00041, 0.00041, 0], [103, 0.000305, 0.000305, 0]],
    damp: { veWound: 0.012, vePlain: 0.0025, teWound: 0.5e-4, tePlain: 2.0e-4, fretted: 0.25 },
    body: {
      // f Hz, Q, effective mass kg at the bridge (z), radiation weight
      modes: [[100, 18, 0.9, 1.0], [188, 25, 0.105, 0.8], [204, 25, 0.18, 0.7], [245, 30, 0.45, 0.3],
              [290, 30, 0.38, 0.3], [380, 35, 0.22, 0.4], [420, 35, 0.3, 0.3], [505, 40, 0.22, 0.3],
              [590, 40, 0.3, 0.25], [680, 40, 0.3, 0.25], [765, 40, 0.38, 0.2], [880, 45, 0.38, 0.2]],
      hf: { f0: 950, f1: 9000, count: 64, qlo: 30, qhi: 80, mlo: 0.8, mhi: 4.0, g: 0.15 },
      inplane: 0.25, cross: 0.35, gy: 0.3, seed: 3
    },
    radHP: 88, air: 11000, out: 9.0, lonQ: 350, lonGain: 0.02
  },
  parlor: {
    name: 'Steel parlor', scale: 0.62, E: 2.0e11, rho: 7850,
    strings: [[99, 0.00135, 0.00043, 1], [116, 0.00107, 0.00038, 1], [122, 0.00081, 0.00033, 1],
              [122, 0.00061, 0.00028, 1], [95, 0.00041, 0.00041, 0], [95, 0.000305, 0.000305, 0]],
    damp: { veWound: 0.012, vePlain: 0.0025, teWound: 0.5e-4, tePlain: 2.0e-4, fretted: 0.25 },
    body: {
      modes: [[124, 15, 0.8, 0.8], [225, 22, 0.1, 0.85], [246, 22, 0.16, 0.65], [300, 28, 0.4, 0.3],
              [352, 28, 0.32, 0.35], [440, 32, 0.22, 0.4], [492, 32, 0.28, 0.3], [578, 36, 0.24, 0.3],
              [690, 36, 0.3, 0.25], [790, 40, 0.34, 0.22], [905, 42, 0.36, 0.2]],
      hf: { f0: 1000, f1: 9000, count: 60, qlo: 30, qhi: 75, mlo: 0.7, mhi: 3.6, g: 0.15 },
      inplane: 0.25, cross: 0.35, gy: 0.3, seed: 5
    },
    radHP: 108, air: 11000, out: 10.0, lonQ: 350, lonGain: 0.02
  },
  classical: {
    name: 'Nylon classical', scale: 0.65, E: 4.0e9, rho: 1140,
    strings: [[71, 0.00110, 0.00055, 1], [72, 0.00089, 0.00045, 1], [70, 0.00075, 0.00038, 1],
              [58, 0.00102, 0.00102, 0], [61, 0.00082, 0.00082, 0], [70, 0.00071, 0.00071, 0]],
    damp: { veWound: 0.06, vePlain: 0.02, teWound: 0, tePlain: 0, fretted: 0.25, woundCoreE: 0.3 },
    body: {
      modes: [[96, 14, 0.7, 1.0], [112, 18, 1.2, 0.3], [198, 20, 0.08, 0.85], [228, 20, 0.14, 0.6],
              [272, 25, 0.4, 0.3], [395, 26, 0.24, 0.38], [445, 28, 0.3, 0.3], [540, 30, 0.3, 0.28],
              [640, 32, 0.34, 0.24], [745, 34, 0.38, 0.2], [850, 36, 0.4, 0.18]],
      hf: { f0: 950, f1: 8000, count: 60, qlo: 25, qhi: 60, mlo: 0.7, mhi: 4.0, g: 0.14 },
      inplane: 0.25, cross: 0.35, gy: 0.3, seed: 7
    },
    radHP: 85, air: 10000, out: 14.0, lonQ: 120, lonGain: 0.004
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
class Body {
  constructor(spec, sr, sizeScale) {
    const rng = makeRng(spec.seed || 1);
    const f = [], Q = [], m = [], g = [];
    for (const md of spec.modes) { f.push(md[0] * sizeScale); Q.push(md[1]); m.push(md[2]); g.push(md[3]); }
    const H = spec.hf;
    for (let i = 0; i < H.count; i++) {
      const t = i / H.count;
      f.push(H.f0 * Math.pow(H.f1 / H.f0, t) * (1 + (rng() - 0.5) * 0.15) * sizeScale);
      Q.push(H.qlo + (H.qhi - H.qlo) * rng());
      m.push(H.mlo * Math.pow(H.mhi / H.mlo, t) * Math.exp(gaussFrom(rng) * 0.5));
      g.push(H.g * (rng() < 0.5 ? -1 : 1) * (0.5 + rng()));
    }
    const n = f.length;
    this.n = n;
    this.f = Float64Array.from(f); this.Q = Float64Array.from(Q); this.m = Float64Array.from(m);
    // how each mode moves the bridge: (ry, 1) direction -> in-plane share and cross term
    this.ry = new Float64Array(n); this.rc = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.ry[i] = spec.inplane * (0.4 + 1.2 * rng());
      this.rc[i] = spec.cross * (rng() * 2 - 1);
    }
    // radiation: modal velocity v_k = bandpass(F) * Q/(m w); pressure ~ g_k * w_k * v_k, two mics
    this.b0 = new Float64Array(n); this.a1 = new Float64Array(n); this.a2 = new Float64Array(n);
    this.gL = new Float64Array(n); this.gR = new Float64Array(n);
    this.z1 = new Float64Array(n); this.z2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const w = TAU * Math.min(this.f[i], sr * 0.45) / sr;
      const al = Math.sin(w) / (2 * this.Q[i]), a0 = 1 + al;
      this.b0[i] = al / a0; this.a1[i] = -2 * Math.cos(w) / a0; this.a2[i] = (1 - al) / a0;
      const vel = this.Q[i] / (this.m[i] * TAU * this.f[i]);
      const rad = g[i] * TAU * this.f[i] * vel;
      const spread = i < spec.modes.length ? spec.modes[i][3] < 0.5 ? 0.6 : 0.15 : 0.9;
      this.gL[i] = rad * (1 + spread * (rng() - 0.5)) * (rng() < spread * 0.4 ? -1 : 1);
      this.gR[i] = rad * (1 + spread * (rng() - 0.5)) * (rng() < spread * 0.4 ? -1 : 1);
    }
    this.x1 = 0; this.x2 = 0;
  }
  // 2x2 bridge admittance at angular frequency w. Returns [yyRe,yyIm, yzRe,yzIm, zzRe,zzIm]
  Y(w, out) {
    let yyR = 0, yyI = 0, yzR = 0, yzI = 0, zzR = 0, zzI = 0;
    const w2 = w * w;
    for (let k = 0; k < this.n; k++) {
      const wk = TAU * this.f[k];
      // i w / (m (wk^2 - w^2 + i w wk/Q))
      const re = this.m[k] * (wk * wk - w2), im = this.m[k] * w * wk / this.Q[k];
      const den = re * re + im * im;
      const yr = (w * im) / den, yi = (w * re) / den;
      const ry = this.ry[k], rc = this.rc[k];
      zzR += yr; zzI += yi;
      yyR += yr * ry * ry; yyI += yi * ry * ry;
      yzR += yr * rc; yzI += yi * rc;
    }
    out[0] = yyR; out[1] = yyI; out[2] = yzR; out[3] = yzI; out[4] = zzR; out[5] = zzI;
    return out;
  }
  reset() { this.z1.fill(0); this.z2.fill(0); this.x1 = this.x2 = 0; }
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
    this.voices = [new Voice(), new Voice()];
    this.cur = 0;
    this.open = STD[idx]; this.midi = STD[idx]; this.fret = 0;
    this.releaseAt = -1;
    this.env = 0;
    this.out = 0;
    this.lastU = 0;
    // longitudinal modes: f_Ln = n/(2L) sqrt(EA/mu); driven by tension fluctuations
    this.lonN = 0; this.lonC1 = new Float64Array(4); this.lonC2 = new Float64Array(4);
    this.lonY1 = new Float64Array(4); this.lonY2 = new Float64Array(4); this.lonG = 0;
    this.f2lp = 0;
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
      sympathetic: 0.5, noise: 0.5, width: 1.0, gain: 1.0, override: null
    };
    this.bend = 0; this.bendTarget = 0;
    this.RING = 16384; this.RMASK = this.RING - 1;
    this.bodyIn = new Float64Array(this.RING);    // extra force into the body (pick noise etc.)
    this.dirL = new Float64Array(this.RING); this.dirR = new Float64Array(this.RING);
    this.staticOff = 0;                            // released pick load (decays slowly)
    this.yTmp = new Float64Array(6);
    this.blockCount = 0;
    this.dcL = 0; this.dcR = 0; this.dcxL = 0; this.dcxR = 0;
    this.airL = 0; this.airR = 0;
    this.rh = new Float64Array(8);
    this.cplLP = 0; this.cplHP = 0; this.lastF = 0;
    this.setPreset('dreadnought');
  }

  // ---------- parameters ----------
  setParams(p) {
    let rebuild = false, retune = false;
    for (const k in p) {
      if (k === 'preset' || k === 'bodySize' || k === 'override') rebuild = true;
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
    this.body = new Body(this.P.body, this.sr, 1 / Math.max(0.7, Math.min(1.4, this.params.bodySize)));
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

  // Physical string data for string i at its current open pitch.
  stringPhys(i) {
    const P = this.P, sp = P.strings[i];
    const Tstd = sp[0], d = sp[1], dc = sp[2], wound = !!sp[3];
    const fstd = mtof(STD[i]);
    const mu = Tstd / Math.pow(2 * P.scale * fstd, 2);
    const fopen = mtof(this.params.tuning[i]); // capo shortens the string, tension set by the tuning
    const T = mu * Math.pow(2 * P.scale * fopen, 2);
    const Ecore = P.E * (wound && P.damp.woundCoreE ? P.damp.woundCoreE : 1);
    return { T, mu, d, dc, wound, Ecore, fopen, EA: Ecore * Math.PI * dc * dc / 4 };
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
    }
    // wound strings couple far more (windings rub; core and wrap move differently)
    s.lonG = (this.P.lonGain || 0) * (ph.wound ? 1 : 0.35);
  }

  // Build the modal components of string i sounding `midi` into voice v.
  loadModes(v, i, midi) {
    const key = i + ':' + midi.toFixed(3) + ':' + this.params.tuning[i] + ':' + this.params.brightness;
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
    const B = Math.PI ** 3 * ph.Ecore * ph.dc ** 4 / (64 * T * L * L);
    const fmax = Math.min(sr * 0.45, 11000);
    const out = { n: 0, L, T, EA: ph.EA, B, f0, k: new Int32Array(MAXC), w: new Float64Array(MAXC), sig: new Float64Array(MAXC),
      vy: new Float64Array(MAXC), vz: new Float64Array(MAXC), wy: new Float64Array(MAXC), wz: new Float64Array(MAXC), gin: new Float64Array(MAXC), single: new Uint8Array(MAXC) };
    const D = P.damp, br = this.params.brightness;
    const eta = 1.8e-5, rhoA = 1.2;
    const I = Math.PI * ph.dc ** 4 / 64;
    const ve = (ph.wound ? D.veWound : D.vePlain) * (1.6 - 1.2 * br); // old strings: more internal loss
    const te = ph.wound ? D.teWound : D.tePlain;
    const Y = this.Ybuf;
    const fretted = fret - capo > 0.5;
    let c = 0;
    for (let k = 1; c < MAXC - 1; k++) {
      const f = k * f0 * Math.sqrt(1 + B * k * k);
      if (f > fmax) break;
      const w = TAU * f;
      // intrinsic damping (Valette & Cuesta)
      const R = TAU * eta + TAU * ph.d * Math.sqrt(Math.PI * eta * rhoA * f);
      const qAir = R / (TAU * ph.mu * f);
      const qVe = 4 * Math.PI * Math.PI * ph.mu * ph.Ecore * I * ve * f * f / (T * T);
      let sInt = Math.PI * f * (qAir + qVe + te);
      if (fretted) sInt += D.fretted * (1 + f / 2000); // finger on the fret, neck losses
      // bridge coupling: ds = -(T/L) Y2(w), eigen-decomposed
      this.body.Y(w, Y);
      const s = -T / L;
      const aR = s * Y[0], aI = s * Y[1], bR = s * Y[2], bI = s * Y[3], dR = s * Y[4], dI = s * Y[5];
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
    const wound = this.P.strings[ev.s] && this.P.strings[ev.s][3];
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
      s.cur ^= 1; v = s.v;
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
    this.staticOff -= Fs * (st + P.body.gy * ct);
    // release click: pick or nail leaving the string, straight into the body
    const nAmt = this.params.noise * vel * (style === 'pick' ? 0.45 : 0.15) * (ev.dead ? 2 : 1);
    if (nAmt > 0) {
      const start = this.clock & this.RMASK, nl = Math.round(0.004 * sr);
      const wound = this.P.strings[ev.s][3];
      let p1 = 0, p2 = 0;
      for (let i = 0; i < nl; i++) {
        const r = this.rng() * 2 - 1, hp = r - 2 * p1 + p2; p2 = p1; p1 = r;
        this.bodyIn[(start + i) & this.RMASK] += hp * nAmt * Math.exp(-i / (0.0009 * sr)) * (wound ? 1 : 0.5);
      }
    }
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
      if (y1 * y1 + y2 * y2 > 1e-17) v.act[n++] = c;
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
    if (!this.P.strings[ev.s][3]) return;
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
      const val = y * (0.5 + 0.5 * Math.cos(TAU * ph)) * env * amt * 0.09 * lvl;
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
          if (a2 > 1e-17) v.act[n++] = c;
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
      s.env = s.env * 0.7 + 0.3 * envSum * 0.004;
      // finger lifted: string becomes a free open string again
      if (s.releaseAt >= 0 && this.clock >= s.releaseAt) {
        s.releaseAt = -1;
        const v = s.v;
        if (Math.abs(v.midi - s.open) > 0.01) { s.cur ^= 1; this.loadModes(s.v, s.idx, s.open); s.midi = s.open; s.fret = 0; }
        else { v.extraTarget = 0; v.extraRate = 0.2; }
        s.v.live = false;
      }
    }
  }

  // ---------- render ----------
  render(outL, outR, n, offset = 0) {
    let done = 0;
    while (done < n) {
      while (this.queue.length && this.queue[0]._at <= this.clock) this.handle(this.queue.shift());
      let seg = n - done;
      if (this.queue.length) seg = Math.max(1, Math.min(seg, this.queue[0]._at - this.clock));
      // control-rate work every 64 samples
      const toCtl = 64 - (this.clock & 63);
      seg = Math.min(seg, toCtl);
      this.renderSeg(outL, outR, offset + done, seg);
      done += seg;
      if ((this.clock & 63) === 0) this.control();
    }
  }

  renderSeg(outL, outR, off, n) {
    const S = this.strings, B = this.body, nb = B.n;
    const b0 = B.b0, a1 = B.a1, a2 = B.a2, gL = B.gL, gR = B.gR, z1 = B.z1, z2 = B.z2;
    const gy = this.P.body.gy, bodyAmt = this.params.body, gain = this.params.gain * this.P.out;
    const width = this.params.width;
    const symp = this.params.sympathetic * 1.2e-6; // bridge compliance, m/N
    const sr = this.sr;
    const fz = this.yTmp;
    const lpC = 1 - Math.exp(-TAU * 3000 / sr), hpC = Math.exp(-TAU * 60 / sr);
    const stDecay = Math.exp(-1 / (0.6 * sr));
    for (let i = 0; i < n; i++) {
      const tIdx = this.clock & this.RMASK;
      // sympathetic drive: band-limited bridge force from the other strings (last sample)
      this.cplLP += (this.lastF - this.cplLP) * lpC || 0;
      this.cplHP = hpC * this.cplHP + (1 - hpC) * this.cplLP;
      const cpl = this.cplLP - this.cplHP;
      let Ftot = 0, Fy = 0, Fz = 0;
      for (let j = 0; j < 6; j++) {
        const s = S[j];
        let sy = 0, sz = 0;
        const u = symp * (cpl - s.lastU);
        for (let vv = 0; vv < 2; vv++) {
          const v = s.voices[vv];
          const na = v.nact; if (!na) continue;
          const act = v.act, c1 = v.c1, c2 = v.c2, y1 = v.y1, y2 = v.y2, wy = v.wy, wz = v.wz, gin = v.gin;
          for (let q = 0; q < na; q++) {
            const c = act[q];
            const y = c1[c] * y1[c] - c2[c] * y2[c] + gin[c] * u;
            y2[c] = y1[c]; y1[c] = y;
            sy += wy[c] * y; sz += wz[c] * y;
          }
        }
        let own = sz + gy * sy;
        if (s.lonN && s.lonG) {
          // tension fluctuation ~ square of the string slope at the bridge ~ (force)^2; remove its slow part
          const f2 = own * own; s.f2lp += (f2 - s.f2lp) * 0.002;
          const drive = (f2 - s.f2lp) * s.lonG;
          let lo = 0;
          for (let q = 0; q < s.lonN; q++) {
            const y = s.lonC1[q] * s.lonY1[q] - s.lonC2[q] * s.lonY2[q] + drive / (q + 1);
            s.lonY2[q] = s.lonY1[q]; s.lonY1[q] = y; lo += y;
          }
          own += lo;
        }
        s.lastU = own; s.out = own;
        Fy += sy; Fz += sz; Ftot += own;
      }
      this.lastF = Ftot;
      // body: modal velocities driven by bridge force (minus the released pick load)
      this.staticOff *= stDecay;
      const bi = Ftot + this.staticOff + this.bodyIn[tIdx]; this.bodyIn[tIdx] = 0;
      const bx = bi - B.x2; B.x2 = B.x1; B.x1 = bi;
      let L = 0, R = 0;
      for (let q = 0; q < nb; q++) {
        const y = b0[q] * bx - a1[q] * z1[q] - a2[q] * z2[q];
        z2[q] = z1[q]; z1[q] = y;
        L += gL[q] * y; R += gR[q] * y;
      }
      L *= bodyAmt; R *= bodyAmt;
      const mid = 0.5 * (L + R), side = 0.5 * (L - R) * width;
      L = mid + side; R = mid - side;
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
      this.clock++;
    }
  }

  panicReset() {
    for (const s of this.strings) for (const v of s.voices) { v.y1.fill(0); v.y2.fill(0); v.nact = 0; }
    this.body.reset(); this.staticOff = 0; this.cplLP = this.cplHP = 0; this.lastF = 0; this.rh.fill(0);
  }

  meters() {
    return this.strings.map(s => ({ e: Math.min(1, s.env), fret: s.fret, midi: s.midi, active: s.v.live }));
  }
}

root.GuitarEngine = GuitarEngine;
root.GUITAR_PRESETS = PRESETS;

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
      this.eng.render(L, R, L.length, 0);
      if (++this.meterCount >= 12) { this.meterCount = 0; this.port.postMessage({ meters: this.eng.meters() }); }
      return true;
    }
  }
  registerProcessor('acoustic-guitar', GuitarProcessor);
}
})(typeof globalThis !== 'undefined' ? globalThis : this);
