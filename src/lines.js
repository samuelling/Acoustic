// Acoustic — generated lead lines over a held chord: "Yngwie mode", neoclassical lines after Yngwie Malmsteen.
// The rules below come from published analyses of his playing (README, "Yngwie mode", has the sources and marks
// what is documented versus estimated):
//  - harmony: a held minor chord is i (harmonic minor, some natural minor in descending sequences); a major chord is
//    V of the minor key a 4th above (Phrygian dominant, never the natural 7th); a diminished chord is vii°7 of the
//    minor key a semitone above (symmetric: the cell moves by minor thirds);
//  - picking (Troy Grady; Guitar Interactive): downward pickslanting. Strings change after upstrokes; after a
//    downstroke only to the next higher string, on another downstroke (a sweep); a descending change after a
//    downstroke is made possible by a pull-off. Every new figure and every new string in a run starts on a downstroke;
//    the first note of each group is accented; legato notes take no stroke;
//  - figures: single-string 3-1-2-3-2-1 sixes, single-string fours, two-string descending sixes, Bach-style pedal
//    point, the 3-string sweep loop (D D D U pull-off U), ascending 5-string arpeggios landing on a long note,
//    diminished cells moving up in minor thirds (U U D), three-note-per-string runs, trills with a turn;
//  - time: runs accelerate into their target (slower first quarter, faster last quarter), land within a few tens of
//    ms of it (sometimes late after a small stall), phrases go burst -> long note with wide vibrato or a bend -> breath;
//  - expression: wide, one-sided ("bend") vibrato ~5 Hz, delayed and easing in; whole-step bends.
// How hard the chord is played sets the intensity (soft: lyrical, few bursts; hard: dense shred).

