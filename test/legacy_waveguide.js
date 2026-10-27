// Acoustic — physical model guitar engine.
// Runs inside an AudioWorklet, on the main thread (ScriptProcessor fallback), or in Node for offline tests.
//
// Model summary
//  * 6 strings, each a single-delay-loop digital waveguide with two polarizations
//    (horizontal: parallel to the top, long decay; vertical: into the top, short decay, louder at the bridge).
//  * Loop = 4-point Lagrange fractional delay -> one-pole loss filter (designed from T60 at f0 and at a high
//    reference frequency) -> two first-order allpasses (stiffness / inharmonicity).
//  * Excitation = rectangular force pulse of length beta*N (beta = pluck point / speaking length), which places
//    the comb-filter nulls of the pluck position, smoothed by a 2-pole lowpass whose corner rises with velocity.
//  * Tension modulation: delay shrinks with squared amplitude envelope (pitch glide on hard attacks).
//  * Strings are coupled through the bridge (sympathetic resonance), DC-blocked and band-limited.
//  * Body = parallel bank of resonant modes (Helmholtz A0, T(1,1) pair, cross dipoles, dense high modes),
//    two sets of mode gains for a stereo pair of mics, plus a high-passed direct radiation path.
//  * Extra noise layers: pick scrape into body, fret squeaks, finger release noise.

