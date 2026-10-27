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
  woodPanel:  { name: 'Wood paneling', a: [0.30, 0.25, 0.20, 0.17, 0.15, 0.10, 0.09] },
  plasterHard:{ name: 'Plaster on masonry', a: [0.013, 0.015, 0.02, 0.03, 0.04, 0.05, 0.06] },
  pews:       { name: 'Wooden pews', a: [0.10, 0.12, 0.14, 0.16, 0.17, 0.17, 0.17] },
  carpet:     { name: 'Carpet on concrete', a: [0.02, 0.06, 0.14, 0.37, 0.60, 0.65, 0.66] },
  carpetPad:  { name: 'Carpet on pad', a: [0.08, 0.24, 0.57, 0.69, 0.71, 0.73, 0.74] },
  curtain:    { name: 'Heavy curtains', a: [0.14, 0.35, 0.55, 0.72, 0.70, 0.65, 0.62] },
  glass:      { name: 'Window glass', a: [0.35, 0.25, 0.18, 0.12, 0.07, 0.04, 0.03] },
  tile:       { name: 'Ceramic tile', a: [0.01, 0.01, 0.01, 0.02, 0.02, 0.02, 0.03] },
  foam:       { name: 'Acoustic foam', a: [0.08, 0.25, 0.60, 0.90, 0.95, 0.98, 0.98] },
  wool:       { name: 'Mineral wool panels', a: [0.45, 0.95, 1.0, 1.0, 1.0, 1.0, 1.0] },
  sofa:       { name: 'Upholstered furniture', a: [0.70, 0.76, 0.81, 0.84, 0.84, 0.81, 0.78] },
  audience:   { name: 'Seated audience', a: [0.60, 0.74, 0.88, 0.96, 0.93, 0.85, 0.80] },
  books:      { name: 'Bookshelves', a: [0.30, 0.40, 0.40, 0.30, 0.30, 0.30, 0.30] },
  grass:      { name: 'Grass', a: [0.10, 0.25, 0.45, 0.60, 0.70, 0.75, 0.78] },
  open:       { name: 'Open air', a: [1, 1, 1, 1, 1, 1, 1] }
};
// air absorption, energy attenuation coefficient m (1/m) at 20 C, 50% RH (ISO 9613-1)
const AIR_M = [0.0001, 0.0003, 0.00063, 0.00107, 0.00227, 0.0065, 0.020]; // effective full-octave (Wenmaekers 2014)

