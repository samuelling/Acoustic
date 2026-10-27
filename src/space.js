// Acoustic — the space around the guitar: where it sits, how it is held, the microphones, and the room.
//
// The guitar radiates from several regions (soundhole, bridge, lower bout bass/treble, tail, upper bout, back).
// For the DIRECT sound, every region reaches every mic at its own distance and angle: the worklet applies the
// per-region delays and gains computed here (spherical spreading, mic polar pattern, the proximity effect of
// pressure-gradient mics, shadowing by the body and by the player's head).
// For the ROOM, an image-source model traces wall reflections with per-band absorption, source directivity in the
// direction each ray leaves the guitar and mic directivity in the direction it arrives; a statistical late tail
// follows the Eyring decay of each band, at the energy level room acoustics predicts (energy arrival rate 4 pi c / V
// relative to a direct sound of amplitude 1/d). Both are baked into impulse responses for ConvolverNodes, one per
// source side (top / back), so the guitar's front and back radiate into the room separately.

(function (root) {
'use strict';
const C = 343;               // speed of sound, m/s
const BANDS = [125, 250, 500, 1000, 2000, 4000, 8000];

// ---------------- materials: absorption per octave band 125..8k (8k extrapolated where not tabulated) ----------------
const MATERIALS = {
  concrete:   { name: 'Painted concrete', a: [0.01, 0.01, 0.01, 0.02, 0.02, 0.02, 0.03] },
  brick:      { name: 'Brick', a: [0.03, 0.03, 0.03, 0.04, 0.05, 0.07, 0.08] },
  stone:      { name: 'Stone', a: [0.02, 0.02, 0.03, 0.04, 0.05, 0.05, 0.06] },
  plaster:    { name: 'Plaster / drywall', a: [0.29, 0.10, 0.05, 0.04, 0.07, 0.09, 0.10] },
  woodFloor:  { name: 'Wood floor', a: [0.15, 0.11, 0.10, 0.07, 0.06, 0.07, 0.07] },
  woodPanel:  { name: 'Wood paneling', a: [0.42, 0.21, 0.10, 0.08, 0.06, 0.06, 0.06] },
  carpet:     { name: 'Carpet on concrete', a: [0.02, 0.06, 0.14, 0.37, 0.60, 0.65, 0.66] },
  carpetPad:  { name: 'Carpet on pad', a: [0.08, 0.24, 0.57, 0.69, 0.71, 0.73, 0.74] },
  curtain:    { name: 'Heavy curtains', a: [0.14, 0.35, 0.55, 0.72, 0.70, 0.65, 0.62] },
  glass:      { name: 'Window glass', a: [0.35, 0.25, 0.18, 0.12, 0.07, 0.04, 0.03] },
  tile:       { name: 'Ceramic tile', a: [0.01, 0.01, 0.01, 0.02, 0.02, 0.02, 0.03] },
  foam:       { name: 'Acoustic panels', a: [0.25, 0.65, 0.95, 1.00, 0.95, 0.90, 0.88] },
  sofa:       { name: 'Upholstered furniture', a: [0.35, 0.45, 0.57, 0.61, 0.59, 0.55, 0.52] },
  audience:   { name: 'Seated audience', a: [0.60, 0.74, 0.88, 0.96, 0.93, 0.85, 0.80] },
  books:      { name: 'Bookshelves', a: [0.30, 0.35, 0.40, 0.45, 0.50, 0.50, 0.50] },
  grass:      { name: 'Grass', a: [0.11, 0.26, 0.60, 0.69, 0.92, 0.99, 0.99] },
  open:       { name: 'Open air', a: [1, 1, 1, 1, 1, 1, 1] }
};
// air absorption, energy attenuation coefficient m (1/m) at 20 C, 50% RH (ISO 9613-1)
const AIR_M = [0.0001, 0.0003, 0.0006, 0.0011, 0.0024, 0.0072, 0.0245];

// surfaces: floor, ceiling, x0 (left), x1 (right), y0 (front, behind the mics), y1 (back, behind the player)
const ROOMS = {
  booth:    { name: 'Dead booth', dims: [2.4, 2.0, 2.4], walls: { floor: 'carpetPad', ceiling: 'foam', x0: 'foam', x1: 'foam', y0: 'foam', y1: 'foam' }, extra: [], scatter: 0.4 },
  living:   { name: 'Living room', dims: [5.6, 4.4, 2.6], walls: { floor: 'woodFloor', ceiling: 'plaster', x0: 'plaster', x1: 'glass', y0: 'plaster', y1: 'books' },
              extra: [{ mat: 'carpet', area: 6, on: 'floor' }, { mat: 'sofa', area: 5, on: 'floor' }, { mat: 'curtain', area: 5, on: 'x1' }], scatter: 0.35 },
  bedroom:  { name: 'Bedroom', dims: [4.0, 3.6, 2.5], walls: { floor: 'carpetPad', ceiling: 'plaster', x0: 'plaster', x1: 'plaster', y0: 'plaster', y1: 'glass' },
              extra: [{ mat: 'sofa', area: 5, on: 'floor' }, { mat: 'curtain', area: 3, on: 'y1' }], scatter: 0.35 },
  bathroom: { name: 'Tiled bathroom', dims: [2.6, 2.2, 2.4], walls: { floor: 'tile', ceiling: 'plaster', x0: 'tile', x1: 'tile', y0: 'tile', y1: 'glass' }, extra: [], scatter: 0.15 },
  studio:   { name: 'Studio live room', dims: [8.0, 6.0, 3.4], walls: { floor: 'woodFloor', ceiling: 'foam', x0: 'woodPanel', x1: 'woodPanel', y0: 'curtain', y1: 'woodPanel' }, extra: [], scatter: 0.5 },
  recital:  { name: 'Wooden recital hall', dims: [22, 14, 8], walls: { floor: 'woodFloor', ceiling: 'woodPanel', x0: 'woodPanel', x1: 'woodPanel', y0: 'plaster', y1: 'woodPanel' },
              extra: [{ mat: 'audience', area: 90, on: 'floor' }], scatter: 0.5 },
  hall:     { name: 'Concert hall', dims: [38, 23, 18], walls: { floor: 'woodFloor', ceiling: 'plaster', x0: 'plaster', x1: 'plaster', y0: 'woodPanel', y1: 'plaster' },
              extra: [{ mat: 'audience', area: 560, on: 'floor' }], scatter: 0.6 },
  church:   { name: 'Stone church', dims: [42, 16, 18], walls: { floor: 'stone', ceiling: 'stone', x0: 'stone', x1: 'glass', y0: 'stone', y1: 'stone' },
              extra: [{ mat: 'woodPanel', area: 120, on: 'floor' }], scatter: 0.45 },
  outdoors: { name: 'Outdoors on grass', dims: [200, 200, 200], walls: { floor: 'grass', ceiling: 'open', x0: 'open', x1: 'open', y0: 'open', y1: 'open' }, extra: [], scatter: 0.2, open: true }
};

// ---------------- microphones ----------------
// pattern: p(theta) = A + B cos(theta); B > 0 parts are pressure-gradient (proximity effect near the source)
const PATTERNS = {
  omni: { name: 'Omni', A: 1, B: 0, diffuse: 1 },
  cardioid: { name: 'Cardioid', A: 0.5, B: 0.5, diffuse: 1 / 3 },
  supercardioid: { name: 'Supercardioid', A: 0.37, B: 0.63, diffuse: 0.27 },
  fig8: { name: 'Figure-8', A: 0, B: 1, diffuse: 1 / 3 }
};

// Guitar-local coordinates (metres): origin at the saddle on the top, x toward the neck along the strings,
// y across the top toward the bass side, z out of the top (toward a listener in front).
// Radiation regions: points with an outward normal and an area. The 12th fret sits at x = scale/2.
const REGIONS = [
  { id: 'hole',   name: 'Soundhole',          p: [0.17, 0.0, 0.0],   n: [0, 0, 1] },
  { id: 'bridge', name: 'Bridge',             p: [0.0, 0.0, 0.0],    n: [0, 0, 1] },
  { id: 'bass',   name: 'Lower bout, bass',   p: [-0.04, 0.12, 0.0], n: [0, 0, 1] },
  { id: 'treb',   name: 'Lower bout, treble', p: [-0.04, -0.12, 0.0], n: [0, 0, 1] },
  { id: 'tail',   name: 'Below the bridge',   p: [-0.13, 0.0, 0.0],  n: [0, 0, 1] },
  { id: 'upper',  name: 'Upper bout',         p: [0.28, 0.0, 0.0],   n: [0, 0, 1] },
  { id: 'back',   name: 'Back',               p: [0.04, 0.0, -0.11], n: [0, 0, -1] }
];

// Mic setups in guitar-local coordinates (aim points too). 'ears' = the player's own head.
const MIC_SETUPS = {
  hole15:   { name: 'Soundhole, 15 cm', mics: [{ p: [0.17, 0.02, 0.15], aim: [0.17, 0, 0], pattern: 'cardioid' }] },
  fret12:   { name: '12th fret, 20 cm', mics: [{ p: [0.33, 0.02, 0.20], aim: [0.30, 0, 0], pattern: 'cardioid' }] },
  bout:     { name: 'Lower bout, 25 cm', mics: [{ p: [-0.07, 0.12, 0.25], aim: [-0.04, 0.08, 0], pattern: 'cardioid' }] },
  spaced:   { name: 'Spaced pair: 12th fret + lower bout', mics: [{ p: [0.33, 0.04, 0.22], aim: [0.30, 0, 0], pattern: 'cardioid' }, { p: [-0.08, 0.10, 0.28], aim: [-0.04, 0.06, 0], pattern: 'cardioid' }] },
  xy40:     { name: 'XY pair, 40 cm', mics: 'xy', center: [0.20, 0.0, 0.40], aim: [0.17, 0, 0], pattern: 'cardioid', spread: 45 },
  room2m:   { name: 'Room pair, 2 m', mics: [{ p: [0.10, -0.4, 2.0], aim: [0.1, 0, 0], pattern: 'omni' }, { p: [0.10, 0.4, 2.0], aim: [0.1, 0, 0], pattern: 'omni' }] },
  ears:     { name: "Player's ears", mics: 'ears', head: [0.12, 0.40, 0.06] }
};

// ---------------- small vector helpers ----------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.sqrt(dot(a, a));
const nrm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ---------------- placement: guitar-local <-> room ----------------
// The guitar faces +Y of the room (its top normal points toward the room's front wall y0 = 0? no: toward -Y),
// its neck points toward -X (player's left for a right-handed player facing -Y), bass side up (+Z).
function placement(scene) {
  const g = scene.guitar; // { pos: [x,y,z] room coords of the saddle point, yaw: radians }
  const cy = Math.cos(g.yaw || 0), sy = Math.sin(g.yaw || 0);
  // local axes in room coords
  const ex = [-cy, sy, 0];          // toward the neck
  const ez = [-sy, -cy, 0];          // out of the top: faces the -Y side of the room
  const ey = [0, 0, 1];              // bass side up
  const toRoom = (p) => add(g.pos, add(add(scl(ex, p[0]), scl(ey, p[1])), scl(ez, p[2])));
  const dirToRoom = (d) => add(add(scl(ex, d[0]), scl(ey, d[1])), scl(ez, d[2]));
  const toLocalDir = (d) => [dot(d, ex), dot(d, ey), dot(d, ez)];
  return { ex, ey, ez, toRoom, dirToRoom, toLocalDir };
}

// Expand a mic setup into concrete mics in guitar-local coords: [{p, axis, pattern, ear?}]
function expandMics(setup, scale) {
  const s = typeof setup === 'string' ? MIC_SETUPS[setup] : setup;
  if (s.mics === 'xy') {
    const c = s.center, ax = nrm(sub(s.aim, c)), half = (s.spread || 45) * Math.PI / 180;
    // rotate the aim around the guitar's y axis (vertical in the room when held) by +-half
    const rot = (v, a) => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];
    return [{ p: c, axis: rot(ax, half), pattern: s.pattern }, { p: c, axis: rot(ax, -half), pattern: s.pattern }];
  }
  if (s.mics === 'ears') {
    // head above the bass edge of the upper bout; ears 17.5 cm apart along the neck direction
    const h = s.head;
    return [
      { p: [h[0] + 0.0875, h[1], h[2]], axis: [1, 0, 0], pattern: 'omni', ear: 'L', head: h },
      { p: [h[0] - 0.0875, h[1], h[2]], axis: [-1, 0, 0], pattern: 'omni', ear: 'R', head: h }
    ];
  }
  return s.mics.map(m => ({ p: m.p, axis: nrm(sub(m.aim, m.p)), pattern: m.pattern }));
}

// A concrete setup from a preset with an optional pattern override and distance scaling (mics move along their
// line to the aim point; the player's head does not move).
function scaledSetup(key, dist, pattern) {
  const s = MIC_SETUPS[key] || MIC_SETUPS.fret12;
  if (s.mics === 'ears') return s;
  const d = dist || 1;
  const pat = (m) => (pattern && pattern !== 'default') ? pattern : m;
  if (s.mics === 'xy') {
    const c = add(s.aim, scl(sub(s.center, s.aim), d));
    return Object.assign({}, s, { center: c, pattern: pat(s.pattern) });
  }
  return { name: s.name, mics: s.mics.map(m => ({ p: add(m.aim, scl(sub(m.p, m.aim), d)), aim: m.aim, pattern: pat(m.pattern) })) };
}

// ---------------- guitar source directivity (for room reflections) ----------------
// Front (top + soundhole) source: omnidirectional at low frequency, beaming forward as frequency rises; back source the
// mirror image. When the guitar is held, the player's body absorbs much of what leaves backward.
const BEAM = [0.0, 0.1, 0.35, 0.8, 1.3, 1.8, 2.3];
function sourceGain(side, uLocal, band, held) {
  const facing = side === 'front' ? uLocal[2] : -uLocal[2];
  let g = Math.pow((1 + facing) / 2 + 0.02, BEAM[band]);
  if (held) {
    // rays leaving toward the player (local -z for the top side, behind the back) hit clothing and torso
    const towardPlayer = -uLocal[2];
    if (towardPlayer > 0) g *= 1 - towardPlayer * (0.25 + 0.1 * band) ;
  }
  return Math.max(0, g);
}

// mic sensitivity for a wave arriving from unit direction `from` (pointing from the mic toward the source)
function micGain(mic, from, band) {
  if (mic.ear) {
    // spherical head (Brown & Duda): the far side is shadowed, more so at high frequencies
    const side = mic.ear === 'L' ? 1 : -1;
    const c = from[0] * side; // cos of angle to the ear axis (local x)
    const shadow = [0.0, 0.1, 0.25, 0.45, 0.65, 0.8, 0.9][band];
    return (1 - shadow) + shadow * (0.5 + 0.5 * c) * (c > 0 ? 1.25 : 1);
  }
  const P = PATTERNS[mic.pattern] || PATTERNS.omni;
  return Math.abs(P.A + P.B * dot(mic.axis, from));
}

// ---------------- direct path coefficients for the worklet ----------------
// For each mic and region: delay (samples), gain for the pressure term, gain for the near-field gradient term
// (pressure-gradient mics: p_grad = B cos(theta) (p + (c/d) * velocity_integral)), and a shadow amount (0 = clear line
// of sight, 1 = region faces away from the mic: heard only by diffraction, low-passed).
function directCoefs(scene, sr) {
  const mics = expandMics(scene.mics, scene.scale || 0.645);
  const held = scene.hold !== 'stand';
  return mics.map(mic => REGIONS.map(r => {
    const v = sub(mic.p, r.p), d = Math.max(0.05, len(v)), u = scl(v, 1 / d);
    const facing = dot(u, r.n);                    // >0: mic in front of this region's surface
    const from = scl(u, -1);
    const P = PATTERNS[mic.pattern] || PATTERNS.omni;
    let A = P.A, B = P.B * dot(mic.axis, from);
    if (mic.ear) { A = 1; B = 0; }
    // body shadow: smooth step from facing (0) to facing away (1)
    let shadow = Math.min(1, Math.max(0, 0.5 - facing * 1.6));
    // the player's body sits behind the back: back radiation reaching the front is further absorbed
    let g = 1 / d;
    if (held && r.id === 'back') g *= 0.45;
    // head shadow for the player's ears: far ear gets the head's diffraction lowpass
    let earShadow = 0;
    if (mic.ear) {
      const side = mic.ear === 'L' ? 1 : -1;
      const toSrc = nrm(sub(r.p, mic.head));
      earShadow = Math.max(0, Math.min(1, 0.5 - toSrc[0] * side * 0.9));
      shadow = Math.max(shadow, earShadow * 0.8);
    }
    return { delay: d / C * sr, gP: g * A, gB: g * B, gNear: g * B * C / d, shadow, d };
  }));
}

// "Preamp gain": normalize each setup by its mics' mean distance to the guitar's regions, as an engineer would
// set gain. Applied equally to direct sound and room, so the direct-to-reverberant balance stays physical.
function micNorm(scene) {
  const mics = expandMics(scene.mics);
  let s = 0, n = 0;
  for (const m of mics) for (const r of REGIONS) { if (r.id === 'back') continue; s += len(sub(m.p, r.p)); n++; }
  return (s / n) / 0.3;
}

// ---------------- impulse responses ----------------
function eyring(room) {
  const [Lx, Ly, Lz] = room.dims;
  const V = Lx * Ly * Lz;
  const areas = { floor: Lx * Ly, ceiling: Lx * Ly, x0: Ly * Lz, x1: Ly * Lz, y0: Lx * Lz, y1: Lx * Lz };
  const S = Object.values(areas).reduce((a, b) => a + b, 0);
  const alpha = {}; // per surface per band, extras blended in by area
  for (const k in areas) alpha[k] = MATERIALS[room.walls[k]].a.slice();
  for (const e of room.extra || []) {
    const f = Math.min(1, e.area / areas[e.on]);
    for (let b = 0; b < 7; b++) alpha[e.on][b] = alpha[e.on][b] * (1 - f) + MATERIALS[e.mat].a[b] * f;
  }
  const rt = [], abar = [];
  for (let b = 0; b < 7; b++) {
    let A = 0; for (const k in areas) A += areas[k] * alpha[k][b];
    const a = Math.min(0.999, A / S); abar.push(a);
    rt.push(0.161 * V / (-S * Math.log(1 - a) + 4 * AIR_M[b] * V));
  }
  return { V, S, areas, alpha, rt, abar };
}

// radix-2 complex FFT (in place)
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / size, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = i + k, b = a + size / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// interpolate 7 band gains (linear amplitude) onto FFT bin frequencies, in dB over log-frequency
function bandCurve(g, nfft, sr, out) {
  const lg = g.map(x => Math.log(Math.max(1e-6, x)));
  for (let k = 0; k <= nfft / 2; k++) {
    const f = Math.max(20, k * sr / nfft);
    const x = Math.log2(f / 125);
    let v;
    if (x <= 0) v = lg[0]; else if (x >= 6) v = lg[6];
    else { const i = Math.floor(x), t = x - i; v = lg[i] * (1 - t) + lg[i + 1] * t; }
    out[k] = Math.exp(v);
  }
  return out;
}

// A short linear-phase FIR (centered) realising 7 band gains; cached by rounded gains
const FIRN = 128;
function bandFir(g, sr, cache) {
  const key = g.map(x => Math.round(x * 400)).join(',');
  if (cache && cache.has(key)) return cache.get(key);
  const re = new Float64Array(FIRN), im = new Float64Array(FIRN), mag = new Float64Array(FIRN / 2 + 1);
  bandCurve(g, FIRN, sr, mag);
  for (let k = 0; k <= FIRN / 2; k++) { re[k] = mag[k]; if (k > 0 && k < FIRN / 2) re[FIRN - k] = mag[k]; }
  fft(re, im, true);
  const h = new Float32Array(FIRN);
  for (let i = 0; i < FIRN; i++) {
    const j = (i + FIRN / 2) % FIRN;                 // center the zero-phase response
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / FIRN);
    h[i] = re[j] * w;
  }
  if (cache) cache.set(key, h);
  return h;
}

