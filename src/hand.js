// Acoustic — the plucking hand. Turns a held chord into what a guitarist's right hand does with it, style by style:
// which finger takes which string, when each finger actually lands, how hard, rest or free stroke, and the small
// contacts a real hand makes (a rest stroke landing on the next string, a follow-through grazing a neighbour, the
// ring finger dragged along by the middle, the thumb resting on the bass, fingers planted before an arpeggio, the
// ring finger tapping the top). Melody notes played over a running pattern are taken by alternating fingers.
//
// Patterns are written in a small notation, one entry per grid step ('-' = nothing), several actions per step:
//   p:B   thumb on the bass string            i:T1 m:T2 a:T3   fingers on the three highest chord strings
//   p:A   thumb on the alternate bass (prefers the chord's 5th)   p:M   thumb on the string above the bass
//   D:all / U:top3 / D:B ...   flatpick stroke down/up across a string set or on a single role
//   R:eami   rasgueado: each finger in turn flicks its nail down across the strings (R:ami, R:i, Ru:i = index up)
//   N:T3     a nail stroke down on one string (clawhammer)       K:top3  brush down with the backs of the nails
//   Pd:/Pu:  thumb down / thumbnail up through a string set (alzapúa)
//   G        golpe (tap on the top)                              X:all   tapado: strings muted by the palm, struck
// Modifiers after a token:  > accent   . ghost (soft)   ! rest stroke   _ palm-muted
//
// Numbers (see README, "The plucking hand"):
//   timing   two levels: a slow drift of the whole hand against the beat (AR(1), rho 0.9; Heijink & Meulenbroek 2002
//            found most of professionals' 18-24 ms onset SD was whole-pattern shifts) plus note-to-note jitter
//            SD = sqrt(4^2 + (k IOI)^2) ms, k ~0.06 for students (Nezio Malta 2012: arpeggio IOI SD 17 ms at 184 ms)
//            down to ~0.03 for professionals; the ring finger slightly late; tremolo's gap before the thumb.
//   chords   plucked together: first-to-last spread ~10 ms (tight) to ~28 ms (loose) in a fixed order per player
//            (Nezio Malta 2012); louder notes a few ms earlier (Goebl 2001).
//   dynamics per-pluck SD ~1.5-2 dB (professional) to 3-4 dB (amateur); m loudest, a weakest, thumb softer in
//            accompaniment; accents +3-4 dB; rest stroke +2.5 dB and more perpendicular to the top.
//   limits   same finger again no sooner than 140-180 ms, thumb 110 ms; finger independence falls with rate and is
//            lowest for the ring finger (Hager-Ross & Schieber 2000; Zatsiorsky et al. 2000).
//   errors   brushes 0.3% (professional) to 3% (amateur) per pluck, -20 to -30 dB; slips late and soft (Maidhof
//            et al. 2009). These rates are estimates: no guitar study has measured them.
//   rasgueado four overlapping nail sweeps across ~290 ms (Laurson, Valimaki & Penttinen 2010).