// surfaces: floor, ceiling, x0 (left), x1 (right), y0 (front, behind the mics), y1 (back, behind the player)
const ROOMS = {
  booth:    { name: 'Vocal booth', dims: [2.0, 1.6, 2.3], walls: { floor: 'carpet', ceiling: 'plaster', x0: 'foam', x1: 'woodPanel', y0: 'foam', y1: 'woodPanel' }, extra: [], scatter: 0.4 },
  living:   { name: 'Living room', dims: [5.6, 4.4, 2.6], walls: { floor: 'woodFloor', ceiling: 'plaster', x0: 'plaster', x1: 'glass', y0: 'plaster', y1: 'books' },
              extra: [{ mat: 'carpet', area: 6, on: 'floor' }, { mat: 'sofa', area: 3, on: 'floor' }, { mat: 'curtain', area: 5, on: 'x1' }], scatter: 0.35 },
  bedroom:  { name: 'Bedroom', dims: [4.0, 3.6, 2.5], walls: { floor: 'carpetPad', ceiling: 'plaster', x0: 'plaster', x1: 'plaster', y0: 'plaster', y1: 'glass' },
              extra: [{ mat: 'sofa', area: 3.5, on: 'floor' }, { mat: 'curtain', area: 3, on: 'y1' }], scatter: 0.35 },
  bathroom: { name: 'Tiled bathroom', dims: [2.6, 2.2, 2.4], walls: { floor: 'tile', ceiling: 'plaster', x0: 'tile', x1: 'tile', y0: 'tile', y1: 'glass' },
              extra: [{ mat: 'curtain', area: 1.2, on: 'x1' }], scatter: 0.15 },
  studio:   { name: 'Studio live room', dims: [8.0, 6.0, 3.4], walls: { floor: 'woodFloor', ceiling: 'woodPanel', x0: 'woodPanel', x1: 'plaster', y0: 'curtain', y1: 'woodPanel' },
              extra: [{ mat: 'wool', area: 4, on: 'ceiling' }], scatter: 0.5 },
  recital:  { name: 'Wooden recital hall', dims: [24, 15, 9], walls: { floor: 'woodFloor', ceiling: 'plasterHard', x0: 'woodPanel', x1: 'woodPanel', y0: 'plasterHard', y1: 'woodPanel' },
              extra: [{ mat: 'audience', area: 230, on: 'floor' }], scatter: 0.5 },
  hall:     { name: 'Concert hall (Boston-like)', dims: [38, 23, 18.6], walls: { floor: 'woodFloor', ceiling: 'plasterHard', x0: 'plasterHard', x1: 'plasterHard', y0: 'woodPanel', y1: 'plasterHard' },
              extra: [{ mat: 'audience', area: 760, on: 'floor' }, { mat: 'audience', area: 160, on: 'x0' }, { mat: 'audience', area: 160, on: 'x1' }], scatter: 0.6 },
  church:   { name: 'Stone church', dims: [42, 16, 18], walls: { floor: 'stone', ceiling: 'stone', x0: 'stone', x1: 'glass', y0: 'stone', y1: 'stone' },
              extra: [{ mat: 'pews', area: 500, on: 'floor' }, { mat: 'audience', area: 110, on: 'floor' }, { mat: 'woodPanel', area: 150, on: 'y1' }], scatter: 0.45 },
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
  ears:     { name: "Player's ears", mics: 'ears', head: [0.12, 0.40, 0.06] },
  behind:   { name: 'Behind the player, 1.3 m', mics: [{ p: [0.25, -0.15, -1.3], aim: [0.1, 0, -0.05], pattern: 'omni' }, { p: [-0.05, 0.15, -1.3], aim: [0.1, 0, -0.05], pattern: 'omni' }] }
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

// ---------------- measured directivity of a guitar held by a player ----------------
// Ackermann, Brinkmann, Zotter, Kob & Weinzierl (2024), "A database with directivities of musical instruments", JAES;
// data doi 10.14279/depositonce-5861.3 (CC BY-NC-SA 4.0): a classical guitar played seated in an anechoic chamber,
// 32 directions at 2.06 m. MEAS: octave-band level per direction (guitar-local unit vectors), power average over the
// sphere = 0 dB. CORR: measured minus this synth's own pattern rendered the same way (test/directivity.js), applied to
// distant mics. BACKFEED: power of the engine's back-side room feed relative to its top-side feed, per octave.
// Regenerate with: python3 -I proto/directivity.py <sofa> data/guitar_directivity_measured.json;
//                  node test/directivity.js classical seated --write
// <directivity-data>
const DIR = {"dirs":[[0.7411,0.5118,0.4345],[0.6181,-0.1006,0.7796],[0.704,-0.6361,0.3159],[-0.0629,-0.1005,0.9929],[0.0761,-0.9671,0.2426],[-0.3979,-0.6361,0.661],[0.968,-0.0565,0.2445],[0.2358,-0.6143,0.753],[0.9029,0.3547,-0.2426],[0.88,-0.3547,-0.3159],[0.3609,-0.5118,-0.7796],[-0.136,-0.8903,-0.4345],[0.529,0.8457,-0.0698],[0.6556,0.0567,-0.753],[0.4743,-0.8457,-0.2445],[-0.529,-0.8457,0.0698],[0.3979,0.6361,-0.661],[-0.0761,0.9671,-0.2426],[0.0629,0.1005,-0.9929],[-0.704,0.6361,-0.3159],[-0.6181,0.1006,-0.7796],[-0.7411,-0.5118,-0.4345],[-0.2358,0.6143,-0.753],[-0.2697,-0.4312,-0.861],[0.136,0.8903,0.4345],[-0.3609,0.5118,0.7796],[-0.88,0.3547,0.3159],[-0.9029,-0.3547,0.2426],[0.2697,0.4312,0.861],[-0.4743,0.8457,0.2445],[-0.968,0.0565,-0.2445],[-0.6556,-0.0567,0.753]],"db":[[0.17,-0.65,1.17,1.59,2.36,2.14,2.48],[1.16,1.54,1.49,2.15,2.37,2,-0.5],[0.14,-0.56,-0.59,-1.75,-1.77,-0.33,3.54],[2.21,4.24,4.39,4.53,2.46,2.24,-0.21],[-0.44,0.03,0.67,-2.22,-0.97,-3.37,-5.62],[0.93,2.38,2.57,5.43,3.22,4.19,-0.13],[1.2,-0.87,1.65,0.99,2.73,5.36,6.05],[1.1,1.89,0.31,1.28,3.34,1.3,2.29],[-1.31,-4.38,-2.4,-4.9,-1.85,-0.8,1.55],[-0.55,-3.39,-0.43,-2.85,-2.73,-1.61,-4.7],[-1.9,-4.45,-4.9,-6.45,-5.36,-4.03,-7.86],[-1.52,-3.61,-3.62,-7.89,-1.66,-6.74,-3.99],[-1.06,-2.36,-1.89,-1.2,-2.41,-3.48,-3.65],[-2.73,-6.17,-5.35,-8.11,-4.8,-7.19,-3.97],[-1.06,-2.16,-1.32,-2.96,-4.07,-3.17,-5.82],[-1.04,-1.36,-3.29,-1.6,-2.1,-0.21,-2.64],[-0.64,-3.6,-3.14,-5.05,-5.94,-7.93,-8.53],[-0.06,-0.69,-1.4,-2.25,-1.41,-4.92,-2.67],[-1.41,-3.48,-6.06,-6.63,-5.35,-9.18,-11.28],[-0.37,-0.74,-2.06,-0.42,-1.02,-3.02,-4.72],[1.82,-1.81,-5.1,-4,-4.18,-5.21,-5.04],[0.53,-3.96,-2.37,-4.5,-3.17,-3.19,-2.75],[-1.7,-3.94,-4.18,-5.58,-4.01,-5.98,-7.49],[-1.8,-5.09,-9.38,-7,-9.94,-10.93,-10.68],[1.3,2.47,3.21,2.37,2.76,0.26,2.39],[1.54,4.13,3.86,4.26,1.45,2.93,1.14],[-0.64,1.56,-0.64,2.02,1.58,3.23,7.43],[-0.83,0.53,-0.61,-2.17,-0.02,-3.08,-3.15],[0.07,1.72,3.04,0.98,1.03,0.42,-2.24],[0.02,1.73,1.09,1.62,-0.16,3.89,0.25],[0.57,-0.26,-1.68,-2.43,-1.03,-1.43,-4],[0.81,3.14,3.03,3.35,4.75,3.2,2.68]],"corr":[[0.06,-0.66,-0.66,-0.02,-0.12,0.97,-0.95],[0.86,1.06,-0.64,-1.74,-0.2,-1.34,-2.28],[0.16,-0.61,-1.34,-4.79,-4.29,-2.51,0.75],[1.55,3.02,2.26,2.28,-0.07,-1.18,-3.76],[-0.26,-0.16,1.99,-2.14,-2.41,-5.5,-8.51],[0.23,1.03,1.22,4.04,-0.03,0.46,-3.63],[1.25,-0.46,0.46,-1.29,1.75,4.07,4.81],[0.81,1.11,-0.68,0.55,-0.32,-1.29,-0.72],[-0.64,-2.82,-0.43,-0.55,5.76,8.33,12.77],[0.09,-1.97,1.55,1.04,3.74,8.77,6.7],[-1.15,-3.33,-2.37,-0.15,1.45,4.66,4.02],[-0.8,-2.71,0.25,-2.5,5.15,1.87,7.93],[-0.3,-0.91,0.49,4.3,2.17,0.73,1.6],[-2.05,-4.86,-3.62,-3.24,2.7,1.15,8.52],[-0.22,-0.87,2.27,3.26,3.38,7.5,6.26],[-1.04,-1.57,-1.48,2.08,-0.62,0.46,-1.05],[0.15,-2.18,-0.47,0.45,2.2,1.24,3.92],[0.68,0.61,1.91,1.72,5.03,3.28,8.65],[-0.78,-2.57,-3.87,-1.66,2.08,-1.44,0.02],[-0.25,-0.26,-0.28,5.15,5.23,5.48,6.6],[2,-1.47,-3.31,0.2,3.12,4.25,6.7],[0.61,-3.78,0,0.06,3.75,4.5,8.7],[-1.13,-3.01,-1.56,-0.83,3.51,2.82,4.49],[-1.29,-4.46,-6.78,-2.67,-2.51,-2.49,1.38],[1.19,2.23,2.5,-0.33,-0.73,-3.19,-0.1],[0.77,2.95,1.7,3.32,-1.2,-0.08,-3.3],[-1.89,-0.07,-3.69,-0.33,-1.28,-0.33,5.16],[-1.89,-0.97,-2.7,-4.06,-0.85,-5.32,-5.02],[-0.3,1.07,1.28,-1.23,-1.18,-1.68,-4.68],[-0.35,1.25,0.19,1.66,-2.29,2.9,-1.96],[0.25,-0.38,-0.47,1.05,5.97,8.83,7.84],[-0.34,1.42,0.09,-0.03,1.89,0.19,-0.93]],"backFeed":[0.00904,0.0629,0.209,0.174,0.283,0.282,0.123]};
// </directivity-data>

// smooth interpolation over the 32 measured directions (von Mises-Fisher kernel), in dB. The measured pattern uses a
// ~25 deg kernel; the correction a ~45 deg one, so it fixes broad trends and leaves each body's own fine lobes.
const KAPPA_CORR = 4;
function dirInterp(table, u, kappa) {
  const KAPPA = kappa || 12;
  const l = len(u) || 1, x = u[0] / l, y = u[1] / l, z = u[2] / l;
  const out = [0, 0, 0, 0, 0, 0, 0]; let ws = 0;
  for (let j = 0; j < DIR.dirs.length; j++) {
    const d = DIR.dirs[j], w = Math.exp(KAPPA * (x * d[0] + y * d[1] + z * d[2] - 1));
    ws += w; const t = table[j]; for (let b = 0; b < 7; b++) out[b] += w * t[b];
  }
  for (let b = 0; b < 7; b++) out[b] /= ws;
  return out;
}
// The measurement includes the player's body. With the guitar on a stand, directions behind the top (toward where the
// player would be) fall back to the synth's own pattern.
function playerWeight(u, held) { return held ? 1 : Math.min(1, Math.max(0, (u[2] / (len(u) || 1) + 0.25) / 0.5)); }

// ---------------- guitar source directivity (for room reflections) ----------------
// Model shape: the top side is omnidirectional at low frequency and beams forward as frequency rises; the back side is
// the mirror image. The total in each direction is then set to the measured balloon, keeping the model's split
// between the two feeds (so rays leaving backward still carry the back plate's sound) and its total radiated power.
const BEAM = [0.0, 0.1, 0.35, 0.8, 1.3, 1.8, 2.3];
function beamGain(side, u, band) {
  const facing = side === 'front' ? u[2] : -u[2];
  return Math.max(0, Math.pow((1 + facing) / 2 + 0.02, BEAM[band]));
}
const FIB = (() => { const n = 400, p = []; for (let i = 0; i < n; i++) { const z = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(1 - z * z), t = Math.PI * (1 + Math.sqrt(5)) * i; p.push([r * Math.cos(t), r * Math.sin(t), z]); } return p; })();
const srcCache = {};
function srcNorm(held, band) {
  const key = (held ? 'h' : 's') + band;
  if (srcCache[key]) return srcCache[key];
  const rho = DIR ? DIR.backFeed[band] : 1;
  let mAvg = 0; for (const u of FIB) mAvg += beamGain('front', u, band) ** 2 + rho * beamGain('back', u, band) ** 2;
  mAvg /= FIB.length;
  // power-preserving scale for the measured-shape gains
  let p = 0; for (const u of FIB) { const t = shapeFactor(u, band, held, mAvg, rho); p += t * t * (beamGain('front', u, band) ** 2 + rho * beamGain('back', u, band) ** 2); }
  p /= FIB.length;
  return (srcCache[key] = { mAvg, rho, k: Math.sqrt(mAvg / p) });
}
function shapeFactor(u, band, held, mAvg, rho) {
  const M = beamGain('front', u, band) ** 2 + rho * beamGain('back', u, band) ** 2;
  const modelDb = 10 * Math.log10(Math.max(1e-9, M / mAvg));
  const w = playerWeight(u, held);
  const targetDb = w * dirInterp(DIR.db, u)[band] + (1 - w) * modelDb;
  return Math.pow(10, (targetDb - modelDb) / 20);
}
function sourceGain(side, uLocal, band, held, raw) {
  if (!DIR || raw) return beamGain(side, uLocal, band);
  const N = srcNorm(held, band);
  return beamGain(side, uLocal, band) * shapeFactor(uLocal, band, held, N.mAvg, N.rho) * N.k;
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

// Far-field correction of the direct sound: the region model is right where geometry dominates (a mic a hand's width
// from the soundhole), the measurement is right at a distance (it includes the player's body and the real diffraction
// around the instrument). Each mic gets the measured-minus-model difference in its direction, faded in between 0.3 m
// and 1.2 m from the guitar's acoustic centre. Returns per-mic octave-band gains in dB (125 Hz .. 8 kHz).
const ACOUSTIC_CENTER = [0.10, 0, -0.05]; // between top and back, between soundhole and bridge
function directEQ(scene) {
  const mics = expandMics(scene.mics, scene.scale || 0.645), held = scene.hold !== 'stand';
  return mics.map(m => {
    if (!DIR || scene.rawRadiation) return [0, 0, 0, 0, 0, 0, 0];
    const v = sub(m.p, ACOUSTIC_CENTER), d = len(v);
    const t = Math.min(1, Math.max(0, (d - 0.3) / 0.9)), fade = t * t * (3 - 2 * t);
    const w = playerWeight(v, held) * fade;
    return dirInterp(DIR.corr, v, KAPPA_CORR).map(x => Math.max(-12, Math.min(12, x * w)));
  });
}

// Graphic EQ for those octave gains: low shelf (125), five peaking filters (250..4k, one octave wide), high shelf (8k),
// RBJ cookbook biquads. The bands overlap, so the requested gains are refined until the realized response at the
// band centres matches.
function biquad(type, f, gDb, sr) {
  const A = Math.pow(10, gDb / 40), w = 2 * Math.PI * f / sr, cs = Math.cos(w), sn = Math.sin(w);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'peak') {
    const al = sn * Math.sinh(Math.LN2 / 2 * 1.0 * w / sn);
    b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A;
  } else {
    const al = sn / 2 * Math.SQRT2, sA = 2 * Math.sqrt(A) * al, s = type === 'low' ? 1 : -1;
    b0 = A * ((A + 1) - s * (A - 1) * cs + sA); b1 = s * 2 * A * ((A - 1) - s * (A + 1) * cs); b2 = A * ((A + 1) - s * (A - 1) * cs - sA);
    a0 = (A + 1) + s * (A - 1) * cs + sA; a1 = -s * 2 * ((A - 1) + s * (A + 1) * cs); a2 = (A + 1) + s * (A - 1) * cs - sA;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function biquadDb(c, f, sr) {
  const w = 2 * Math.PI * f / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c[0] + c[1] * c1 + c[2] * c2, ni = -(c[1] * s1 + c[2] * s2);
  const dr = 1 + c[3] * c1 + c[4] * c2, di = -(c[3] * s1 + c[4] * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}
function designEQ(gDb, sr) {
  const fc = BANDS, types = ['low', 'peak', 'peak', 'peak', 'peak', 'peak', 'high'];
  const edge = (b) => b === 0 ? 177 : b === 6 ? 5657 : fc[b];
  let req = gDb.slice(), cs = [];
  for (let it = 0; it < 6; it++) {
    cs = req.map((g, b) => biquad(types[b], edge(b), g, sr));
    for (let b = 0; b < 7; b++) {
      let got = 0; for (const c of cs) got += biquadDb(c, fc[b], sr);
      req[b] += 0.8 * (gDb[b] - got);
    }
  }
  return cs;
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
        if (order > 1) for (let a = 0; a < 3; a++) I[a] += (r() - 0.5) * 0.16 * Math.min(1, order / 4); // randomized image method, <= 8 cm
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
          a *= sourceGain(side, depLocal, b, held, scene.rawRadiation);
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
  // inter-mic coherence of the diffuse tail: sin(kd)/(kd) for spaced omnis (spacing d); coincident directional pairs
  // keep partial coherence from their overlapping patterns
  const m0 = mics[0], m1 = mics[1] || mics[0];
  const spacing = mics.length > 1 ? len(sub(m0.p, m1.p)) : 0.3;
  const coincident = spacing < 0.05;
  const coh = new Float64Array(NF / 2 + 1);
  for (let k = 0; k <= NF / 2; k++) {
    const f = Math.max(1, k * sr / NF), kd = 2 * Math.PI * f / C * (m0.ear ? 0.22 : spacing);
    coh[k] = coincident ? 0.55 : Math.max(0, Math.sin(kd) / kd);
  }
  for (const side of ['front', 'back']) {
    // fraction of the source's power going into this side's directions (diffuse-field weighting)
    const sidePow = []; for (let b = 0; b < 7; b++) {
      let sp = 0, n = 0;
      for (const u of FIB) { sp += Math.pow(sourceGain(side, u, b, held, scene.rawRadiation), 2); n++; }
      sidePow.push(sp / n);
    }
    const nm = Math.min(2, mics.length);
    const rg = rng32(777 + (side === 'back' ? 999 : 0));
    const curves = [new Float64Array(NF / 2 + 1), new Float64Array(NF / 2 + 1)], gains = new Array(7);
    const r1 = new Float64Array(NF), i1 = new Float64Array(NF), r2 = new Float64Array(NF), i2 = new Float64Array(NF);
    const o1 = new Float64Array(NF), q1 = new Float64Array(NF);
    for (let fI = 0; fI < nFrames; fI++) {
      const t = (fI * hop + NF / 2) / sr;
      const nRef = C * t / meanFree;
      const ramp = t >= tMix ? 1 : Math.max(0, 1 - Math.pow(1 - scat, nRef)) * 0.9 + 0.1 * Math.min(1, t / tMix) ** 2;
      for (let mi = 0; mi < nm; mi++) {
        const P = mics[mi].ear ? { diffuse: 0.9 } : (PATTERNS[mics[mi].pattern] || PATTERNS.omni);
        for (let b = 0; b < 7; b++) {
          // energy per second 4 pi c / V * exp(-13.8 t / RT) (integrates to Barron's 16 pi / A); per sample / sr
          const e = 4 * Math.PI * C / E.V * Math.exp(-13.82 * t / E.rt[b]) * sidePow[b] * P.diffuse / sr;
          gains[b] = Math.sqrt(e * ramp);
        }
        bandCurve(gains, NF, sr, curves[mi]);
      }
      for (let k = 0; k < NF; k++) { r1[k] = gauss(rg) * win[k]; i1[k] = 0; r2[k] = gauss(rg) * win[k]; i2[k] = 0; }
      fft(r1, i1, false); fft(r2, i2, false);
      for (let mi = 0; mi < nm; mi++) {
        for (let k = 0; k < NF; k++) {
          const kb = k <= NF / 2 ? k : NF - k;
          let a, b2;
          if (mi === 0) { a = r1[k]; b2 = i1[k]; }
          else { const g = coh[kb], h = Math.sqrt(1 - g * g); a = g * r1[k] + h * r2[k]; b2 = g * i1[k] + h * i2[k]; }
          const c = curves[mi][kb]; o1[k] = a * c; q1[k] = b2 * c;
        }
        fft(o1, q1, true);
        const buf = out[side][mi], o = fI * hop;
        for (let i = 0; i < NF; i++) { const k = o + i; if (k < N) buf[k] += o1[i] * win[i]; }
      }
    }
  }
  return out;
}

function buildIRsNormalized(scene, sr) {
  const g = micNorm(scene), mics = expandMics(scene.mics);
  let sc = scene;
  // single mic: the room is rendered at the mic and at a twin 30 cm to the side (partially coherent tail), so the
  // reflections arrive in stereo while the direct sound stays centred
  if (mics.length === 1) {
    const m = mics[0];
    sc = Object.assign({}, scene, { mics: { mics: [{ p: m.p, aim: add(m.p, m.axis), pattern: m.pattern }, { p: [m.p[0] + 0.3, m.p[1], m.p[2]], aim: add([m.p[0] + 0.3, m.p[1], m.p[2]], m.axis), pattern: m.pattern }] } });
  }
  const out = buildIRs(sc, sr);
  for (const side of ['front', 'back']) for (const ch of out[side]) for (let i = 0; i < ch.length; i++) ch[i] *= g;
  out.norm = g;
  return out;
}

root.AcousticSpace = { ACOUSTIC_CENTER, DIR: () => DIR, dirInterp, sourceGain, directEQ, designEQ, biquadDb, BANDS, MATERIALS, ROOMS, PATTERNS, REGIONS, MIC_SETUPS, AIR_M, expandMics, placement, directCoefs, buildIRs: buildIRsNormalized, buildIRsRaw: buildIRs, micNorm, scaledSetup, eyring, fft };
})(typeof globalThis !== 'undefined' ? globalThis : this);
