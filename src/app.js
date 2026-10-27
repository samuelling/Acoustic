// Acoustic — UI, audio graph, MIDI, keyboard, recording.
(function () {
'use strict';
const $ = (id) => document.getElementById(id);
const STRING_NAMES = ['E', 'A', 'D', 'G', 'B', 'e'];

let ctx = null, node = null, fallback = null, master = null, wetGain = null, dryGain = null, convF = null, convB = null, recNode = null;
let meters = [0, 0, 0, 0, 0, 0].map(() => ({ e: 0, fret: 0, damp: 0, active: false }));
let started = false;
let tuning = [40, 45, 50, 55, 59, 64], capo = 0;
let shape = [-1, 3, 2, 0, 1, 0];
let octave = 48; // keyboard starts at C3

const store = {
  get(k, d) { try { const v = localStorage.getItem('acoustic.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('acoustic.' + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }
};

// ---------- audio ----------
function engineTime() { return ctx ? ctx.currentTime : 0; }
function send(evs) {
  if (!evs || !evs.length) return;
  if (node) node.port.postMessage(evs);
  else if (fallback) for (const e of evs) fallback.post(e);
  for (const e of evs) if (e.type === 'pluck') pulse(e);
}
function setEngine(params) { send([{ type: 'params', params, t: engineTime() }]); }

const strum = new StrumEngine({ send, now: engineTime, onVoicing: (f) => { shape = f.slice(); $('shapeText').textContent = shapeLabel(shape); if (typeof markNeck === 'function') markNeck(); } });

// Rough device benchmark: render a worst-case second (two overlapping full strums) on the main thread.
let quality = 'high';
function benchmark() {
  try {
    const E = new GuitarEngine(48000), open = [40, 45, 50, 55, 59, 64];
    for (let s = 0; s < 6; s++) E.post({ t: 0.001 + s * 0.008, type: 'pluck', s, midi: open[s] + [3, 2, 0, 0, 0, 3][s], vel: 1, style: 'pick', dir: 1 });
    const L = new Float32Array(128), R = new Float32Array(128);
    for (let i = 0; i < 20; i++) E.render(L, R, 128, 0);
    const t0 = performance.now(); for (let i = 0; i < 94; i++) E.render(L, R, 128, 0);
    const load = (performance.now() - t0) / 250; // fraction of real time for 0.25 s of audio
    return load;
  } catch (e) { return 0; }
}
async function start() {
  if (started) return;
  started = true;
  const load = benchmark();
  quality = load > 0.3 ? 'eco' : 'high';
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive', sampleRate: 48000 });
  master = ctx.createGain(); master.gain.value = 0.7;
  dryGain = ctx.createGain(); wetGain = ctx.createGain();
  // the room: one convolver per source side (top / back), impulse responses from the image-source model
  convF = ctx.createConvolver(); convB = ctx.createConvolver(); convF.normalize = false; convB.normalize = false;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6; limiter.knee.value = 4; limiter.ratio.value = 14; limiter.attack.value = 0.001; limiter.release.value = 0.12;
  let src;
  try {
    const code = document.getElementById('dsp-src').textContent;
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    node = new AudioWorkletNode(ctx, 'acoustic-guitar', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [4] });
    node.port.onmessage = (m) => { if (m.data.meters) meters = m.data.meters; };
    src = node;
  } catch (err) {
    // AudioWorklet unavailable: run the same engine on the main thread
    console.warn('AudioWorklet unavailable, using ScriptProcessor', err);
    fallback = new GuitarEngine(ctx.sampleRate);
    fallback.clock = Math.round(ctx.currentTime * ctx.sampleRate);
    const sp = ctx.createScriptProcessor(512, 0, 4);
    sp.onaudioprocess = (e) => {
      const ob = e.outputBuffer, L = ob.getChannelData(0), R = ob.getChannelData(1);
      fallback.render(L, R, L.length, 0, ob.numberOfChannels > 2 ? ob.getChannelData(2) : null, ob.numberOfChannels > 3 ? ob.getChannelData(3) : null);
      meters = fallback.meters();
    };
    src = sp;
  }
  // channels: 0/1 direct sound at the mics, 2 top-side feed, 3 back-side feed
  const split = ctx.createChannelSplitter(4), merge = ctx.createChannelMerger(2);
  src.connect(split);
  split.connect(merge, 0, 0); split.connect(merge, 1, 1);
  merge.connect(dryGain);
  splitNode = split; wireRoom();
  convF.connect(wetGain); convB.connect(wetGain);
  dryGain.connect(master); wetGain.connect(master); master.connect(limiter); limiter.connect(ctx.destination);
  try { await setupRecorder(limiter); } catch (e) { $('recBtn').disabled = true; }
  if (ctx.state !== 'running') await ctx.resume();
  applyAll();
  $('startOverlay').hidden = true;
  initMidi();
  strum.setShape(shape);
}

// ---------- the space: wood, holding, mics, room ----------
const SP = () => window.AcousticSpace;
const scene = {
  room: store.get('sp.room', 'living'), mics: store.get('sp.mics', 'fret12'), pattern: store.get('sp.pattern', 'default'),
  dist: store.get('sp.dist', 1), gx: store.get('sp.gx', 0.42), gy: store.get('sp.gy', 0.62), yaw: store.get('sp.yaw', 0),
  trim: store.get('sp.trim', 0)
};
const build = {
  top: store.get('b.top', 'sitka'), back: store.get('b.back', 'indian'), bracing: store.get('b.bracing', 'standard'),
  finish: store.get('b.finish', 'nitro'), hold: store.get('b.hold', 'seated'), style: store.get('b.style', 'luthier')
};
function sceneObject() {
  const S = SP(), room = S.ROOMS[scene.room];
  const h = build.hold === 'stand' ? 0.75 : build.hold === 'firm' ? 1.05 : 0.95;
  const [Lx, Ly] = room.dims;
  const mx = Math.min(1.2, Lx * 0.2), my = Math.min(1.2, Ly * 0.2);
  const pos = [Math.max(mx, Math.min(Lx - mx, Lx * scene.gx)), Math.max(my, Math.min(Ly - my, Ly * scene.gy)), h];
  return { room: scene.room, mics: S.scaledSetup(scene.mics, scene.dist, scene.pattern), hold: build.hold, guitar: { pos, yaw: scene.yaw } };
}
let irWorker = null, irBusy = false, irPending = false, irSeq = 0;
function ensureWorker() {
  if (irWorker) return irWorker;
  try {
    const code = document.getElementById('dsp-src').textContent + `
      self.onmessage = (e) => { const { id, scene, sr } = e.data; const ir = AcousticSpace.buildIRs(scene, sr);
        const bufs = [ir.front[0], ir.front[1], ir.back[0], ir.back[1]];
        self.postMessage({ id, bufs, rt: ir.rt, V: ir.V }, bufs.map(b => b.buffer)); };`;
    irWorker = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
    irWorker.onmessage = (e) => { irBusy = false; applyIR(e.data); if (irPending) { irPending = false; rebuildRoom(); } };
    irWorker.onerror = () => { irWorker = null; };
  } catch (e) { irWorker = null; }
  return irWorker;
}
// CPU mode. Light (default): reverb tails capped at 2.5 s, one reverb for both sides of the guitar (the back-side
// feed joins the top-side one), a 6-ridge finger contact. Full: tails to 6 s, separate top/back reverbs, ~15 ridges.
let cpuMode = store.get('o.cpu', 'light'), splitNode = null;
function wireRoom() {
  if (!splitNode) return;
  try { splitNode.disconnect(convF); } catch (e) {} try { splitNode.disconnect(convB); } catch (e) {}
  splitNode.connect(convF, 2);
  if (cpuMode === 'full') splitNode.connect(convB, 3); else splitNode.connect(convF, 3);
}
function setCpu(m) {
  cpuMode = m; store.set('o.cpu', m); $('cpuMode').value = m;
  setEngine({ cpu: m }); wireRoom(); rebuildRoom();
}
function applyIR(d) {
  if (!ctx) return;
  const mk = (a, b) => { const buf = ctx.createBuffer(2, a.length, ctx.sampleRate); buf.copyToChannel(a, 0); buf.copyToChannel(b, 1); return buf; };
  convF.buffer = mk(d.bufs[0], d.bufs[1]);
  convB.buffer = cpuMode === 'full' ? mk(d.bufs[2], d.bufs[3]) : null;   // Light: the back-side reverb isn't used
  roomStats = { rt: d.rt, V: d.V };
  drawRoomMap();
}
let roomStats = null;
let roomTimer = 0;
function rebuildRoom() {
  clearTimeout(roomTimer);
  roomTimer = setTimeout(() => {
    if (!ctx) return;
    const w = ensureWorker(), sc = Object.assign(sceneObject(), cpuMode === 'full' ? {} : { maxDur: 2.5 });
    if (w) { if (irBusy) { irPending = true; return; } irBusy = true; w.postMessage({ id: ++irSeq, scene: sc, sr: ctx.sampleRate }); }
    else { const ir = SP().buildIRs(sc, ctx.sampleRate); applyIR({ bufs: [ir.front[0], ir.front[1], ir.back[0], ir.back[1]], rt: ir.rt, V: ir.V }); }
  }, 120);
}
function applyScene() {
  const sc = sceneObject();
  setEngine({ scene: { mics: sc.mics }, build: Object.assign({}, build) });
  if (wetGain) wetGain.gain.value = Math.pow(10, scene.trim / 20) * 2.0; // 2.0: same reference gain as the direct path
  rebuildRoom();
  drawRoomMap();
}

// ---------- recording (tap after the limiter) ----------
let recording = false, recChunks = [[], []], recLen = 0;
async function setupRecorder(after) {
  const code = `class RecTap extends AudioWorkletProcessor {
    constructor(){ super(); this.on = false; this.port.onmessage = (m) => { this.on = m.data; }; }
    process(inputs, outputs){ const i = inputs[0]; const o = outputs[0];
      if (i.length) { for (let c = 0; c < o.length; c++) o[c].set(i[Math.min(c, i.length - 1)]);
        if (this.on) this.port.postMessage([i[0].slice(0), (i[1] || i[0]).slice(0)]); }
      return true; } }
    registerProcessor('rec-tap', RecTap);`;
  if (!ctx.audioWorklet) throw new Error('no worklet');
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
  recNode = new AudioWorkletNode(ctx, 'rec-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  recNode.port.onmessage = (m) => { if (!recording) return; recChunks[0].push(m.data[0]); recChunks[1].push(m.data[1]); recLen += m.data[0].length; };
  after.connect(recNode);
  const sink = ctx.createGain(); sink.gain.value = 0; recNode.connect(sink); sink.connect(ctx.destination);
}
function toggleRecord() {
  if (!started || !recNode) return;
  recording = !recording;
  $('recBtn').setAttribute('aria-pressed', recording);
  $('recBtn').textContent = recording ? '■ Stop' : '● Record';
  recNode.port.postMessage(recording);
  if (recording) { recChunks = [[], []]; recLen = 0; $('recOut').innerHTML = '<span class="note">Recording…</span>'; return; }
  const wav = encodeWav(recChunks, recLen, ctx.sampleRate);
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  const secs = (recLen / ctx.sampleRate).toFixed(1);
  const name = 'acoustic-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.wav';
  $('recOut').innerHTML = '';
  const audio = document.createElement('audio'); audio.controls = true; audio.src = url;
  const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = `Save WAV (${secs} s)`;
  const n = document.createElement('span'); n.className = 'note';
  b.addEventListener('click', () => saveRecording(wav, name, url, n));
  $('recOut').append(audio, b, n);
}
// Inside Claude's artifact viewer files go through the downloads capability, which takes .zip but not .wav,
// so the lossless WAV travels inside a ZIP there. Anywhere else it is a plain WAV download.
async function saveRecording(wav, name, url, note) {
  const dl = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
  if (dl) {
    try { await dl.save({ filename: name.replace(/\.wav$/, '.zip'), data: zipStore(name, new Uint8Array(wav)) }); note.textContent = 'Saved as a ZIP containing the WAV.'; }
    catch (e) { note.textContent = e && e.code === 'declined' ? 'Save cancelled.' : 'Saving is not available in this view.'; }
    return;
  }
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
}
const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
function zipStore(name, data) { // single file, no compression
  let crc = 0xffffffff; for (let i = 0; i < data.length; i++) crc = CRC[(crc ^ data[i]) & 255] ^ (crc >>> 8); crc = (crc ^ 0xffffffff) >>> 0;
  const fn = new TextEncoder().encode(name), L = 30 + fn.length, C = 46 + fn.length;
  const out = new Uint8Array(L + data.length + C + 22), v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint32(14, crc, true); v.setUint32(18, data.length, true); v.setUint32(22, data.length, true); v.setUint16(26, fn.length, true);
  out.set(fn, 30); out.set(data, L);
  let o = L + data.length;
  v.setUint32(o, 0x02014b50, true); v.setUint16(o + 4, 20, true); v.setUint16(o + 6, 20, true); v.setUint32(o + 16, crc, true); v.setUint32(o + 20, data.length, true); v.setUint32(o + 24, data.length, true); v.setUint16(o + 28, fn.length, true); v.setUint32(o + 42, 0, true);
  out.set(fn, o + 46); o += C;
  v.setUint32(o, 0x06054b50, true); v.setUint16(o + 8, 1, true); v.setUint16(o + 10, 1, true); v.setUint32(o + 12, C, true); v.setUint32(o + 16, L + data.length, true);
  return out;
}
function encodeWav(ch, n, sr) {
  const buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true);
  v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 4, true);
  let o = 44;
  for (let k = 0; k < ch[0].length; k++) {
    const L = ch[0][k], R = ch[1][k];
    for (let i = 0; i < L.length; i++) {
      v.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true);
      v.setInt16(o + 2, Math.max(-1, Math.min(1, R[i])) * 32767, true); o += 4;
    }
  }
  return buf;
}

// ---------- controls ----------
const sliders = {
  speed: { out: v => v + ' ms', apply: v => strum.set({ speed: v / 1000 }) },
  humanize: { out: v => v, apply: v => strum.set({ humanize: v / 100 }) },
  updepth: { out: v => v, apply: v => strum.set({ upDepth: v / 100 }) },
  gather: { out: v => v + ' ms', apply: v => strum.set({ gather: v / 1000 }) },
  keyvel: { out: v => v, apply: () => {} },
  // slide speed: 0..100 -> x0.33 .. x3 (log), shown as the typical time of a 3-fret slide at medium force
  slidespeed: { out: v => Math.round((0.055 + 0.075 * 2) * 0.895 / Math.pow(3, (v - 50) / 50) * 1000) + ' ms', apply: v => strum.set({ slideSpeed: Math.pow(3, (v - 50) / 50) }) },
  fingernoise: { out: v => v + '%', apply: v => setEngine({ fingerAmt: v / 100 }) },
  bpm: { out: v => v, apply: v => strum.set({ bpm: v }) },
  skill: { out: v => v, apply: v => strum.set({ skill: v / 100 }) },
  brushes: { out: v => v + '%', apply: v => strum.set({ brushes: v / 100 }) },
  capo: { out: v => +v ? 'fret ' + v : 'none', apply: v => { capo = +v; strum.set({ capo }); setEngine({ capo }); } },
  pickpos: { out: v => v + '%', apply: v => strum.set({ pickPos: v / 100 }) },
  bright: { out: v => v < 25 ? 'dead' : v < 50 ? 'played in' : v < 80 ? 'fresh' : 'new', apply: v => setEngine({ brightness: v / 100 }) },
  body: { out: v => v, apply: v => setEngine({ body: v / 80 }) },
  bodysize: { out: v => v + '%', apply: v => setEngine({ bodySize: v / 100 }) },
  symp: { out: v => v, apply: v => setEngine({ sympathetic: v / 100 }) },
  noise: { out: v => v, apply: v => setEngine({ noise: v / 100 }) },
  vol: { out: v => v, apply: v => setEngine({ gain: Math.pow(v / 100, 1.5) * 1.5 }) }
};
function bindSliders() {
  for (const id in sliders) {
    const el = $(id), cfg = sliders[id];
    const saved = store.get('s.' + id, null);
    if (saved != null) el.value = saved;
    const upd = () => { $(id + 'Out').textContent = cfg.out(+el.value); cfg.apply(+el.value); store.set('s.' + id, +el.value); };
    el.addEventListener('input', upd);
    $(id + 'Out').textContent = cfg.out(+el.value);
    cfg.apply(+el.value);
  }
}
function applyAll() {
  for (const id in sliders) sliders[id].apply(+$(id).value);
  setEngine({ preset: $('preset').value, tuning, capo, quality, cpu: cpuMode });
  applyScene(); applyPick();
}
function bindSegs() {
  document.querySelectorAll('.seg').forEach(seg => {
    const opt = seg.dataset.opt;
    const val = store.get('o.' + opt, seg.querySelector('button').dataset.v);
    const set = (v) => {
      seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === v));
      strum.set({ [opt]: v }); store.set('o.' + opt, v);
      if (opt === 'mode') { $('patternCtl').hidden = v !== 'pattern'; if (v !== 'pattern' && strum.hand) strum.hand.stop(); }
    };
    seg.querySelectorAll('button').forEach(b => { b.type = 'button'; b.addEventListener('click', () => set(b.dataset.v)); });
    set(val);
  });
  const tog = (id, opt) => {
    const b = $(id); const v = store.get('o.' + opt, false);
    const set = (on) => { b.setAttribute('aria-pressed', on); strum.set({ [opt]: on }); store.set('o.' + opt, on); };
    b.addEventListener('click', () => { const on = b.getAttribute('aria-pressed') !== 'true'; set(on); if (!on && opt === 'letRing') strum.setSustain(strum.sustain); });
    set(v);
  };
  tog('letRing', 'letRing'); tog('palm', 'palm');
  const pre = $('preset'); pre.value = store.get('o.preset', 'dreadnought');
  pre.addEventListener('change', () => { setEngine({ preset: pre.value }); store.set('o.preset', pre.value); });
  const tun = $('tuning'); tun.value = store.get('o.tuning', tun.value);
  tuning = tun.value.split(',').map(Number); strum.set({ tuning });
  tun.addEventListener('change', () => {
    tuning = tun.value.split(',').map(Number); store.set('o.tuning', tun.value);
    strum.set({ tuning }); setEngine({ tuning }); renderChords();
  });
}

