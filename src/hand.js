// Acoustic — the plucking hand. Turns a held chord into what a guitarist's right hand does with it, style by style:
// which finger takes which string, when each finger actually lands, how hard, rest or free stroke, and the small
// contacts a real hand makes (a rest stroke landing on the next string, a follow-through grazing a neighbour,
// fingers planted before an arpeggio, the palm on the bass strings, the ring finger tapping the top).
//
// Patterns are written in a small notation, one entry per grid step ('-' = nothing), several actions per step:
//   p:B   thumb on the bass string            i:T1 m:T2 a:T3   fingers on the three highest chord strings
//   p:A   thumb on the alternate bass (prefers the chord's 5th)   p:M   thumb on the string above the bass
//   D:all / U:top3 / D:B ...   flatpick stroke down/up across a string set or on a single role
//   R:eami   rasgueado: each finger in turn flicks its nail down across the strings (R:ami, R:i, Ru:i = index up)
//   N:T3     a nail stroke down on one string (clawhammer)       K:top3  brush down with the backs of the nails
//   G        golpe (tap on the top)                              X:all   tapado: strings muted by the palm, struck
// Modifiers after a token:  > accent   . ghost (soft)   ! rest stroke   _ palm-muted
//
// Timing follows the two-level model of rhythmic motor control (Wing & Kristofferson 1973): a central timekeeper
// whose intervals vary, with first-order phase correction toward the beat (Vorberg & Wing 1996; Repp 2005), plus
// a motor delay per finger. Finger-specific means and spreads are in MOTOR (see the README for sources).

