// Acoustic as a MEGAjam instrument (https://github.com/samuelling/JamJam).
//
// MEGAjam plays every jammer's instruments in every jammer's browser, so this guitar must make the same sound
// everywhere from the same timestamped notes. Two parts of Acoustic were written for one player in real time,
// and this adapter runs them in lockstep without changing them:
//  - The strumming hand (src/strum.js, hand.js, lines.js) gathers chords with timers, reads the clock, and
//    humanizes with random numbers. Here it runs on a virtual clock in room time (identical in every browser),
//    its timers are virtual, and its random numbers are reseeded from that time before every step.
//  - The guitar engine (src/modal.js) jitters each pluck a little with a running random generator. Here every
//    event carries a seed taken from its room time, so a bandmate who walked in late still hears the same pluck.
// The room (src/space.js) is an impulse response built from a seeded image-source model, so it is the same too.
// The hand adds Acoustic's own chord-gathering delay (about 25 ms) after the moment the band hears the notes.

const FILES = ['src/space.js', 'src/modal.js', 'src/lines.js', 'src/hand.js', 'src/strum.js'];
const PRESET_IDS = ['dreadnought', 'parlor', 'classical'];
const MODES = ['pick', 'finger', 'pattern'];
const ROOMS = ['booth', 'living', 'bedroom', 'bathroom', 'studio', 'recital', 'hall', 'church', 'outdoors'];
const MICS = ['fret12', 'hole15', 'bout', 'spaced', 'xy40', 'room2m', 'ears', 'behind'];
const BUILD = { top: 'sitka', back: 'indian', bracing: 'standard', finish: 'nitro', hold: 'seated', style: 'luthier' };
const LEAD = 0.015;     // the hand thinks this far ahead of the audio clock (s)

const hash32 = (x) => { let h = (x | 0) ^ 0x9e3779b9; h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0; };
const rngFrom = (seed) => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };
const seedOf = (tRoom, salt = 0) => hash32(Math.round(tRoom * 96000) + salt * 7919);