// ---------- space controls ----------
function fillSelect(id, entries, val) {
  const el = $(id); el.innerHTML = '';
  for (const [k, v] of entries) { const o = document.createElement('option'); o.value = k; o.textContent = v; el.appendChild(o); }
  el.value = val;
}
// ---------- pick ----------
const pick = { type: store.get('pk.type', 'cell71'), grip: store.get('pk.grip', 'normal'), angle: +store.get('pk.angle', 20), Es: store.get('pk.Es', null) };
// hardness slider: log surface modulus from 1 MPa (felt) to 200 GPa (steel); starts at the material's own value
const hardToEs = (v) => Math.pow(10, 6 + v / 100 * 5.3), esToHard = (Es) => Math.round((Math.log10(Es) - 6) / 5.3 * 100);
function showHard() {
  const P = GUITAR_PICKS[pick.type] || GUITAR_PICKS.cell71, Es = pick.Es || P.Es || P.E;
  $('pickHard').value = esToHard(Es);
  $('pickHardOut').textContent = guitarShore.fromEs(Es).replace('harder than Shore D 90', 'D90+') .replace('Shore ', '') + (pick.Es ? '' : '*');
  $('pickHard').title = guitarShore.fromEs(Es) + (pick.Es ? '' : ' (the material\'s own)');
}
function applyPick() {
  setEngine({ pick: Object.assign({}, pick) });
  // a pick that lets go of each string sooner also passes through a strum faster (mid-neck string, medium attack)
  const M = guitarPickModel, P = GUITAR_PICKS;
  const r = M(P[pick.type] || P.cell71, 72, 0.645, 0.13, 0.7, pick.angle, pick.grip, pick.Es), r0 = M(P.cell71, 72, 0.645, 0.13, 0.7, 20, 'normal');
  strum.set({ pickHold: Math.max(0.5, Math.min(1.6, r.hold / r0.hold)) });
}
// legato: overlapping single notes become hammer-ons, pull-offs or slides (see StrumEngine.tryGlide)
function setLegato(m) { $('legatoMode').value = m; strum.set({ legato: m }); store.set('o.legatoMode', m); }
function bindCpu() { $('cpuMode').value = cpuMode; $('cpuMode').addEventListener('change', () => setCpu($('cpuMode').value)); }
function bindLegato() {
  $('legatoMode').addEventListener('change', () => setLegato($('legatoMode').value));
  setLegato(store.get('o.legatoMode', 'auto'));
}
const KEYSWITCH = { 24: 'auto', 25: 'slide', 26: 'hammer', 27: 'off' };   // C1, C#1, D1, D#1
function bindHandStyle() {
  fillSelect('handStyle', Object.entries(HAND_STYLES).map(([k, v]) => [k, v.name]), store.get('o.style', 'travis'));
  strum.set({ style: $('handStyle').value });
  $('handStyle').addEventListener('change', () => {
    const k = $('handStyle').value; strum.set({ style: k }); store.set('o.style', k);
    // each style starts at its typical tempo unless a MIDI clock is setting it
    const clocked = clockTicks.length === 25 && performance.now() - clockTicks[24] < 1000;
    if (!clocked && HAND_STYLES[k].tempo) { $('bpm').value = HAND_STYLES[k].tempo; $('bpmOut').textContent = HAND_STYLES[k].tempo; strum.set({ bpm: HAND_STYLES[k].tempo }); store.set('s.bpm', HAND_STYLES[k].tempo); }
  });
}
// MIDI clock (24 per quarter note): tempo from the spacing of the last 24 ticks; Start realigns the pattern grid
const clockTicks = [];
function onClock(st, ts) {
  if (st === 0xfa) { clockTicks.length = 0; if (strum.hand && strum.hand.running) strum.hand.realign(engineTime()); return; }
  if (st !== 0xf8) return;
  clockTicks.push(ts); if (clockTicks.length > 25) clockTicks.shift();
  if (clockTicks.length === 25) {
    const bpm = 60000 / (clockTicks[24] - clockTicks[0]);
    if (bpm > 30 && bpm < 300 && Math.abs(bpm - (strum.o.bpm || 0)) > 0.3) {
      strum.set({ bpm }); $('bpm').value = Math.round(bpm); $('bpmOut').textContent = Math.round(bpm) + ' (clock)';
    }
  }
}
function bindPick() {
  fillSelect('pickType', Object.entries(GUITAR_PICKS).map(([k, v]) => [k, v.name]), pick.type);
  $('grip').value = pick.grip; $('pickAngle').value = pick.angle; $('pickAngleOut').textContent = pick.angle + '°';
  showHard();
  $('pickType').addEventListener('change', () => { pick.type = $('pickType').value; pick.Es = null; store.set('pk.type', pick.type); store.set('pk.Es', null); showHard(); applyPick(); });
  $('pickHard').addEventListener('input', () => { pick.Es = hardToEs(+$('pickHard').value); store.set('pk.Es', pick.Es); showHard(); applyPick(); });
  $('grip').addEventListener('change', () => { pick.grip = $('grip').value; store.set('pk.grip', pick.grip); applyPick(); });
  $('pickAngle').addEventListener('input', () => { pick.angle = +$('pickAngle').value; $('pickAngleOut').textContent = pick.angle + '°'; store.set('pk.angle', pick.angle); applyPick(); });
}
function bindSpace() {
  const S = SP();
  fillSelect('topWood', Object.entries(GUITAR_WOODS.top).map(([k, v]) => [k, v.name]), build.top);
  fillSelect('backWood', Object.entries(GUITAR_WOODS.back).map(([k, v]) => [k, v.name]), build.back);
  fillSelect('hold', Object.entries(GUITAR_HOLDS).map(([k, v]) => [k, v.name]), build.hold);
  fillSelect('micSetup', Object.entries(S.MIC_SETUPS).map(([k, v]) => [k, v.name]), scene.mics);
  fillSelect('roomSel', Object.entries(S.ROOMS).map(([k, v]) => [k, v.name]), scene.room);
  $('bracing').value = build.bracing; $('finish').value = build.finish; $('buildStyle').value = build.style; $('micPattern').value = scene.pattern;
  $('micDist').value = Math.round(scene.dist * 100); $('micDistOut').textContent = 'x' + scene.dist.toFixed(1);
  $('roomTrim').value = scene.trim; $('roomTrimOut').textContent = (scene.trim > 0 ? '+' : '') + scene.trim + ' dB';
  const onBuild = (id, key) => $(id).addEventListener('change', () => { build[key] = $(id).value; store.set('b.' + key, build[key]); applyScene(); });
  onBuild('topWood', 'top'); onBuild('backWood', 'back'); onBuild('buildStyle', 'style'); onBuild('bracing', 'bracing'); onBuild('finish', 'finish'); onBuild('hold', 'hold');
  const onScene = (id, key) => $(id).addEventListener('change', () => { scene[key] = $(id).value; store.set('sp.' + key, scene[key]); applyScene(); });
  onScene('micSetup', 'mics'); onScene('micPattern', 'pattern'); onScene('roomSel', 'room');
  $('micDist').addEventListener('input', () => { scene.dist = +$('micDist').value / 100; $('micDistOut').textContent = 'x' + scene.dist.toFixed(1); store.set('sp.dist', scene.dist); applyScene(); });
  $('roomTrim').addEventListener('input', () => {
    scene.trim = +$('roomTrim').value; store.set('sp.trim', scene.trim);
    $('roomTrimOut').textContent = (scene.trim > 0 ? '+' : '') + scene.trim + ' dB';
    if (wetGain) wetGain.gain.value = Math.pow(10, scene.trim / 20) * 2.0;
  });
  $('turnGuitar').addEventListener('click', () => { scene.yaw = (scene.yaw + Math.PI / 4) % (2 * Math.PI); store.set('sp.yaw', scene.yaw); applyScene(); });
  // drag the guitar on the map
  const map = $('roomMap');
  const moveTo = (e) => {
    const r = map.getBoundingClientRect(), g = mapGeom();
    if (!g) return;
    const x = (e.clientX - r.left - g.ox) / g.k, y = (e.clientY - r.top - g.oy) / g.k;
    scene.gx = Math.max(0, Math.min(1, x / g.Lx)); scene.gy = Math.max(0, Math.min(1, y / g.Ly));
    drawRoomMap();
  };
  map.addEventListener('pointerdown', (e) => { map.setPointerCapture(e.pointerId); moveTo(e); });
  map.addEventListener('pointermove', (e) => { if (e.buttons) moveTo(e); });
  map.addEventListener('pointerup', () => { store.set('sp.gx', scene.gx); store.set('sp.gy', scene.gy); applyScene(); });
  window.addEventListener('resize', drawRoomMap);
  drawRoomMap();
}
function mapGeom() {
  const map = $('roomMap'); const S = SP(); if (!map || !S) return null;
  const room = S.ROOMS[scene.room], W = map.clientWidth, H = map.clientHeight;
  const Lx = room.open ? 12 : room.dims[0], Ly = room.open ? 8 : room.dims[1];
  const k = Math.min((W - 24) / Lx, (H - 34) / Ly);
  return { W, H, Lx, Ly, k, ox: (W - Lx * k) / 2, oy: 20 + (H - 34 - Ly * k) / 2, room };
}
function drawRoomMap() {
  const map = $('roomMap'); const S = SP(); if (!map || !S) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  map.width = Math.round(map.clientWidth * dpr); map.height = Math.round(map.clientHeight * dpr);
  const g = map.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const G = mapGeom(), room = G.room, cs = getComputedStyle(document.documentElement);
  const col = (v) => cs.getPropertyValue(v).trim();
  g.clearRect(0, 0, G.W, G.H);
  const X = (x) => G.ox + x * G.k, Y = (y) => G.oy + y * G.k;
  // walls, colored by how reflective they are at 1 kHz
  const wall = (key, x0, y0, x1, y1) => {
    if (room.open) return;
    const a = S.MATERIALS[room.walls[key]].a[3];
    g.strokeStyle = a < 0.15 ? col('--brass') : a < 0.5 ? col('--muted') : col('--faint');
    g.lineWidth = a < 0.15 ? 3 : 2; g.beginPath(); g.moveTo(X(x0), Y(y0)); g.lineTo(X(x1), Y(y1)); g.stroke();
  };
  wall('y0', 0, 0, G.Lx, 0); wall('y1', 0, G.Ly, G.Lx, G.Ly); wall('x0', 0, 0, 0, G.Ly); wall('x1', G.Lx, 0, G.Lx, G.Ly);
  if (room.open) { g.fillStyle = col('--panel'); g.fillRect(X(0), Y(0), G.Lx * G.k, G.Ly * G.k); }
  g.fillStyle = col('--faint'); g.font = '10px "JetBrains Mono", monospace'; g.textAlign = 'left';
  g.fillText(room.open ? 'open air, grass below' : `${room.dims[0]} × ${room.dims[1]} × ${room.dims[2]} m · floor ${S.MATERIALS[room.walls.floor].name.toLowerCase()}`, 8, 12);
  // guitar, player and mics
  const sc = sceneObject();
  const pl = S.placement(sc);
  const P = (p) => { const r = pl.toRoom(p); return [X(r[0]), Y(r[1])]; };
  const big = Math.max(1, 0.9 / (G.k * 0.42)); // draw tiny guitars bigger in large rooms
  const Pz = (p) => { const r = pl.toRoom([p[0] * big, p[1] * big, p[2] * big]); const o = pl.toRoom([0, 0, 0]); return [X(o[0] + (r[0] - o[0])), Y(o[1] + (r[1] - o[1]))]; };
  if (build.hold !== 'stand') { const c = Pz([0.1, 0, -0.3]); g.fillStyle = col('--panel-2'); g.strokeStyle = col('--faint'); g.lineWidth = 1; g.beginPath(); g.arc(c[0], c[1], 0.2 * G.k * big, 0, 7); g.fill(); g.stroke(); }
  const a = Pz([-0.2, 0, 0]), b = Pz([0.33, 0, 0]), neck = Pz([0.7, 0, 0]);
  g.strokeStyle = col('--brass'); g.lineWidth = Math.max(5, 0.1 * G.k * big); g.lineCap = 'round';
  g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
  g.lineWidth = Math.max(2, 0.04 * G.k * big); g.beginPath(); g.moveTo(b[0], b[1]); g.lineTo(neck[0], neck[1]); g.stroke();
  const face = Pz([0.05, 0, 0.18]), fo = Pz([0.05, 0, 0]);
  g.strokeStyle = col('--accent'); g.lineWidth = 1; g.beginPath(); g.moveTo(fo[0], fo[1]); g.lineTo(face[0], face[1]); g.stroke();
  const mics = S.expandMics(sc.mics);
  let dmin = Infinity;
  for (const m of mics) {
    const p = m.ear ? Pz(m.p) : (big > 1.01 ? Pz(m.p) : P(m.p));
    dmin = Math.min(dmin, Math.hypot(m.p[0] - 0.12, m.p[1], m.p[2]));
    g.fillStyle = col('--fg'); g.beginPath(); g.arc(p[0], p[1], 3.5, 0, 7); g.fill();
    const q = (big > 1.01 || m.ear) ? Pz([m.p[0] + m.axis[0] * 0.12, m.p[1] + m.axis[1] * 0.12, m.p[2] + m.axis[2] * 0.12]) : P([m.p[0] + m.axis[0] * 0.12, m.p[1] + m.axis[1] * 0.12, m.p[2] + m.axis[2] * 0.12]);
    g.strokeStyle = col('--fg'); g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke();
  }
  // stats
  const E = S.eyring(room);
  const rt = room.open ? null : (E.rt[2] + E.rt[3]) / 2;
  const rc = rt ? 0.057 * Math.sqrt(2 * E.V / rt) : null;
  $('roomInfo').textContent = room.open ? `No walls: only the ground reflects. Nearest mic ${dmin.toFixed(2)} m from the soundhole.`
    : `Reverb time ${rt.toFixed(2)} s (500 Hz–1 kHz) · critical distance ${rc.toFixed(1)} m · nearest mic ${dmin.toFixed(2)} m`;
}

