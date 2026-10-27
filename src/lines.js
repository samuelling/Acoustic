// Acoustic — generated lead lines over a held chord. The first (and so far only) generator: "Yngwie mode",
// neoclassical lines after Yngwie Malmsteen (see the README for the analysis and sources).
//
// The held chord sets the harmony. Its root and quality choose the scale:
//   minor chord      -> harmonic minor on its root
//   major / dom7     -> Phrygian dominant on its root (it is the V of the harmonic minor a fifth below)
//   diminished       -> its diminished-seventh arpeggio (the vii of the harmonic minor a semitone above)
// A phrase is a chain of figures (descending sixes, pedal-point, sweeps, diminished runs, scale runs ending on a long
// note with vibrato, trills), fingered on the neck in position and picked by explicit rules, each note an event for
// the guitar engine: pluck (with its pick stroke), hammer-on / pull-off, slide, vibrato, damp.

(function (root) {
'use strict';

const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const SCALES = { hminor: [0, 2, 3, 5, 7, 8, 11], phrygdom: [0, 1, 4, 5, 7, 8, 10], dim: [0, 3, 6, 9] };

// ---------------- harmony ----------------
function analyseChord(frets, open) {
  const pcs = []; frets.forEach((f, s) => { if (f >= 0) pcs.push((open[s] + f) % 12); });
  const set = new Set(pcs), bass = pcs.length ? pcs[0] : 9;
  const has = (r, i) => set.has((r + i) % 12);
  const cands = [];
  for (const r of set) {
    if (has(r, 3) && has(r, 6) && (has(r, 9) || !has(r, 7))) cands.push({ r, q: 'dim', s: 3 + (r === bass ? 1 : 0) });
    if (has(r, 4) && has(r, 7)) cands.push({ r, q: has(r, 10) ? 'dom' : 'maj', s: 3 + (r === bass ? 1 : 0) });
    if (has(r, 3) && has(r, 7)) cands.push({ r, q: 'min', s: 3 + (r === bass ? 1 : 0) });
    if (has(r, 4) && !has(r, 7)) cands.push({ r, q: 'maj', s: 1 + (r === bass ? 0.5 : 0) });
    if (has(r, 3) && !has(r, 6) && !has(r, 7)) cands.push({ r, q: 'min', s: 1 + (r === bass ? 0.5 : 0) });
  }
  cands.sort((a, b) => b.s - a.s);
  const c = cands[0] || { r: bass, q: 'min' };
  const scale = c.q === 'min' ? SCALES.hminor.map(i => (c.r + i) % 12)
    : c.q === 'dim' ? SCALES.hminor.map(i => (c.r + 1 + i) % 12)          // vii° of harmonic minor a semitone up
    : SCALES.phrygdom.map(i => (c.r + i) % 12);
  const tones = c.q === 'min' ? [0, 3, 7] : c.q === 'dim' ? [0, 3, 6, 9] : [0, 4, 7];
  return { root: c.r, quality: c.q, scale: new Set(scale), tones: tones.map(i => (c.r + i) % 12) };
}

// ---------------- the neck ----------------
// every (string, fret) for pitches in the scale, within frets 0..maxFret
function positions(open, pcs, maxFret) {
  const out = [];
  for (let s = 0; s < 6; s++) for (let f = 0; f <= maxFret; f++) { const m = open[s] + f; if (pcs.has(m % 12)) out.push({ s, f, m }); }
  return out;
}
// Three notes per string, ascending, starting at fret `pos` on string `s0` (a box that walks up the neck as harmonic
// minor's wide steps demand, the way three-note-per-string fingerings do)
function threeNps(open, scale, s0, pos, strings, maxFret) {
  const notes = [];
  let f = pos;
  for (let s = s0; s < Math.min(6, s0 + strings); s++) {
    // first scale note at or above the fret where the previous string's last note sits, minus the fourth (5 frets)
    let start = s === s0 ? f : notes[notes.length - 1].m + 1 - open[s];
    let k = 0;
    for (let fr = Math.max(0, start); fr <= maxFret && k < 3; fr++) {
      const m = open[s] + fr;
      if (scale.has(m % 12)) { notes.push({ s, f: fr, m }); k++; }
    }
  }
  return notes;
}

// ---------------- pick strokes ----------------
// Downward pickslanting with sweeps (Grady's analysis of Yngwie): within a string, alternate; moving to a higher
// string (toward the treble) the next stroke is a downstroke continuing the same motion if the last was a
// downstroke (a sweep), so ascending string changes ride on downstrokes; descending string changes come after an
// upstroke. Hammer-ons / pull-offs take no stroke.
function assignStrokes(notes) {
  let last = -1, lastS = null;
  for (const n of notes) {
    if (n.art === 'h' || n.art === 'p' || n.art === 'sl') { continue; }
    let d;
    if (lastS === null) d = 1;
    else if (n.s > lastS && last === 1) d = 1;          // sweep down onto the next higher string
    else if (n.s < lastS && last === -1) d = -1;        // sweep up onto the next lower string
    else d = -last;
    n.dir = d; last = d; lastS = n.s;
  }
  return notes;
}

// ---------------- figures ----------------
// each returns { notes: [{s, f, m, dur (beats), art?, vib?}], beats }
const FIG = {
  // descending "sixes": groups of six (three on a string, three on the next lower), each group starting one scale
  // step lower, played as sextuplets
  sixes(ctx, beats) {
    const { open, scale, top } = ctx;
    const pos = clamp(top - 4, 1, ctx.maxFret - 5);
    const box = threeNps(open, scale, 2, pos, 4, ctx.maxFret);         // strings G..E, ascending
    const asc = box.map(n => n), out = [];
    const desc = asc.slice().reverse();
    for (let g = 0; g < beats; g++) {
      const start = Math.min(desc.length - 6, g * 2);
      if (start < 0) break;
      for (let i = 0; i < 6; i++) out.push(Object.assign({}, desc[start + i], { dur: 1 / 6 }));
    }
    return { notes: out, beats };
  },
  // pedal point: a pedal note on the top string alternating with a line descending (or ascending) on the same
  // string, sixteenths, alternate picking
  pedal(ctx, beats) {
    const { open, scale, tones } = ctx;
    const s = 5 - (ctx.rng() < 0.3 ? 1 : 0);
    // pedal: a chord tone high on the string
    let pf = -1;
    for (let f = Math.min(ctx.maxFret, ctx.top + 2); f >= 5; f--) if (tones.includes((open[s] + f) % 12)) { pf = f; break; }
    if (pf < 0) return null;
    const line = [];
    for (let f = pf - 1; f >= Math.max(0, pf - 9) && line.length < 6; f--) if (scale.has((open[s] + f) % 12)) line.push(f);
    const up = ctx.rng() < 0.35, seq = up ? line.slice().reverse() : line;
    const out = [];
    for (let i = 0; i < beats * 2; i++) {
      const lf = seq[i % seq.length];
      out.push({ s, f: pf, m: open[s] + pf, dur: 1 / 4 }, { s, f: lf, m: open[s] + lf, dur: 1 / 4 });
    }
    return { notes: out, beats };
  },
  // sweep arpeggio over 3 or 5 strings: one chord tone per string upward, a hammer-on to the next chord tone on top,
  // pull-off back, and down again; sextuplets (3-string) or sixteenth-note groups of 8 (5-string)
  sweep(ctx, beats) {
    const { open, tones } = ctx, n = ctx.rng() < 0.5 ? 3 : 5;
    const low = 6 - n, around = clamp(ctx.top, 5, ctx.maxFret - 3);
    const up = [];
    let prev = -1;
    for (let s = low; s < 6; s++) {
      let best = null;
      for (let f = Math.max(1, around - 5); f <= Math.min(ctx.maxFret, around + 3); f++) {
        const m = open[s] + f;
        if (!tones.includes(m % 12) || m <= prev) continue;
        if (!best || Math.abs(f - around) < Math.abs(best.f - around)) best = { s, f, m };
      }
      if (!best) return null;
      up.push(best); prev = best.m;
    }
    const topS = 5, topNote = up[up.length - 1];
    let hf = -1;
    for (let f = topNote.f + 1; f <= Math.min(ctx.maxFret, topNote.f + 5); f++) if (tones.includes((open[topS] + f) % 12)) { hf = f; break; }
    const out = [], per = n === 3 ? 6 : 8, d = 1 / (per / (n === 3 ? 1 : 2));
    for (let rep = 0; rep < Math.max(1, Math.round(beats / (n === 3 ? 1 : 2))); rep++) {
      up.forEach(x => out.push(Object.assign({}, x, { dur: d })));
      if (hf > 0) { out.push({ s: topS, f: hf, m: open[topS] + hf, dur: d, art: 'h' }); out.push(Object.assign({}, topNote, { dur: d, art: 'p' })); }
      up.slice(0, -1).reverse().forEach(x => out.push(Object.assign({}, x, { dur: d })));
    }
    return { notes: out, beats: out.reduce((a, x) => a + x.dur, 0) };
  },
  // diminished arpeggio run: minor thirds, two notes per string, climbing; sixteenths
  dimRun(ctx, beats) {
    const { open } = ctx, r = ctx.dimRoot;
    const out = []; let prev = open[1] + Math.max(1, ctx.top - 7);
    for (let s = 1; s < 6 && out.length < beats * 4; s++) {
      for (let k = 0; k < 2; k++) {
        let m = prev + (out.length ? 3 : 0);
        while ((m - r + 120) % 3 !== 0) m++;
        const f = m - open[s];
        if (f < 0 || f > ctx.maxFret) break;
        out.push({ s, f, m, dur: 1 / 4 }); prev = m;
      }
    }
    return out.length >= 4 ? { notes: out, beats: out.length / 4 } : null;
  },
  // scale run (3 per string), up or down, fast, ending on a chord tone held with wide vibrato
  run(ctx, beats) {
    const { open, scale, tones } = ctx;
    const up = ctx.rng() < 0.55;
    const box = threeNps(open, scale, ctx.rng() < 0.5 ? 1 : 2, clamp(ctx.top - 3 - Math.floor(ctx.rng() * 3), 1, ctx.maxFret - 6), 5, ctx.maxFret);
    const seq = up ? box : box.slice().reverse();
    const runBeats = Math.max(1, beats - 1), per = ctx.fast ? 8 : 6, count = Math.min(seq.length, runBeats * per);
    const out = seq.slice(0, count).map(x => Object.assign({}, x, { dur: 1 / per }));
    // land on the nearest chord tone and hold it with vibrato
    let last = out[out.length - 1], land = null;
    for (let df = 0; df <= 3 && !land; df++) for (const sg of up ? [1, -1] : [-1, 1]) {
      const f = last.f + sg * df; if (f < 0 || f > ctx.maxFret) continue;
      if (tones.includes((open[last.s] + f) % 12)) { land = { s: last.s, f, m: open[last.s] + f }; break; }
    }
    if (land) out.push(Object.assign(land, { dur: beats - out.reduce((a, x) => a + x.dur, 0), vib: true, accent: true }));
    return { notes: out, beats };
  },
  // trill on a chord tone with its upper scale neighbour (hammer / pull), then a turn and resolution
  trill(ctx, beats) {
    const { open, scale, tones } = ctx, s = 4 + (ctx.rng() < 0.5 ? 1 : 0);
    let tf = -1;
    for (let f = clamp(ctx.top, 3, ctx.maxFret - 3); f >= 2; f--) if (tones.includes((open[s] + f) % 12)) { tf = f; break; }
    if (tf < 0) return null;
    let uf = tf + 1; while (uf <= tf + 2 && !scale.has((open[s] + uf) % 12)) uf++;
    let lf = tf - 1; while (lf >= tf - 2 && !scale.has((open[s] + lf) % 12)) lf--;
    const out = [{ s, f: tf, m: open[s] + tf, dur: 1 / 8 }];
    for (let i = 0; i < beats * 8 - 4; i++) { const f = i % 2 ? tf : uf; out.push({ s, f, m: open[s] + f, dur: 1 / 8, art: i % 2 ? 'p' : 'h' }); }
    out.push({ s, f: lf, m: open[s] + lf, dur: 1 / 8, art: 'p' }, { s, f: tf, m: open[s] + tf, dur: 1 / 8, art: 'h' });
    return { notes: out, beats: out.reduce((a, x) => a + x.dur, 0) };
  }
};

// ---------------- the generator ----------------
class YngwieGen {
  constructor(host) { this.h = host; this.lastFig = null; this.phrasePos = 0; }
  // plan the next stretch of `beats` beats over this voicing; returns notes with beat offsets
  plan(frets, beats) {
    const open = this.h.open(), rng = this.h.rng, o = this.h.options();
    const H = analyseChord(frets, open);
    const fr = frets.filter(f => f > 0), base = fr.length ? Math.min(...fr) : 0;
    const ctx = { open, scale: H.scale, tones: H.tones, quality: H.quality, rng, maxFret: 19,
      top: clamp(base + 7 + Math.floor(rng() * 6), 7, 15), fast: (o.bpm || 120) < 130 && rng() < 0.5,
      dimRoot: H.quality === 'dim' ? H.root : (H.root + 11) % 12 };
    // phrase shape: busy figures, and every few beats a run that lands on a long note with vibrato
    const weights = H.quality === 'dim' ? { dimRun: 3, sweep: 2, run: 2, sixes: 1 }
      : { sixes: 3, pedal: 2.5, sweep: 3, run: 1.5, trill: 0.8, dimRun: H.quality === 'min' ? 0 : 1 };
    const out = []; let b = 0;
    while (b < beats - 1e-6) {
      const left = beats - b;
      this.phrasePos++;
      let name;
      if (left >= 2 && this.phrasePos % 4 === 0) name = 'run';
      else {
        const keys = Object.keys(weights).filter(k => k !== this.lastFig || rng() < 0.25), tot = keys.reduce((a, k) => a + weights[k], 0);
        let r = rng() * tot; name = keys[0];
        for (const k of keys) { r -= weights[k]; if (r <= 0) { name = k; break; } }
      }
      const len = name === 'run' ? Math.min(left, 2) : Math.min(left, name === 'sweep' ? (rng() < 0.5 ? 1 : 2) : 2);
      const fig = FIG[name](ctx, len) || FIG.sixes(ctx, Math.max(1, Math.floor(len)));
      if (!fig || !fig.notes.length) { b += 1; continue; }
      this.lastFig = name;
      let t = b;
      for (const n of fig.notes) { out.push(Object.assign({}, n, { beat: t })); t += n.dur; }
      b += fig.beats;
    }
    return assignStrokes(out);
  }
}

root.YngwieGen = YngwieGen;
root.analyseChord = analyseChord;
})(typeof globalThis !== 'undefined' ? globalThis : this);
