// Acoustic — performance layer: turns keyboard notes into what a guitarist's hands would do.
//
// 1. Gather: notes arriving within a short window (default 18 ms) are one chord.
// 2. Voice: map the notes onto strings and frets.
//      "played"     - exactly the notes you pressed, placed on a playable fingering.
//      "guitarize"  - your chord's pitch classes, bass and top note, expanded into a real 4-6 string shape.
// 3. Perform: a pick stroke crosses the strings in order. Stroke time shrinks as velocity rises; each string
//    holds the pick for a moment (thicker strings longer), so later strings arrive slightly late; upstrokes are
//    lighter and usually only catch the treble strings; interior muted strings produce a dead "chk".
//    Direction comes from a pendulum model: the strumming hand swings down and up every subdivision whether or
//    not it touches the strings, so the direction of a strum is set by how many subdivisions have passed.
//    Fingerstyle instead plucks all strings together with the thumb on the bass.

(function (root) {
'use strict';

const STD = [40, 45, 50, 55, 59, 64];
const MAXFRET = 17;

function gauss(rng) { // approx standard normal
  return (rng() + rng() + rng() + rng() - 2) * 1.2247;
}

// ---------- voicing ----------

// Fingers needed for a shape (frets per string, -1 muted, 0 open). Lowest fret on 2+ strings can be barred.
function fingersNeeded(frets) {
  const fr = frets.filter(f => f > 0);
  if (!fr.length) return 0;
  const min = Math.min(...fr);
  const idx = []; frets.forEach((f, s) => { if (f === min) idx.push(s); });
  const rest = fr.length - idx.length;
  // a barre can't cover an open string lying between the barred strings
  let barreOk = idx.length >= 2;
  for (let s = idx[0]; barreOk && s <= idx[idx.length - 1]; s++) if (frets[s] === 0) barreOk = false;
  return barreOk ? 1 + rest : fr.length;
}
// an open string sandwiched between fingers stretched up the neck is hard to keep ringing
function archPenalty(frets) {
  let c = 0;
  for (let s = 1; s < 5; s++) {
    if (frets[s] !== 0) continue;
    let l = s - 1; while (l >= 0 && frets[l] < 0) l--;
    let r = s + 1; while (r < 6 && frets[r] < 0) r++;
    if (l >= 0 && r < 6 && frets[l] > 0 && frets[r] > 0 && Math.max(frets[l], frets[r]) >= 4) c += 0.9;
  }
  return c;
}
function span(frets) {
  const fr = frets.filter(f => f > 0);
  return fr.length ? Math.max(...fr) - Math.min(...fr) : 0;
}

// Exact notes -> strings.  Returns {frets:[6], notes: {s: midi}, pos} or null.
function voicePlayed(notes, open, prevPos) {
  notes = [...new Set(notes)].sort((a, b) => a - b);
  const lo = open[0], hi = open[5] + MAXFRET;
  notes = notes.map(n => { while (n < lo) n += 12; while (n > hi) n -= 12; return n; });
  notes = [...new Set(notes)].sort((a, b) => a - b);
  if (notes.length > 6) notes = notes.slice(0, 1).concat(notes.slice(-5));
  let best = null, bestCost = Infinity;
  const assign = new Array(notes.length);
  const used = [false, false, false, false, false, false];
  function cost() {
    const frets = [-1, -1, -1, -1, -1, -1];
    for (let i = 0; i < notes.length; i++) frets[assign[i]] = notes[i] - open[assign[i]];
    const sp = span(frets);
    if (sp > 5) return Infinity;
    if (fingersNeeded(frets) > 4) return Infinity;
    let c = sp * sp * 0.6;
    const fr = frets.filter(f => f > 0);
    const pos = fr.length ? Math.min(...fr) : 0;
    c += pos * 0.12;
    c += frets.filter(f => f === 0).length * -0.4;
    // pitch order should follow string order
    for (let i = 1; i < notes.length; i++) if (assign[i] < assign[i - 1]) c += 2.5;
    // unplayed strings inside the chord get hit by a strum
    const ss = assign.slice().sort((a, b) => a - b);
    for (let i = 1; i < ss.length; i++) c += (ss[i] - ss[i - 1] - 1) * 1.6;
    if (prevPos != null && fr.length) c += Math.abs(pos - prevPos) * 0.15;
    return c;
  }
  function rec(i) {
    if (i === notes.length) {
      const c = cost();
      if (c < bestCost) { bestCost = c; best = assign.slice(); }
      return;
    }
    for (let s = 0; s < 6; s++) {
      if (used[s]) continue;
      const f = notes[i] - open[s];
      if (f < 0 || f > MAXFRET) continue;
      used[s] = true; assign[i] = s; rec(i + 1); used[s] = false;
    }
  }
  rec(0);
  if (!best) {
    // too many notes for one hand: drop inner notes until something fits
    if (notes.length <= 1) return null;
    const keep = notes.slice(0, -2).concat(notes.slice(-1));
    return voicePlayed(keep, open, prevPos);
  }
  const frets = [-1, -1, -1, -1, -1, -1], map = {};
  for (let i = 0; i < notes.length; i++) { frets[best[i]] = notes[i] - open[best[i]]; map[best[i]] = notes[i]; }
  const fr = frets.filter(f => f > 0);
  return { frets, map, pos: fr.length ? Math.min(...fr) : (prevPos ?? 0) };
}

const gCache = new Map();
// Pitch classes + bass + top -> a full guitar chord shape.
function voiceGuitarize(notes, open, prevPos) {
  notes = [...new Set(notes)].sort((a, b) => a - b);
  if (notes.length < 2) return voicePlayed(notes, open, prevPos);
  const pcs = [...new Set(notes.map(n => ((n % 12) + 12) % 12))];
  const bassPc = notes[0] % 12, top = notes[notes.length - 1];
  const key = open.join(',') + '|' + pcs.sort().join(',') + '|' + bassPc + '|' + (top % 12) + '|' + Math.round((prevPos ?? 0) / 3);
  if (gCache.has(key)) return withMap(gCache.get(key), open);
  let best = null, bestCost = Infinity;
  for (let p = 1; p <= 12; p++) {
    const opts = open.map((o, s) => {
      const list = [-1];
      for (const f of [0, p, p + 1, p + 2, p + 3]) if (pcs.includes((o + f) % 12) && !list.includes(f)) list.push(f);
      return list;
    });
    const frets = [0, 0, 0, 0, 0, 0];
    const rec = (s) => {
      if (s === 6) {
        const c = gCost(frets, open, pcs, bassPc, top, p, prevPos);
        if (c < bestCost) { bestCost = c; best = frets.slice(); }
        return;
      }
      for (const f of opts[s]) { frets[s] = f; rec(s + 1); }
    };
    rec(0);
  }
  if (!best) return voicePlayed(notes, open, prevPos);
  gCache.set(key, best);
  return withMap(best, open);
}
function withMap(frets, open) {
  const map = {};
  frets.forEach((f, s) => { if (f >= 0) map[s] = open[s] + f; });
  const fr = frets.filter(f => f > 0);
  return { frets: frets.slice(), map, pos: fr.length ? Math.min(...fr) : 0 };
}
function gCost(frets, open, pcs, bassPc, top, p, prevPos) {
  const sounding = [];
  for (let s = 0; s < 6; s++) if (frets[s] >= 0) sounding.push(s);
  if (sounding.length < Math.min(3, pcs.length)) return Infinity;
  if (fingersNeeded(frets) > 4) return Infinity;
  let c = 0;
  const lowS = sounding[0], highS = sounding[sounding.length - 1];
  const pitches = sounding.map(s => open[s] + frets[s]);
  const lowPitch = Math.min(...pitches);
  if (lowPitch % 12 !== bassPc) c += 9;
  // the bass should be on the lowest sounding string
  if (open[lowS] + frets[lowS] !== lowPitch) c += 4;
  // interior mutes are hit by the strum; treble-side mutes are unusual
  for (let s = lowS; s <= highS; s++) if (frets[s] < 0) c += 2.2;
  c += (5 - highS) * 1.2;
  c += Math.max(0, 5 - sounding.length) * 0.9;
  // cover the chord: the 3rd and 7th matter most, the 5th least
  const got = new Set(sounding.map(s => (open[s] + frets[s]) % 12));
  for (const pc of pcs) if (!got.has(pc)) c += (pc === (bassPc + 7) % 12) ? 1.2 : 4.5;
  // keep the melody on top
  const topPitch = Math.max(...pitches);
  if (topPitch % 12 !== top % 12) c += 0.7;
  c += archPenalty(frets);
  // repeated bass doubling below the 5th fret sounds muddy
  const pos = Math.min(...frets.filter(f => f > 0).concat([p]));
  c += pos * 0.18;
  c += frets.filter(f => f === 0).length * -0.35;
  c += span(frets) * 0.3;
  if (prevPos != null) c += Math.abs(pos - prevPos) * 0.08;
  return c;
}

// ---------- engine ----------

class StrumEngine {
  constructor(opts) {
    this.send = opts.send;           // (events[]) => void ; events carry absolute engine time t (s)
    this.now = opts.now;             // () => engine time (s)
    this.onVoicing = opts.onVoicing || (() => {});
    this.rng = opts.rng || Math.random;
    this.o = {
      mode: 'pick',          // 'pick' | 'finger' | 'pattern' (the right hand plays a style's pattern on held chords)
      style: 'travis', bpm: 96, skill: 0.6, brushes: 1,
      voicing: 'played',     // 'played' | 'guitarize'
      direction: 'auto',     // 'auto' | 'down' | 'up' | 'alternate'
      speed: 0.055,          // seconds for a 6-string stroke at medium velocity (measured strums: 26-62 ms)
      humanize: 0.6,
      gather: 0.018,
      letRing: false,
      palm: false,
      pickPos: 0.2,
      tuning: STD.slice(),
      capo: 0,
      upDepth: 0.55,         // how far into the bass strings an upstroke reaches (0..1)
      hold: 0.16             // the fretting hand keeps a released chord this long, so strums connect
    };
    Object.assign(this.o, opts.options || {});
    this.pending = [];
    this.timer = null;
    this.held = new Map();      // midi -> {strings:Set, group}
    this.owner = [null, null, null, null, null, null]; // string -> group id
    this.groups = new Map();    // id -> {keys:Set, strings:Set}
    this.gid = 0;
    this.sustain = false;
    this.lastStrum = -1; this.lastDir = -1; this.period = null;
    this.handPos = 0; this.lastShapeTime = -1;
    this.shape = null;
    this.lookahead = 0.006;
    this.hand = root.RightHand ? new root.RightHand({ send: (e) => this.send(e), now: () => this.now(), rng: () => this.rng(), open: () => this.open(), options: () => this.o }) : null;
  }
  set(opts) { Object.assign(this.o, opts); }
  open() { return this.o.tuning.map(t => t + this.o.capo); }

  // ----- input -----
  noteOn(midi, vel, t) {
    const now = this.now();
    t = t == null ? now : t;
    // a key restruck while its string still rings: release the old mapping
    if (this.held.has(midi)) this.release(midi, true);
    this.pending.push({ midi, vel, t });
    if (this.pending.length === 1) {
      const wait = Math.max(0, this.o.gather - (now - t));
      this.timer = setTimeout(() => this.flush(), wait * 1000);
    }
  }
  noteOff(midi) {
    const i = this.pending.findIndex(p => p.midi === midi);
    if (i >= 0) { // released before the chord was even voiced: play it anyway, then let it go
      this.pending[i].releaseAfter = true;
      return;
    }
    this.release(midi, false);
  }
  setSustain(on) {
    this.sustain = on;
    if (!on && this.hand && this.hand.running && ![...this.groups.values()].some(x => x.keys.size)) setTimeout(() => { if (!this.sustain && ![...this.groups.values()].some(x => x.keys.size)) this.hand.stop(); }, this.o.hold * 1000);
    if (!on) for (const [id, g] of this.groups) if (g.keys.size === 0) this.dampGroup(id);
  }

  flush() {
    clearTimeout(this.timer); this.timer = null;
    const notes = this.pending; this.pending = [];
    if (!notes.length) return;
    const t0 = Math.max(this.now() + this.lookahead, Math.min(...notes.map(n => n.t)) + this.o.gather);
    const vel = Math.max(...notes.map(n => n.vel));
    const midis = notes.map(n => n.midi);
    const open = this.open();
    let v;
    if (notes.length === 1) v = this.voiceSingle(midis[0], open);
    else v = this.o.voicing === 'guitarize' ? voiceGuitarize(midis, open, this.handPos) : voicePlayed(midis, open, this.handPos);
    if (!v) return;
    // key -> strings
    const id = ++this.gid;
    const group = { keys: new Set(), strings: new Set() };
    this.groups.set(id, group);
    const sounding = Object.keys(v.map).map(Number);
    for (const n of notes) {
      const strs = new Set(sounding.filter(s => v.map[s] % 12 === n.midi % 12 && (notes.length === 1 || this.o.voicing === 'guitarize' || v.map[s] === this.fold(n.midi, open))));
      if (!strs.size) continue;
      this.held.set(n.midi, { strings: strs, group: id });
      group.keys.add(n.midi);
    }
    for (const s of sounding) { this.takeString(s, id); group.strings.add(s); }
    const shift = Math.abs(v.pos - this.handPos);
    this.handPos = v.pos;
    if (sounding.length > 1) { this.shape = v.frets; this.onVoicing(v.frets); } // a chord becomes the shape the swipe area strums
    const evs = [];
    if (shift >= 2 && t0 - this.lastShapeTime < 1.5) this.squeaks(evs, v, shift, t0);
    this.lastShapeTime = t0;
    if (this.o.mode === 'pattern' && this.hand && sounding.length > 1) this.hand.chord(v, vel, t0);
    else if (sounding.length === 1) this.single(evs, sounding[0], v.map[sounding[0]], vel, t0);
    else this.chord(evs, v, vel, t0);
    this.send(evs);
    // keys that were released during the gather window
    for (const n of notes) if (n.releaseAfter) setTimeout(() => this.release(n.midi, false), 60);
  }

  fold(n, open) {
    const lo = open[0], hi = open[5] + MAXFRET;
    while (n < lo) n += 12; while (n > hi) n -= 12; return n;
  }

  // A lone note: choose a free string near the hand.
  voiceSingle(midi, open) {
    midi = this.fold(midi, open);
    let best = -1, bc = Infinity;
    for (let s = 0; s < 6; s++) {
      const f = midi - open[s];
      if (f < 0 || f > MAXFRET) continue;
      let c = f === 0 ? Math.max(0, this.handPos - 4) * 0.3 : Math.abs(f - Math.max(1, this.handPos + 1)) * 0.5;
      if (this.owner[s] != null && this.groups.get(this.owner[s])?.keys.size) c += 6; // string busy under a held note
      c += f > 12 ? (f - 12) * 0.4 : 0;
      if (c < bc) { bc = c; best = s; }
    }
    if (best < 0) return null;
    const frets = [-1, -1, -1, -1, -1, -1]; frets[best] = midi - open[best];
    return { frets, map: { [best]: midi }, pos: frets[best] > 0 ? Math.max(0, frets[best] - 1) : this.handPos };
  }

  takeString(s, id) {
    const prev = this.owner[s];
    if (prev != null && prev !== id) {
      const g = this.groups.get(prev);
      if (g) {
        g.strings.delete(s);
        for (const k of g.keys) { const h = this.held.get(k); if (h) h.strings.delete(s); }
        if (!g.strings.size && !g.keys.size) this.groups.delete(prev);
      }
    }
    this.owner[s] = id;
  }

  release(midi, quiet) {
    const h = this.held.get(midi);
    if (!h) return;
    this.held.delete(midi);
    const g = this.groups.get(h.group);
    if (!g) return;
    g.keys.delete(midi);
    if (this.hand && this.hand.running && !this.sustain && ![...this.groups.values()].some(x => x.keys.size)) {
      setTimeout(() => { if (!this.sustain && ![...this.groups.values()].some(x => x.keys.size)) this.hand.stop(); }, this.o.hold * 1000);
    }
    if (this.o.letRing || this.sustain) return;
    if (this.o.voicing === 'guitarize' && this.groups.get(h.group).keys.size) return; // shape held while any key is down
    if (this.o.voicing === 'guitarize') { this.later(() => this.dampGroup(h.group), h.group); return; }
    const strs = [...h.strings], gid = h.group;
    this.later(() => {
      const evs = [];
      for (const s of strs) if (this.owner[s] === gid && !this.anyHeldOn(s)) evs.push({ type: 'damp', s, time: 0.05 + 0.04 * this.rng(), t: this.now() + 0.004 });
      this.send(evs);
    }, gid, quiet ? 0 : undefined);
  }
  // run a release after the hand-hold time unless the strings were taken by a newer chord meanwhile
  later(fn, gid, delay) {
    const d = delay ?? this.o.hold;
    if (d <= 0) return fn();
    setTimeout(() => { if (!this.sustain && !this.o.letRing) fn(); }, d * 1000);
  }
  anyHeldOn(s) {
    const g = this.groups.get(this.owner[s]);
    return !!(g && g.keys.size);
  }
  dampGroup(id) {
    const g = this.groups.get(id); if (!g || g.keys.size) return;
    const evs = [];
    for (const s of g.strings) if (this.owner[s] === id) evs.push({ type: 'damp', s, time: 0.05 + 0.04 * this.rng(), t: this.now() + 0.004 + this.rng() * 0.01 });
    this.send(evs);
    this.groups.delete(id);
  }

  // ----- direction: pendulum model -----
  nextDir(t) {
    const d = this.o.direction;
    if (d === 'down') return 1;
    if (d === 'up') return -1;
    const dt = this.lastStrum < 0 ? Infinity : t - this.lastStrum;
    let dir;
    if (d === 'alternate') dir = dt > 1.2 ? 1 : -this.lastDir;
    else if (dt > 1.1) { dir = 1; this.period = null; }
    else {
      if (this.period == null) this.period = dt >= 0.36 ? dt / 2 : Math.max(0.07, dt);
      let k = dt / this.period;
      if (k < 0.7) { this.period = Math.max(0.07, dt); k = 1; }
      k = Math.max(1, Math.round(k));
      dir = k % 2 ? -this.lastDir : this.lastDir;
      this.period = this.period * 0.75 + (dt / k) * 0.25;
    }
    this.lastStrum = t; this.lastDir = dir;
    return dir;
  }

  // ----- performance -----
  single(evs, s, midi, vel, t0) {
    const dir = this.o.mode === 'pick' ? this.nextDir(t0) : 1;
    const h = this.o.humanize;
    evs.push({ type: 'pluck', s, midi, t: t0 + Math.abs(gauss(this.rng)) * 0.002 * h,
      vel: clamp(vel * (dir < 0 ? 0.9 : 1) * (1 + gauss(this.rng) * 0.05 * h), 0.03, 1),
      dir, style: this.o.mode === 'pick' ? 'pick' : (s <= 2 ? 'thumb' : 'finger'),
      pickPos: this.o.pickPos * (1 + gauss(this.rng) * 0.04 * h), palm: this.o.palm });
  }

  chord(evs, v, vel, t0) {
    const open = this.open();
    const sounding = [];
    for (let s = 0; s < 6; s++) if (v.frets[s] >= 0) sounding.push(s);
    const lowS = sounding[0], highS = sounding[sounding.length - 1];
    const path = []; // strings crossed by the stroke (including interior mutes)
    for (let s = lowS; s <= highS; s++) path.push(s);
    const h = this.o.humanize;
    if (this.o.mode === 'finger') return this.pinch(evs, v, sounding, vel, t0);
    const dir = this.nextDir(t0);
    let order = dir > 0 ? path : path.slice().reverse();
    if (dir < 0) { // upstrokes catch the treble strings; how deep depends on velocity and the setting
      const depth = Math.round(clamp(2 + (path.length - 2) * this.o.upDepth * (0.5 + vel) + gauss(this.rng) * 0.6 * h, 2, path.length));
      order = order.slice(0, depth);
    }
    this.stroke(evs, order, v, vel, dir, t0, open);
  }

  // Pick stroke across `order` strings.
  stroke(evs, order, v, vel, dir, t0, open, speedOverride) {
    const h = this.o.humanize, n = order.length;
    // total sweep time: faster when harder; scales with the distance travelled (string spacing ~10.5 mm)
    const T = (speedOverride ?? this.o.speed * (1.45 - 0.85 * vel)) * Math.max(1, n - 1) / 5 * (dir < 0 ? 0.75 : 1);
    let t = t0 + Math.abs(gauss(this.rng)) * 0.003 * h;
    let catchAcc = 0;
    for (let i = 0; i < n; i++) {
      const s = order[i];
      const frac = n > 1 ? i / (n - 1) : 0;
      // the hand accelerates into the strings, then coasts: time at string i ~ frac^0.85
      const base = T * Math.pow(frac, 0.85);
      const jitter = gauss(this.rng) * 0.0012 * h;
      const tt = t + base + catchAcc + jitter;
      // each string resists the pick briefly; heavier strings longer, harder strokes push through faster
      catchAcc += (0.0009 + 0.0007 * (5 - s) / 5) * (1.1 - 0.6 * vel) * (1 + 0.3 * gauss(this.rng) * h) * (this.o.pickHold || 1);
      const fret = v.frets[s];
      const dead = fret < 0;
      // recorded upstrokes are only ~1.5 dB softer than downstrokes and brighter (treble strings, pick edge)
      const sv = clamp(vel * (dir > 0 ? 1 - 0.2 * frac : (0.9 - 0.12 * frac)) * (1 + gauss(this.rng) * 0.07 * h) * (dead ? 0.7 : 1), 0.03, 1);
      evs.push({ type: 'pluck', s, midi: dead ? open[s] : open[s] + fret, t: Math.max(t0, tt), vel: sv, dir,
        style: 'pick', dead, palm: this.o.palm, bright: dir < 0 ? 1.8 : 1,
        pickPos: this.o.pickPos * (1 + 0.03 * (dir > 0 ? i : n - i) / Math.max(1, n) + gauss(this.rng) * 0.03 * h) });
    }
  }

  // Fingerstyle: thumb takes the bass, fingers the rest, all plucked nearly together.
  pinch(evs, v, sounding, vel, t0) {
    const h = this.o.humanize;
    const open = this.open();
    const thumbCount = sounding.length >= 4 ? 2 : 1;
    sounding.forEach((s, i) => {
      const thumb = i < thumbCount;
      const off = thumb ? Math.abs(gauss(this.rng)) * 0.003 * h : 0.002 + Math.abs(gauss(this.rng)) * 0.006 * h;
      evs.push({ type: 'pluck', s, midi: open[s] + v.frets[s], t: t0 + off, dir: thumb ? 1 : -1,
        vel: clamp(vel * (thumb ? 1.0 : 0.85) * (1 + gauss(this.rng) * 0.08 * h), 0.03, 1),
        style: thumb ? 'thumb' : 'finger', palm: this.o.palm,
        pickPos: this.o.pickPos * (thumb ? 1.15 : 0.9) * (1 + gauss(this.rng) * 0.05 * h) });
    });
  }

  squeaks(evs, v, shift, t0) {
    const wound = [0, 1, 2, 3].filter(s => v.frets[s] > 0);
    if (!wound.length || this.rng() > 0.25 + 0.06 * shift) return;
    const s = wound[Math.floor(this.rng() * wound.length)];
    evs.push({ type: 'squeak', s, amt: clamp(0.25 + 0.08 * shift, 0, 1), t: Math.max(this.now(), t0 - 0.09) });
  }

  // ----- direct control (chord pads and the string swipe area) -----
  setShape(frets) {
    this.shape = frets.slice();
    const fr = frets.filter(f => f > 0);
    const pos = fr.length ? Math.min(...fr) : 0;
    const evs = [];
    const now = this.now();
    if (Math.abs(pos - this.handPos) >= 2 && now - this.lastShapeTime < 1.5) this.squeaks(evs, { frets }, Math.abs(pos - this.handPos), now + 0.05);
    // strings not in the new shape: the fretting hand mutes them
    if (!this.o.letRing) frets.forEach((f, s) => { if (f < 0) evs.push({ type: 'damp', s, time: 0.06, t: now + 0.005 }); });
    this.handPos = pos;
    this.lastShapeTime = now;
    this.onVoicing(frets);
    if (evs.length) this.send(evs);
  }
  strumShape(dir, vel) {
    if (!this.shape) return;
    const open = this.open();
    const sounding = []; this.shape.forEach((f, s) => { if (f >= 0) sounding.push(s); });
    if (!sounding.length) return;
    const t0 = this.now() + this.lookahead;
    const path = []; for (let s = sounding[0]; s <= sounding[sounding.length - 1]; s++) path.push(s);
    const v = { frets: this.shape };
    const evs = [];
    if (this.o.mode === 'finger') this.pinch(evs, v, sounding, vel, t0);
    else {
      let order = dir > 0 ? path : path.slice().reverse();
      if (dir < 0) order = order.slice(0, Math.max(2, Math.round(path.length * (0.45 + 0.4 * vel))));
      this.stroke(evs, order, v, vel, dir, t0, open);
      this.lastStrum = t0; this.lastDir = dir;
    }
    this.send(evs);
  }
  // Swipe area: pluck one string as the finger crosses it.
  pluckString(s, vel, dir) {
    const open = this.open();
    const f = this.shape ? this.shape[s] : 0;
    const dead = f == null || f < 0;
    this.send([{ type: 'pluck', s, midi: dead ? open[s] : open[s] + f, vel: clamp(vel * (dead ? 0.6 : 1), 0.03, 1), dir,
      style: this.o.mode === 'pick' ? 'pick' : (s <= 2 ? 'thumb' : 'finger'), dead, palm: this.o.palm,
      pickPos: this.o.pickPos, t: this.now() + 0.003 }]);
  }
  allOff() {
    if (this.hand) this.hand.stop();
    this.pending = []; this.held.clear(); this.groups.clear(); this.owner.fill(null);
    this.send([{ type: 'allOff', t: this.now() }]);
  }
}

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

// Common open-position and barre shapes for the chord pads (low E -> high E; -1 = muted).
const CHORDS = {
  'C': [-1, 3, 2, 0, 1, 0], 'Cadd9': [-1, 3, 2, 0, 3, 0], 'D': [-1, -1, 0, 2, 3, 2], 'Dm': [-1, -1, 0, 2, 3, 1],
  'Dsus4': [-1, -1, 0, 2, 3, 3], 'E': [0, 2, 2, 1, 0, 0], 'Em': [0, 2, 2, 0, 0, 0], 'Em7': [0, 2, 2, 0, 3, 3],
  'F': [1, 3, 3, 2, 1, 1], 'Fmaj7': [-1, -1, 3, 2, 1, 0], 'G': [3, 2, 0, 0, 0, 3], 'G/B': [-1, 2, 0, 0, 0, 3],
  'A': [-1, 0, 2, 2, 2, 0], 'Am': [-1, 0, 2, 2, 1, 0], 'A7': [-1, 0, 2, 0, 2, 0], 'Bm': [-1, 2, 4, 4, 3, 2],
  'B7': [-1, 2, 1, 2, 0, 2], 'E7': [0, 2, 0, 1, 0, 0], 'Asus2': [-1, 0, 2, 2, 0, 0], 'C/G': [3, 3, 2, 0, 1, 0]
};

root.StrumEngine = StrumEngine;
root.voicePlayed = voicePlayed;
root.voiceGuitarize = voiceGuitarize;
root.CHORD_SHAPES = CHORDS;
root.STD_TUNING = STD;
})(typeof globalThis !== 'undefined' ? globalThis : this);