(function (root) {
'use strict';

const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const HMINOR = [0, 2, 3, 5, 7, 8, 11], AEOLIAN = [0, 2, 3, 5, 7, 8, 10];

// ---------------- harmony ----------------
const IONIAN = [0, 2, 4, 5, 7, 9, 11];
const NOTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const pcsOf = (frets, open) => { const o = []; frets.forEach((f, s) => { if (f >= 0) o.push((open[s] + f) % 12); }); return o; };

function chordId(pcs) {
  const set = new Set(pcs), bass = pcs.length ? pcs[0] : 9, has = (r, i) => set.has((r + i) % 12);
  const cands = [];
  for (const r of set) {
    const b = r === bass ? 1 : 0;
    if (has(r, 3) && has(r, 6) && !has(r, 7)) cands.push({ r, q: 'dim', s: 3 + b });
    if (has(r, 4) && has(r, 7)) cands.push({ r, q: has(r, 10) ? 'dom' : 'maj', s: 3 + b });
    if (has(r, 3) && has(r, 7)) cands.push({ r, q: 'min', s: 3 + b });
    if (has(r, 5) && has(r, 7) && !has(r, 3) && !has(r, 4)) cands.push({ r, q: 'sus', s: 2.5 + b });
    if (has(r, 4) && !has(r, 7)) cands.push({ r, q: 'maj', s: 1 + b / 2 });
    if (has(r, 3) && !has(r, 6) && !has(r, 7)) cands.push({ r, q: 'min', s: 1 + b / 2 });
  }
  cands.sort((a, b) => b.s - a.s);
  return cands[0] || { r: bass, q: 'min' };
}
const toneSet = (c) => (c.q === 'min' ? [0, 3, 7] : c.q === 'dim' ? [0, 3, 6, 9] : c.q === 'sus' ? [0, 5, 7] : c.q === 'dom' ? [0, 4, 7, 10] : [0, 4, 7]).map(i => (c.r + i) % 12);
const setOf = (key, iv) => new Set(iv.map(i => (key + i) % 12));

// The chord on its own, Yngwie's way: everything belongs to a minor key. A minor chord is i (harmonic minor); a
// major chord is V of the minor key a 4th above (Phrygian dominant); a diminished chord is vii°7 of the minor key a
// semitone above.
function chordAlone(c, pcs) {
  const key = c.q === 'min' ? c.r : c.q === 'dim' ? (c.r + 1) % 12 : (c.r + 5) % 12;
  return { root: c.r, quality: c.q, key, mode: 'minor', pcs,
    hm: setOf(key, HMINOR), aeol: setOf(key, AEOLIAN), tones: toneSet(c),
    dimRoot: c.q === 'dim' ? c.r : (key + 11) % 12, dimOK: true };
}

// The chord inside a key (`ctx` = { tonic, mode }). In a minor key every diatonic chord is played over the key's
// harmonic minor (natural minor where the chord has the flat 7th, e.g. VII); in a major key over the major scale,
// with the leading-tone diminished seventh (his V7b9 colour) only over the V chord. A chord that doesn't fit the key
// (a secondary dominant such as E in C major, a borrowed iv) falls back to the chord-alone reading.
function analyseChord(frets, open, ctx) {
  const pcs = pcsOf(frets, open), c = chordId(pcs);
  if (!ctx) return chordAlone(c, pcs);
  const t = ctx.tonic;
  if (ctx.mode === 'minor') {
    const hm = setOf(t, HMINOR), ae = setOf(t, AEOLIAN);
    const inHm = pcs.every(p => hm.has(p)), inAe = pcs.every(p => ae.has(p));
    if (!inHm && !inAe) return chordAlone(c, pcs);
    const sc = inHm ? hm : ae;
    return { root: c.r, quality: c.q, key: t, mode: 'minor', pcs, hm: sc, aeol: inHm ? ae : ae, tones: toneSet(c),
      dimRoot: c.q === 'dim' ? c.r : (t + 11) % 12, dimOK: inHm };
  }
  const maj = setOf(t, IONIAN);
  if (!pcs.every(p => maj.has(p))) return chordAlone(c, pcs);
  const isV = c.r === (t + 7) % 12 && (c.q === 'maj' || c.q === 'dom');
  return { root: c.r, quality: c.q, key: t, mode: 'major', pcs, hm: maj, aeol: maj, tones: toneSet(c),
    dimRoot: c.q === 'dim' ? c.r : (t + 11) % 12, dimOK: isV || c.q === 'dim' };
}

// Key from the last few chords. Each of the 24 keys scores, per chord (recent chords count most): how many of the
// chord's notes the key holds, plus a bonus when the chord is the key's tonic triad or its major V. Minor keys get a
// small head start (he hears in minor), the current key a little hysteresis, so a lone C chord still reads as the V
// of F minor, but C - F - G is C major.
class KeyTracker {
  constructor() { this.hist = []; this.key = null; }
  add(pcs) {
    if (!pcs.length) return;
    const last = this.hist[this.hist.length - 1];
    if (last && last.length === pcs.length && last.every((p, i) => p === pcs[i])) return;   // same chord again
    this.hist.push(pcs.slice()); if (this.hist.length > 8) this.hist.shift();
    let best = null;
    for (let t = 0; t < 12; t++) for (const mode of ['major', 'minor']) {
      const col = mode === 'major' ? setOf(t, IONIAN) : new Set([...setOf(t, HMINOR), ...setOf(t, AEOLIAN)]);
      let sc = mode === 'minor' ? (this.hist.length === 1 ? 0.25 : 0.1) : 0, w = 1;
      for (let i = this.hist.length - 1; i >= 0; i--, w *= 0.75) {
        const p = this.hist[i], c = chordId(p);
        sc += w * p.filter(x => col.has(x)).length / p.length;
        if (c.r === t && (mode === 'major' ? c.q === 'maj' : c.q === 'min')) sc += 0.5 * w;
        if (c.r === (t + 7) % 12 && (c.q === 'maj' || c.q === 'dom')) sc += 0.3 * w;
      }
      if (this.key && this.key.tonic === t && this.key.mode === mode) sc += 0.13 * Math.min(3, this.hist.length - 1);   // trust grows with evidence
      if (!best || sc > best.sc) best = { tonic: t, mode, sc };
    }
    this.key = { tonic: best.tonic, mode: best.mode };
  }
  reset() { this.hist = []; this.key = null; }
}
const keyName = (k) => k ? NOTE[k.tonic] + (k.mode === 'major' ? ' major' : ' minor') : '';

// ascending list of scale pitches between lo and hi
const scalePitches = (pcs, lo, hi) => { const o = []; for (let m = lo; m <= hi; m++) if (pcs.has(m % 12)) o.push(m); return o; };
const fretOn = (open, s, m, maxF) => { const f = m - open[s]; return f >= 0 && f <= maxF ? f : -1; };

// ---------------- figures ----------------
// Each returns an array of notes {s, f, m, dur (beats), art ('pick' | 'h' | 'p'), dir (1 down, -1 up), acc}
// or null if it can't be placed. `per` = notes per beat for the fast figures.
const FIG = {
  // single-string six-note pattern: degrees [d, d-2, d-1, d, d-1, d-2], next group one step down; D U D U D U
  sixes1(c, beats) {
    const s = c.rng() < 0.7 ? 5 : 4, pcs = c.minorDesc(), sc = scalePitches(pcs, c.open[s] + 3, c.open[s] + c.maxF);
    let d = sc.findIndex(m => m - c.open[s] >= c.top - 1); if (d < 0) d = sc.length - 1;
    const out = [], groups = Math.max(1, Math.round(beats * c.per / 6));
    for (let g = 0; g < groups && d - 2 >= 0; g++, d--) {
      [d, d - 2, d - 1, d, d - 1, d - 2].forEach((i, k) => out.push({ s, m: sc[i], f: sc[i] - c.open[s], dur: 1 / c.per, art: 'pick', dir: k % 2 ? -1 : 1, acc: k === 0 }));
    }
    return out;
  },
  // single-string fours: [d, d-1, d-2, d-3], next group one step down; D U D U
  fours1(c, beats) {
    const s = c.rng() < 0.6 ? 5 : 4, pcs = c.minorDesc(), sc = scalePitches(pcs, c.open[s] + 3, c.open[s] + c.maxF);
    let d = sc.findIndex(m => m - c.open[s] >= c.top); if (d < 0) d = sc.length - 1;
    const out = [], groups = Math.max(1, Math.round(beats * 4 / 4));
    for (let g = 0; g < groups && d - 3 >= 0; g++, d--) [d, d - 1, d - 2, d - 3].forEach((i, k) => out.push({ s, m: sc[i], f: sc[i] - c.open[s], dur: 1 / 4, art: 'pick', dir: k % 2 ? -1 : 1, acc: k === 0 }));
    return out;
  },
  // two-string descending sixes: six consecutive scale notes down, three on the high E then three on B, each group
  // one step lower; each string D U pull-off
  sixes2(c, beats) {
    const pcs = c.minorDesc(), sc = scalePitches(pcs, c.open[4], c.open[5] + c.maxF);
    let d = sc.findIndex(m => m - c.open[5] >= c.top + 1); if (d < 0) d = sc.length - 1;
    const out = [], groups = Math.max(1, Math.round(beats * c.per / 6));
    for (let g = 0; g < groups; g++, d--) {
      if (d - 5 < 0) break;
      const grp = [0, 1, 2, 3, 4, 5].map(i => sc[d - i]);
      const ok = grp.every((m, i) => fretOn(c.open, i < 3 ? 5 : 4, m, c.maxF) >= 0);
      if (!ok) break;
      grp.forEach((m, i) => { const s = i < 3 ? 5 : 4; out.push({ s, m, f: m - c.open[s], dur: 1 / c.per, art: i % 3 === 2 ? 'p' : 'pick', dir: i % 3 === 0 ? 1 : -1, acc: i === 0 }); });
    }
    return out.length ? out : null;
  },
  // Bach / violin pedal point on one string: a fixed pedal below, a scale line above moving down toward it;
  // [L1, P, L2, P, ...] strict alternation
  pedal(c, beats) {
    const s = 5, pcs = c.H.hm;
    let pf = -1;
    for (let f = clamp(c.top - 3, 3, 12); f >= 2; f--) if (c.H.tones.includes((c.open[s] + f) % 12)) { pf = f; break; }
    if (pf < 0) return null;
    const P = c.open[s] + pf, line = scalePitches(pcs, P + 1, Math.min(c.open[s] + c.maxF, P + 6)).reverse();   // in position
    const out = [];
    for (let i = 0; i < beats * 2 && line.length; i++) {
      const L = line[i % line.length];
      out.push({ s, m: L, f: L - c.open[s], dur: 1 / 4, art: 'pick', dir: 1, acc: i % 2 === 0 }, { s, m: P, f: pf, dur: 1 / 4, art: 'pick', dir: -1 });
    }
    return out;
  },
  // 3-string sweep loop on G, B, E: [s3, s2, s1, s1top, s1, s2], D D D U pull-off U, one loop per beat (sextuplets)
  sweep3(c, beats) {
    const shape = c.arpShape([3, 4, 5]);
    if (!shape) return null;
    const [g, b, e] = shape, topM = c.nextTone(e.m, 5);
    if (topM < 0) return null;
    const top = { s: 5, m: topM, f: topM - c.open[5] }, out = [], d = 1 / 6;
    for (let r = 0; r < Math.max(1, Math.round(beats)); r++) {
      out.push(Object.assign({}, g, { dur: d, art: 'pick', dir: 1, acc: true }), Object.assign({}, b, { dur: d, art: 'pick', dir: 1 }),
        Object.assign({}, e, { dur: d, art: 'pick', dir: 1 }), Object.assign({}, top, { dur: d, art: 'pick', dir: -1 }),
        Object.assign({}, e, { dur: d, art: 'p' }), Object.assign({}, b, { dur: d, art: 'pick', dir: -1 }));
    }
    return out;
  },
  // ascending 5-string arpeggio: [s5, s5 hammer to the next tone, s4, s3, s2, s1, s1 top], all downstrokes (a sweep),
  // landing on the top note (the phrase holds it)
  arp5(c) {
    const shape = c.arpShape([1, 2, 3, 4, 5]);
    if (!shape) return null;
    const a = shape[0], ah = c.nextTone(a.m, 1), topM = c.nextTone(shape[4].m, 5);
    const out = [Object.assign({}, a, { dur: 1 / 8, art: 'pick', dir: 1, acc: true })];
    if (ah > 0 && ah < shape[1].m && ah - a.m <= 4) out.push({ s: 1, m: ah, f: ah - c.open[1], dur: 1 / 8, art: 'h' });
    shape.slice(1).forEach(n => out.push(Object.assign({}, n, { dur: 1 / 8, art: 'pick', dir: 1 })));
    if (topM > 0) out.push({ s: 5, m: topM, f: topM - c.open[5], dur: 1 / 8, art: 'h' });
    return out;
  },
  // diminished cells: a descending dim7 triad across E, B, G (U U D), then the same cell three frets higher
  dimCells(c, beats) {
    const r = c.H.dimRoot, out = [];
    let base = clamp(c.top - 6, 3, c.maxF - 9);
    for (let k = 0; k < Math.max(2, Math.round(beats * 2)) && base + 3 * k <= c.maxF - 1; k++) {
      // cell: on the top string the dim7 tone at/above base+3k, then the next lower tones on B and G
      let m = c.open[5] + base + 3 * k; while ((m - r + 120) % 3 !== 0) m++;
      const notes = [m, m - 3, m - 6], strs = [5, 4, 3];
      const fs = notes.map((x, i) => fretOn(c.open, strs[i], x, c.maxF));
      if (fs.some(f => f < 0)) break;
      notes.forEach((x, i) => out.push({ s: strs[i], m: x, f: fs[i], dur: 1 / 6, art: 'pick', dir: i < 2 ? -1 : 1, acc: i === 0 }));
    }
    return out.length >= 6 ? out : null;
  },
  // three notes per string, ascending (D U D, sweep D...) or descending (D U pull-off per string)
  run3(c, beats, upOverride) {
    const up = upOverride ?? c.rng() < 0.55, pcs = up ? c.H.hm : c.minorDesc();
    const pos = clamp(c.top - 4 - Math.floor(c.rng() * 3), 1, c.maxF - 6);
    const strs = up ? [2, 3, 4, 5] : [5, 4, 3, 2];
    const box = [];
    for (const s of strs) {
      const prevM = box.length ? box[box.length - 1].m : null;
      // three scale notes in this position, continuing the line (no repeated pitch across the string change)
      let cand = scalePitches(pcs, c.open[s] + pos - 1, c.open[s] + pos + 6);
      if (prevM != null) cand = up ? cand.filter(m => m > prevM) : cand.filter(m => m < prevM);
      cand = up ? cand.slice(0, 3) : cand.slice(-3);
      if (cand.length < 3) break;
      const asc = up ? cand : cand.slice().reverse();
      asc.forEach((m, i) => box.push({ s, m, f: m - c.open[s], art: !up && i === 2 ? 'p' : 'pick', dir: i === 1 ? -1 : 1, acc: i === 0 && box.length === 0 }));
    }
    const n = Math.min(box.length, Math.max(6, Math.round(beats * c.per)));
    return box.slice(0, n).map(x => Object.assign(x, { dur: 1 / c.per }));
  },
  // trill: main <-> upper neighbour (first picked, rest legato), then a turn [upper, main, lower, main]
  trill(c, beats) {
    const s = c.rng() < 0.6 ? 5 : 4, pcs = c.H.hm;
    let tf = -1;
    for (let f = clamp(c.top, 4, c.maxF - 2); f >= 3; f--) if (c.H.tones.includes((c.open[s] + f) % 12)) { tf = f; break; }
    if (tf < 0) return null;
    const M = c.open[s] + tf, up = scalePitches(pcs, M + 1, M + 2)[0], lo = scalePitches(pcs, M - 2, M - 1).pop();
    if (!up || !lo) return null;
    const out = [{ s, m: M, f: tf, dur: 1 / 8, art: 'pick', dir: 1, acc: true }];
    const n = Math.max(4, Math.round(beats * 8) - 5);
    for (let i = 0; i < n; i++) { const m = i % 2 ? M : up; out.push({ s, m, f: m - c.open[s], dur: 1 / 8, art: i % 2 ? 'p' : 'h' }); }
    if (out[out.length - 1].m === M) out.push({ s, m: up, f: up - c.open[s], dur: 1 / 8, art: 'h' });
    out.push({ s, m: M, f: tf, dur: 1 / 8, art: 'p' }, { s, m: lo, f: lo - c.open[s], dur: 1 / 8, art: 'p' }, { s, m: M, f: tf, dur: 1 / 8, art: 'h' });
    return out;
  }
};

// Pickstroke check where figures meet (inside a figure the strokes are already written in). Downward pickslanting:
// an upstroke escapes the strings, a downstroke ends trapped beside the next higher string. So after a downstroke
// the pick can only go on to that next string, with another downstroke (a sweep). Moving to a lower string after a
// downstroke needs the last note on the old string to be a pull-off instead (his standard fix); where that isn't
// possible, the pick hops over the string, which costs a few ms (`hop`).
function enforcePicking(notes) {
  for (let i = 1; i < notes.length; i++) {
    const n = notes[i], p = notes[i - 1];
    if (n.art !== 'pick' || p.art !== 'pick' || n.s === p.s || p.dir !== 1) continue;
    if (n.s === p.s + 1) { n.dir = 1; continue; }
    const pp = notes[i - 2];
    if (n.s < p.s && pp && pp.s === p.s && pp.m > p.m) { p.art = 'p'; n.dir = 1; continue; }
    n.hop = 0.008 + 0.006 * Math.abs(n.s - p.s);   // keeps its written stroke
  }
  return notes;
}

// ---------------- the generator ----------------
class YngwieGen {
  constructor(host) { this.h = host; this.lastFig = null; this.phrases = 0; this.keys = new KeyTracker(); }
  // a new chord is held: update the key estimate
  chord(frets) { this.keys.add(pcsOf(frets, this.h.open())); }
  // the key in force: a fixed key from the options ('A minor', 'C major'...), else the estimate ('auto')
  key() {
    const k = this.h.options().key;
    if (k && k !== 'auto') { const [n, m] = k.split(' '); const t = NOTE.indexOf(n); if (t >= 0) return { tonic: t, mode: m === 'major' ? 'major' : 'minor' }; }
    return this.keys.key;
  }
  keyName() { return keyName(this.key()); }
  // A phrase over this voicing: [optional slow statement] -> burst of figures -> long note (vibrato or bend) ->
  // breath. Returns notes with beat offsets (`beat`), timing already shaped (rushing runs, landing deviations), and
  // the phrase's total length in beats.
  phrase(frets, vel) {
    const open = this.h.open(), rng = this.h.rng, o = this.h.options(), bpm = o.bpm || 120;
    const H = analyseChord(frets, open, this.key());
    const intensity = clamp((vel - 0.25) / 0.65, 0, 1);
    const maxF = 17;
    const c = { open, H, rng, maxF, top: clamp(9 + Math.floor(rng() * 7), 7, 15),
      // sextuplets unless that passes ~15 notes/s; played softly he sings in sixteenths instead
      per: Math.floor(15 * 60 / bpm) >= 6 && intensity >= 0.35 ? 6 : 4,
      minorDesc: () => H.mode === 'minor' && H.quality === 'min' && rng() < 0.35 ? H.aeol : H.hm };
    // a chord-tone shape across the given strings, ascending, near c.top
    c.arpShape = (strs) => {
      const out = []; let prev = -1;
      for (const s of strs) {
        let best = null;
        for (let f = Math.max(1, c.top - 5); f <= Math.min(maxF, c.top + 3); f++) {
          const m = open[s] + f; if (!H.tones.includes(m % 12) || m <= prev) continue;
          if (!best || Math.abs(f - c.top + 1) < Math.abs(best.f - c.top + 1)) best = { s, f, m };
        }
        if (!best) return null; out.push(best); prev = best.m;
      }
      return out;
    };
    c.nextTone = (m, s) => { for (let x = m + 1; x <= m + 6; x++) if (H.tones.includes(x % 12) && x - open[s] <= maxF) return x; return -1; };
    this.phrases++;
    const notes = []; let b = 0;
    const push = (arr, warp) => {
      if (!arr || !arr.length) return 0;
      const span = arr.reduce((a, n) => a + n.dur, 0), k = warp ? 0.08 + 0.07 * rng() : 0;
      let t = 0;
      for (const n of arr) { const x = t / span; notes.push(Object.assign({}, n, { beat: b + span * (x + k * x * (1 - x)) })); t += n.dur; }
      b += span; return span;
    };
    // 1) an optional slow statement: two or three chord tones, the last held with vibrato
    if (rng() < 0.45 * (1 - intensity) + 0.1) {
      const sh = c.arpShape([3, 4, 5]);
      if (sh) { const k = 2 + (rng() < 0.5 ? 1 : 0); for (let i = 0; i < k; i++) push([Object.assign({}, sh[i], { dur: i === k - 1 ? 1.5 : 0.5, art: 'pick', dir: 1, vib: i === k - 1, acc: i === 0 })]); }
    }
    // 2) a burst of chained figures; the acoustic keeps them a little sparser than on electric
    const nFig = 1 + Math.round(intensity * 2 * (0.6 + 0.4 * rng()));
    const W = H.quality === 'dim' ? { dimCells: 4, sweep3: 2, run3: 2, trill: 1 }
      : H.quality === 'min' ? { sixes1: 3, sixes2: 2.5, fours1: 1.5, pedal: 2.5, sweep3: 3, run3: 2, trill: 1.2 }
      : { sixes1: 2, sixes2: 2, pedal: 1.5, sweep3: 3, run3: 2, dimCells: 2, trill: 1.2, fours1: 1 };
    if (!H.dimOK) delete W.dimCells;   // no leading-tone diminished colour where it would clash with the key
    for (let i = 0; i < nFig; i++) {
      const keys = Object.keys(W).filter(k => k !== this.lastFig), tot = keys.reduce((a, k) => a + W[k], 0);
      let r = rng() * tot, name = keys[0];
      for (const k of keys) { r -= W[k]; if (r <= 0) { name = k; break; } }
      const beats = name === 'sweep3' ? 1 + Math.floor(rng() * 2) : name === 'pedal' ? 2 : rng() < 0.5 ? 1 : 2;
      const f = FIG[name](c, beats);
      if (f && f.length) { push(f, true); this.lastFig = name; }
    }
    // 3) the landing: a run or a 5-string arpeggio into a long chord tone with wide vibrato, or a whole-step bend
    const into = rng() < 0.4 ? FIG.arp5(c) : FIG.run3(c, 1, rng() < 0.6);
    if (into && into.length) push(into, true);
    const last = notes[notes.length - 1];
    if (last) {
      const hold = 1 + Math.floor(rng() * (2 + 2 * (1 - intensity)));   // 1-2 beats when shredding, up to 4 when singing
      const next = Math.ceil(b - 0.05);                        // the beat the long note fills to
      if (H.tones.includes(last.m % 12) && rng() < 0.6) {
        // the run's last note is already the target: hold it
        last.dur = next + hold - last.beat; last.vib = true; last.acc = true;
        b = next + hold;
      } else {
        // resolve to the nearest chord tone on the same string, on the next beat; often a whole-step bend into it
        let land = null;
        for (let df = 1; df <= 4 && !land; df++) for (const sg of [-1, 1]) {
          const m = last.m + sg * df, f = m - open[last.s];
          if (f > 0 && f <= maxF && H.tones.includes(m % 12)) { land = { s: last.s, m, f }; break; }
        }
        if (land) {
          const bend = rng() < 0.35 && land.f >= 5 && last.s >= 3 && H.hm.has((land.m - 2) % 12);
          // landing deviation: usually within ~20 ms, sometimes a small stall and a late landing
          const late = rng() < 0.2 ? 0.04 + 0.04 * rng() : (rng() - 0.5) * 0.04;
          b = Math.max(next, b);
          notes.push({ s: land.s, m: bend ? land.m - 2 : land.m, f: bend ? land.f - 2 : land.f, dur: hold, beat: b, lateS: late,
            art: 'pick', dir: 1, acc: true, vib: true, bend });
          b += hold;
        }
      }
    }
    // 4) a breath
    b += 0.25 + Math.round(rng() * 3) * 0.25;
    return { notes: enforcePicking(notes), beats: b, H };
  }
}

root.YngwieGen = YngwieGen;
root.analyseChord = analyseChord;
root.lineKeyName = keyName;
root.LINE_KEYS = ['auto'].concat(...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(t => [NOTE[t] + ' minor', NOTE[t] + ' major']));
})(typeof globalThis !== 'undefined' ? globalThis : this);