// ---------- chord pads & strum pads ----------
const PAD_CHORDS = ['G', 'C', 'D', 'Em', 'Am', 'F', 'A', 'E', 'Dm', 'Cadd9', 'Dsus4', 'Bm', 'E7', 'A7', 'G/B', 'Fmaj7'];
let activeChord = 'C';
function renderChords() {
  const box = $('chords'); box.innerHTML = '';
  PAD_CHORDS.forEach((name, i) => {
    const b = document.createElement('div');
    b.className = 'chord' + (name === activeChord ? ' on' : '');
    b.setAttribute('role', 'button'); b.tabIndex = 0;
    const keyHint = i < 9 ? String(i + 1) : i === 9 ? '0' : '';
    b.innerHTML = `${name}<small>${shapeLabel(CHORD_SHAPES[name])}${keyHint ? ' · ' + keyHint : ''}</small>`;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); playChordPad(name, 1); });
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playChordPad(name, 1); } });
    box.appendChild(b);
  });
}
async function playChordPad(name, dir) {
  await start();
  // Pattern mode: a pad latches the right hand's pattern on that chord; tapping the playing chord again stops it
  if (strum.o.mode === 'pattern' && strum.hand) {
    if (strum.hand.running && activeChord === name) {
      strum.hand.stop(); activeChord = null;
      document.querySelectorAll('.chord').forEach(c => c.classList.remove('on'));
      return;
    }
    activeChord = name;
    document.querySelectorAll('.chord').forEach(c => c.classList.toggle('on', c.firstChild.textContent === name));
    strum.setShape(CHORD_SHAPES[name].slice());
    strum.hand.chord({ frets: strum.shape }, +$('keyvel').value / 100, engineTime() + 0.01);
    return;
  }
  activeChord = name;
  document.querySelectorAll('.chord').forEach(c => c.classList.toggle('on', c.firstChild.textContent === name));
  const f = CHORD_SHAPES[name].slice();
  // shapes are written for standard tuning; in other tunings keep the fingering (it becomes a new chord, as on a real guitar)
  strum.setShape(f);
  strum.strumShape(dir, +$('keyvel').value / 100);
}
function padStrum(dir) {
  start().then(() => strum.strumShape(dir, +$('keyvel').value / 100 * (dir < 0 ? 0.85 : 1)));
  const el = dir > 0 ? $('padDown') : $('padUp');
  el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 90);
}
function shapeLabel(f) { return f.map(x => x < 0 ? 'x' : x).join(f.some(x => x > 9) ? '-' : ''); }

