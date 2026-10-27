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

### 2. The space around it (`src/space.js` + the body section of `src/modal.js`)

**Wood and construction.** Each species enters as measured density, stiffness along and across the grain, and internal damping (USDA Wood Handbook; Brémaud et al. 2012; Haines; Stephens 2015 for finish). How that changes the sound depends on the build style:
- *Luthier*: plates thinned to equal stiffness (h ∝ E^−1/3), so mass ∝ ρE^−1/3 changes and frequency barely moves; backs compensated (Carcagno et al. 2018 found back-wood choice moved modes only a few percent).
- *Factory*: fixed thickness, so stiffness ∝ E and mass ∝ ρ both change.
Braces carry about half the low-mode stiffness. Each body mode is shifted by its share of top versus back motion, with wood loss contributing about a quarter of a mode's damping. Finish adds mass and cross-grain damping (thin nitro vs thick poly). Expected effect sizes are small, as blind tests found: a few percent in frequency, 1–3 dB in level.

**Holding.** Torso contact roughly halves the Q of back-dominated modes, adds about 20–30% damping to A0 and T(1,1), lowers back modes about 1%, and absorbs the back's radiation (Le Carrou, Paté & Chomette 2019; Woodhouse 2004).

**Radiation and microphones.** Seven radiating regions: soundhole, bridge, lower bout bass and treble halves, below the bridge, upper bout, back. Each low mode has its own pattern over them (A0 through the soundhole; dipoles with halves in opposite phase); high modes each live in one region. Each mic hears every region at its own distance (delay and 1/r), through its polar pattern A + B·cosθ, with the near-field gradient term B·cosθ·(c/(jωr)) that produces the proximity effect, and with a diffraction lowpass for regions facing away (the body, or the player's head for the ears view). Setups: soundhole 15 cm, 12th fret 20 cm, lower bout, spaced pair, XY 40 cm, room pair at 2 m, behind the player, and the player's own ears. Preamp gain is normalized per setup.

**Measured directivity.** Ackermann et al. (2024) recorded a classical guitar (Kohno 1985) played by a musician in TU Berlin's anechoic chamber with 32 microphones on a 2.06 m sphere ([data](https://doi.org/10.14279/depositonce-5861.3), CC BY-NC-SA 4.0). `proto/directivity.py` turns the third-octave file into octave-band levels per direction in the guitar's own coordinates (power average over the sphere = 0 dB); `test/directivity.js` renders this synth the same way (an omni mic at 2.06 m in each of the 32 directions, single notes across the range) and compares. The uncorrected model had the broad shape (pattern correlation 0.6–0.8) but was too uniform at 250–500 Hz (the player's body takes about 6 dB off the back; the model gave 2–3 dB) and 11 dB too dark behind the guitar at 8 kHz. Two uses of the data follow: room reflections leave the guitar with the measured pattern (keeping the model's split between its top-side and back-side feeds and its total radiated power), and each mic's direct sound gets the measured-minus-model difference in its direction, as a 7-band EQ faded in from 0.3 m to 1.2 m from the guitar (close mics keep the region geometry). The correction is averaged over the three bodies and spatially smoothed, so each body keeps its own fine high-frequency lobes. On a stand, directions toward where the player would be fall back to the model.

**Rooms.** An image-source model (Allen & Berkley) with randomized higher-order images traces reflections up to the mixing time. Each reflection is attenuated per octave by each wall's absorption (and scattering), per ray by the direction it left the guitar (the top beams forward as frequency rises, the back radiates backward, the player absorbs) and by the mic's pattern in the arrival direction, and by air absorption (ISO 9613-1). A late tail follows with per-octave Eyring decay at energy rate 4πc/V (which integrates to Barron's 16π/A), so the direct-to-reverberant balance follows distance on its own. Tails at the two mics are coherent according to their spacing, following sin(kd)/kd. The result is two stereo impulse responses (for the top side and the back side) rendered in a worker and played through native convolvers. Room presets are calibrated to measured reverb times: booth 0.11 s, living room 0.56 s, bedroom 0.35 s, tiled bath 0.92 s, studio 0.53 s, recital hall 1.36 s, Boston-like hall 1.79 s, stone church 5.2 s, plus outdoors over grass.

### 3. The hand (`src/strum.js`)

- **Gather**: notes within a short window (default 18 ms) form one chord.
- **Voice**: a fingering search places them on the neck — span, barre feasibility (a barre can't cover an open string), open strings, string order, interior mutes, voice leading from the previous position.
  - *As played*: exactly your notes.
  - *Guitar shape*: your chord's pitch classes, bass and top note expanded into a full 4–6 string shape (C3 E3 G3 → x32010, B2 D4 F#4 → x24432).
- **Strum**: the pick crosses the strings in order, about 35–55 ms for a six-string downstroke (measured strums: 26–62 ms, Freire et al. 2018). Stroke time shrinks with velocity; each string holds the pick briefly (heavier strings longer), so later strings land slightly later; upstrokes are lighter and mostly catch the treble strings; muted strings inside the shape give a dead "chk".
- **Direction — pendulum model**: a strumming arm swings down and up every subdivision whether or not it touches the strings. The engine estimates the subdivision from your timing and sets each strum's direction by how many swings have passed. Quarter notes stay downstrokes; 8ths alternate.
- **Fingerstyle**: thumb on the bass strings, fingers on the rest, plucked nearly together.
- **Hand hold**: a released chord keeps ringing ~160 ms so strums connect; strings a new chord doesn't use are muted.

### 4. The pick (`pickModel` in `src/modal.js`)

A flat pick is a short cantilever held between thumb and finger. Each pick is specified by material (Young's modulus, density, loss factor, friction against the string, surface hardness), thickness, tip width, edge radius, and how much tip shows past the grip. For every pluck a quasi-static force balance finds where the string slips off:
- The string pushes on the pick face with stiffness Ks = T·L/(x(L−x)). The pick bends (tip stiffness 3EI/ℓ³), tilting its face.
- With the player's attack angle and the friction angle atan μ, the string slides toward the tip and leaves when it reaches it. That sets the release displacement (loudness) and direction (more perpendicular to the top for a flexing pick).
- Release time is the edge radius divided by the slip speed, where the bent pick's recoil adds its component along the face. Standard picks are cut square and polished (edge ~0.15 mm whatever their thickness); bevelled picks are rounder.
- Surface hardness (Hertz contact): the string dents the tip by dc = (9F²/(16 R E*²))^(1/3). Hard plastics dent ~10 µm; leather ~0.15 mm, rubber ~0.7 mm, felt ~1.5 mm. A soft tip takes up part of the pick's travel, lets go over the time the dent takes to unload, and touches a wider stretch of string. The tip hardness can be set on its own (Shore A/D scale).
- The pick's own flap after release rings at its cantilever frequency and decays at its material's loss factor.

Effects are taken relative to a medium celluloid pick, which keeps the engine's calibration to real strums. Predictions: thin and loosely held picks give up the string earlier (−2 to −7 dB) and push it more into the top; slick Delrin releases earlier than celluloid; thick and hard picks are louder (as Carral & Paset measured, 0.46 vs 2 mm). Bevelled, leather, rubber and felt picks are progressively darker. A thinner pick also passes through a strum faster. Only Carral & Paset have measured pick effects on a guitar, so these magnitudes are model predictions.

### 5. The plucking hand (`src/hand.js`)

Choose **Pattern**, a style and a tempo, and hold a chord: the right hand plays it the way a guitarist would. Fourteen styles: classical arpeggios (p-i-m-a-m-i, Giuliani p-i-m-i with a rest-stroke bass, planted p-i-m-a), tremolo (p-a-m-i), Travis picking, folk p-i-m-i, ballad pinch, bossa nova, bluegrass boom-chuck and crosspicking (flatpick), clawhammer, flamenco rumba, soleá compás (12 beats, rasgueado and golpe on 3, 6, 8, 10, 12) and alzapúa.

- **Strings to fingers.** Roles come from the voicing: the root bass, an alternate bass (preferring the chord's 5th), the three highest chord strings. Fingers keep home strings (p on the bass, i/m/a on strings 3/2/1). Notes played over a running pattern are melody: they take a string of their own, the pattern leaves it alone, and the finger follows the classical crossing rules (alternate; i→m→a to a higher string, a→m→i to a lower one), with a rest stroke when the next string isn't needed.
- **Timing**, two levels:
  - A slow drift of the whole hand against the beat (AR(1), ρ 0.9). Heijink & Meulenbroek (2002) found most of professionals' 18–24 ms onset scatter was whole-pattern shifts.
  - Note-to-note jitter SD = √(4² + (k·IOI)²) ms. At student skill this reproduces Nézio Malta's (2012) measured arpeggio (185 ± 16 ms against 184 ± 17 ms) and tremolo (100 ± 13 ms against 94–99 ± 20–25 ms).
  - The ring finger is slightly late. Tremolo's gap before the thumb is longer for weaker players.
- **Plucked chords** spread first-to-last ~10 ms (tight player) to ~25 ms (loose), in a fixed finger order per player (Nézio Malta 2012). Louder notes land a little earlier (Goebl 2001).
- **Dynamics.** Per-pluck SD 1.9 dB (professional) to 3 dB (student). The middle finger is loudest and the ring finger weakest; the thumb is softer in accompaniment and louder where the bass is voiced. Accents are +3.5 dB and slightly early. A rest stroke is +2.5 dB and drives the string more perpendicular to the top. Nails touch 1–3 mm of string, flesh 8 mm.
- **Limits.** The same finger repeats no sooner than 140–180 ms (thumb 110 ms); a finger pushed past that arrives late and softer. Finger independence falls above ~3 Hz and is lowest for the ring finger (Häger-Ross & Schieber 2000), raising stray contacts.
- **Contacts.**
  - A rest stroke lands on the next string toward the bass (toward the treble for the thumb) and damps it 20–40 ms later.
  - A free-stroke follow-through occasionally grazes that string: a faint note, a brief damping if it is ringing, or a dead tick if muted.
  - The ring finger is sometimes dragged along by the middle finger.
  - In alternating-bass styles the thumb settles on the next string.
  - Sequential planting mutes a string just before it is plucked.
  - Rare slips: a miss, the neighbouring string instead, or a late soft note.
  - Rates scale with skill and the *Stray contacts* control. No study has measured these rates on guitar, so they are estimates (about 0.3% of plucks for a professional, 3% for an amateur).
- **Rasgueado.** The fingers flick out in turn (e-a-m-i). Each nail sweeps the strings in ~45 ms, and successive sweeps overlap across ~290 ms, as in Laurson, Välimäki & Penttinen's (2010) measurement. A sweep only skims a ringing string (~90% survives). Golpe is a half-sine force pulse into the top.
- **Feel.**
  - Swing shrinks toward straight as tempo rises (Friberg & Sundström 2002; Honing & de Haas 2008).
  - Bluegrass pushes slightly ahead of the beat.
  - Bossa off-beats come ~2.5% of a beat early (Brazilian microtiming, Gouyon 2007).
- **Tempo** comes from the slider or from MIDI clock; MIDI Start realigns the pattern. Chord pads latch the pattern (tap the playing chord to stop), and the sustain pedal keeps it going after keys are released.

### 6. The fretting hand's own sounds (`friction`, `glide` in `src/modal.js`; `departure`, `arrival`, `tryGlide` in `src/strum.js`)

No sample or noise layer is added on top. The incidental sounds come from the hand's motion acting on the string:

- **Friction on a winding.** A fingertip moving along a wound string sinks into each groove and is pushed out by the next wrap: one smooth force pulse per wrap, at f = speed / winding pitch (wrap wire 0.18–0.36 mm on a bronze set, 0.12–0.16 mm on nylon basses).
  - The force acts along the string's axis, so it drives the string's own longitudinal modes. These push on the bridge, and from there the body, mics and room carry it like every other sound; a little is heard straight from the fingertip.
  - This reproduces what Pakarinen, Penttinen & Bank (2007) measured: lowpass noise with time-varying harmonics set by the sliding speed, and fixed peaks from the longitudinal modes.
  - Plain strings only hiss faintly.
- **Modulation.** *Finger noise* (0–200%, 100% = the level measured in GuitarSet) scales the finger sound live; MIDI CC2 (breath) rides it. Aftertouch (channel or polyphonic) sets how hard the finger presses the string while it slides, up to 2.5×. That changes the contact itself (more ridges catch: louder and grittier), and it takes effect mid-slide.
- **Calibrated against real slides.** GuitarSet (Xi et al. 2018, CC BY 4.0) recorded an acoustic steel-string guitar with a microphone and annotated every string's pitch. `proto/gs_slides.py` finds 437 genuine slides on the wound strings (≥ 2 semitones, 15–150 ms per semitone, no instantaneous jumps): median 168 ms for 2.5 frets (10–90%: 70–325 ms).
  - `proto/gs_squeak.py` masks every harmonic of every sounding note and measures what the slide adds. In 226 slides with a clear finger sound, it sits ~21 dB below the note's harmonics and is bright: concentrated at 4–8 kHz, with a centroid near 6 kHz *whatever the hand speed*. Below 4 kHz the note's own partials hide it.
  - `test/gs_model_slides.js` plays the same slides (string, frets, duration) through the synth and the same analysis is applied, using the synth's own pitch track. The fit showed:
    - The friction must shake the string sideways, a millimetre or two from the stopping fret, which favours its high overtones.
    - The contact's own radiation carries the top octave.
    - The string's longitudinal path must stay small; it gave the boxy ~1 kHz "zip" real slides don't have.
    - Fret crossings are knocks of a few millinewtons.
  - The fitted model matches the real finger sound within 1.4 dB rms across 4–12.5 kHz, with the same fixed ~6 kHz centroid at every hand speed. Slide timing was matched to the recorded durations.
 (Flash & Hogan 1985), with its bell-shaped speed profile, so a squeak rises in pitch and falls again: about 2 kHz as the hand accelerates, 3 kHz at full speed, under 1 kHz as it settles, for a 4-fret move on the low E.
- **Gestures.** A keyboard reveals the next chord only when it arrives, so a change becomes two physical events:
  - *Departure*: on letting go of a chord, fingers on wound strings drag briefly as the hand lifts away, the pressure fading out.
  - *Arrival*: on a chord needing a position shift, the guide finger (one staying on its string) slides into place, slowing and pressing down as the strum begins.
  - Weaker players squeak more often and harder.
- **Fretted glides.** A new single note pressed while the previous one is still held (up to 7 semitones, on a string that reaches both) slides along the string instead of being plucked.
  - The string is stopped by whichever fret lies just ahead of the finger, so pitch moves in semitone steps as the finger crosses each wire. Steps are quick mid-move and slow at the ends, following the minimum-jerk path.
  - Each crossing loses a little energy and bumps the bridge.
  - The winding sings under the pressed finger.
  - **Speed varies like a player's:**
    - Longer slides take longer but cover more ground per second, roughly with the log of the distance.
    - Press the new note harder and the slide snaps there; softly and it drifts: a 3-fret slide takes ~150 ms when struck firmly, ~270 ms when soft.
    - Each slide differs from the last (log-normal spread, wider for a weaker player).
    - In a running pattern slides scale with the tempo.
    - The point of peak speed moves too: a snap rushes early and coasts in, a lazy slide starts slowly and arrives in a hurry (time-warped minimum-jerk, peak at 1/3–2/3 of the move).
    - *Slide speed* sets the overall pace; MIDI CC5 (portamento time) controls it live and CC65 (portamento on/off) toggles legato slides.
  - This staircase is what separates a fretted glide from a slide guitar's continuous one.

### 7. Hammer-ons and pull-offs (`legatoNote` in `src/modal.js`; `tryGlide` in `src/strum.js`)

The ringing string keeps its motion and changes length at once; that is the legato.
- **Hammer-on.** The fretting finger strikes the string onto a higher fret. The push is short and soft (fingertip, ~1.5 ms, ~8 mm wide), into the top, right at the new end of the vibrating length. The fingertip also knocks the fretboard, reaching the body through the neck. It comes out ~5 dB below a picked note, and darker.
- **Pull-off.** The finger leaves by plucking the string sideways where it was pressing. On the now-longer string that point lies near the end, so the pluck is thin and bright, ~2–3 dB below a picked note. Pull-offs to an open string work.
- **Choosing the technique.** A new single note pressed while the previous one is held:
  - up to 4 semitones away (within the hand's reach) is a hammer-on going up or a pull-off going down;
  - wider intervals, up to 7, slide.
  - A soft legato note leans toward hammer/pull (up to 6 semitones), a firm one toward sliding (from 3).
  - Overrides:
    - the *Legato* selector (Auto / Slides / Hammer-ons & pull-offs / Off);
    - MIDI CC68 (legato pedal: slide while held);
    - CC65 (legato on/off);
    - keyswitch notes C1 (auto), C♯1 (slides), D1 (hammer/pull), D♯1 (off).
  - Trills come out as alternating hammer-ons and pull-offs.

### 8. Yngwie mode (`src/lines.js`; `lineTick` in `src/hand.js`)

A pattern style that plays generated neoclassical lead lines over the held chord, after Yngwie Malmsteen's playing as documented in transcriptions and slow-motion analyses. *Documented* rules come from those sources. *Estimated* numbers are my reading of recordings, and the generator's choices are random within them.
- **Harmony (documented).** A minor chord is i: harmonic minor, with natural minor in some descending sequences. A major chord is V of the minor key a fourth above: Phrygian dominant, never the natural 7th. A diminished chord is vii°7 of the minor key a semitone above; its cells move in minor thirds. Over a V chord, the diminished seventh on its third (the V7♭9 sound) also appears.
- **Picking (documented: Troy Grady's *Cracking the Code*; Guitar Interactive).** Downward pickslanting. Upstrokes escape the strings, so string changes come after upstrokes. After a downstroke the pick can only go on to the next higher string, with another downstroke (a sweep). A descending change after a downstroke turns the last note on the old string into a pull-off; where that can't happen, the pick hops the string and loses a few ms. Every figure and every new string in a run starts on a downstroke. The first note of each group is accented (+15–25 %, estimated). The previous string is damped at each change.
- **Figures (documented).**
  - single-string sixes (3-1-2-3-2-1 degrees, moving down a scale step);
  - single-string fours;
  - two-string descending sixes (down-up-pull-off per string);
  - Bach-style pedal point on the top string;
  - the three-string sweep loop (D D D U pull-off U);
  - ascending five-string arpeggios with a hammer-on on the A string, landing on the top note;
  - diminished cells across E-B-G (U U D) climbing in minor thirds;
  - three-note-per-string runs;
  - trills ending in a turn.
- **Phrasing (estimated).**
  - A phrase goes: an optional slow statement, a burst of 1–3 figures, a run or arpeggio into a long note, then a breath.
  - The long note gets wide one-sided vibrato (~4.6–5.9 Hz, +60–80 cents, starting 120–300 ms late and easing in). Sometimes it is instead picked a whole step low and bent up in 80–150 ms.
  - Runs rush toward their target: the first quarter is 8–15 % slow and the end fast.
  - Landings are within ~20 ms of the beat, or 40–80 ms late after a small stall one time in five.
  - Per-note jitter is 3–6 ms, by skill.
- **Tempo and intensity.** Sextuplets at 120 BPM give 12 notes/s, his usual rate; above ~150 BPM the figures go to sixteenths. How hard you play the chord sets the intensity. Softly, it sings in sixteenths with longer held notes. Hard, it chains more figures in sextuplets. On acoustic, density is about 40 % lower than on his electric records.
- **Pick.** Choosing the style selects his pick, a 1.5 mm Delrin (Dunlop YJM) with a bevelled edge. You can change it afterwards. He tunes down a half step; the synth stays at concert pitch.
- **Engine support.** `sbend`: a per-string bend with a smooth rise and optional release. Bends and vibrato sent with a pluck now survive its pick-contact delay.

## Controls

- MIDI: notes, sustain (CC64 = let ring / latch the pattern), soft pedal (CC67 = palm mute), mod wheel (stroke time), pitch bend (±2 st), portamento time (CC5 = slide speed), portamento on/off (CC65 = legato on/off), legato pedal (CC68 = slide while held), keyswitches C1–D♯1 (legato mode), breath (CC2 = finger-noise level), aftertouch (finger pressure while sliding), clock (pattern tempo).
- Computer keys: `A W S E D F T G Y H U J K O L P ;` play notes, `Z`/`X` octave, `Space` sustain, `Shift` palm mute, `1`–`0` chord pads, `[` `]` down/up strum.
- Phone: chord pads, ↓/↑ pads, or swipe across the strings (down the screen = downstroke). Tap the neck to fret a string.
- Record captures the exact output to a 48 kHz WAV.

## CPU

Measured in Chromium (renderer process, % of one core):

| Situation | Before | Now (Light) | Full |
|---|---|---|---|
| Idle, living room | 34% | 7% | — |
| Travis pattern playing, living room | 42% | 28% | — |
| Playing, stone church | 55% | 32% | 53% |
| Playing, concert hall | 45% | 35% | 41% |

- **Always on, no change in sound.**
  - The neck view redraws only when something moves (at most ~30 fps; a still picture at 60 fps cost ~10%).
  - The engine skips the body, radiation and mic work when every string is still, the body has rung out and nothing is queued: silence costs 0.2% instead of 9%.
- **CPU: Light (default) / Full** (in *MIDI & recording*).
  - Light caps reverb tails at 2.5 s with a fade. A 5-second church decay is already ~29 dB down by then, so what goes is the long, quiet tail after you stop.
  - Light also feeds the guitar's back-side sound into the top-side reverb instead of a second one, and uses a 6-ridge finger contact instead of ~15 (same total force).
  - Full restores 6 s tails, separate top/back reverbs and the full contact.
- **Other costs**, measured on the engine alone in Node:
  - a stereo mic pair +1.7%;
  - sympathetic strings +1.1%;
  - a slide in progress +5% (Full) while it lasts;
  - Eco quality, picked automatically on slow devices, −2%.

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
- Nézio Malta, L. (2012), *Regularidade e simultaneidade na técnica violonística de mão direita*, MA dissertation, UFMG (hexaphonic measurements of arpeggio, tremolo and block-chord timing and level).
- Heijink & Meulenbroek (2002), on the complexity of classical guitar playing, J. Motor Behavior 34.
- Häger-Ross & Schieber (2000), quantifying the independence of human finger movements, J. Neuroscience 20; Zatsiorsky, Li & Latash (2000), enslaving effects, Exp. Brain Res. 131; Aoki & Kinoshita (2001), Ergonomics.
- Laurson, Välimäki & Penttinen (2010), simulating idiomatic playing styles in a classical guitar synthesizer: rasgueado, DAFx.
- Goebl (2001), melody lead in piano performance, JASA 110; Maidhof et al. (2009), PLoS One (errors late and soft).
- Wing & Kristofferson (1973), the timing of interresponse intervals; Vorberg & Wing (1996); Repp (2005), sensorimotor synchronization review.
- Friberg & Sundström (2002), swing ratios and ensemble timing in jazz, Music Perception 19; Honing & de Haas (2008), Music Perception 25; Gouyon (2007), microtiming in samba de roda, SBCM.
- Carral & Paset (2008), plectrum thickness and the radiated sound of the guitar, Acoustics'08; Perng, Smith & Rossing (2010), harpsichord plectrum–string interaction, DAFx; Chadefaux et al. (2012), harp plucking, JASA 131.
- Xi, Bittner, Pauwels, Ye & Bello (2018), GuitarSet: a dataset for guitar transcription, ISMIR (data: doi 10.5281/zenodo.3371780).
- Pakarinen, Penttinen & Bank (2007), analysis of handling noises on wound strings, JASA 122 EL197; Pakarinen, Puputti & Välimäki (2008), slide guitar synthesizer with gestural control, NIME.
- Flash & Hogan (1985), the coordination of arm movements: minimum-jerk model, J. Neuroscience 5.
- Niedt, D., choosing right-hand fingering (crossing rules); Werner, S., planting; Tennant, *Pumping Nylon*.
- Pakarinen, Penttinen & Bank (2007), handling noises on wound strings, JASA-EL.
- Carcagno, Bucknall, Woodhouse, Fritz & Plack (2018), effect of back wood choice on steel-string guitars, JASA.
- Brémaud et al. (2012), vibrational properties of 98 woods; Stephens (2015), finish effects, Savart Journal; Hess (2013), Savart Journal.
- Le Carrou, Paté & Chomette (2019), influence of the player on guitar dynamics, JASA.
- Ackermann, Brinkmann, Zotter, Kob & Weinzierl (2024), "A database with directivities of musical instruments," JAES; data doi 10.14279/depositonce-5861.3.
- Weinzierl, Vorländer et al. (2017), "A database of anechoic microphone array measurements of musical instruments," TU Berlin.
- Allen & Berkley (1979), image method; De Sena et al. (2015), randomized image method; Barron & Lee (1988), energy relations; Wenmaekers et al. (2014), air absorption.
- Hodgkinson, Timoney & Lazzarini (2010), tension-modulated steel-string partial tracks, DAFx.
- Grady, T., *Cracking the Code*: "Yngwie Malmsteen's rotational picking mechanic" (Guitar World) and the Volcano seminar on the six-note pattern (troygrady.com); Guitar Interactive tech session with Yngwie Malmsteen; Premier Guitar, "How Yngwie Malmsteen unleashes the fury" and "Inside the harmonic minor scale"; Vintage Guitar, "Fretprints: Yngwie Malmsteen"; Guitar Player, position shifts and alternate picking; Dunlop YJM 1.5 mm Delrin pick specification.