(function (root) {
'use strict';

function gauss(r) { return (r() + r() + r() + r() - 2) * 1.2247; }
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

// ---------------- motor parameters ----------------
// strength: velocity multiplier; bias: mean timing offset (s) relative to the hand's clock; sd: motor delay
// spread (s) at mid skill. Thumb: strongest, slightly early in pinches; ring finger: weakest and least independent.
const MOTOR = {
  fingers: {
    p: { strength: 1.00, bias: -0.002, sd: 0.0045, style: 'thumb' },
    i: { strength: 0.86, bias: 0.000, sd: 0.0040, style: 'finger' },
    m: { strength: 0.88, bias: 0.001, sd: 0.0040, style: 'finger' },
    a: { strength: 0.76, bias: 0.003, sd: 0.0055, style: 'finger' },
    c: { strength: 0.60, bias: 0.004, sd: 0.0070, style: 'finger' },
    e: { strength: 0.70, bias: 0.000, sd: 0.0050, style: 'finger' }  // little finger in rasgueado
  },
  timekeeper: 0.012,      // SD of the internal clock as a fraction of the step interval (mid skill)
  phaseCorr: 0.35,        // fraction of each asynchrony corrected on the next step
  velSd: 0.09,            // per-pluck dynamic variability (fraction), mid skill
  pinchSpread: 0.006,     // SD of finger onsets within a simultaneous pinch (s)
  brush: 0.05,            // probability that a free-stroke follow-through grazes the neighbouring string (mid skill)
  maxRate: { p: 9, i: 10, m: 10, a: 8, c: 6, e: 7 }   // fastest comfortable repetitions per second for one finger
};

// ---------------- styles ----------------
// sub: grid steps per beat; beats: pattern length in beats; swing: long/short ratio of off-beat pairs (1 = straight);
// push: playing ahead (-) or behind (+) the beat, s; nail: plucks with nails; rest: default to rest strokes;
// plant: plant fingers before arpeggios; brush: scales the accidental-contact rate; pick: flatpick style.
const STYLES = {
  classical: { name: 'Classical arpeggio (p-i-m-a-m-i)', sub: 3, beats: 2, nail: true, plant: false, brush: 0.6,
    steps: ['p:B', 'i:T1', 'm:T2', 'a:T3', 'm:T2', 'i:T1'] },
  giuliani: { name: 'Classical: Giuliani p-i-m-i, bass rest stroke', sub: 4, beats: 2, nail: true, brush: 0.6,
    steps: ['p:B!>', 'i:T1', 'm:T2', 'i:T1', 'p:A!', 'i:T1', 'm:T2', 'i:T1'] },
  tremolo: { name: 'Classical tremolo (p-a-m-i)', sub: 4, beats: 2, nail: true, brush: 0.5,
    steps: ['p:B', 'a:T3', 'm:T3', 'i:T3', 'p:A', 'a:T3', 'm:T3', 'i:T3'] },
  travis: { name: 'Travis picking (alternating thumb)', sub: 2, beats: 4, swing: 1.15, brush: 1.0,
    steps: ['p:B_> m:T3', 'i:T2', 'p:A_', 'm:T3', 'p:B_', 'i:T2', 'p:A_', 'm:T3.'] },
  folk: { name: 'Folk fingerpicking (p-i-m-i)', sub: 2, beats: 4, brush: 1.2,
    steps: ['p:B>', 'i:T1', 'm:T2', 'i:T1', 'p:A', 'i:T1', 'm:T2', 'i:T1'] },
  ballad: { name: 'Ballad pinch (p+a, then i-m)', sub: 2, beats: 4, brush: 1.0,
    steps: ['p:B> a:T3', 'i:T1', 'm:T2', 'i:T1', 'p:A m:T2', 'i:T1', 'a:T3', 'i:T1'] },
  bossa: { name: 'Bossa nova (thumb + block chords)', sub: 2, beats: 8, brush: 0.7,
    steps: ['p:B i:T1 m:T2 a:T3', '-', '-', 'i:T1 m:T2 a:T3', 'p:A', '-', 'i:T1. m:T2. a:T3.', '-',
            'p:B', '-', 'i:T1 m:T2 a:T3', '-', 'p:A i:T1 m:T2 a:T3', '-', '-', '-'] },
  boomchuck: { name: 'Bluegrass boom-chuck (flatpick)', sub: 2, beats: 4, pick: true, swing: 1.1, push: -0.006, brush: 0,
    steps: ['D:B>', '-', 'D:top4', 'U:top3.', 'D:A>', '-', 'D:top4', 'U:top3.'] },
  crosspick: { name: 'Bluegrass crosspicking roll (3+3+2)', sub: 2, beats: 4, pick: true, push: -0.004, brush: 0,
    steps: ['D:T1>', 'D:T2', 'U:T3', 'D:T1>', 'D:T2', 'U:T3', 'D:T1>', 'U:T3'] },
  clawhammer: { name: 'Clawhammer / frailing (bum-ditty)', sub: 2, beats: 2, brush: 0.8,
    steps: ['N:T3>', '-', 'K:top3', 'p:A'] },
  rumba: { name: 'Flamenco rumba (rasgueo + tapado)', sub: 2, beats: 4, nail: true, push: -0.004, brush: 0,
    steps: ['R:i>', '-', 'X:all G', 'Ru:i.', '-', 'Ru:i', 'X:all G', 'Ru:i.'] },
  solea: { name: 'Flamenco soleá compás (12 beats)', sub: 1, beats: 12, nail: true, brush: 0,
    steps: ['p:B', 'R:i', 'R:eami> G', 'p:B', 'R:i', 'R:eami> G', 'R:i', 'R:eami> G', 'p:B', 'R:eami> G', 'Ru:i', 'R:ami> G'] },
  alzapua: { name: 'Flamenco alzapúa (thumb down-up-down)', sub: 3, beats: 2, nail: true, brush: 0,
    steps: ['p:B!>', 'Pd:top3', 'Pu:top3', 'p:B!>', 'Pd:top3', 'Pu:top3'] }
};

// ---------------- the hand ----------------
class RightHand {
  // host: { send(events), now(), rng(), open(), options() }  (options: bpm, skill, brushes, palm, pickPos, humanize)
  constructor(host) {
    this.h = host;
    this.running = false; this.v = null; this.vel = 0.7;
    this.step = 0; this.tGrid = 0; this.tHand = 0; this.timer = null;
    this.lastFinger = {}; this.lastTimeFinger = {};
    this.ringing = [0, 0, 0, 0, 0, 0];   // time each string was last plucked by the hand
  }
  style() { return STYLES[this.h.options().style] || STYLES.travis; }
  stepDur() { const o = this.h.options(), S = this.style(); return 60 / Math.max(30, o.bpm || 96) / S.sub; }

  // a new chord: start the pattern at this time, or keep the running grid and swap the voicing
  chord(v, vel, t) {
    const prev = this.v;
    this.v = v; this.vel = vel; this.roles = this.mapRoles(v);
    if (!this.running) {
      this.running = true; this.step = 0; this.tGrid = t; this.tHand = t; this.async = 0;
      this.tick();
      return;
    }
    // a chord grabbed just after a step already went out with the old one: play that step again, late, as a player
    // who was late with the left hand would
    const sd = this.stepDur(), last = this.tGrid - sd;
    if (prev && t - last < Math.min(0.09, 0.45 * sd) && t >= last - 0.01) this.emitStep((this.step - 1 + this.len()) % this.len(), Math.max(t, last), true);
  }
  realign(t) { if (!this.running) return; this.step = 0; this.tGrid = t; this.async = 0; }
  stop() { this.running = false; clearTimeout(this.timer); this.timer = null; }
  len() { return this.style().steps.length; }

  tick() {
    if (!this.running) return;
    const now = this.h.now(), ahead = 0.035;
    while (this.tGrid < now + ahead) {
      this.emitStep(this.step, this.tGrid, false);
      this.step = (this.step + 1) % this.len();
      // swing: lengthen on-beat steps of each pair, shorten off-beats
      const S = this.style(), sd = this.stepDur(), sw = S.swing || 1;
      const pairPos = S.sub % 2 === 0 ? (this.step % 2) : -1;
      const k = pairPos === 1 ? 2 * sw / (1 + sw) : pairPos === 0 ? 2 / (1 + sw) : 1;
      this.tGrid += sd * k;
    }
    this.timer = setTimeout(() => this.tick(), 12);
  }

  // roles -> strings for this voicing
  mapRoles(v) {
    const open = this.h.open();
    const snd = []; v.frets.forEach((f, s) => { if (f >= 0) snd.push(s); });
    const pitch = (s) => open[s] + v.frets[s];
    const B = snd[0];
    const rootPc = pitch(B) % 12;
    // alternate bass: a bass-side string (not B) carrying the 5th, else the next sounding string up
    let A = snd.find(s => s !== B && s <= 3 && (pitch(s) - rootPc + 120) % 12 === 7);
    if (A == null) A = snd.find(s => s > B && s <= 3) ?? snd[1] ?? B;
    const treb = snd.filter(s => s >= 2 && s !== B && s !== A);
    const top = treb.length >= 3 ? treb.slice(-3) : snd.slice(-3);
    const T3 = top[top.length - 1], T2 = top[top.length - 2] ?? T3, T1 = top[top.length - 3] ?? T2;
    const M = snd.find(s => s > B) ?? B;
    return { B, A, M, T1, T2, T3, snd, pitch };
  }
  stringSet(name) {
    const r = this.roles, snd = r.snd;
    if (name === 'all') { const out = []; for (let s = snd[0]; s <= snd[snd.length - 1]; s++) out.push(s); return out; }
    const m = /^top(\d)$/.exec(name);
    if (m) { const n = +m[1], hi = snd[snd.length - 1], out = []; for (let s = Math.max(snd[0], hi - n + 1); s <= hi; s++) out.push(s); return out; }
    return [r[name]].filter(s => s != null);
  }

  // ---- one grid step ----
  emitStep(k, tGrid, late) {
    const S = this.style(), o = this.h.options(), rng = this.h.rng;
    const src = S.steps[k];
    if (!src || src === '-' || !this.v) return;
    const skill = clamp(o.skill ?? 0.6, 0, 1), loose = 1.6 - 1.2 * skill;   // beginner ~1.6x, virtuoso ~0.4x spread
    // the hand's clock: timekeeper noise with phase correction toward the grid
    const sd = this.stepDur();
    if (!late) {
      // asynchrony of the hand's clock against the beat: a fraction is corrected each step, the timekeeper adds new error
      this.async = (this.async || 0) * (1 - MOTOR.phaseCorr) + gauss(rng) * MOTOR.timekeeper * sd * loose * (o.humanize ?? 0.6) / 0.6;
      this.tHand = tGrid + this.async;
    }
    const tBase = (late ? tGrid : this.tHand) + (S.push || 0);
    const beatPos = k / S.sub, onBeat = k % S.sub === 0;
    // metric accent: downbeat of the pattern strongest, then beats, then subdivisions
    const metric = k === 0 ? 1.0 : onBeat ? 0.93 : 0.84;
    const evs = [];
    const toks = src.trim().split(/\s+/);
    const pinch = toks.filter(t => /^[pimac]:/.test(t)).length > 1;
    for (const tok of toks) this.action(tok, tBase, metric, pinch, skill, loose, evs, S, o);
    this.h.send(evs);
  }

  action(tok, t0, metric, pinch, skill, loose, evs, S, o) {
    const rng = this.h.rng, open = this.h.open(), v = this.v, hum = (o.humanize ?? 0.6) / 0.6;
    const mods = /[>.!_]+$/.exec(tok); const md = mods ? mods[0] : '';
    const core = mods ? tok.slice(0, -md.length) : tok;
    const acc = md.includes('>') ? 1.18 : md.includes('.') ? 0.62 : 1;
    const rest = md.includes('!') || (S.rest && !md.includes('.'));
    const palm = md.includes('_') || o.palm;
    const vel0 = this.vel * metric * acc;
    const vsd = MOTOR.velSd * loose * hum;
    const [kind, arg] = core.split(':');
    const midiOf = (s) => v.frets[s] >= 0 ? open[s] + v.frets[s] : open[s];

    if (kind === 'G') { evs.push({ type: 'tap', t: t0 + 0.002 + Math.abs(gauss(rng)) * 0.003 * loose, vel: clamp(vel0 * 0.9, 0.05, 1), nail: true }); return; }

    // flatpick strokes
    if (kind === 'D' || kind === 'U') {
      const dir = kind === 'D' ? 1 : -1;
      const set = this.stringSet(arg);
      if (set.length === 1) {
        const s = set[0];
        evs.push({ type: 'pluck', s, midi: midiOf(s), t: t0 + gauss(rng) * 0.0035 * loose * hum, dir, style: 'pick',
          vel: clamp(vel0 * (dir < 0 ? 0.9 : 1) * (1 + gauss(rng) * vsd), 0.03, 1), palm, dead: v.frets[s] < 0,
          pickPos: (o.pickPos || 0.2) * (1 + gauss(rng) * 0.04 * hum), bright: dir < 0 ? 1.4 : 1 });
        this.ringing[s] = t0;
        // a single-string pick stroke sometimes clips the next string in its path (less for skilled players)
        if (rng() < 0.03 * (o.brushes ?? 1) * loose) this.graze(evs, s + dir, t0 + 0.006, 'pick', vel0, dir);
        return;
      }
      this.sweep(evs, dir > 0 ? set : set.slice().reverse(), t0, vel0 * (dir < 0 ? 0.88 : 1), dir, 'pick', false, palm, o, loose);
      return;
    }
    if (kind === 'X') { // tapado: palm lands on the strings as the hand strikes: dead, percussive
      this.sweep(evs, this.stringSet(arg), t0, vel0 * 0.8, 1, S.pick ? 'pick' : 'finger', S.nail, palm, o, loose, true);
      return;
    }
    if (kind === 'K') { this.sweep(evs, this.stringSet(arg), t0, vel0 * 0.8, 1, 'finger', true, palm, o, loose); return; }
    if (kind === 'N') { // clawhammer: the nail strikes down through one string
      for (const s of this.stringSet(arg)) evs.push({ type: 'pluck', s, midi: midiOf(s), t: t0 + gauss(rng) * 0.004 * loose * hum, dir: 1,
        style: 'finger', nail: true, rest: true, vel: clamp(vel0 * 1.05 * (1 + gauss(rng) * vsd), 0.03, 1), palm, pickPos: 0.22 });
      return;
    }
    if (kind === 'Pd' || kind === 'Pu') { // alzapúa: thumb through the strings down, thumbnail back up
      const dir = kind === 'Pd' ? 1 : -1, set = this.stringSet(arg);
      this.sweep(evs, dir > 0 ? set : set.slice().reverse(), t0, vel0 * (dir > 0 ? 0.9 : 0.75), dir, 'thumb', true, palm, o, loose);
      return;
    }
    if (kind === 'R' || kind === 'Ru') {
      // rasgueado: fingers flick out in sequence (little/ring/middle/index), each nail sweeping the strings
      const fingers = kind === 'Ru' ? ['i'] : arg.split('');
      const set = this.stringSet('all');
      const gap = clamp(0.028 * (1.25 - 0.5 * skill), 0.014, 0.04);     // between successive fingers
      fingers.forEach((f, j) => {
        const F = MOTOR.fingers[f] || MOTOR.fingers.i;
        const tf = t0 + j * gap * (1 + gauss(rng) * 0.12 * loose) + F.bias;
        const dir = kind === 'Ru' ? -1 : 1;
        const strength = (j === fingers.length - 1 ? 1.08 : 1) * F.strength;   // the last flick lands the accent
        const order = dir > 0 ? set : set.slice().reverse().slice(0, Math.max(3, Math.round(set.length * 0.7)));
        this.sweep(evs, order, tf, vel0 * strength, dir, 'finger', true, palm, o, loose, false, 0.014);
      });
      return;
    }

    // a finger plucking one string
    const finger = kind, F = MOTOR.fingers[finger];
    if (!F) return;
    const s = this.roles[arg];
    if (s == null) return;
    let t = t0 + F.bias + gauss(rng) * F.sd * loose * hum;
    if (pinch) t += gauss(rng) * MOTOR.pinchSpread * loose * hum * 0.5;
    // a finger asked to repeat faster than it can: it arrives late and softer
    const lastT = this.lastTimeFinger[finger] ?? -1, minGap = 1 / MOTOR.maxRate[finger];
    let fatigue = 1;
    if (lastT >= 0 && t - lastT < minGap) { t = lastT + minGap * (0.9 + 0.1 * rng()); fatigue = 0.85; }
    this.lastTimeFinger[finger] = t;
    const vel = clamp(vel0 * F.strength * fatigue * (rest ? 1.12 : 1) * (1 + gauss(rng) * vsd), 0.03, 1);
    const thumb = finger === 'p';
    // planting: the finger rests on its string just before plucking it, cutting what was ringing there
    if (S.plant && !thumb && t - this.ringing[s] > 0.05) evs.push({ type: 'touch', s, amt: 50, dur: 0.03, t: t - 0.035, nail: S.nail });
    evs.push({ type: 'pluck', s, midi: midiOf(s), t, dir: thumb ? 1 : -1, style: F.style, nail: S.nail, rest, palm: palm && thumb,
      vel, dead: v.frets[s] < 0, pickPos: (o.pickPos || 0.2) * (thumb ? 1.12 : 0.92) * (1 + gauss(rng) * 0.05 * hum) });
    this.ringing[s] = t;
    // where the finger goes next: fingers follow through toward the bass strings (toward the palm), the thumb
    // toward the treble strings
    const nb = thumb ? s + 1 : s - 1;
    if (nb < 0 || nb > 5) return;
    if (rest) { // the stroke ends on the neighbour and stays there until the finger moves on
      evs.push({ type: 'touch', s: nb, amt: 45, dur: 0.09 + 0.08 * rng(), t: t + 0.004, nail: false });
      return;
    }
    const pB = MOTOR.brush * (S.brush ?? 1) * (o.brushes ?? 1) * loose * (0.6 + 0.6 * this.vel);
    if (rng() < pB) this.graze(evs, nb, t + 0.004 + 0.006 * rng(), F.style, vel, thumb ? 1 : -1);
  }

  // an unintended contact with string s: a ringing string gets briefly damped; a quiet one gets a faint pluck;
  // a string the fretting hand is muting gives a dead tick
  graze(evs, s, t, style, vel, dir) {
    if (s < 0 || s > 5) return;
    const v = this.v, open = this.h.open(), rng = this.h.rng;
    const ringingNow = t - this.ringing[s] < 1.2;
    if (v.frets[s] < 0) { evs.push({ type: 'pluck', s, midi: open[s], t, dir, style, dead: true, vel: clamp(vel * 0.25, 0.02, 0.3), pickPos: 0.2 }); return; }
    if (ringingNow && rng() < 0.6) { evs.push({ type: 'touch', s, amt: 22, dur: 0.02 + 0.03 * rng(), t }); return; }
    evs.push({ type: 'pluck', s, midi: open[s] + v.frets[s], t, dir, style, vel: clamp(vel * (0.12 + 0.12 * rng()), 0.02, 0.25), pickPos: 0.2 });
    this.ringing[s] = t;
  }

  // a stroke across several strings (pick, nails, thumb); `dead` = palm muting them as it strikes
  sweep(evs, order, t0, vel, dir, style, nail, palm, o, loose, dead = false, total) {
    const rng = this.h.rng, v = this.v, open = this.h.open(), n = order.length, hum = (o.humanize ?? 0.6) / 0.6;
    const T = (total ?? (o.speed ?? 0.045) * (1.4 - 0.7 * this.vel)) * Math.max(1, n - 1) / 5 * (dir < 0 ? 0.8 : 1);
    order.forEach((s, i) => {
      const frac = n > 1 ? i / (n - 1) : 0, md = v.frets[s] < 0 || dead;
      evs.push({ type: 'pluck', s, midi: v.frets[s] >= 0 ? open[s] + v.frets[s] : open[s], t: t0 + T * Math.pow(frac, 0.85) + gauss(rng) * 0.001 * loose * hum,
        dir, style, nail, dead: md, palm, bright: dir < 0 ? 1.5 : 1,
        vel: clamp(vel * (1 - 0.18 * frac) * (1 + gauss(rng) * 0.07 * loose * hum) * (md ? 0.7 : 1), 0.03, 1),
        pickPos: (o.pickPos || 0.2) * (1 + gauss(rng) * 0.04 * hum) });
      this.ringing[s] = t0;
    });
  }
}

root.RightHand = RightHand;
root.HAND_STYLES = STYLES;
root.HAND_MOTOR = MOTOR;
})(typeof globalThis !== 'undefined' ? globalThis : this);