// ---------- on-screen keyboard ----------
const QWERTY = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k', 'o', 'l', 'p', ';'];
const keyEls = new Map();
function buildKeys() {
  const box = $('keys'); box.innerHTML = ''; keyEls.clear();
  const whites = [], N = 29; // C to E two octaves + a third
  for (let i = 0; i < N; i++) if (![1, 3, 6, 8, 10].includes(i % 12)) whites.push(i);
  const ww = 100 / whites.length;
  let wi = 0;
  for (let i = 0; i < N; i++) {
    const black = [1, 3, 6, 8, 10].includes(i % 12);
    const el = document.createElement('div');
    el.className = 'key ' + (black ? 'black' : 'white');
    if (black) { el.style.left = `calc(${wi * ww}% - ${ww * 0.32}%)`; el.style.width = ww * 0.64 + '%'; }
    else { el.style.left = wi * ww + '%'; el.style.width = ww + '%'; wi++; }
    el.dataset.i = i;
    const q = QWERTY[i]; if (q) el.innerHTML = `<span class="kb">${q.toUpperCase()}</span>`;
    box.appendChild(el); keyEls.set(i, el);
  }
  $('octLabel').textContent = 'C' + (octave / 12 - 1);
}
const pointerNote = new Map();
function bindKeys() {
  const box = $('keys');
  const noteAt = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || !el.classList.contains('key')) return null;
    const r = el.getBoundingClientRect();
    const depth = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    return { i: +el.dataset.i, vel: 0.35 + 0.65 * depth };
  };
  box.addEventListener('pointerdown', async (e) => {
    e.preventDefault(); await start();
    const k = noteAt(e); if (!k) return;
    box.setPointerCapture(e.pointerId);
    pointerNote.set(e.pointerId, k.i);
    noteOn(octave + k.i, k.vel);
  });
  box.addEventListener('pointermove', (e) => {
    if (!pointerNote.has(e.pointerId)) return;
    const k = noteAt(e); const cur = pointerNote.get(e.pointerId);
    if (k && k.i !== cur) { noteOff(octave + cur); pointerNote.set(e.pointerId, k.i); noteOn(octave + k.i, k.vel); }
  });
  const up = (e) => { if (!pointerNote.has(e.pointerId)) return; noteOff(octave + pointerNote.get(e.pointerId)); pointerNote.delete(e.pointerId); };
  box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
}
const litKeys = new Map();
function noteOn(midi, vel, t) {
  strum.noteOn(midi, vel, t);
  const el = keyEls.get(midi - octave); if (el) el.classList.add('down');
  litKeys.set(midi, true);
}
function noteOff(midi) {
  strum.noteOff(midi);
  const el = keyEls.get(midi - octave); if (el) el.classList.remove('down');
  litKeys.delete(midi);
}

