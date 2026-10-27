"""The sound of a finger sliding on a wound string, measured in GuitarSet's microphone recordings.

For each slide found by gs_slides.py: STFT of the mic signal; every harmonic of every note sounding at that moment
(from all six strings' pitch contours) is masked out; the remaining (inharmonic) energy during the slide is
compared with the same measure just before and after it. The excess is the finger-on-winding sound. Reports its
third-octave spectrum relative to the note's harmonic energy, its level, and whether its spectral peak follows
the hand speed (winding-rate hypothesis f = v / pitch).

usage: python3 -I proto/gs_squeak.py <slides.json> <mic dir> <annotation dir> <out.json> [--model <dir of model wavs>]
"""
import json, os, sys, wave
import numpy as np

slides = json.load(open(sys.argv[1])); mic_dir, ann_dir, out = sys.argv[2], sys.argv[3], sys.argv[4]
model_dir = sys.argv[sys.argv.index('--model') + 1] if '--model' in sys.argv else None
L = 0.645
BANDS = [500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500]

def read(path):
    hdr = open(path, 'rb').read(64)
    if hdr[20:22] == b'\x03\x00':   # IEEE float (fmt3): the synth's renders
        ch = int.from_bytes(hdr[22:24], 'little'); sr = int.from_bytes(hdr[24:28], 'little')
        x = np.frombuffer(open(path, 'rb').read()[44:], '<f4').astype(np.float64)
        return x.reshape(-1, ch).mean(1), sr
    w = wave.open(path); n = w.getnframes(); sr = w.getframerate(); ch = w.getnchannels(); sw = w.getsampwidth()
    raw = w.readframes(n)
    if sw == 2: x = np.frombuffer(raw, '<i2').astype(np.float64) / 32768
    elif sw == 4:
        x = np.frombuffer(raw, '<f4').astype(np.float64) if w.getcomptype() == 'NONE' and path.endswith('.f32.wav') else np.frombuffer(raw, '<i4').astype(np.float64) / 2 ** 31
    else: x = (np.frombuffer(raw, np.uint8).astype(np.float64) - 128) / 128
    return x.reshape(-1, ch).mean(1), sr

contours = {}
def contour(fn):
    if fn in contours: return contours[fn]
    j = json.load(open(os.path.join(ann_dir, fn + '.jams')))
    cs = []
    for a in j['annotations']:
        if a['namespace'] != 'pitch_contour': continue
        t = np.array(a['data']['time']); f = np.array([x['frequency'] if x['voiced'] else 0 for x in a['data']['value']])
        cs.append((t, f))
    contours[fn] = cs
    return cs

NFFT = int(os.environ.get('NFFT', 1024))
def analyse(x, sr, sl, cs):
    N, H = NFFT, 256   # short frames: fewer of them straddle a fret step
    win = np.hanning(N)
    fr = np.fft.rfftfreq(N, 1 / sr)
    def frame(tc):
        i = int(tc * sr) - N // 2
        if i < 0 or i + N > len(x): return None
        S = np.abs(np.fft.rfft(x[i:i + N] * win)) ** 2
        harm = np.zeros_like(S, bool)
        for (t, f) in cs:
            if len(t) == 0: continue
            k = np.searchsorted(t, tc)
            for kk in (k - 1, k, k + 1):     # neighbouring contour frames (the pitch moves during a slide)
                if 0 <= kk < len(t) and abs(t[kk] - tc) < 0.03 and f[kk] > 0:
                    f0 = f[kk]
                    # partials below 4 kHz, allowing for stretched overtones (wound strings, B ~ 1e-4)
                    for h in range(1, int(4000 / f0) + 1):
                        fh = h * f0 * np.sqrt(1 + 1e-4 * h * h)
                        harm |= np.abs(fr - fh) < 2.5 * sr / N + 0.006 * fh
        return S, harm
    # frames during the slide, and the reference frames before and after
    during = np.arange(sl['t0'], sl['t1'], H / sr)
    ref = np.concatenate([np.arange(sl['t0'] - 0.22, sl['t0'] - 0.04, H / sr), np.arange(sl['t1'] + 0.05, sl['t1'] + 0.22, H / sr)])
    def collect(times):
        res, har, n = np.zeros(len(fr)), 0.0, 0
        frames = []
        for tc in times:
            r = frame(tc)
            if r is None: continue
            S, harm = r
            res += np.where(harm, 0, S); har += S[harm & (fr > 70)].sum(); n += 1
            frames.append((tc, np.where(harm, 0, S)))
        return res / max(1, n), har / max(1, n), (~np.zeros(len(fr), bool)), frames
    rd, hd, _, fd = collect(during)
    rr, hr, _, _ = collect(ref)
    if hd <= 0: return None
    excess = np.maximum(0, rd - rr)
    bands = []
    for fc in BANDS:
        sel = (fr >= fc / 2 ** (1 / 6)) & (fr < fc * 2 ** (1 / 6))
        bands.append(10 * np.log10(excess[sel].sum() / hd + 1e-20))
    total = 10 * np.log10(excess[(fr > 400) & (fr < 14000)].sum() / hd + 1e-20)
    snr = 10 * np.log10((rd[(fr > 400) & (fr < 14000)].sum() + 1e-20) / (rr[(fr > 400) & (fr < 14000)].sum() + 1e-20))
    # does the excess's spectral peak follow the hand speed?
    tt, fret = np.array(sl['time']), np.array(sl['fret'])
    xs = L * (1 - 2 ** (-fret / 12))
    pairs = []
    sel = (fr > 700) & (fr < 12000)
    for tc, R in fd:
        v = abs(np.interp(tc + 0.012, tt, xs) - np.interp(tc - 0.012, tt, xs)) / 0.024
        E = np.maximum(0, R - rr)[sel]
        if E.sum() <= 0 or v < 0.05: continue
        pairs.append((v, float((E * fr[sel]).sum() / E.sum()), float(fr[sel][np.argmax(E)])))
    return {'bands': bands, 'total': total, 'snr': snr, 'pairs': pairs}