export default async function (arg, { base }) {
  const src = {};
  await Promise.all(FILES.map(async (f) => {
    const r = await fetch(new URL(f, base).href, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`Acoustic: couldn't load ${f} (${r.status})`);
    src[f] = await r.text();
  }));
  const tag = (hash32(src['src/modal.js'].length * 31 + src['src/strum.js'].length) >>> 0).toString(36);
  const PROC = `megajam-acoustic-${tag}`;
  const DSP = src['src/space.js'] + '\n' + src['src/modal.js'];
  // the hand, compiled once; each guitar gets its own copy with its own virtual timers
  const handFactory = new Function('globalThis', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    src['src/lines.js'] + '\n' + src['src/hand.js'] + '\n' + src['src/strum.js'] + '\nreturn globalThis;');
  const probe = handFactory({}, () => 0, () => {}, () => 0, () => {});
  const STYLE_IDS = Object.keys(probe.HAND_STYLES || {});
  const styleNames = STYLE_IDS.map((k) => probe.HAND_STYLES[k].name.replace(/ \(.*\)$/, ''));

  const space = {};
  new Function('globalThis', DSP.replace(/if \(typeof registerProcessor[\s\S]*$/, '') + '\n})(globalThis);')(space);   // room presets for the labels
  const PARAMS = [
    { id: 'body', name: 'Guitar', options: PRESET_IDS.map((k) => space.GUITAR_PRESETS?.[k]?.name || k), min: 0, max: 2, def: 0, step: 1, group: 'GUITAR' },
    { id: 'mode', name: 'Hand', options: ['Pick', 'Fingers', 'Pattern'], min: 0, max: 2, def: 0, step: 1, group: 'HAND' },
    { id: 'style', name: 'Pattern', options: styleNames, min: 0, max: Math.max(0, STYLE_IDS.length - 1), def: Math.max(0, STYLE_IDS.indexOf('travis')), step: 1, group: 'HAND' },
    { id: 'bpm', name: 'Pattern tempo', min: 40, max: 220, def: 96, step: 1, unit: 'bpm', group: 'HAND' },
    { id: 'voicing', name: 'Voicing', options: ['As played', 'Guitar shape'], min: 0, max: 1, def: 1, step: 1, group: 'HAND' },
    { id: 'speed', name: 'Strum speed', min: 0.02, max: 0.1, def: 0.055, unit: 's', group: 'HAND' },
    { id: 'humanize', name: 'Humanize', min: 0, max: 1, def: 0.6, group: 'HAND' },
    { id: 'palm', name: 'Palm mute', min: 0, max: 1, def: 0, step: 1, group: 'HAND' },
    { id: 'pickPos', name: 'Pick position', min: 0.05, max: 0.45, def: 0.2, group: 'HAND' },
    { id: 'capo', name: 'Capo', min: 0, max: 9, def: 0, step: 1, unit: 'fret', group: 'GUITAR' },
    { id: 'bright', name: 'Strings', min: 0, max: 1, def: 0.55, group: 'GUITAR', cc: 74 },
    { id: 'room', name: 'Room', options: ROOMS.map((k) => space.AcousticSpace?.ROOMS[k]?.name || k), min: 0, max: ROOMS.length - 1, def: 1, step: 1, group: 'SPACE' },
    { id: 'mic', name: 'Mics', options: MICS.map((k) => space.AcousticSpace?.MIC_SETUPS[k]?.name || k), min: 0, max: MICS.length - 1, def: 0, step: 1, group: 'SPACE' },
    { id: 'reverb', name: 'Room level', min: 0, max: 1.5, def: 0.6, group: 'SPACE', cc: 91 },
    { id: 'level', name: 'Level', min: 0, max: 1, def: 0.8, group: 'SPACE', cc: 7 },
  ];
  const sty = (k) => Math.max(0, STYLE_IDS.indexOf(k));
  const PRESETS = {
    strum: { body: 0, mode: 0, voicing: 1, speed: 0.055, room: 1, mic: 0 },
    fingerstyle: { body: 1, mode: 1, voicing: 1, room: 1, mic: 0 },
    nylon: { body: 2, mode: 1, voicing: 1, room: 5, mic: 0 },
    travis: { body: 0, mode: 2, style: sty('travis'), bpm: 110, voicing: 1, room: 1 },
    bossa: { body: 2, mode: 2, style: sty('bossa'), bpm: 136, voicing: 1, room: 4 },
    flamenco: { body: 2, mode: 2, style: sty('rumba'), bpm: 110, voicing: 1, room: 5 },
    bluegrass: { body: 0, mode: 2, style: sty('boomchuck'), bpm: 120, voicing: 1, room: 4 },
  };

  let irWorker = null; const irWaiters = new Map(); let irSeq = 0;
  const buildIR = (scene, sr) => new Promise((resolve) => {
    if (!irWorker) {
      irWorker = new Worker(URL.createObjectURL(new Blob([DSP.replace(/if \(typeof registerProcessor[\s\S]*$/, '') + `\n})(globalThis);
        self.onmessage = (e) => { const { id, scene, sr } = e.data; const ir = AcousticSpace.buildIRs(scene, sr);
          const bufs = [ir.front[0], ir.front[1], ir.back[0], ir.back[1]]; self.postMessage({ id, bufs }, bufs.map((b) => b.buffer)); };`], { type: 'text/javascript' })));
      irWorker.onmessage = (e) => { const w = irWaiters.get(e.data.id); irWaiters.delete(e.data.id); if (w) w(e.data.bufs); };
    }
    const id = ++irSeq; irWaiters.set(id, resolve); irWorker.postMessage({ id, scene, sr });
  });

  return {
    name: 'Acoustic',
    family: 'Physically modelled acoustic guitar',
    blurb: 'Six modelled strings on a wooden body, a strumming hand that voices your chords as a guitarist would, and a real room around it. Play chords and it strums them; pick a pattern and the right hand plays Travis, bossa, flamenco or bluegrass.',
    accent: '#d8a83a',
    traits: { arch: ['pluck', 'guitar'], voices: 6 },
    contentHash: tag,
    params: PARAMS,
    presets: PRESETS,
    async init(ctx) {
      ctx.__jjWorklets = ctx.__jjWorklets || new Set();
      if (ctx.__jjWorklets.has(PROC)) return;
      const code = DSP + `
;(() => {
  const hash32 = ${hash32.toString()}, rngFrom = ${rngFrom.toString()};
  class P extends AudioWorkletProcessor {
    constructor() {
      super(); this.eng = new globalThis.GuitarEngine(sampleRate); this.dead = false;
      const handle = this.eng.handle.bind(this.eng);
      this.eng.handle = (ev) => { if (ev.seed != null) this.eng.rng = rngFrom(ev.seed); handle(ev); };
      this.port.onmessage = (m) => { if (m.data === 'dispose') { this.dead = true; return; } for (const ev of m.data) this.eng.post(ev); };
    }
    process(_, outputs) {
      const o = outputs[0]; if (this.eng.clock === 0) this.eng.clock = Math.round(currentTime * sampleRate);
      this.eng.render(o[0], o[1] || o[0], o[0].length, 0, o[2] || null, o[3] || null);
      return !this.dead;
    }
  }
  registerProcessor('${PROC}', P);
})();`;
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      ctx.__jjWorklets.add(PROC);
    },
    create(ctx, out, init = {}, env = null) {
      const p = {}; for (const d of PARAMS) p[d.id] = init[d.id] ?? d.def;
      // room time (s) <-> audio time (s). Without MEGAjam's env, room time is audio time.
      const toCtx = (tr) => (env ? env.audioTime(tr * 1000) : tr);
      const roomNow = () => (env ? env.roomTime(ctx.currentTime) / 1000 : ctx.currentTime);

      const node = new AudioWorkletNode(ctx, PROC, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [4] });
      const split = ctx.createChannelSplitter(4), dry = ctx.createChannelMerger(2), wet = ctx.createGain(), level = ctx.createGain();
      const convF = ctx.createConvolver(), convB = ctx.createConvolver(); convF.normalize = false; convB.normalize = false;
      node.connect(split); split.connect(dry, 0, 0); split.connect(dry, 1, 1); split.connect(convF, 2); split.connect(convB, 3);
      convF.connect(wet); convB.connect(wet); dry.connect(level); wet.connect(level); level.connect(out);
      level.gain.value = p.level; wet.gain.value = 2 * p.reverb;

      // --- the virtual clock: everything the hand does happens in room time, in order
      let vt = 0, shift = 0, order = 0, dead = false;
      const log = [];        // what the hand decided, in room time: the same list in every browser (tests read it)
      const q = [];          // {at, ord, fn}
      const push = (at, fn) => { const it = { at, ord: ++order, fn }; let i = q.length; while (i > 0 && (q[i - 1].at > at || (q[i - 1].at === at && q[i - 1].ord > it.ord))) i--; q.splice(i, 0, it); return it.ord; };
      const vSetTimeout = (fn, ms) => push(vt + Math.max(0, +ms || 0) / 1000, fn);
      const vClear = (id) => { const i = q.findIndex((x) => x.ord === id); if (i >= 0) q.splice(i, 1); };
      let rng = rngFrom(1);
      const run = (until) => {
        while (q.length && q[0].at <= until) { const it = q.shift(); vt = Math.max(vt, it.at); rng = rngFrom(seedOf(vt, it.ord & 0)); try { it.fn(); } catch (e) { console.warn('Acoustic hand:', e); } }
      };
      // the guitar engine gets everything in audio time, each event seeded from its room time
      const post = (evs) => {
        const outEvs = [];
        for (const e of evs) {
          const tr = e.t == null ? vt : e.t, seed = seedOf(tr, (e.s ?? 7) + 1);
          outEvs.push({ ...e, t: toCtx(tr) - shift, seed });
          if (e.type !== 'params') { log.push(`${e.type} s${e.s ?? ''} ${e.midi ?? ''} @${tr.toFixed(5)} #${seed}`); if (log.length > 600) log.splice(0, 200); }
        }
        if (outEvs.length && !dead) node.port.postMessage(outEvs);
      };
      const G = handFactory({}, vSetTimeout, vClear, vSetTimeout, vClear);
      const hand = new G.StrumEngine({ send: post, now: () => vt, rng: () => rng() });
      const ENGINE = { body: () => ({ preset: PRESET_IDS[p.body] || 'dreadnought' }), capo: () => ({ capo: p.capo }), bright: () => ({ brightness: p.bright }), mic: () => ({ scene: { mics: sceneOf().mics } }) };
      // quality is fixed at full for everyone: the "eco" detail level would make this guitar sound different in a slower bandmate's browser
      const engineParams = (t, id) => post([{ type: 'params', t, params: id ? ENGINE[id]() : { ...ENGINE.body(), ...ENGINE.capo(), ...ENGINE.bright(), ...ENGINE.mic(), quality: 'high', build: { ...BUILD } } }]);
      const handOpts = () => ({ mode: MODES[p.mode] || 'pick', style: STYLE_IDS[p.style] || 'travis', bpm: p.bpm, voicing: p.voicing ? 'guitarize' : 'played', speed: p.speed, humanize: p.humanize, palm: !!p.palm, pickPos: p.pickPos, capo: p.capo });
      function sceneOf() {
        const S = space.AcousticSpace, room = S.ROOMS[ROOMS[p.room]] || S.ROOMS.living, [Lx, Ly] = room.dims;
        const mx = Math.min(1.2, Lx * 0.2), my = Math.min(1.2, Ly * 0.2);
        return { room: ROOMS[p.room] || 'living', mics: S.scaledSetup(MICS[p.mic] || 'fret12', 1, 'default'), hold: BUILD.hold, guitar: { pos: [Math.max(mx, Math.min(Lx - mx, Lx * 0.42)), Math.max(my, Math.min(Ly - my, Ly * 0.62)), 0.95], yaw: 0 } };
      }
      let irKey = '', irJob = 0;
      const rebuildRoom = async () => {
        const key = `${p.room}/${p.mic}/${p.body}`; if (key === irKey) return; irKey = key;
        const job = ++irJob, bufs = await buildIR(sceneOf(), ctx.sampleRate);
        if (job !== irJob || dead) return;
        const mk = (a, b) => { const B = ctx.createBuffer(2, a.length, ctx.sampleRate); B.getChannelData(0).set(a); B.getChannelData(1).set(b); return B; };
        convF.buffer = mk(bufs[0], bufs[1]); convB.buffer = mk(bufs[2], bufs[3]);
      };
      hand.set(handOpts()); engineParams(null); rebuildRoom();
      const tick = setInterval(() => run(roomNow() + LEAD + shift), 5);

      // a MEGAjam event at audio time t with room stamp at (ms). Self-monitored notes (t now, at in the future)
      // are decided at their room time like everyone else's, then played early by the difference.
      const input = (t, at, fn) => {
        const tr = at != null ? at / 1000 : t;
        const early = toCtx(tr) - t;
        shift = early > 0.004 ? early : 0;
        push(tr, fn); if (shift) run(roomNow() + LEAD + shift);
      };
      return {
        noteOn: (note, vel, t, at) => input(t, at, () => hand.noteOn(note, Math.max(0.02, Math.min(1, vel / 127)), vt)),
        noteOff: (note, t, at) => input(t, at, () => hand.noteOff(note)),
        set: (id, v, t, at) => {
          if (id === 'bend') return;
          p[id] = v;
          if (id === 'level') { level.gain.setTargetAtTime(v, t, 0.02); return; }
          if (id === 'reverb') { wet.gain.setTargetAtTime(2 * v, t, 0.02); return; }
          input(t, at, () => {
            if (ENGINE[id]) engineParams(vt, id);
            if (['room', 'mic', 'body'].includes(id)) rebuildRoom();
            hand.set(handOpts());
            if (id === 'mode' && v !== 2 && hand.hand) hand.hand.stop();
          });
        },
        allOff: (t) => input(t, null, () => hand.allOff()),
        _log: log,
        dispose: () => { dead = true; clearInterval(tick); q.length = 0; node.port.postMessage('dispose'); level.disconnect(); },
      };
    },
  };
}