// ---------- computer keyboard ----------
const downKeys = new Map();
function keyOf(e) {
  const c = e.code || '';
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  const m = { Semicolon: ';', BracketLeft: '[', BracketRight: ']', Space: ' ', ShiftLeft: 'shift', ShiftRight: 'shift', Quote: "'" };
  return m[c] || (e.key || '').toLowerCase();
}
// Palm mute: the palm also settles on strings already ringing (and lifts off again), as a real palm would
function setPalm(on) {
  strum.set({ palm: on }); $('palm').setAttribute('aria-pressed', on);
  send([{ type: 'palm', on, t: engineTime() }]);
}
function bindQwerty() {
  window.addEventListener('keydown', async (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // the physical key (e.code), so Shift (palm mute) doesn't turn '1' into '!' or ';' into ':'
    const k = keyOf(e);
    if (e.repeat) { if (QWERTY.includes(k) || k === ' ') e.preventDefault(); return; }
    if (k === ' ') { e.preventDefault(); strum.setSustain(true); return; }
    if (k === 'shift') { setPalm(true); return; }
    if (k === 'z') { shiftOct(-12); return; }
    if (k === 'x') { shiftOct(12); return; }
    if (k === '[') { padStrum(1); return; }
    if (k === ']') { padStrum(-1); return; }
    if (/^[0-9]$/.test(k)) { const i = k === '0' ? 9 : +k - 1; if (PAD_CHORDS[i]) playChordPad(PAD_CHORDS[i], 1); return; }
    const i = QWERTY.indexOf(k);
    if (i < 0) return;
    e.preventDefault();
    await start();
    const midi = octave + i; downKeys.set(k, midi);
    noteOn(midi, +$('keyvel').value / 100);
  });
  window.addEventListener('keyup', (e) => {
    const k = keyOf(e);
    if (k === ' ') { strum.setSustain(false); return; }
    if (k === 'shift') { setPalm(false); return; }
    if (downKeys.has(k)) { noteOff(downKeys.get(k)); downKeys.delete(k); }
  });
  window.addEventListener('blur', () => { for (const [, m] of downKeys) noteOff(m); downKeys.clear(); });
}
function shiftOct(d) {
  for (const [m] of litKeys) noteOff(m);
  octave = Math.max(24, Math.min(72, octave + d));
  buildKeys();
}