function rng32(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function gauss(r) { let u = 0; for (let i = 0; i < 6; i++) u += r(); return (u - 3) * 1.4142; }

// Build stereo IRs (reflections + late tail, no direct sound) for the top ('front') and back source sides.
// scene: { room (key or object), guitar: {pos, yaw}, mics (setup key or object), hold, scale }
function buildIRs(scene, sr) {
  const room = typeof scene.room === 'string' ? ROOMS[scene.room] : scene.room;
  const E = eyring(room);
  const [Lx, Ly, Lz] = room.dims;
  const pl = placement(scene);
  const mics = expandMics(scene.mics, scene.scale || 0.645).map(m => ({ ...m, room: pl.toRoom(m.p), roomAxis: pl.dirToRoom(m.axis) }));
  const held = scene.hold !== 'stand';
  const src = { front: pl.toRoom([0.12, 0, 0.0]), back: pl.toRoom([0.04, 0, -0.11]) };
  const rtMax = Math.max(...E.rt);
  const dur = room.open ? 0.25 : Math.min(6, Math.max(0.3, rtMax * 1.15));
  const N = Math.ceil(dur * sr) + FIRN;
  const tMix = room.open ? 0.25 : Math.min(0.12, Math.max(0.035, Math.sqrt(E.V) / 1000 * 1.6));
  const scat = room.scatter ?? 0.4;
  const beta = {}; for (const k in E.alpha) beta[k] = E.alpha[k].map(a => Math.sqrt(Math.max(0, 1 - a)));
  const out = { front: [new Float32Array(N), new Float32Array(N)], back: [new Float32Array(N), new Float32Array(N)], rt: E.rt, V: E.V, tMix };
  const cache = new Map();
  const r = rng32(1234);
  const maxOrder = room.open ? 1 : 40;
  // ----- image sources (Allen & Berkley), specular part
  for (const side of ['front', 'back']) {
    const S = src[side];
    for (let mi = 0; mi < Math.min(2, mics.length); mi++) {
      const M = mics[mi], buf = out[side][mi];
      const nmax = Math.ceil(tMix * C / Math.min(Lx, Ly, Lz)) + 1;
      for (let nx = -nmax; nx <= nmax; nx++) for (let ny = -nmax; ny <= nmax; ny++) for (let nz = -nmax; nz <= nmax; nz++)
      for (let px = 0; px < 2; px++) for (let py = 0; py < 2; py++) for (let pz = 0; pz < 2; pz++) {
        if (nx === 0 && ny === 0 && nz === 0 && px === 0 && py === 0 && pz === 0) continue; // direct sound
        const cnt = {
          x0: Math.abs(nx - px), x1: Math.abs(nx), y0: Math.abs(ny - py), y1: Math.abs(ny), floor: Math.abs(nz - pz), ceiling: Math.abs(nz)
        };
        if (room.open && (cnt.x0 + cnt.x1 + cnt.y0 + cnt.y1 + cnt.ceiling > 0)) continue;
        const order = cnt.x0 + cnt.x1 + cnt.y0 + cnt.y1 + cnt.floor + cnt.ceiling;
        if (order > maxOrder) continue;
        const I = [(1 - 2 * px) * S[0] + 2 * nx * Lx, (1 - 2 * py) * S[1] + 2 * ny * Ly, (1 - 2 * pz) * S[2] + 2 * nz * Lz];
        // randomize higher-order images slightly (diffusion; avoids flutter from a perfect lattice)
        if (order > 1) for (let a = 0; a < 3; a++) I[a] += (r() - 0.5) * 0.12 * Math.min(1, order / 4);
        const v = sub(M.room, I), d = len(v), t = d / C;
        if (t > tMix) continue;
        const arrive = scl(v, -1 / d);                       // from mic toward the image
        // departure direction at the real source: mirror the arrival back through the same reflections
        const dep = [(px ? -1 : 1) * -arrive[0], (py ? -1 : 1) * -arrive[1], (pz ? -1 : 1) * -arrive[2]];
        const depLocal = pl.toLocalDir(dep);
        const arrLocal = pl.toLocalDir(arrive);
        const micAx = M.axis;
        const g = new Array(7);
        const spec = Math.pow(1 - scat, order / 2);
        for (let b = 0; b < 7; b++) {
          let a = spec / d * Math.exp(-AIR_M[b] * d / 2);
          for (const k in cnt) if (cnt[k]) a *= Math.pow(beta[k][b], cnt[k]);
          a *= sourceGain(side, depLocal, b, held);
          a *= micGain({ ...M, axis: micAx }, arrLocal, b);
          g[b] = a;
        }
        if (Math.max(...g) < 1e-5) continue;
        const h = bandFir(g.map(x => x / Math.max(1e-9, Math.max(...g))), sr, cache);
        const amp = Math.max(...g);
        const at = Math.round(t * sr);
        for (let i = 0; i < FIRN; i++) { const k = at + i - FIRN / 2; if (k >= 0 && k < N) buf[k] += h[i] * amp; }
      }
    }
  }
  if (room.open) return out;
  // ----- late tail: per-band noise with Eyring decay, energy arrival rate 4 pi c / V (relative to a 1/d direct sound),
  // ramping in as scattering turns specular energy diffuse, and fully after the mixing time
  const hop = 256, NF = 512;
  const win = new Float64Array(NF); for (let i = 0; i < NF; i++) win[i] = Math.sin(Math.PI * (i + 0.5) / NF); // sqrt-hann pair
  const nFrames = Math.ceil(N / hop);
  const meanFree = 4 * E.V / E.S;
  for (const side of ['front', 'back']) {
    // fraction of the source's power going into this side's directions (diffuse-field weighting)
    const sidePow = []; for (let b = 0; b < 7; b++) {
      let s = 0, n = 0;
      for (let k = 0; k < 64; k++) { const z = -1 + (k + 0.5) / 32; s += Math.pow(sourceGain(side, [0, 0, z], b, held), 2); n++; }
      sidePow.push(s / n);
    }
    for (let mi = 0; mi < Math.min(2, mics.length); mi++) {
      const M = mics[mi], buf = out[side][mi];
      const P = M.ear ? { diffuse: 0.9 } : (PATTERNS[M.pattern] || PATTERNS.omni);
      const rg = rng32(777 + mi * 31 + (side === 'back' ? 999 : 0));
      const curve = new Float64Array(NF / 2 + 1), gains = new Array(7);
      const re = new Float64Array(NF), im = new Float64Array(NF);
      for (let fI = 0; fI < nFrames; fI++) {
        const t = (fI * hop + NF / 2) / sr;
        const nRef = C * t / meanFree;
        const ramp = t >= tMix ? 1 : Math.max(0, 1 - Math.pow(1 - scat, nRef)) * 0.9 + 0.1 * Math.min(1, t / tMix) ** 2;
        for (let b = 0; b < 7; b++) {
          // energy per second 4 pi c / V * exp(-13.8 t / RT); per sample divide by sr
          const e = 4 * Math.PI * C / E.V * Math.exp(-13.82 * t / E.rt[b]) * sidePow[b] * P.diffuse / sr;
          gains[b] = Math.sqrt(e * ramp);
        }
        bandCurve(gains, NF, sr, curve);
        for (let k = 0; k < NF; k++) { re[k] = gauss(rg); im[k] = 0; }
        for (let k = 0; k < NF; k++) re[k] *= win[k];
        fft(re, im, false);
        for (let k = 0; k <= NF / 2; k++) {
          const g = curve[k]; re[k] *= g; im[k] *= g;
          if (k > 0 && k < NF / 2) { re[NF - k] *= g; im[NF - k] *= g; }
        }
        fft(re, im, true);
        const o = fI * hop;
        for (let i = 0; i < NF; i++) { const k = o + i; if (k < N) buf[k] += re[i] * win[i]; }
      }
    }
  }
  return out;
}

function buildIRsNormalized(scene, sr) {
  const out = buildIRs(scene, sr), g = micNorm(scene);
  for (const side of ['front', 'back']) for (const ch of out[side]) for (let i = 0; i < ch.length; i++) ch[i] *= g;
  // single-mic setups: the room is heard in stereo through a twin of the mic offset 30 cm (decorrelated)
  if (expandMics(scene.mics).length === 1) {
    const s2 = Object.assign({}, scene, { mics: { mics: expandMics(scene.mics).map(m => ({ p: [m.p[0] + 0.3, m.p[1], m.p[2]], aim: add(m.p, m.axis), pattern: m.pattern })) } });
    const tw = buildIRs(s2, sr);
    for (const side of ['front', 'back']) { out[side][1] = tw[side][0]; for (let i = 0; i < out[side][1].length; i++) out[side][1][i] *= g; }
  }
  out.norm = g;
  return out;
}

root.AcousticSpace = { BANDS, MATERIALS, ROOMS, PATTERNS, REGIONS, MIC_SETUPS, AIR_M, expandMics, placement, directCoefs, buildIRs: buildIRsNormalized, buildIRsRaw: buildIRs, micNorm, scaledSetup, eyring, fft };
})(typeof globalThis !== 'undefined' ? globalThis : this);