(function (root) {
'use strict';

function gauss(r) { return (r() + r() + r() + r() - 2) * 1.7321; }   // ~N(0,1)
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
const dB = (x) => Math.pow(10, x / 26);   // pluck velocity -> level: string displacement ~ vel^1.3

// ---------------- motor parameters ----------------
// db: level offset of the finger in arpeggios; bias: mean lag (s); minGap: shortest repeat of the same finger (s,
// for a professional; amateurs ~30% longer); indep: individuation index (Hager-Ross & Schieber 2000).
const MOTOR = {
  fingers: {
    p: { db: -2.0, bias: -0.001, minGap: 0.110, indep: 0.983, style: 'thumb' },
    i: { db: 0.0, bias: 0.000, minGap: 0.140, indep: 0.982, style: 'finger' },
    m: { db: 0.5, bias: 0.000, minGap: 0.140, indep: 0.937, style: 'finger' },
    a: { db: -1.5, bias: 0.004, minGap: 0.150, indep: 0.907, style: 'finger' },
    c: { db: -3.0, bias: 0.005, minGap: 0.170, indep: 0.943, style: 'finger' },
    e: { db: -2.0, bias: 0.000, minGap: 0.170, indep: 0.943, style: 'finger' }   // little finger, rasgueado
  },
  jitterFloor: 0.004,      // s
  jitterK: [0.075, 0.03],  // fraction of the inter-onset interval, beginner -> professional (an IOI SD is sqrt(2) x the onset SD:
                           // students' 17 ms IOI SD at 184 ms (Nezio Malta 2012) ~ k 0.06 at skill ~0.35)
  driftRho: 0.9,
  driftSd: [0.06, 0.03],   // stationary SD of the hand's drift, fraction of the step
  velSdDb: [3.5, 1.7],
  chordSpread: [[28, 8], [10, 5]],  // ms first-to-last (mean, SD): loose, tight
  brush: [0.03, 0.003],    // per free-stroke pluck, before rate and style scaling
  drag: [0.015, 0.002],    // ring finger pulled along by the middle finger
  slip: [0.03, 0.005]      // a pluck that goes wrong: missed, wrong string, or late and soft
};
const lerp = (pair, skill) => pair[0] + (pair[1] - pair[0]) * skill;

// ---------------- styles ----------------
// sub: grid steps per beat; beats: pattern length; tempo: typical bpm; swing: long/short ratio of off-beat pairs at
// slow tempo, shrinking toward 1 as tempo rises (Friberg & Sundstrom 2002; Honing & de Haas 2008); push: playing
// ahead (-) or behind (+), s; offEarly: off-beats early by this fraction of a beat (Brazilian microtiming, Gouyon
// 2007); nail: plucks with nails; thumbDb: thumb level in this style; thumbRest: chance the thumb settles on the next
// string after a bass note; plant: sequential planting; preP: tremolo's extra gap before the thumb.
const STYLES = {
  classical: { name: 'Classical arpeggio (p-i-m-a-m-i)', tempo: 66, sub: 3, beats: 2, nail: true, brush: 0.7,
    steps: ['p:B', 'i:T1', 'm:T2', 'a:T3', 'm:T2', 'i:T1'] },
  giuliani: { name: 'Classical: Giuliani p-i-m-i, bass rest stroke', tempo: 72, sub: 4, beats: 2, nail: true, thumbDb: 3, brush: 0.7,
    steps: ['p:B!>', 'i:T1', 'm:T2', 'i:T1', 'p:A!', 'i:T1', 'm:T2', 'i:T1'] },
  planted: { name: 'Classical: planted arpeggio (p-i-m-a)', tempo: 60, sub: 4, beats: 1, nail: true, plant: true, brush: 0.5,
    steps: ['p:B', 'i:T1', 'm:T2', 'a:T3'] },
  tremolo: { name: 'Classical tremolo (p-a-m-i)', tempo: 140, sub: 4, beats: 2, nail: true, preP: true, brush: 0.6,
    steps: ['p:B', 'a:T3', 'm:T3', 'i:T3', 'p:A', 'a:T3', 'm:T3', 'i:T3'] },
  travis: { name: 'Travis picking (alternating thumb)', tempo: 110, sub: 2, beats: 4, swing: 1.2, thumbDb: 0, thumbRest: 0.45, brush: 1.0,
    steps: ['p:B_> m:T3', 'i:T2', 'p:A_', 'm:T3', 'p:B_', 'i:T2', 'p:A_', 'm:T3.'] },
  folk: { name: 'Folk fingerpicking (p-i-m-i)', tempo: 92, sub: 2, beats: 4, thumbDb: -1, thumbRest: 0.3, brush: 1.2,
    steps: ['p:B>', 'i:T1', 'm:T2', 'i:T1', 'p:A', 'i:T1', 'm:T2', 'i:T1'] },
  ballad: { name: 'Ballad pinch (p+a, then i-m)', tempo: 76, sub: 2, beats: 4, brush: 1.0,
    steps: ['p:B> a:T3', 'i:T1', 'm:T2', 'i:T1', 'p:A m:T2', 'i:T1', 'a:T3', 'i:T1'] },
  bossa: { name: 'Bossa nova (thumb + block chords)', tempo: 136, sub: 2, beats: 8, thumbDb: 2, offEarly: 0.025, brush: 0.7,
    steps: ['p:B i:T1 m:T2 a:T3', '-', '-', 'i:T1 m:T2 a:T3', 'p:A', '-', 'i:T1. m:T2. a:T3.', '-',
            'p:B', '-', 'i:T1 m:T2 a:T3', '-', 'p:A i:T1 m:T2 a:T3', '-', '-', '-'] },
  boomchuck: { name: 'Bluegrass boom-chuck (flatpick)', tempo: 120, sub: 2, beats: 4, pick: true, swing: 1.25, push: -0.006, brush: 0,
    steps: ['D:B>', '-', 'D:top4', 'U:top3.', 'D:A>', '-', 'D:top4', 'U:top3.'] },
  crosspick: { name: 'Bluegrass crosspicking roll (D-D-U, 3+3+2)', tempo: 120, sub: 2, beats: 4, pick: true, swing: 1.15, push: -0.004, brush: 0,
    steps: ['D:T1>', 'D:T2', 'U:T3', 'D:T1>', 'D:T2', 'U:T3', 'D:T1>', 'U:T3'] },
  clawhammer: { name: 'Clawhammer / frailing (bum-ditty)', tempo: 100, sub: 2, beats: 2, brush: 0.8,
    steps: ['N:T3>', '-', 'K:top3', 'p:A'] },
  rumba: { name: 'Flamenco rumba (rasgueo + tapado)', tempo: 110, sub: 2, beats: 4, nail: true, push: -0.004, brush: 0,
    steps: ['R:i>', '-', 'X:all G', 'Ru:i.', '-', 'Ru:i', 'X:all G', 'Ru:i.'] },
  solea: { name: 'Flamenco soleá compás (12 beats)', tempo: 150, sub: 1, beats: 12, nail: true, brush: 0,
    steps: ['p:B', 'R:i', 'R:eami> G', 'p:B', 'R:i', 'R:eami> G', 'R:i', 'R:eami> G', 'p:B', 'R:eami> G', 'Ru:i', 'R:ami> G'] },
  yngwie: { name: 'Yngwie mode (neoclassical lead lines)', tempo: 120, sub: 4, beats: 4, gen: 'yngwie', pick: true, pickType: 'delrin150', brush: 0, steps: ['-'] },
  alzapua: { name: 'Flamenco alzapúa (thumb down-up-down)', tempo: 120, sub: 3, beats: 2, nail: true, brush: 0,
    steps: ['p:B!>', 'Pd:top3', 'Pu:top3', 'p:B!>', 'Pd:top3', 'Pu:top3'] }
};

// ---------------- the hand ----------------
class RightHand {
  // host: { send(events), now(), rng(), open(), options() }  (options: style, bpm, skill, brushes, palm, pickPos, humanize)
  constructor(host) {
    this.h = host;
    this.running = false; this.v = null; this.vel = 0.7;
    this.step = 0; this.tGrid = 0; this.timer = null; this.drift = 0;
    this.lastT = {};                      // finger -> last pluck time
    this.ringing = [-9, -9, -9, -9, -9, -9];
    this.melody = new Map();              // string -> melody note holding it
    this.lastMel = null;                  // { s, finger }
    // this player's habitual order of fingers in a plucked chord (stable across the performance)
    const r = host.rng, order = ['p', 'i', 'm', 'a'];
    for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
    this.chordOrder = order;
  }
  style() { return STYLES[this.h.options().style] || STYLES.travis; }
  stepDur() { const o = this.h.options(), S = this.style(); return 60 / Math.max(30, o.bpm || S.tempo || 96) / S.sub; }
  skill() { return clamp(this.h.options().skill ?? 0.6, 0, 1); }
  hum() { return (this.h.options().humanize ?? 0.6) / 0.6; }

  // a new chord: start the pattern now, or keep the running grid and swap the voicing
  chord(v, vel, t) {
    const prev = this.v;
    this.v = v; this.vel = vel; this.roles = this.mapRoles(v);
    if (this.style().gen) {   // a generated line: replan from (about) now over the new harmony
      if (!this.gen) this.gen = new root.YngwieGen(this.h);
      this.gen.chord(v.frets);   // the key follows the progression
      this.lineQ = []; this.tLine = Math.max(t, this.h.now() + 0.01);
      if (!this.running) { this.running = true; this.tick(); }
      return;
    }
    if (!this.running) {
      this.running = true; this.step = 0; this.tGrid = t; this.drift = 0;
      this.tick();
      return;
    }
    // grabbed just after a step went out with the old chord: play that step again, late, like a late left hand
    const sd = this.stepDur(), last = this.tGrid - sd;
    if (prev && t - last < Math.min(0.09, 0.45 * sd) && t >= last - 0.01) this.emitStep((this.step - 1 + this.len()) % this.len(), Math.max(t, last), true);
  }
  // ---- generated lead lines (Yngwie mode) ----
  // Plans a phrase at a time with the line generator (statement -> burst -> long note -> breath), turns its notes
  // into engine events (pick strokes, hammer-ons / pull-offs, damping of the string just left, bends, wide vibrato
  // on long notes) and sends them out ~35 ms ahead. The chord's velocity sets the intensity (see lines.js).
  lineTick() {
    const now = this.h.now(), ahead = 0.035, o = this.h.options(), rng = this.h.rng;
    if (!this.gen) this.gen = new root.YngwieGen(this.h);
    if (!this.lineQ) this.lineQ = [];
    if (this.tLine == null) this.tLine = now;
    const beat = 60 / Math.max(40, o.bpm || 120), skill = this.skill();
    // a tight player: per-note jitter ~3 ms (skilled) to ~6 ms
    const jit = () => gauss(rng) * (0.006 - 0.003 * skill);
    while (!this.lineQ.length || this.lineQ[this.lineQ.length - 1].t < now + 0.3) {
      const ph = this.gen.phrase(this.v.frets, this.vel ?? 0.7);
      let prev = this.lastLine || null;
      for (let i = 0; i < ph.notes.length; i++) {
        const n = ph.notes[i], nx = ph.notes[i + 1];
        const t = this.tLine + n.beat * beat + jit() + (n.lateS || 0) + (n.hop || 0);
        const dur = (nx ? nx.beat - n.beat : ph.beats - n.beat) * beat;   // the phrase's last note rings through the breath
        // accents on the first note of each group (+15-25 %), upstrokes a touch lighter
        const vel = clamp(this.vel * (n.acc ? 1.12 + 0.08 * rng() : 0.92) * (n.dir < 0 ? 0.95 : 1) * this.velNoise(), 0.05, 1);
        if ((n.art === 'h' || n.art === 'p') && prev && prev.s === n.s) {
          this.lineQ.push({ t, ev: { type: n.art === 'h' ? 'hammer' : 'pulloff', s: n.s, from: prev.m, to: n.m, vel: vel * 0.9 } });
        } else {
          this.lineQ.push({ t, ev: { type: 'pluck', s: n.s, midi: n.m, vel, dir: n.dir || 1, style: 'pick', bright: n.dir < 0 ? 1.25 : 1,
            pickPos: (o.pickPos || 0.2) * (0.85 + 0.1 * rng()) } });
        }
        // the string just left is muted as the next note sounds (fretting finger lifts, picking-hand palm)
        if (prev && prev.s !== n.s) this.lineQ.push({ t: t + 0.012, ev: { type: 'damp', s: prev.s, time: 0.03 } });
        if (n.bend) this.lineQ.push({ t, ev: { type: 'sbend', s: n.s, delay: 0.03 + 0.04 * rng(), amount: 2, rise: 0.08 + 0.07 * rng() } });
        if (n.vib && dur > 0.25) {
          // wide one-sided "rock" vibrato, ~5 Hz, starting late and easing in; capped for an acoustic's heavier strings
          const delay = (n.bend ? 0.2 : 0.12) + 0.15 * rng();
          this.lineQ.push({ t, ev: { type: 'vibrato', s: n.s, delay, rate: 4.6 + 1.3 * rng(), depth: 0.6 + 0.2 * rng(),
            dur: Math.max(0.15, dur - delay - 0.03), attack: 0.2 + 0.2 * rng() } });
        }
        prev = n;
      }
      this.lastLine = prev;
      this.tLine += ph.beats * beat;
      this.lineQ.sort((a, b) => a.t - b.t);
    }
    const evs = [];
    while (this.lineQ.length && this.lineQ[0].t < now + ahead) { const q = this.lineQ.shift(); q.ev.t = Math.max(now, q.t); evs.push(q.ev); }
    if (evs.length) this.h.send(evs);
  }

  realign(t) { if (!this.running) return; this.step = 0; this.tGrid = t; this.drift = 0; }
  stop() { this.running = false; clearTimeout(this.timer); this.timer = null; this.melody.clear(); this.lineQ = []; this.tLine = null; this.lastLine = null; }
  len() { return this.style().steps.length; }

  swingRatio() {
    const S = this.style(), bpm = this.h.options().bpm || S.tempo || 96;
    if (!S.swing || S.sub % 2) return 1;
    return 1 + (S.swing - 1) * clamp((220 - bpm) / (220 - 100), 0, 1);
  }
  tick() {
    if (!this.running) return;
    if (this.style().gen) { this.lineTick(); this.timer = setTimeout(() => this.tick(), 12); return; }
    const now = this.h.now(), ahead = 0.035;
    while (this.tGrid < now + ahead) {
      this.emitStep(this.step, this.tGrid, false);
      this.step = (this.step + 1) % this.len();
      const S = this.style(), sd = this.stepDur(), sw = this.swingRatio();
      const k = S.sub % 2 === 0 ? (this.step % 2 === 1 ? 2 * sw / (1 + sw) : 2 / (1 + sw)) : 1;
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
    let A = snd.find(s => s !== B && s <= 3 && (pitch(s) - rootPc + 120) % 12 === 7);
    if (A == null) A = snd.find(s => s > B && s <= 3) ?? snd[1] ?? B;
    const treb = snd.filter(s => s >= 2 && s !== B && s !== A);
    const top = treb.length >= 3 ? treb.slice(-3) : snd.slice(-3);
    const T3 = top[top.length - 1], T2 = top[top.length - 2] ?? T3, T1 = top[top.length - 3] ?? T2;
    const M = snd.find(s => s > B) ?? B;
    return { B, A, M, T1, T2, T3, snd };
  }
  stringSet(name) {
    const r = this.roles, snd = r.snd;
    if (name === 'all') { const out = []; for (let s = snd[0]; s <= snd[snd.length - 1]; s++) out.push(s); return out; }
    const m = /^top(\d)$/.exec(name);
    if (m) { const n = +m[1], hi = snd[snd.length - 1], out = []; for (let s = Math.max(snd[0], hi - n + 1); s <= hi; s++) out.push(s); return out; }
    return [r[name]].filter(s => s != null);
  }
  midiOf(s) { const open = this.h.open(); return this.melody.has(s) ? this.melody.get(s) : (this.v.frets[s] >= 0 ? open[s] + this.v.frets[s] : open[s]); }

  // ---- one grid step ----
  emitStep(k, tGrid, late) {
    const S = this.style(), o = this.h.options(), rng = this.h.rng;
    const src = S.steps[k];
    if (!src || src === '-' || !this.v) return;
    const skill = this.skill(), sd = this.stepDur(), hum = this.hum();
    if (!late) { // slow drift of the whole hand against the beat
      const sdD = lerp(MOTOR.driftSd, skill) * sd * hum;
      this.drift = this.drift * MOTOR.driftRho + gauss(rng) * sdD * Math.sqrt(1 - MOTOR.driftRho * MOTOR.driftRho);
    }
    const onBeat = k % S.sub === 0;
    let t = tGrid + this.drift + (S.push || 0);
    if (!onBeat && S.offEarly) t -= S.offEarly * sd * S.sub;
    const metric = k === 0 ? 1.0 : onBeat ? 0.93 : 0.84;
    const toks = src.trim().split(/\s+/);
    const pluckToks = toks.filter(x => /^[pimac]:/.test(x));
    const evs = [];
    // a plucked chord: fingers land in this player's habitual order over the chord spread
    let chordOff = null;
    if (pluckToks.length > 1) {
      const [mu, sdS] = MOTOR.chordSpread.map(x => x).reduce((a, b) => [a[0] + (b[0] - a[0]) * skill, a[1] + (b[1] - a[1]) * skill]);
      const spread = Math.max(0, mu + gauss(rng) * sdS) / 1000 * hum;
      const fingers = pluckToks.map(x => x[0]);
      const ranked = this.chordOrder.filter(f => fingers.includes(f));
      chordOff = {}; ranked.forEach((f, j) => { chordOff[f] = ranked.length > 1 ? spread * j / (ranked.length - 1) - spread / 2 : 0; });
    }
    for (const tok of toks) this.action(tok, t, metric, chordOff, sd, evs, S, o);
    this.h.send(evs);
  }

  // per-pluck timing and level noise, scaled by skill and the humanize control
  jitter(ioi) {
    const k = lerp(MOTOR.jitterK, this.skill());
    return gauss(this.h.rng) * Math.sqrt(MOTOR.jitterFloor ** 2 + (k * ioi) ** 2) * this.hum();
  }
  velNoise() { return dB(gauss(this.h.rng) * lerp(MOTOR.velSdDb, this.skill()) * this.hum()); }
  rateFactor(finger, t) {  // independence falls as fingers move faster than ~3 Hz (Hager-Ross & Schieber 2000)
    const last = this.lastT[finger]; if (last == null) return 1;
    const hz = 1 / Math.max(0.03, t - last);
    return 1 + Math.max(0, hz - 3) / 3;
  }

  action(tok, t0, metric, chordOff, sd, evs, S, o) {
    const rng = this.h.rng, v = this.v, skill = this.skill(), hum = this.hum();
    const mods = /[>.!_]+$/.exec(tok); const md = mods ? mods[0] : '';
    const core = mods ? tok.slice(0, -md.length) : tok;
    const accent = md.includes('>'), ghost = md.includes('.');
    const acc = accent ? dB(3.5) : ghost ? dB(-6) : 1;
    const rest = md.includes('!') || (S.rest && !ghost);
    const palm = md.includes('_') || o.palm;
    const vel0 = this.vel * metric * acc;
    const [kind, arg] = core.split(':');
    const tA = t0 - (accent ? 0.003 : 0);   // accented notes come a little early

    if (kind === 'G') { evs.push({ type: 'tap', t: tA + 0.002 + Math.abs(this.jitter(0.02)), vel: clamp(vel0 * 0.9, 0.05, 1), nail: true }); return; }

    // flatpick strokes
    if (kind === 'D' || kind === 'U') {
      const dir = kind === 'D' ? 1 : -1, set = this.stringSet(arg);
      if (set.length === 1) {
        const s = set[0]; if (this.melody.has(s)) return;
        if (this.slip(evs, s, tA, dir, 'pick', vel0)) return;
        evs.push({ type: 'pluck', s, midi: this.midiOf(s), t: tA + this.jitter(sd), dir, style: 'pick',
          vel: clamp(vel0 * (dir < 0 ? 0.9 : 1) * this.velNoise(), 0.03, 1), palm, dead: v.frets[s] < 0,
          pickPos: (o.pickPos || 0.2) * (1 + gauss(rng) * 0.04 * hum), bright: dir < 0 ? 1.4 : 1 });
        this.ringing[s] = tA;
        // a single-string pick stroke sometimes clips the next string in its path
        if (rng() < lerp(MOTOR.brush, skill) * (o.brushes ?? 1) * 1.5) this.graze(evs, s + dir, tA + 0.006, 'pick', vel0, dir);
        return;
      }
      this.sweep(evs, dir > 0 ? set : set.slice().reverse(), tA + this.jitter(sd) * 0.6, vel0 * (dir < 0 ? 0.88 : 1), dir, 'pick', false, palm, o);
      return;
    }
    if (kind === 'X') { this.sweep(evs, this.stringSet(arg), tA, vel0 * 0.8, 1, S.pick ? 'pick' : 'finger', S.nail, palm, o, true); return; }
    if (kind === 'K') { this.sweep(evs, this.stringSet(arg), tA + this.jitter(sd), vel0 * 0.8, 1, 'finger', true, palm, o); return; }
    if (kind === 'N') { // clawhammer: the nail strikes down through one string and comes to rest on the next
      for (const s of this.stringSet(arg)) {
        if (this.melody.has(s)) continue;
        const t = tA + this.jitter(sd);
        evs.push({ type: 'pluck', s, midi: this.midiOf(s), t, dir: 1, style: 'finger', nail: true, rest: true,
          vel: clamp(vel0 * dB(1) * this.velNoise(), 0.03, 1), palm, pickPos: 0.22 });
        this.ringing[s] = t;
      }
      return;
    }
    if (kind === 'Pd' || kind === 'Pu') { // alzapúa: thumb through the strings down, thumbnail back up
      const dir = kind === 'Pd' ? 1 : -1, set = this.stringSet(arg);
      this.sweep(evs, dir > 0 ? set : set.slice().reverse(), tA + this.jitter(sd) * 0.6, vel0 * (dir > 0 ? 0.9 : 0.75), dir, 'thumb', true, palm, o, false, 0.02);
      return;
    }
    if (kind === 'R' || kind === 'Ru') {
      // rasgueado: fingers flick out one after another, each nail sweeping the strings; successive sweeps overlap
      // (Laurson et al. 2010: four sweeps across ~290 ms). Gap scales with the beat, tighter for a stronger player.
      const fingers = kind === 'Ru' ? ['i'] : arg.split('');
      const set = this.stringSet('all');
      const beat = sd * S.sub;
      const gap = clamp(0.22 * beat, 0.055, 0.1) * (1.15 - 0.3 * skill);
      fingers.forEach((f, j) => {
        const F = MOTOR.fingers[f] || MOTOR.fingers.i;
        const tf = tA + j * gap * (1 + gauss(rng) * 0.1 * (1.6 - 1.2 * skill)) + F.bias;
        const dir = kind === 'Ru' ? -1 : 1;
        const strength = dB(F.db) * (j === fingers.length - 1 ? dB(1.5) : 1);   // the last flick lands the accent
        const order = dir > 0 ? set : set.slice().reverse().slice(0, Math.max(3, Math.round(set.length * 0.7)));
        this.sweep(evs, order, tf, vel0 * strength * 0.72, dir, 'finger', true, palm, o, false, 0.045, 0.9);
      });
      return;
    }

    // ---- a finger plucking one string ----
    const finger = kind, F = MOTOR.fingers[finger];
    if (!F) return;
    const s = this.roles[arg];
    if (s == null || this.melody.has(s)) return;
    const thumb = finger === 'p';
    // inside a plucked chord the measured first-to-last spread already carries the timing scatter
    let t = tA + F.bias + this.jitter(sd) * (chordOff ? 0.3 : 1) + (chordOff ? chordOff[finger] ?? 0 : 0);
    // tremolo: the thumb arrives late after the a-m-i run (the "gallop"), less so for a strong player
    if (S.preP && thumb) t += (0.12 - 0.09 * skill) * sd;
    // a finger asked to repeat faster than it can arrives late and softer
    const minGap = F.minGap * (1.3 - 0.3 * skill), last = this.lastT[finger];
    let tired = 1;
    if (last != null && t - last < minGap) { t = last + minGap * (0.95 + 0.1 * rng()); tired = dB(-1.5); }
    const rate = this.rateFactor(finger, t);
    this.lastT[finger] = t;
    let level = dB(thumb ? (S.thumbDb ?? F.db) : F.db + (finger === 'a' ? -1.5 * (1 - skill) : 0));
    if (rest) level *= dB(2.5);
    const vel = clamp(vel0 * level * tired * this.velNoise(), 0.03, 1);
    if (this.slip(evs, s, t, thumb ? 1 : -1, F.style, vel)) return;
    // sequential planting: the finger settles on its string a moment before plucking it, cutting what rang there
    if (S.plant && !thumb && t - this.ringing[s] > 0.05) evs.push({ type: 'touch', s, amt: 50, dur: 0.6 * sd, t: t - 0.6 * sd - 0.004, nail: S.nail });
    evs.push({ type: 'pluck', s, midi: this.midiOf(s), t, dir: thumb ? 1 : -1, style: F.style, nail: S.nail, rest, palm: palm && thumb,
      vel, dead: v.frets[s] < 0, pickPos: (o.pickPos || 0.2) * (thumb ? 1.12 : 0.95) * (1 + gauss(rng) * 0.05 * hum) });
    this.ringing[s] = t;
    // where the finger goes next: fingers follow through toward the bass strings (toward the palm), the thumb
    // toward the treble strings
    const nb = thumb ? s + 1 : s - 1;
    if (rest) { // the stroke ends on the neighbour and stays there until the finger moves on
      if (nb >= 0 && nb <= 5 && !this.melody.has(nb)) evs.push({ type: 'touch', s: nb, amt: 45, dur: 0.06 + 0.1 * rng(), t: t + 0.02 + 0.02 * rng() });
    } else {
      const pB = lerp(MOTOR.brush, skill) * (S.brush ?? 1) * (o.brushes ?? 1) * rate * (0.6 + 0.6 * this.vel);
      if (rng() < pB) this.graze(evs, nb, t + 0.004 + 0.006 * rng(), F.style, vel, thumb ? 1 : -1);
    }
    // the ring finger, poorly individuated, is dragged along by the middle finger
    if (finger === 'm' && rng() < lerp(MOTOR.drag, skill) * (o.brushes ?? 1) * rate * (S.brush ?? 1)) this.graze(evs, s + 1, t + 0.008, 'finger', vel, -1);
    // in alternating-bass styles the thumb settles on the next string after a bass note, muting it
    if (thumb && S.thumbRest && nb <= 3 && rng() < S.thumbRest && !this.melody.has(nb)) evs.push({ type: 'touch', s: nb, amt: 35, dur: 0.05 + 0.15 * rng(), t: t + 0.03 });
  }

  // a pluck that goes wrong (rare for a strong player): missed, the neighbouring string instead, or late and soft
  slip(evs, s, t, dir, style, vel) {
    const rng = this.h.rng, o = this.h.options();
    if (rng() >= lerp(MOTOR.slip, this.skill()) * (o.brushes ?? 1) * this.hum()) return false;
    const r = rng(), v = this.v, open = this.h.open();
    if (r < 0.33) return true;                       // missed entirely
    if (r < 0.66) {                                  // caught the neighbour instead
      const n = clamp(s + (rng() < 0.5 ? -1 : 1), 0, 5);
      evs.push({ type: 'pluck', s: n, midi: v.frets[n] >= 0 ? open[n] + v.frets[n] : open[n], t: t + 0.01, dir, style, dead: v.frets[n] < 0, vel: clamp(vel * 0.6, 0.03, 1), pickPos: 0.2 });
      return true;
    }
    evs.push({ type: 'pluck', s, midi: this.midiOf(s), t: t + 0.01 + 0.02 * rng(), dir, style, vel: clamp(vel * dB(-4.5), 0.03, 1), pickPos: 0.2 });
    return true;                                     // late and soft
  }

  // an unintended contact with string s: a ringing string gets briefly damped; a quiet one gets a faint pluck
  // (-20 to -30 dB); a string the fretting hand is muting gives a dead tick
  graze(evs, s, t, style, vel, dir) {
    if (s < 0 || s > 5 || this.melody.has(s)) return;
    const v = this.v, open = this.h.open(), rng = this.h.rng;
    const ringingNow = t - this.ringing[s] < 1.2;
    if (v.frets[s] < 0) { evs.push({ type: 'pluck', s, midi: open[s], t, dir, style, dead: true, vel: clamp(vel * 0.25, 0.02, 0.3), pickPos: 0.2 }); return; }
    if (ringingNow && rng() < 0.6) { evs.push({ type: 'touch', s, amt: 22, dur: 0.02 + 0.03 * rng(), t }); return; }
    evs.push({ type: 'pluck', s, midi: open[s] + v.frets[s], t, dir, style, vel: clamp(vel * (0.08 + 0.07 * rng()), 0.02, 0.2), pickPos: 0.2 });
    this.ringing[s] = t;
  }

  // a stroke across several strings (pick, nails, thumb); `dead` = palm muting them as it strikes; `keep`: how much
  // of a ringing string survives the sweep
  sweep(evs, order, t0, vel, dir, style, nail, palm, o, dead = false, total, keep) {
    const rng = this.h.rng, v = this.v, open = this.h.open(), n = order.length, hum = this.hum();
    const T = (total ?? (o.speed ?? 0.045) * (1.4 - 0.7 * this.vel)) * Math.max(1, n - 1) / 5 * (dir < 0 ? 0.8 : 1);
    order.forEach((s, i) => {
      if (this.melody.has(s)) return;
      const frac = n > 1 ? i / (n - 1) : 0, md = v.frets[s] < 0 || dead;
      const t = t0 + T * Math.pow(frac, 0.85) + gauss(rng) * 0.001 * hum;
      evs.push({ type: 'pluck', s, midi: md ? open[s] : this.midiOf(s), t, dir, style, nail, dead: md, palm, keep,
        bright: dir < 0 ? 1.5 : 1, vel: clamp(vel * (1 - 0.18 * frac) * this.velNoise() * (md ? 0.7 : 1), 0.03, 1),
        pickPos: (o.pickPos || 0.2) * (1 + gauss(rng) * 0.04 * hum) });
      this.ringing[s] = t;
    });
  }

  // ---- melody over the pattern ----
  // A note played while the pattern runs is a melody note: it takes a string near the hand (preferring the treble
  // strings), the pattern leaves that string alone while the note is held, and the finger follows the classical
  // crossing rules (alternate; to a higher string i->m->a, to a lower one a->m->i; Niedt) with a rest stroke when the
  // next lower string isn't needed by the pattern.
  playMelody(midi, vel, t) {
    if (!this.v) return null;
    const open = this.h.open(), S = this.style(), rng = this.h.rng;
    let best = -1, bc = Infinity;
    const fr = this.v.frets.filter(f => f > 0), pos = fr.length ? Math.min(...fr) : 0;
    for (let s = 2; s < 6; s++) {
      const f = midi - open[s];
      if (f < 0 || f > 15) continue;
      let c = (5 - s) * 0.6 + Math.abs(f - (pos + 1)) * 0.5 + (f === 0 ? -0.3 : 0);
      if (s === this.roles.B || s === this.roles.A) c += 4;
      if (c < bc) { bc = c; best = s; }
    }
    if (best < 0) return null;
    const s = best, last = this.lastMel;
    let finger;
    if (!last) finger = s >= 5 ? 'a' : 'm';
    else if (s > last.s) finger = last.finger === 'i' ? 'm' : 'a';
    else if (s < last.s) finger = last.finger === 'a' ? 'm' : 'i';
    else finger = last.finger === 'i' ? 'm' : 'i';
    this.lastMel = { s, finger };
    this.melody.set(s, midi);
    const nb = s - 1, needed = nb === this.roles.T1 || nb === this.roles.T2 || nb === this.roles.T3;
    const rest = !S.pick && s >= 3 && !needed && rng() < 0.7;
    const F = MOTOR.fingers[finger];
    const tt = t + F.bias + this.jitter(this.stepDur());
    const evs = [];
    if (S.pick) evs.push({ type: 'pluck', s, midi, t: tt, dir: 1, style: 'pick', vel: clamp(vel * this.velNoise(), 0.03, 1), pickPos: 0.2 });
    else {
      evs.push({ type: 'pluck', s, midi, t: tt, dir: -1, style: 'finger', nail: S.nail, rest, vel: clamp(vel * dB(1.5) * (rest ? dB(2.5) : 1) * this.velNoise(), 0.03, 1), pickPos: 0.19 });
      if (rest && nb >= 0) evs.push({ type: 'touch', s: nb, amt: 45, dur: 0.08 + 0.08 * rng(), t: tt + 0.025 });
    }
    this.lastT[finger] = tt; this.ringing[s] = tt;
    this.h.send(evs);
    return s;
  }
  releaseMelody(s) { this.melody.delete(s); }
}

root.RightHand = RightHand;
root.HAND_STYLES = STYLES;
root.HAND_MOTOR = MOTOR;
})(typeof globalThis !== 'undefined' ? globalThis : this);