// ---------- MIDI ----------
let midiAccess = null;
async function initMidi() {
  if (!navigator.requestMIDIAccess) { midiMsg('This browser has no Web MIDI. Chrome, Edge and Firefox support it; Safari does not.'); return; }
  try { midiAccess = await navigator.requestMIDIAccess({ sysex: false }); }
  catch (e) { midiMsg('MIDI access was refused here. Open the GitHub Pages version to use a MIDI keyboard.'); return; }
  midiAccess.onstatechange = listInputs;
  listInputs();
}
function midiMsg(t) { $('midiNote').textContent = t; }
function listInputs() {
  const sel = $('midiIn'), cur = sel.value;
  sel.innerHTML = '<option value="all">All inputs</option>';
  let n = 0;
  for (const inp of midiAccess.inputs.values()) {
    const o = document.createElement('option'); o.value = inp.id; o.textContent = inp.name; sel.appendChild(o);
    inp.onmidimessage = onMidi; n++;
  }
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : 'all';
  $('midiDot').classList.toggle('on', n > 0);
  $('midiStatus').textContent = n ? `${n} MIDI in` : 'no MIDI';
}
function onMidi(e) {
  const sel = $('midiIn').value;
  if (sel !== 'all' && e.target.id !== sel) return;
  const [st, d1, d2] = e.data; const cmd = st & 0xf0;
  if (st >= 0xf8) { onClock(st, e.timeStamp); return; }
  const t = ctx ? ctx.currentTime + Math.min(0, (e.timeStamp - performance.now()) / 1000) : undefined;
  if ((cmd === 0x90 || cmd === 0x80) && KEYSWITCH[d1]) { if (cmd === 0x90 && d2 > 0) setLegato(KEYSWITCH[d1]); return; }   // keyswitches
  if (cmd === 0x90 && d2 > 0) { start(); noteOn(d1, Math.pow(d2 / 127, 0.9), t); }
  else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) noteOff(d1);
  else if (cmd === 0xb0) {
    if (d1 === 64) strum.setSustain(d2 >= 64);
    else if (d1 === 2) { const v = Math.round(d2 / 127 * 200); $('fingernoise').value = v; $('fingernoiseOut').textContent = v + '%'; setEngine({ fingerAmt: v / 100 }); }   // breath: finger-noise level
    else if (d1 === 5) { const v = Math.round(100 - d2 / 127 * 100); $('slidespeed').value = v; sliders.slidespeed.apply(v); $('slidespeedOut').textContent = sliders.slidespeed.out(v); }   // portamento time
    else if (d1 === 65) setLegato(d2 >= 64 ? 'auto' : 'off');   // portamento on/off
    else if (d1 === 68) strum.legatoForce = d2 >= 64 ? 'slide' : null;   // legato pedal: slide while held
    else if (d1 === 67) setPalm(d2 >= 64);   // soft pedal: palm mute
    else if (d1 === 1) { const ms = Math.round(12 + (d2 / 127) * 70); $('speed').value = ms; $('speedOut').textContent = ms + ' ms'; strum.set({ speed: ms / 1000 }); }
    else if (d1 === 123 || d1 === 120) strum.allOff();
  } else if (cmd === 0xd0 || cmd === 0xa0) {
    // aftertouch: how hard the finger presses the string while it slides (1 = normal, up to 2.5x)
    const v = cmd === 0xd0 ? d1 : d2;
    send([{ type: 'params', params: { fingerPress: 1 + 1.5 * v / 127 }, t: engineTime() }]);
  } else if (cmd === 0xe0) {
    const v = ((d2 << 7) | d1) - 8192;
    send([{ type: 'bend', value: (v / 8192) * 2, t: engineTime() }]);
  }
}

