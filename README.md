# Acoustic

A physically modelled acoustic guitar for the browser, with a strumming hand in front of it. Nothing is sampled: every note comes from six simulated strings, a pick and a wooden body, computed live in an AudioWorklet. Play it with a MIDI keyboard, the computer keyboard, chord pads, or by swiping across the strings on a phone.

**Play:** https://samuelling.github.io/acoustic/

## The two halves

### 1. The instrument (`src/modal.js`)

A coupled string–body modal model. Nothing about any harmonic's decay or pitch is hand-tuned: both are computed from physics at that harmonic's frequency.

| Part | Model | Source of numbers |
|---|---|---|
| String modes | Two damped oscillators per harmonic (one per polarization), f_k = k f0 √(1+Bk²), B = π²EI/(TL²) | D'Addario EJ16 / EJ45 tensions and unit weights; EI and measured B from Woodhouse et al. 2012 |
| String losses | η = [T(η_F + η_A/ω) + EI η_B (kπ/L)²] / [T + EI (kπ/L)²]; "string age" blends new→used η_B | Woodhouse et al. 2012 (80/20 bronze new/used, Pro Arte nylon) |
| Bridge coupling | Each harmonic's complex frequency shifts by −(T/L)·Y₂(ω), Y₂ the 2×2 bridge admittance; eigen-decomposition gives two decay rates, two pitches and the polarization mix | Gough 1981; Woodhouse 2004; Paté et al. 2014 |
| Polarization split | Normal-to-top polarization slightly sharp (effective length at the saddle) | Woodhouse 2004 ("a few Hz") |
| Body | Literature low modes (A0 ~100 Hz, top pair 193/204 Hz, back, dipoles 292/376/436 Hz with effective masses) + Woodhouse's statistical modes (Rayleigh spacing ≈38 Hz, Q 30–80, log-normal masses, random bridge-motion angles) | Russell; Popp & Rossing; Christensen & Vistisen; Woodhouse 2004; Elie et al. — mean admittance ≈ −45 dB re 1 m/Ns |
| Radiation | Body modal velocities (bridge-velocity weighted, two mic weightings) through a first-order 250 Hz highpass, plus sub-A0 rolloff | Woodhouse 2004; Firth 1977 |
| Pluck | Triangular displacement at the pluck point, finite contact width, slip-off time, push direction; pre-release scrape; release of the pick's static bridge load (body "thump") | Chadefaux et al. 2012; Pavlidou 1997 |
| Tension modulation | Pitch rises with Σ(kπ/L)²A_k²·EA/8 | Kirchhoff–Carrier |
| Longitudinal modes | f_L = (n/2L)√(EA/μ), driven by tension fluctuation | Pakarinen et al. 2007; confirmed as the ~2.7 kHz line in recorded low-E notes |
| Sympathetic strings | Band-limited bridge force from the other strings drives each string's modes | — |

Cost: about 10–17% of one desktop core for two overlapping full strums; an automatic "eco" quality (fewer high partials and radiation modes) is chosen on slow devices.
The previous digital-waveguide engine is kept as `test/legacy_waveguide.js` for A/B tests.

### 2. The hand (`src/strum.js`)

- **Gather**: notes within a short window (default 18 ms) form one chord.
- **Voice**: a fingering search places them on the neck — span, barre feasibility (a barre can't cover an open string), open strings, string order, interior mutes, voice leading from the previous position.
  - *As played*: exactly your notes.
  - *Guitar shape*: your chord's pitch classes, bass and top note expanded into a full 4–6 string shape (C3 E3 G3 → x32010, B2 D4 F#4 → x24432).
- **Strum**: the pick crosses the strings in order, about 35–55 ms for a six-string downstroke (measured strums: 26–62 ms, Freire et al. 2018). Stroke time shrinks with velocity; each string holds the pick briefly (heavier strings longer), so later strings land slightly later; upstrokes are lighter and mostly catch the treble strings; muted strings inside the shape give a dead "chk".
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

The analyzer reports per-partial starting level and T60, inharmonicity, spectral centroid over time and a 1/6-octave spectrum. `test/partials.py` tracks each partial's complex envelope by heterodyning (beating, two-stage decay, pitch glide, non-harmonic attack residual); `proto/invert.py` infers the real guitar's bridge conductance from measured decays; `test/strums.py` measures attack spread, brightness and level of labeled real strums (KLANGIO-GST-MM-T, Apache-2.0) against `test/render_strums.js`; `test/demo.js` renders the same performance through either engine. Reference notes came from the open [tonejs-instruments](https://github.com/nbrosowsky/tonejs-instruments) sample set. Record your own guitar (or a take from the app) and run the same comparison.

## Build

`src/` is the source; `node build.mjs` inlines it into the single-file `index.html` served by GitHub Pages.

## Sources

- Smith, J. O. *Physical Audio Signal Processing* — digital waveguides, commuted synthesis.
- Karjalainen, Välimäki & Tolonen (1998), "Plucked-string models: from the Karplus-Strong algorithm to digital waveguides and beyond."
- Laurson, Erkut, Välimäki & Kuuskankare (2001), "Methods for modeling realistic playing in acoustic guitar synthesis," *Computer Music Journal*.
- Bank & Karjalainen (2010), "Passive admittance matrix modeling for guitar synthesis," DAFx — dual-polarization strings coupled at the bridge.
- Russell, D. A., modal analysis of a Gibson Hummingbird dreadnought (A0 and the 188/203 Hz T(1,1) pair).
- Woodhouse, J. (2004), "On the synthesis of guitar plucks" and "Plucked guitar transients," Acta Acustica 90.
- Woodhouse, Manuel, Smith, Wheble & Fritz (2012), "Perceptual thresholds for acoustical guitar models," Acta Acustica 98.
- Paté, Le Carrou & Fabre (2014), "Predicting the decay time of solid body electric guitar tones," JASA.
- Christensen & Vistisen (1980), simple model for low-frequency guitar function, JASA.
- Freire, Armondes, Viana & Silva (2018), strumming microtiming on acoustic guitar, SMC.
- Pakarinen, Penttinen & Bank (2007), handling noises on wound strings, JASA-EL.
- Hodgkinson, Timoney & Lazzarini (2010), tension-modulated steel-string partial tracks, DAFx.
