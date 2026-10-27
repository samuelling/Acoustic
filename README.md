# Acoustic

A physically modelled acoustic guitar for the browser, with a strumming hand in front of it. Nothing is sampled: every note comes from six simulated strings, a pick and a wooden body, computed live in an AudioWorklet. Play it with a MIDI keyboard, the computer keyboard, chord pads, or by swiping across the strings on a phone.

**Play:** https://samuelling.github.io/acoustic/

## The two halves

### 1. The instrument (`src/dsp.js`)

| Part | Model | Why it matters |
|---|---|---|
| Strings | Single-delay-loop digital waveguide per string, 4-point Lagrange fractional delay | Exact tuning; pitch bends and tension glide without zipper noise |
| Two polarizations | Horizontal (long decay) and vertical (fast decay, louder at the bridge), slightly detuned, weakly coupled | The two-stage "prompt sound then aftersound" decay and slow beating of real partials |
| Loss | One-pole loop filter designed from T60 at the fundamental and at ~1.2 kHz | Treble dies faster than bass, at measured rates |
| Stiffness | Cascade of first-order allpasses | Inharmonicity, B ≈ 4–5×10⁻⁵ like the reference recordings |
| Pick | Force pulse of length β·N (β = pluck point / speaking length) through a velocity-dependent lowpass | Pluck-position comb notches that move as you fret; harder = brighter |
| Tension modulation | Delay shrinks with amplitude² | Hard attacks start a few cents sharp and settle |
| Sympathetic strings | Band-limited, DC-free bridge signal fed into every string | Undamped strings ring along |
| Body | ~45 resonant modes: A0 air mode ~100 Hz, T(1,1) pair 188/204 Hz, cross dipoles, dense high modes to 7 kHz; two mic positions | Woody colour and natural stereo |
| Radiation | Highpass below A0 | Top and soundhole cancel there, so the low-E fundamental is weaker than its overtones, as in recordings |
| Noise | Pick scrape, release lift-off, fret squeaks on wound strings when the hand shifts | The small sounds that make it a performance |

### 2. The hand (`src/strum.js`)

- **Gather**: notes within a short window (default 18 ms) form one chord.
- **Voice**: a fingering search places them on the neck — span, barre feasibility (a barre can't cover an open string), open strings, string order, interior mutes, voice leading from the previous position.
  - *As played*: exactly your notes.
  - *Guitar shape*: your chord's pitch classes, bass and top note expanded into a full 4–6 string shape (C3 E3 G3 → x32010, B2 D4 F#4 → x24432).
- **Strum**: the pick crosses the strings in order. Stroke time shrinks with velocity; each string holds the pick briefly (heavier strings longer), so later strings land slightly later; upstrokes are lighter and mostly catch the treble strings; muted strings inside the shape give a dead "chk".
- **Direction — pendulum model**: a strumming arm swings down and up every subdivision whether or not it touches the strings. The engine estimates the subdivision from your timing and sets each strum's direction by how many swings have passed. Quarter notes stay downstrokes; 8ths alternate.
- **Fingerstyle**: thumb on the bass strings, fingers on the rest, plucked nearly together.
- **Hand hold**: a released chord keeps ringing ~160 ms so strums connect; strings a new chord doesn't use are muted.

## Controls

- MIDI: notes, sustain (CC64 = let ring), soft pedal (CC67 = palm mute), mod wheel (stroke time), pitch bend (±2 st).
- Computer keys: `A W S E D F T G Y H U J K O L P ;` play notes, `Z`/`X` octave, `Space` sustain, `Shift` palm mute, `1`–`0` chord pads, `[` `]` down/up strum.
- Phone: chord pads, ↓/↑ pads, or swipe across the strings (down the screen = downstroke). Tap the neck to fret a string.
- Record captures the exact output to a 48 kHz WAV.

## Calibration loop

`test/` renders the same DSP code offline in Node and compares it with recordings of real guitars:

```bash
node test/render.js note out.wav '{"s":0,"midi":40,"seconds":4}'
python3 test/analyze.py real_E2.wav out.wav --midi 40 --png compare.png
test/calib.sh '{"t60Mid":2.4}'          # override any preset field and compare four notes at once
python3 test/browser_record.py take.wav  # play a progression through the real page in headless Chromium and record it
```

The analyzer reports per-partial starting level and T60, inharmonicity, spectral centroid over time and a 1/6-octave spectrum. Reference notes came from the open [tonejs-instruments](https://github.com/nbrosowsky/tonejs-instruments) sample set. Record your own guitar (or a take from the app) and run the same comparison.

## Build

`src/` is the source; `node build.mjs` inlines it into the single-file `index.html` served by GitHub Pages.

## Sources

- Smith, J. O. *Physical Audio Signal Processing* — digital waveguides, commuted synthesis.
- Karjalainen, Välimäki & Tolonen (1998), "Plucked-string models: from the Karplus-Strong algorithm to digital waveguides and beyond."
- Laurson, Erkut, Välimäki & Kuuskankare (2001), "Methods for modeling realistic playing in acoustic guitar synthesis," *Computer Music Journal*.
- Bank & Karjalainen (2010), "Passive admittance matrix modeling for guitar synthesis," DAFx — dual-polarization strings coupled at the bridge.
- Russell, D. A., modal analysis of a Gibson Hummingbird dreadnought (A0 and the 188/203 Hz T(1,1) pair).
- Hodgkinson, Timoney & Lazzarini (2010), tension-modulated steel-string partial tracks, DAFx.