// ---------- the neck ----------
const cv = $('neck'), g2 = cv.getContext('2d');
let W = 0, H = 0, dpr = 1;
const flash = [0, 0, 0, 0, 0, 0];
function pulse(e) { if (e.s >= 0 && e.s < 6) flash[e.s] = Math.max(flash[e.s], e.dead ? 0.3 : 0.4 + e.vel * 0.6); }
function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = cv.getBoundingClientRect(); W = r.width; H = r.height;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
}
function geom() {
  const nutX = Math.max(34, W * 0.05), neckEnd = W * (W < 560 ? 0.80 : 0.74);
  const scale = 2 * (neckEnd - nutX); // fret 12 at neckEnd
  const top = 38, bot = H - 26;
  const sy = (s) => top + (bot - top) * (s / 5); // s=0 low E at top (player's view)
  const fx = (f) => nutX + scale * (1 - Math.pow(2, -f / 12));
  return { nutX, neckEnd, scale, top, bot, sy, fx, saddle: nutX + scale * 0.985 };
}
// Redraw only when something moves (a vibrating string, a flash, an interaction), at most ~30 times a second;
// otherwise twice a second in case something changed (redrawing a still picture 60 times a second cost ~10% CPU)
let lastDraw = -1e9, neckDirty = true;
const markNeck = () => { neckDirty = true; };
['pointerdown', 'pointermove', 'keydown', 'resize'].forEach(ev => window.addEventListener(ev, markNeck, { passive: true }));
function draw(ts) {
  requestAnimationFrame(draw);
  if (!W) return;
  const active = flash.some(f => f > 0.01) || meters.some(m => m && m.e > 0.002);
  if (!(active || neckDirty) && ts - lastDraw < 500) return;
  if (ts - lastDraw < 31) return;
  lastDraw = ts; neckDirty = false;
  const G = geom();
  g2.setTransform(dpr, 0, 0, dpr, 0, 0);
  g2.clearRect(0, 0, W, H);
  // fingerboard
  const fb = g2.createLinearGradient(0, G.top - 14, 0, G.bot + 14);
  fb.addColorStop(0, '#2a1a12'); fb.addColorStop(0.5, '#33211a'); fb.addColorStop(1, '#24170f');
  g2.fillStyle = fb; g2.fillRect(G.nutX, G.top - 14, G.neckEnd - G.nutX, G.bot - G.top + 28);
  // body top beyond the neck: spruce with soundhole + rosette
  const bx = G.neckEnd;
  const top = g2.createLinearGradient(bx, 0, W, 0);
  top.addColorStop(0, '#6b5434'); top.addColorStop(1, '#8a7046');
  g2.fillStyle = top; g2.fillRect(bx, 0, W - bx, H);
  g2.fillStyle = 'rgba(0,0,0,0.08)';
  for (let x = bx + 3; x < W; x += 5) g2.fillRect(x, 0, 1, H);
  const hx = bx + Math.min(W - bx, H) * 0.62, hy = H / 2, hr = H * 0.36;
  g2.strokeStyle = 'rgba(20,12,6,0.6)'; g2.lineWidth = 6; g2.beginPath(); g2.arc(hx, hy, hr + 12, 0, Math.PI * 2); g2.stroke();
  g2.strokeStyle = 'rgba(108,194,180,0.35)'; g2.lineWidth = 2; g2.beginPath(); g2.arc(hx, hy, hr + 7, 0, Math.PI * 2); g2.stroke();
  g2.fillStyle = '#0b0705'; g2.beginPath(); g2.arc(hx, hy, hr, 0, Math.PI * 2); g2.fill();
  // headstock edge + nut
  g2.fillStyle = '#1a110c'; g2.fillRect(0, 0, G.nutX, H);
  g2.fillStyle = '#e8dcc3'; g2.fillRect(G.nutX - 4, G.top - 14, 5, G.bot - G.top + 28);
  // frets & inlays
  for (let f = 1; f <= 12; f++) {
    const x = G.fx(f);
    g2.fillStyle = '#b9a988'; g2.fillRect(x - 1, G.top - 14, 2, G.bot - G.top + 28);
    if ([3, 5, 7, 9].includes(f) || f === 12) {
      const mx = (G.fx(f - 1) + x) / 2; g2.fillStyle = 'rgba(220,230,226,0.55)';
      if (f === 12) { g2.beginPath(); g2.arc(mx, G.sy(1.5), 4, 0, 7); g2.arc(mx, G.sy(3.5), 4, 0, 7); g2.fill(); }
      else { g2.beginPath(); g2.arc(mx, H / 2, 4.5, 0, 7); g2.fill(); }
    }
    if (f <= 12 && W > 420) { g2.fillStyle = 'rgba(168,153,138,0.6)'; g2.font = '10px "JetBrains Mono", monospace'; g2.textAlign = 'center'; g2.fillText(String(f), (G.fx(f - 1) + x) / 2, H - 8); }
  }
  // saddle
  g2.fillStyle = '#e8dcc3'; g2.fillRect(W - 10, G.top - 10, 4, G.bot - G.top + 20);
  // strings
  const t = (ts || 0) / 1000;
  const open = tuning.map(x => x + capo);
  for (let s = 0; s < 6; s++) {
    const y = G.sy(s);
    const m = meters[s] || { e: 0, fret: 0 };
    flash[s] *= 0.88;
    const fret = Math.max(0, Math.round((m.midi ?? open[s]) - open[s]));
    const x0 = fret > 0 ? G.fx(fret) : G.nutX, x1 = W - 8;
    const amp = Math.min(9, Math.sqrt(m.e || 0) * 28 + flash[s] * 2);
    const wound = s < 4 && $('preset').value !== 'classical';
    const col = $('preset').value === 'classical' ? (s < 3 ? '#d8c9a6' : '#e9e2d2') : (wound ? '#c99d55' : '#c9ccd1');
    const lw = 3.2 - s * 0.42;
    // dead part of the string (behind the fretting finger)
    if (fret > 0) { g2.strokeStyle = col; g2.globalAlpha = 0.35; g2.lineWidth = lw; g2.beginPath(); g2.moveTo(G.nutX, y); g2.lineTo(x0, y); g2.stroke(); g2.globalAlpha = 1; }
    if (amp > 0.25) {
      // motion blur envelope of a standing wave between finger and saddle
      g2.fillStyle = col; g2.globalAlpha = 0.18 + Math.min(0.25, amp / 30);
      g2.beginPath(); g2.moveTo(x0, y);
      for (let k = 0; k <= 40; k++) { const x = x0 + (x1 - x0) * k / 40; g2.lineTo(x, y - amp * Math.sin(Math.PI * k / 40)); }
      for (let k = 40; k >= 0; k--) { const x = x0 + (x1 - x0) * k / 40; g2.lineTo(x, y + amp * Math.sin(Math.PI * k / 40)); }
      g2.fill(); g2.globalAlpha = 1;
      g2.strokeStyle = col; g2.lineWidth = lw; g2.beginPath();
      const ph = Math.sin(t * (40 + s * 9));
      for (let k = 0; k <= 40; k++) { const x = x0 + (x1 - x0) * k / 40; const yy = y + amp * ph * Math.sin(Math.PI * k / 40); k ? g2.lineTo(x, yy) : g2.moveTo(x, yy); }
      g2.stroke();
    } else {
      g2.strokeStyle = col; g2.lineWidth = lw; g2.beginPath(); g2.moveTo(x0, y); g2.lineTo(x1, y); g2.stroke();
    }
    // labels and shape markers
    g2.font = '11px "JetBrains Mono", monospace'; g2.textAlign = 'center';
    const sf = shape[s];
    g2.fillStyle = sf < 0 ? '#e0765f' : 'rgba(239,230,214,0.85)';
    g2.fillText(sf < 0 ? '×' : sf === 0 ? '○' : midiName(open[s]), G.nutX / 2 - 2, y + 4);
    if (sf > 0) {
      const mx = (G.fx(sf - 1) + G.fx(sf)) / 2;
      g2.fillStyle = 'rgba(211,171,98,0.9)'; g2.beginPath(); g2.arc(mx, y, 7.5, 0, 7); g2.fill();
      g2.fillStyle = '#1b1208'; g2.font = '600 9px "JetBrains Mono", monospace'; g2.fillText(midiName(open[s] + sf), mx, y + 3);
    }
  }
}
const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
function midiName(m) { return NAMES[((m % 12) + 12) % 12]; }