(function (root) {
'use strict';

const TAU = Math.PI * 2;

function onePolePD(a, w) { // phase delay (samples) of (1-a)/(1-a z^-1) at w
  return Math.atan2(a * Math.sin(w), 1 - a * Math.cos(w)) / w;
}
function onePoleMag(a, w) {
  return (1 - a) / Math.sqrt(1 - 2 * a * Math.cos(w) + a * a);
}
function allpassPD(c, w) { // (c + z^-1)/(1 + c z^-1)
  const num = Math.atan2(-Math.sin(w), c + Math.cos(w));
  const den = Math.atan2(-c * Math.sin(w), 1 + c * Math.cos(w));
  let ph = num - den;
  while (ph > 0) ph -= TAU;
  return -ph / w;
}
// Design one-pole loss filter so per-period gain at w0 is G0 and at w1 is G1 (G1 < G0).
function designLoss(G0, G1, w0, w1) {
  const target = G1 / G0;
  let lo = 0, hi = 0.995;
  for (let i = 0; i < 50; i++) {
    const a = 0.5 * (lo + hi);
    const r = onePoleMag(a, w1) / onePoleMag(a, w0);
    if (r > target) lo = a; else hi = a;
  }
  const a = 0.5 * (lo + hi);
  const g = G0 / onePoleMag(a, w0);
  return { a, g };
}

// ---------- Instrument presets ----------
const PRESETS = {
  dreadnought: {
    name: 'Steel dreadnought',
    t60Low: 10, t60Exp: 0.35, t60Mid: 2.6, midRef: 1200, fretFactor: 0.72,
    apStages: 4, stiffLow: 0.7, stiffHigh: 0.3, tension: 0.020, pickBright: 3400, fingerBright: 1500,
    polV: 0.55, polDetune: 0.0011, vertDecay: 0.38, polCross: 0.0015,
    direct: 0.7, directHP: 320, air: 8000, radHP: 120,
    modes: [ // f, Q, gain, stereo spread  (low modes after Russell's dreadnought measurements: A0 ~100 Hz, T(1,1) pair 188/203 Hz)
      [99, 11, 1.00, 0.05], [118, 14, 0.25, 0.3], [188, 14, 0.80, 0.15], [204, 13, 0.70, 0.25],
      [242, 16, 0.30, 0.6], [292, 15, 0.30, 0.6], [378, 17, 0.40, 0.8], [418, 17, 0.30, 0.9],
      [505, 19, 0.33, 1], [588, 18, 0.26, 1], [676, 20, 0.24, 1], [764, 22, 0.22, 1], [880, 22, 0.20, 1]
    ],
    hiModes: { count: 34, f0: 960, f1: 7000, qLo: 12, qHi: 30, g: 0.24 }
  },
  parlor: {
    name: 'Steel parlor',
    t60Low: 8, t60Exp: 0.35, t60Mid: 2.2, midRef: 1200, fretFactor: 0.72,
    apStages: 4, stiffLow: 0.68, stiffHigh: 0.28, tension: 0.020, pickBright: 3400, fingerBright: 1500,
    polV: 0.55, polDetune: 0.0012, vertDecay: 0.38, polCross: 0.0015,
    direct: 0.55, directHP: 380, air: 8000, radHP: 125,
    modes: [
      [124, 10, 0.75, 0.05], [225, 13, 0.85, 0.15], [246, 13, 0.65, 0.25], [300, 16, 0.3, 0.6],
      [352, 16, 0.35, 0.7], [440, 17, 0.42, 0.9], [492, 18, 0.32, 1], [578, 19, 0.3, 1],
      [690, 20, 0.25, 1], [790, 21, 0.24, 1], [905, 22, 0.2, 1]
    ],
    hiModes: { count: 32, f0: 1000, f1: 7000, qLo: 12, qHi: 28, g: 0.24 }
  },
  classical: {
    name: 'Nylon classical',
    t60Low: 9, t60Exp: 0.3, t60Mid: 3.0, midRef: 1200, fretFactor: 0.75,
    apStages: 4, stiffLow: 0.6, stiffHigh: 0.32, tension: 0.040, pickBright: 3600, fingerBright: 3400,
    polV: 0.6, polDetune: 0.0012, vertDecay: 0.45, polCross: 0.002,
    direct: 0.6, directHP: 300, air: 10000, radHP: 118,
    modes: [
      [96, 10, 1.0, 0.05], [112, 12, 0.3, 0.3], [198, 12, 0.85, 0.15], [228, 12, 0.6, 0.3],
      [272, 14, 0.3, 0.6], [395, 15, 0.38, 0.8], [445, 16, 0.3, 0.9], [540, 17, 0.28, 1],
      [640, 18, 0.24, 1], [745, 19, 0.2, 1], [850, 20, 0.18, 1]
    ],
    hiModes: { count: 34, f0: 950, f1: 7000, qLo: 10, qHi: 24, g: 0.26 }
  }
};

function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

const BUF = 8192, MASK = BUF - 1;
const RING = 16384, RMASK = RING - 1;

class Pol {
  constructor() {
    this.buf = new Float32Array(BUF); this.w = 0;
    this.lp = 0; this.ap = new Float64Array(6);
    this.D = 100; this.g = 0.99; this.a = 0.1; this.c = 0;
    this.y = 0;
  }
  clear() { this.buf.fill(0); this.lp = 0; this.ap.fill(0); this.y = 0; }
}

class GString {
  constructor(idx) {
    this.idx = idx;
    this.h = new Pol(); this.v = new Pol();
    this.open = 40; this.midi = 40; this.fret = 0;
    this.f0 = 82.4;
    // loss targets: free and damped
    this.free = { gh: .99, ah: .1, gv: .99, av: .1 };
    this.mute = { g: .8, a: .6 };
    this.damp = 0; this.dampTarget = 0; this.dampRate = 0.001;
    this.releaseAt = -1;           // sample index when string returns to "open/free" after a damp
    this.contactLeft = 0; this.contactGain = 1;
    this.exc = new Float32Array(RING); // excitation ring aligned to engine clock
    this.ch = 0.8; this.cv = 0.45;
    this.env = 0; this.envOut = 0;
    this.tension = 0.02;
    this.Dh = 100; this.Dv = 100;
    this.out = 0;
    this.pickPos = 0.2;
    this.active = false;
  }
}

class GuitarEngine {
  constructor(sr) {
    this.sr = sr;
    this.rng = makeRng(12345);
    this.strings = [];
    for (let i = 0; i < 6; i++) this.strings.push(new GString(i));
    this.clock = 0;            // samples rendered
    this.queue = [];           // pending events sorted by sample time
    this.bodyIn = new Float32Array(RING); // pick noise etc. into body
    this.dirL = new Float32Array(RING); this.dirR = new Float32Array(RING); // direct noises (squeaks)
    this.params = {
      preset: 'dreadnought', tuning: [40, 45, 50, 55, 59, 64], capo: 0,
      brightness: 0.55,       // string age / brightness 0..1
      body: 0.8,              // body resonance amount
      bodySize: 1.0,          // scales mode frequencies (inverse)
      sympathetic: 0.5,       // 0..1
      noise: 0.5,             // finger / pick noise amount
      width: 0.7,
      gain: 0.7
    };
    this.bend = 0; this.bendTarget = 0;
    this.couplingK = 0.00015;
    this.hpB = 0; this.lpB = 0;
    this.dcL = 0; this.dcR = 0; this.dcxL = 0; this.dcxR = 0;
    this.airL = 0; this.airR = 0;
    this.directLP = 0; this.directHPs = 0; this.bx1 = 0; this.bx2 = 0;
    this.setPreset('dreadnought');
  }

  // ---------- parameters ----------
  setParams(p) {
    let rebuildBody = false, retune = false;
    for (const k in p) {
      if ((k === 'preset' && p[k] !== this.params.preset) || k === 'override') rebuildBody = true;
      if (k === 'bodySize' && p[k] !== this.params.bodySize) rebuildBody = true;
      if (k === 'brightness' || k === 'tuning' || k === 'capo') retune = true;
      this.params[k] = p[k];
    }
    this.couplingK = 0.00032 * Math.max(0, Math.min(1, this.params.sympathetic));
    if (rebuildBody) this.setPreset(this.params.preset);
    else if (retune) this.retuneAll();
  }

  setPreset(name) {
    this.preset = Object.assign({}, PRESETS[name] || PRESETS.dreadnought, this.params.override || {});
    this.params.preset = name in PRESETS ? name : 'dreadnought';
    this.buildBody();
    this.retuneAll();
  }

  buildBody() {
    const P = this.preset, sr = this.sr, rng = makeRng(777 + this.params.preset.length);
    const scale = 1 / Math.max(0.6, Math.min(1.5, this.params.bodySize));
    const modes = [];
    for (const m of P.modes) {
      const s = m[3];
      const gl = m[2] * (1 + s * (rng() - 0.5) * 0.8) * (rng() < s * 0.35 ? -1 : 1);
      const gr = m[2] * (1 + s * (rng() - 0.5) * 0.8) * (rng() < s * 0.35 ? -1 : 1);
      modes.push([m[0] * scale, m[1], gl, gr]);
    }
    const H = P.hiModes;
    for (let i = 0; i < H.count; i++) {
      const t = (i + 0.5) / H.count;
      const f = H.f0 * Math.pow(H.f1 / H.f0, t) * (1 + (rng() - 0.5) * 0.12);
      const q = H.qLo + (H.qHi - H.qLo) * rng();
      const g = H.g * (0.55 + 0.9 * rng()) * Math.pow(1 - t, 0.5);
      modes.push([f * scale, q, g * (rng() < 0.5 ? -1 : 1), g * (rng() < 0.5 ? -1 : 1)]);
    }
    const n = modes.length;
    this.nm = n;
    this.mb0 = new Float32Array(n); this.ma1 = new Float32Array(n); this.ma2 = new Float32Array(n);
    this.mgL = new Float32Array(n); this.mgR = new Float32Array(n);
    this.mz1 = new Float32Array(n); this.mz2 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const [f, q, gl, gr] = modes[i];
      const w = TAU * Math.min(f, sr * 0.45) / sr;
      const al = Math.sin(w) / (2 * q);
      const a0 = 1 + al;
      this.mb0[i] = al / a0; this.ma1[i] = -2 * Math.cos(w) / a0; this.ma2[i] = (1 - al) / a0;
      this.mgL[i] = gl; this.mgR[i] = gr;
    }
    this.directHPc = Math.exp(-TAU * P.directHP / sr);
    // radiation efficiency below the air (A0) resonance falls steeply: 2nd-order highpass on the output
    { const w = TAU * P.radHP / sr, q = 0.8, al = Math.sin(w) / (2 * q), a0 = 1 + al, cw = Math.cos(w);
      this.rhb0 = (1 + cw) / 2 / a0; this.rhb1 = -(1 + cw) / a0; this.rhb2 = this.rhb0;
      this.rha1 = -2 * cw / a0; this.rha2 = (1 - al) / a0; }
    this.rh = new Float64Array(8);
    this.airC = Math.exp(-TAU * P.air / sr);
  }

  retuneAll() {
    const tun = this.params.tuning, capo = this.params.capo | 0;
    for (let i = 0; i < 6; i++) {
      const s = this.strings[i];
      s.open = tun[i] + capo;
      if (!s.active) { s.midi = s.open; s.fret = 0; }
      this.tuneString(s);
    }
  }

  // Compute loop parameters for string s at s.midi.
  tuneString(s) {
    const P = this.preset, sr = this.sr;
    const f0 = 440 * Math.pow(2, (s.midi - 69) / 12);
    s.f0 = f0;
    const fretted = s.midi - s.open > 0.5;
    const openF = 440 * Math.pow(2, (s.open - 69) / 12);
    // T60 of fundamental: longer for low strings; fretted notes lose energy into the finger/neck
    let t60 = P.t60Low * Math.pow(82.4 / f0, P.t60Exp);
    if (fretted) t60 *= P.fretFactor;
    // T60 at a mid reference (~1.2 kHz) sets how fast upper partials die; new strings keep their highs longer
    const br = this.params.brightness;
    const t60m = P.t60Mid * (0.5 + 1.0 * br) * Math.pow(openF / 82.4, 0.1);
    const fRef = Math.max(P.midRef, f0 * 2.5);
    const w0 = TAU * f0 / sr, w1 = TAU * Math.min(fRef, sr * 0.4) / sr;
    const tm = Math.min(t60m * Math.pow(P.midRef / fRef, 0.8), t60 * 0.85);
    const G0 = Math.pow(10, -3 / (t60 * f0)), G1 = Math.pow(10, -3 / (tm * f0));
    const lh = designLoss(G0, G1, w0, w1);
    const t60v = t60 * P.vertDecay;
    const G0v = Math.pow(10, -3 / (t60v * f0)), G1v = Math.pow(10, -3 / (Math.min(tm * 0.85, t60v * 0.85) * f0));
    const lv = designLoss(G0v, G1v, w0, w1);
    s.free = { gh: Math.min(lh.g, 0.9995), ah: lh.a, gv: Math.min(lv.g, 0.9995), av: lv.a };
    // muted string: ~0.09 s fundamental decay, very dark
    const Gm = Math.pow(10, -3 / (0.09 * f0));
    s.mute = { g: Gm / onePoleMag(0.55, w0), a: 0.55 };
    // stiffness: cascade of first-order allpasses; coefficient interpolated by string gauge
    const tt = Math.pow(Math.max(0, Math.min(1, (s.open - 40) / 24)), 1.6);
    let c = -(P.stiffLow * (1 - tt) + P.stiffHigh * tt);
    let M = P.apStages | 0;
    // keep the loop long enough for very high notes
    while (M > 0 && sr / f0 - M * allpassPD(c, w0) < 8) M--;
    s.M = M; s.h.c = c; s.v.c = c;
    s.tension = P.tension * (1.2 - 0.6 * tt);
    const apd = M * allpassPD(c, w0);
    s.Dh = sr / f0 - onePolePD(lh.a, w0) - apd;
    const fv = f0 * (1 + P.polDetune * (s.idx % 2 ? 1 : -0.7));
    const wv = TAU * fv / sr;
    s.Dv = sr / fv - onePolePD(lv.a, wv) - M * allpassPD(c, wv);
    s.N = sr / f0;
    s.lpdH = onePolePD(lh.a, w0);
  }

  // ---------- events ----------
  post(ev) {
    // ev.t: seconds on engine clock; convert to sample index
    const at = ev.t == null ? this.clock : Math.max(this.clock, Math.round(ev.t * this.sr));
    ev._at = at;
    const q = this.queue;
    let i = q.length;
    while (i > 0 && q[i - 1]._at > at) i--;
    q.splice(i, 0, ev);
  }

  handle(ev) {
    switch (ev.type) {
      case 'pluck': this.pluck(ev); break;
      case 'damp': this.dampString(ev); break;
      case 'squeak': this.squeak(ev); break;
      case 'bend': this.bendTarget = ev.value; break;
      case 'params': this.setParams(ev.params); break;
      case 'allOff': for (const s of this.strings) this.dampString({ s: s.idx, time: 0.08 }); break;
      case 'panic': for (const s of this.strings) { s.h.clear(); s.v.clear(); s.exc.fill(0); s.active = false; } break;
    }
  }

  pluck(ev) {
    const sr = this.sr, P = this.preset, s = this.strings[ev.s];
    if (!s) return;
    const vel = Math.max(0.02, Math.min(1, ev.vel == null ? 0.7 : ev.vel));
    const newMidi = ev.midi == null ? s.open : ev.midi;
    const changed = Math.abs(newMidi - s.midi) > 0.01;
    const wasRinging = s.envOut > 0.002;
    s.midi = newMidi; s.fret = Math.round(newMidi - s.open);
    this.tuneString(s);
    s.active = true;
    s.releaseAt = -1;
    // pick / finger contact on a vibrating string removes part of the old vibration over one period
    // (each stored sample passes the loss point once per period, so a per-sample factor scales the whole loop once)
    s.contactLeft = Math.ceil(s.N) + 2;
    s.contactGain = changed ? 0.3 : (0.62 - 0.32 * vel);
    if (changed && wasRinging) { // new fret: the old standing wave is mostly stopped right away
      s.h.buf.forEach((v, i, b) => { b[i] = v * 0.3; }); s.v.buf.forEach((v, i, b) => { b[i] = v * 0.3; });
      s.h.lp *= 0.3; s.v.lp *= 0.3;
    }
    // damping state
    if (ev.dead) { s.dampTarget = 1; s.damp = 1; }
    else if (ev.palm) { s.dampTarget = 0.55; s.damp = 0.55; }
    else { s.dampTarget = 0; s.damp = Math.min(s.damp, 0.15); }
    s.dampRate = 1 - Math.exp(-1 / (0.004 * sr));

    const style = ev.style || 'pick';
    const dir = ev.dir < 0 ? -1 : 1;
    // speaking length fraction and pluck position along it
    const speak = Math.pow(2, -(s.midi - s.open) / 12);
    const pickPos = (ev.pickPos == null ? 0.2 : ev.pickPos) * (1 + (this.rng() - 0.5) * 0.08);
    const beta = Math.max(0.03, Math.min(0.5, pickPos / speak));
    s.pickPos = beta;
    // brightness: velocity raises the excitation lowpass corner
    let fc = (style === 'pick' ? P.pickBright : P.fingerBright) * (0.3 + 0.95 * Math.pow(vel, 1.2));
    if (style === 'thumb') fc *= 0.6;
    // thinner (treble) strings bend more sharply around the pick: brighter attack
    fc *= Math.pow(440 * Math.pow(2, (s.open - 69) / 12) / 165, 0.35);
    if (ev.bright != null) fc *= ev.bright;
    if (ev.dead) fc *= 0.5;
    fc = Math.min(fc, sr * 0.4);
    const al = 1 - Math.exp(-TAU * fc / sr);
    const amp = Math.pow(vel, 1.25) * (ev.dead ? 0.6 : 1) * (style === 'thumb' ? 0.95 : 1);
    const L = Math.max(2, Math.round(beta * s.N));
    const tail = Math.ceil(6 * sr / (TAU * fc)) + 4;
    const start = (ev._at || this.clock) & RMASK;
    // polarization split: pick strokes are mostly parallel to the top, finger rest strokes push into it
    const pv = style === 'pick' ? 0.42 : style === 'thumb' ? 0.6 : 0.55;
    const ch = 1.0, cv = pv * (0.8 + 0.4 * this.rng());
    s.ch = ch; s.cv = cv;
    // Excitation sample k should reach the output at time now+k. Samples with k < D are written straight
    // into the part of each delay line that will be read k samples from now; later ones are injected at the
    // loop input k-D samples from now.
    const Di = Math.max(3, Math.round(s.Dh));
    let s1 = 0, s2 = 0;
    const total = Math.min(L + tail, RING - 64);
    const scrape = style === 'pick' ? 0.06 * vel * this.params.noise : 0.015 * vel * this.params.noise;
    let nz = 0;
    for (let k = 0; k < total; k++) {
      const x = k < L ? amp * dir : 0;
      s1 += (x - s1) * al; s2 += (s1 - s2) * al;
      let v = s2;
      if (k < 160) { const r = this.rng() - 0.5; v += (r - nz) * scrape * (1 - k / 160); nz = r; }
      if (k < Di) {
        const ih = (s.h.w + k - Math.round(s.Dh)) & MASK, iv = (s.v.w + k - Math.round(s.Dv)) & MASK;
        s.h.buf[ih] += v * ch; s.v.buf[iv] += v * cv;
      } else {
        s.exc[(start + k - Di) & RMASK] += v;
      }
    }
    // pick / nail contact noise straight into the body (very short, bright)
    const nAmt = this.params.noise * vel * (style === 'pick' ? 0.05 : 0.018) * (ev.dead ? 2.2 : 1);
    if (nAmt > 0) {
      const nl = Math.round((style === 'pick' ? 0.004 : 0.006) * sr);
      let p = 0;
      for (let k = 0; k < nl; k++) {
        const r = this.rng() * 2 - 1, hp = r - p; p = r;
        const e = Math.exp(-k / (nl * 0.25));
        this.bodyIn[(start + k) & RMASK] += hp * nAmt * e;
      }
    }
  }

  dampString(ev) {
    const s = this.strings[ev.s]; if (!s) return;
    const time = ev.time == null ? 0.07 : ev.time;
    s.dampTarget = 1;
    s.dampRate = 1 - Math.exp(-1 / (Math.max(0.005, time) * this.sr));
    // after the vibration is gone the finger lifts and the string is a free open string again
    s.releaseAt = this.clock + Math.round((0.35 + time * 3) * this.sr);
    // small lift-off noise
    const amt = this.params.noise * 0.004 * Math.min(1, s.envOut * 8);
    if (amt > 0.00005) {
      const at = this.clock & RMASK; let p = 0;
      for (let k = 0; k < 400; k++) {
        const r = this.rng() * 2 - 1; const v = (r - p) * amt * Math.exp(-k / 90); p = r;
        this.bodyIn[(at + k) & RMASK] += v;
      }
    }
  }

  // Fret / finger squeak: fingertip sliding along a wound string. Noise through a resonance that sweeps,
  // amplitude-modulated at the rate the fingertip crosses the windings.
  squeak(ev) {
    const s = this.strings[ev.s]; if (!s) return;
    const amt = (ev.amt == null ? 0.5 : ev.amt) * this.params.noise;
    if (amt < 0.01) return;
    const wound = s.open < 56; // E A D G wound on steel sets
    if (!wound && this.params.preset !== 'classical') return;
    const sr = this.sr, dur = 0.06 + 0.12 * this.rng();
    const n = Math.min(RING - 64, Math.round(dur * sr));
    const start = (ev._at || this.clock) & RMASK;
    const f1 = 1800 + 2400 * this.rng(), f2 = f1 * (0.6 + 0.8 * this.rng());
    let z1 = 0, z2 = 0, ph = 0;
    const rate = 120 + 260 * this.rng(); // windings per second
    const pan = (s.idx - 2.5) / 6;
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const f = f1 + (f2 - f1) * t;
      const w = TAU * f / sr, q = 6;
      const al = Math.sin(w) / (2 * q), a0 = 1 + al;
      const x = this.rng() * 2 - 1;
      const y = (al / a0) * x - (-2 * Math.cos(w) / a0) * z1 - ((1 - al) / a0) * z2; // bandpass-ish resonance
      z2 = z1; z1 = y;
      ph += rate / sr; const am = 0.5 + 0.5 * Math.cos(TAU * ph);
      const env = Math.sin(Math.PI * t) * Math.sin(Math.PI * t);
      const v = y * am * env * amt * 0.09 * (this.params.preset === 'classical' ? 0.6 : 1);
      this.dirL[(start + k) & RMASK] += v * (1 - pan);
      this.dirR[(start + k) & RMASK] += v * (1 + pan);
    }
  }

  // ---------- render ----------
  render(outL, outR, n, offset = 0) {
    let done = 0;
    while (done < n) {
      while (this.queue.length && this.queue[0]._at <= this.clock) this.handle(this.queue.shift());
      let seg = n - done;
      if (this.queue.length) seg = Math.max(1, Math.min(seg, this.queue[0]._at - this.clock));
      this.renderSeg(outL, outR, offset + done, seg);
      done += seg;
    }
  }

  renderSeg(outL, outR, off, n) {
    const S = this.strings, k = this.couplingK, P = this.preset, nm = this.nm;
    const mb0 = this.mb0, ma1 = this.ma1, ma2 = this.ma2, mgL = this.mgL, mgR = this.mgR, mz1 = this.mz1, mz2 = this.mz2;
    const body = this.params.body, direct = P.direct, gain = this.params.gain;
    const width = this.params.width;
    const hpBc = Math.exp(-TAU * 70 / this.sr), lpBc = 1 - Math.exp(-TAU * 2500 / this.sr);
    for (let i = 0; i < n; i++) {
      const tIdx = this.clock & RMASK;
      // bend smoothing
      this.bend += (this.bendTarget - this.bend) * 0.0015;
      const bendR = this.bend === 0 ? 1 : Math.pow(2, -this.bend / 12);
      // 1) read all string outputs
      let bridge = 0;
      for (let j = 0; j < 6; j++) {
        const s = S[j];
        const tm = 1 / (1 + s.tension * s.env * s.env);
        s.h.y = readLagrange(s.h, s.Dh * tm * bendR);
        s.v.y = readLagrange(s.v, s.Dv * tm * bendR);
        s.out = 0.38 * s.h.y + s.v.y;
        bridge += s.out;
      }
      // coupling signal: band-limited, DC-free bridge motion
      this.lpB += (bridge - this.lpB) * lpBc;
      this.hpB = hpBc * this.hpB + (1 - hpBc) * this.lpB;
      const cpl = this.lpB - this.hpB;
      // 2) loop filters + write
      for (let j = 0; j < 6; j++) {
        const s = S[j];
        if (s.releaseAt >= 0 && this.clock >= s.releaseAt) {
          s.releaseAt = -1; s.dampTarget = 0; s.dampRate = 1 - Math.exp(-1 / (0.03 * this.sr));
          s.active = false;
          if (Math.abs(s.midi - s.open) > 0.01) { s.midi = s.open; s.fret = 0; this.tuneString(s); }
        }
        s.damp += (s.dampTarget - s.damp) * s.dampRate;
        const d = s.damp;
        const f = s.free, m = s.mute;
        const gh = f.gh + (m.g - f.gh) * d, ah = f.ah + (m.a - f.ah) * d;
        const gv = f.gv + (m.g - f.gv) * d, av = f.av + (m.a - f.av) * d;
        let cg = 1;
        if (s.contactLeft > 0) { s.contactLeft--; cg = s.contactGain; }
        const e = s.exc[tIdx]; s.exc[tIdx] = 0;
        const own = 0.38 * s.h.y + s.v.y;
        const cin = k * (cpl - own * 0.3);
        const M = s.M, pc = P.polCross, hy = s.h.y, vy = s.v.y;
        // horizontal
        let H = s.h, ap = H.ap, c = H.c;
        H.lp = (1 - ah) * ((1 - pc) * hy + pc * vy) + ah * H.lp;
        let x = gh * cg * H.lp;
        for (let q = 0; q < M; q++) { const o = c * x + ap[q]; ap[q] = x - c * o; x = o; }
        let wv = x + e * s.ch + cin * 0.5;
        if (wv > 4 || wv < -4) wv = Math.tanh(wv * 0.25) * 4;
        H.buf[H.w] = wv; H.w = (H.w + 1) & MASK;
        // vertical
        H = s.v; ap = H.ap; c = H.c;
        H.lp = (1 - av) * ((1 - pc) * vy + pc * hy) + av * H.lp;
        x = gv * cg * H.lp;
        for (let q = 0; q < M; q++) { const o = c * x + ap[q]; ap[q] = x - c * o; x = o; }
        wv = x + e * s.cv + cin;
        if (wv > 4 || wv < -4) wv = Math.tanh(wv * 0.25) * 4;
        H.buf[H.w] = wv; H.w = (H.w + 1) & MASK;
        // amplitude envelope (for tension modulation + meters)
        const ao = Math.abs(own);
        s.env += (ao - s.env) * (ao > s.env ? 0.02 : 0.0015);
        s.envOut = s.env;
      }
      // 3) body
      const bi = bridge + this.bodyIn[tIdx]; this.bodyIn[tIdx] = 0;
      const bx = bi - this.bx2; this.bx2 = this.bx1; this.bx1 = bi;
      let mL = 0, mR = 0;
      for (let q = 0; q < nm; q++) {
        const y = mb0[q] * bx - ma1[q] * mz1[q] - ma2[q] * mz2[q]; // RBJ bandpass, 0 dB peak
        mz2[q] = mz1[q]; mz1[q] = y;
        mL += mgL[q] * y; mR += mgR[q] * y;
      }
      this.directHPs = this.directHPc * this.directHPs + (1 - this.directHPc) * bi;
      const dir = (bi - this.directHPs) * direct;
      let L = dir + body * 2.2 * mL, R = dir + body * 2.2 * mR;
      // width
      const mid = 0.5 * (L + R), side = 0.5 * (L - R) * width;
      L = mid + side; R = mid - side;
      // radiation highpass (below A0 the top and the soundhole cancel)
      { const r = this.rh;
        const yl = this.rhb0 * L + this.rhb1 * r[0] + this.rhb2 * r[1] - this.rha1 * r[2] - this.rha2 * r[3];
        r[1] = r[0]; r[0] = L; r[3] = r[2]; r[2] = yl; L = yl;
        const yr = this.rhb0 * R + this.rhb1 * r[4] + this.rhb2 * r[5] - this.rha1 * r[6] - this.rha2 * r[7];
        r[5] = r[4]; r[4] = R; r[7] = r[6]; r[6] = yr; R = yr; }
      // air absorption / mic rolloff
      this.airL = this.airC * this.airL + (1 - this.airC) * L;
      this.airR = this.airC * this.airR + (1 - this.airC) * R;
      L = this.airL + this.dirL[tIdx]; R = this.airR + this.dirR[tIdx];
      this.dirL[tIdx] = 0; this.dirR[tIdx] = 0;
      // DC block
      const yL = L - this.dcxL + 0.9995 * this.dcL; this.dcxL = L; this.dcL = yL;
      const yR = R - this.dcxR + 0.9995 * this.dcR; this.dcxR = R; this.dcR = yR;
      let oL = yL * gain, oR = yR * gain;
      if (!(oL === oL) || !(oR === oR)) { this.reset(); oL = oR = 0; }
      outL[off + i] = oL; outR[off + i] = oR;
      this.clock++;
    }
  }

  reset() {
    for (const s of this.strings) { s.h.clear(); s.v.clear(); s.exc.fill(0); s.env = 0; }
    this.mz1.fill(0); this.mz2.fill(0); this.bodyIn.fill(0);
    this.lpB = this.hpB = 0; this.directHPs = 0; this.airL = this.airR = 0; this.rh.fill(0);
  }

  meters() {
    return this.strings.map(s => ({ e: s.envOut, fret: s.fret, midi: s.midi, damp: s.damp, active: s.active }));
  }
}

