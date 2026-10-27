"""Measure real strums: per-strum attack spread (from a fine high-frequency onset function), level and brightness,
split by down/up. usage: python3 test/strums.py audio.wav labels.strums [more pairs]"""
import sys, numpy as np, scipy.io.wavfile as wavfile
from scipy.signal import butter, sosfiltfilt, find_peaks

def load(p):
    sr, x = wavfile.read(p); x = x.astype(float)
    if x.ndim > 1: x = x.mean(1)
    return sr, x / (np.abs(x).max() + 1e-12)

def strum_metrics(x, sr, t):
    sos = butter(4, [1500, 9000], 'band', fs=sr, output='sos')
    hf = sosfiltfilt(sos, x)
    hop = int(0.0005 * sr)
    w0, w1 = int((t - 0.06) * sr), int((t + 0.12) * sr)
    if w0 < 0 or w1 > len(x): return None
    seg = hf[w0:w1] ** 2
    env = np.sqrt(np.convolve(seg, np.ones(hop * 2) / (hop * 2), 'same'))[::hop]
    # attack rise: broadband envelope (2 ms smoothing) from 10% to 90% of its peak near the label
    bb = x[w0:w1] ** 2
    k = int(0.002 * sr)
    env = np.sqrt(np.convolve(bb, np.ones(k) / k, 'same'))
    c = int(0.06 * sr)
    pkI = c - int(0.03 * sr) + np.argmax(env[c - int(0.03 * sr): c + int(0.08 * sr)])
    pv = env[pkI]
    i10 = pkI
    while i10 > 0 and env[i10] > 0.1 * pv: i10 -= 1
    i90 = i10
    while i90 < pkI and env[i90] < 0.9 * pv: i90 += 1
    rise = (i90 - i10) / sr
    spread = rise * 1000
    pk = []
    full = x[int((t - 0.01) * sr): int((t + 0.15) * sr)]
    S = np.abs(np.fft.rfft(full * np.hanning(len(full)))); f = np.fft.rfftfreq(len(full), 1 / sr)
    cen = (f * S).sum() / S.sum()
    lvl = 20 * np.log10(np.sqrt((full ** 2).mean()) + 1e-9)
    spread = (pk[-1] - pk[0]) * 0.5 if len(pk) > 1 else 0.0
    return dict(n_onsets=0, spread_ms=spread, rise_ms=rise * 1000, centroid=cen, level=lvl)

def run(pairs):
    out = {'D': [], 'U': []}
    for wav, lab in pairs:
        sr, x = load(wav)
        for line in open(lab):
            p = line.split()
            if len(p) < 2: continue
            m = strum_metrics(x, sr, float(p[0]))
            if m: out[p[1]].append(m)
    for k in ('D', 'U'):
        L = out[k]
        if not L: continue
        a = lambda key: np.median([m[key] for m in L])
        q = lambda key: (np.percentile([m[key] for m in L], 25), np.percentile([m[key] for m in L], 75))
        print(f"{k}: n={len(L)}  attack rise 10-90% {a('rise_ms'):.1f} ms (IQR {q('rise_ms')[0]:.1f}-{q('rise_ms')[1]:.1f})  "
              f"centroid {a('centroid'):.0f} Hz  level {a('level'):.1f} dB")
    return out

if __name__ == '__main__':
    a = sys.argv[1:]
    run(list(zip(a[0::2], a[1::2])))