// Swipe across strings to strum; tap the neck to fret a string.
const swipes = new Map();
function bindNeck() {
  const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() }; };
  cv.addEventListener('pointerdown', async (e) => {
    e.preventDefault(); await start();
    cv.setPointerCapture(e.pointerId);
    const p = pos(e);
    swipes.set(e.pointerId, { last: p, start: p, crossed: 0 });
  });
  cv.addEventListener('pointermove', (e) => {
    const sw = swipes.get(e.pointerId); if (!sw) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ce of evs) {
      const p = pos(ce), G = geom();
      for (let s = 0; s < 6; s++) {
        const y = G.sy(s);
        if ((sw.last.y - y) * (p.y - y) < 0 || (p.y === y && sw.last.y !== y)) {
          const dt = Math.max(1, p.t - sw.last.t), speed = Math.abs(p.y - sw.last.y) / dt; // px per ms
          const vel = Math.max(0.12, Math.min(1, 0.15 + speed * 0.35));
          const dir = p.y > sw.last.y ? 1 : -1; // down the screen = low E first = downstroke
          strum.pluckString(s, vel, dir);
          sw.crossed++;
        }
      }
      sw.last = p;
    }
  });
  const end = (e) => {
    const sw = swipes.get(e.pointerId); if (!sw) return;
    swipes.delete(e.pointerId);
    const p = pos(e), G = geom();
    const moved = Math.hypot(p.x - sw.start.x, p.y - sw.start.y);
    if (sw.crossed || moved > 8 || p.x > G.neckEnd) return;
    // tap: nearest string, fret under the finger
    let s = Math.round((p.y - G.top) / ((G.bot - G.top) / 5)); s = Math.max(0, Math.min(5, s));
    let f = 0;
    if (p.x < G.nutX) f = shape[s] < 0 ? 0 : -1;
    else for (let k = 1; k <= 12; k++) if (p.x < G.fx(k)) { f = k; break; }
    if (p.x >= G.nutX && f === shape[s]) f = 0; // tapping a fretted spot again lifts the finger
    const next = shape.slice(); next[s] = f;
    strum.setShape(next);
    if (f >= 0) strum.pluckString(s, +$('keyvel').value / 100, 1);
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
}

// ---------- boot ----------
function boot() {
  resize(); window.addEventListener('resize', resize);
  bindSliders(); bindSegs(); bindSpace(); bindPick(); bindHandStyle(); bindLegato(); bindCpu(); renderChords(); buildKeys(); bindKeys(); bindQwerty(); bindNeck();
  $('startBtn').addEventListener('click', start);
  $('recBtn').addEventListener('click', toggleRecord);
  $('panicBtn').addEventListener('click', () => { strum.allOff(); send([{ type: 'panic', t: engineTime() }]); });
  $('octDown').addEventListener('click', () => shiftOct(-12));
  $('octUp').addEventListener('click', () => shiftOct(12));
  const padBind = (el, dir) => {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); padStrum(dir); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); padStrum(dir); } });
  };
  padBind($('padDown'), 1); padBind($('padUp'), -1);
  $('shapeText').textContent = shapeLabel(shape);
  requestAnimationFrame(draw);
  window.__acoustic = { strum, send, get ctx() { return ctx; }, start, get meters() { return meters; } };
}
boot();
})();