function readLagrange(p, D) {
  if (D < 3) D = 3;
  const pos = p.w - D;
  const fl = Math.floor(pos);
  const f = pos - fl;
  const b = p.buf;
  const xm1 = b[(fl - 1) & MASK], x0 = b[fl & MASK], x1 = b[(fl + 1) & MASK], x2 = b[(fl + 2) & MASK];
  const fm1 = f - 1, fm2 = f - 2, fp1 = f + 1;
  return -f * fm1 * fm2 / 6 * xm1 + fp1 * fm1 * fm2 / 2 * x0 - fp1 * f * fm2 / 2 * x1 + fp1 * f * fm1 / 6 * x2;
}

root.GuitarEngine = GuitarEngine;
root.GUITAR_PRESETS = PRESETS;

// ---------- AudioWorklet wrapper ----------
if (typeof registerProcessor === 'function' && typeof AudioWorkletProcessor !== 'undefined') {
  class GuitarProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.eng = new GuitarEngine(sampleRate);
      this.meterCount = 0;
      this.port.onmessage = (m) => {
        const d = m.data;
        if (Array.isArray(d)) for (const ev of d) this.eng.post(ev); else this.eng.post(d);
      };
    }
    process(inputs, outputs) {
      const out = outputs[0];
      const L = out[0], R = out[1] || out[0];
      // keep engine clock in step with the context clock
      if (this.eng.clock === 0) this.eng.clock = Math.round(currentTime * sampleRate);
      this.eng.render(L, R, L.length, 0);
      if (++this.meterCount >= 12) { this.meterCount = 0; this.port.postMessage({ meters: this.eng.meters() }); }
      return true;
    }
  }
  registerProcessor('acoustic-guitar', GuitarProcessor);
}
})(typeof globalThis !== 'undefined' ? globalThis : this);