results = []
cache = {}
for sl in slides:
    fn = sl['file']
    path = os.path.join(model_dir, f"{fn}_{sl['t0']:.3f}.wav") if model_dir else os.path.join(mic_dir, fn + '_mic.wav')
    if not os.path.exists(path): continue
    if model_dir:
        x, sr = read(path); off = sl.get('model_offset', 0.6)
        sl2 = dict(sl); shift = sl['t0'] - off
        sl2['t0'] -= shift; sl2['t1'] -= shift; sl2['time'] = [t - shift for t in sl['time']]
        # the model's pitch track: the starting fret held from the pluck, the slide, then the target fret held
        f_open = 82.41 * [1, 1.335, 1.782, 2.378][sl['string']]
        tb = np.arange(0.06, sl2['t0'], 0.0058); ta = np.arange(sl2['t1'] + 0.0058, len(x) / sr, 0.0058)
        a, b = round(sl['from']), round(sl['to'])
        tt_ = np.concatenate([tb, np.array(sl2['time']), ta])
        ff_ = np.concatenate([np.full(len(tb), f_open * 2 ** (a / 12)), f_open * 2 ** (np.array(sl['fret']) / 12), np.full(len(ta), f_open * 2 ** (b / 12))])
        cs = [(tt_, ff_)]
        own = path[:-4] + '.json'
        if os.path.exists(own):   # the synth's own pitch track: fret steps exactly when they happened
            st = json.load(open(own))['steps']
            tt_ = np.arange(0.06, len(x) / sr, 0.0058)
            ff_ = f_open * 2 ** (np.array([[s_[1] for s_ in st if s_[0] <= t][-1] for t in tt_]) / 12)
            cs = [(tt_, ff_)]
        r = analyse(x, sr, sl2, cs)
    else:
        if path not in cache: cache = {path: read(path)}
        x, sr = cache[path]
        r = analyse(x, sr, sl, contour(fn))
    if r is None: continue
    r.update({'file': fn, 'string': sl['string'], 'dur': sl['t1'] - sl['t0'], 'dist': abs(sl['to'] - sl['from'])})
    results.append(r)

json.dump(results, open(out, 'w'))
good = [r for r in results if r['snr'] > 1.5] if '--all' not in sys.argv else results   # the slide clearly adds inharmonic energy
print(len(results), 'slides analysed;', len(good), 'with a clear finger sound (inharmonic energy up > 1.5 dB during the slide)')
if good:
    B = np.array([r['bands'] for r in good]); T = np.array([r['total'] for r in good])
    print('finger sound, total re the note harmonics: median %.1f dB (10-90%%: %.1f to %.1f)' % (np.median(T), np.percentile(T, 10), np.percentile(T, 90)))
    print('third-octave shape (median, dB re its own total):')
    shape = np.median(B - T[:, None], 0)
    print('  ' + ' '.join(f'{fc:>6}' for fc in BANDS)); print('  ' + ' '.join(f'{v:6.1f}' for v in shape))
    P = np.array([p for r in good for p in r['pairs']])
    if len(P) > 20:
        v, cen, pk = P[:, 0], P[:, 1], P[:, 2]
        c = np.corrcoef(np.log(v), np.log(cen))[0, 1]
        # speed bins: how the excess sound's centroid and peak move with hand speed
        for lo, hi in [(0.05, 0.2), (0.2, 0.4), (0.4, 0.7), (0.7, 1.2), (1.2, 3)]:
            m = (v >= lo) & (v < hi)
            if m.sum() > 10: print(f'  hand speed {lo:.2f}-{hi:.2f} m/s: centroid {np.median(cen[m]):6.0f} Hz, peak {np.median(pk[m]):6.0f} Hz (n={m.sum()})')
        for s in range(4):
            Ps = np.array([p for r in good if r['string'] == s for p in r['pairs']])
            if len(Ps) > 10: print(f'  string {s}: implied winding pitch (median v / peak) {np.median(Ps[:, 0] / Ps[:, 1]) * 1e3:.3f} mm, n={len(Ps)}')
        print('correlation of log centroid with log hand speed: %.2f (n=%d frames)' % (c, len(P)))
