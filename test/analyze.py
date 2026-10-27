"""Compare synthesized guitar notes to real recordings.

For each file: onset, f0, inharmonicity B, per-partial initial level (relative to fundamental) and decay
(T60 from a linear fit to the dB envelope), spectral centroid over time, and a smoothed long-term spectrum.

usage: python3 test/analyze.py ref.wav synth.wav [more pairs...] --midi 40 --png out.png
"""
import sys, json, argparse
import numpy as np
import scipy.io.wavfile as wavfile
from scipy.signal import stft, get_window


def load(path):
    sr, x = wavfile.read(path)
    x = x.astype(np.float64)
    if x.ndim > 1:
        x = x.mean(1)
    if np.abs(x).max() > 2:
        x /= 32768.0
    return sr, x


def onset(x, sr):
    env = np.abs(x)
    thr = 0.12 * env.max()
    i = int(np.argmax(env > thr))
    # back up to where the attack begins
    w = int(0.004 * sr)
    j = i
    while j > w and np.abs(x[j - w:j]).max() > 0.02 * env.max():
        j -= w
    return j


def partial_track(x, sr, f0, npart=24, t_max=4.0):
    seg = x[: int(t_max * sr)]
    nfft = 16384
    hop = int(0.01 * sr)
    win = int(min(8192, max(2048, 8 * sr / f0)))
    f, t, Z = stft(seg, sr, window=get_window('hann', win), nperseg=win, noverlap=win - hop, nfft=nfft, boundary=None)
    M = np.abs(Z)
    # inharmonicity: refine each partial frequency from the early spectrum
    early = M[:, : max(3, int(0.6 / 0.01))].mean(1)
    freqs = []
    for n in range(1, npart + 1):
        fn = n * f0
        if fn > sr * 0.45:
            break
        lo, hi = fn * (1 - 0.03), fn * (1 + 0.05)
        sel = (f >= lo) & (f <= hi)
        if not sel.any():
            break
        k = np.argmax(early[sel])
        freqs.append(f[sel][k])
    freqs = np.array(freqs)
    ns = np.arange(1, len(freqs) + 1)
    # fit f_n = n f0' sqrt(1 + B n^2) on strong partials
    ratio = (freqs / (ns * freqs[0])) ** 2
    try:
        B = max(0.0, np.polyfit(ns[1:12] ** 2 - 1, ratio[1:12] - 1, 1)[0])
    except Exception:
        B = 0.0
    tracks = []
    for n, fn in zip(ns, freqs):
        k = np.argmin(np.abs(f - fn))
        band = M[max(0, k - 2): k + 3].max(0)
        tracks.append(20 * np.log10(band + 1e-9))
    return t, freqs, np.array(tracks), B, f, M


def fit_t60(t, db, t0=0.08, t1=2.5):
    sel = (t >= t0) & (t <= t1)
    if sel.sum() < 5:
        return np.nan
    tt, dd = t[sel], db[sel]
    # stop at noise floor
    floor = dd.max() - 55
    keep = dd > floor
    if keep.sum() < 5:
        return np.nan
    slope = np.polyfit(tt[keep], dd[keep], 1)[0]
    return -60.0 / slope if slope < -0.5 else 99.0


def analyze(path, midi=None):
    sr, x = load(path)
    o = onset(x, sr)
    x = x[o:]
    x = x / (np.abs(x).max() + 1e-12)
    f0 = 440 * 2 ** ((midi - 69) / 12) if midi is not None else None
    # refine f0 from spectrum near the expected value
    seg = x[int(0.05 * sr): int(1.05 * sr)]
    S = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), 1 << 18))
    fr = np.fft.rfftfreq(1 << 18, 1 / sr)
    sel = (fr > f0 * 0.94) & (fr < f0 * 1.06)
    f0m = fr[sel][np.argmax(S[sel])]
    t, freqs, tracks, B, f, M = partial_track(x, sr, f0m)
    init = tracks[:, (t > 0.02) & (t < 0.08)].max(1)
    rel = init - init[0]
    t60 = np.array([fit_t60(t, tr) for tr in tracks])
    # centroid over time
    cen = (f[:, None] * M).sum(0) / (M.sum(0) + 1e-12)
    cen_at = {str(tt): float(np.interp(tt, t, cen)) for tt in (0.05, 0.3, 1.0, 2.0)}
    # long-term spectrum (first 1.5 s), smoothed in 1/6 octave bands
    seg = x[: int(1.5 * sr)]
    P = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) ** 2
    pf = np.fft.rfftfreq(len(seg), 1 / sr)
    bands = 80 * 2 ** (np.arange(0, 7.5, 1 / 6))
    ltas = []
    for b in bands:
        s = (pf >= b * 2 ** (-1 / 12)) & (pf < b * 2 ** (1 / 12))
        ltas.append(10 * np.log10(P[s].mean() + 1e-20) if s.any() else np.nan)
    ltas = np.array(ltas)
    ltas -= np.nanmax(ltas)
    # attack: time to peak, and noise ratio in first 15 ms above 4 kHz
    a = np.abs(x[: int(0.1 * sr)])
    tpk = float(np.argmax(a) / sr)
    return dict(path=path, sr=sr, f0=float(f0m), cents=float(1200 * np.log2(f0m / f0)), B=float(B),
                rel=rel.tolist(), t60=t60.tolist(), centroid=cen_at, ltas=ltas.tolist(), bands=bands.tolist(),
                t_peak=tpk, tracks=tracks, t=t)


def report(a, b):
    n = min(len(a['rel']), len(b['rel']), 16)
    lines = [f"{'n':>3} {'ref dB':>7} {'syn dB':>7} {'refT60':>7} {'synT60':>7}"]
    for i in range(n):
        lines.append(f"{i+1:>3} {a['rel'][i]:7.1f} {b['rel'][i]:7.1f} {a['t60'][i]:7.2f} {b['t60'][i]:7.2f}")
    lines.append(f"f0 {a['f0']:.2f} vs {b['f0']:.2f} Hz ({b['cents']:+.1f} c synth vs nominal)  B {a['B']:.2e} vs {b['B']:.2e}")
    lines.append('centroid ' + ' '.join(f"{k}s:{a['centroid'][k]:.0f}/{b['centroid'][k]:.0f}" for k in a['centroid']))
    d = np.array(a['ltas']) - np.array(b['ltas'])
    bands = np.array(a['bands'])
    lines.append('LTAS ref-syn dB @ ' + ' '.join(f"{int(bands[i])}:{d[i]:+.0f}" for i in range(0, len(d), 3)))
    return '\n'.join(lines)


def plot(pairs, png):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(len(pairs), 3, figsize=(15, 3.2 * len(pairs)))
    if len(pairs) == 1:
        axes = axes[None]
    for r, (a, b) in enumerate(pairs):
        for c, z in enumerate((a, b)):
            ax = axes[r, c]
            for i in range(min(10, len(z['tracks']))):
                ax.plot(z['t'], z['tracks'][i] - z['tracks'][0].max(), lw=1, label=str(i + 1))
            ax.set_ylim(-80, 5); ax.set_xlim(0, 3.5)
            ax.set_title(('REF ' if c == 0 else 'SYN ') + z['path'].split('/')[-1], fontsize=9)
            if r == 0 and c == 0:
                ax.legend(ncol=5, fontsize=6)
        ax = axes[r, 2]
        ax.semilogx(a['bands'], a['ltas'], label='ref'); ax.semilogx(b['bands'], b['ltas'], label='syn')
        ax.set_ylim(-60, 3); ax.legend(fontsize=7); ax.set_title('1/6-oct spectrum, first 1.5 s', fontsize=9)
    fig.tight_layout(); fig.savefig(png, dpi=80)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='+')
    ap.add_argument('--midi', type=float, nargs='+', required=True)
    ap.add_argument('--png')
    args = ap.parse_args()
    pairs = []
    for i in range(0, len(args.files), 2):
        m = args.midi[i // 2] if len(args.midi) > 1 else args.midi[0]
        a, b = analyze(args.files[i], m), analyze(args.files[i + 1], m)
        print('==', args.files[i].split('/')[-1], 'vs', args.files[i + 1].split('/')[-1], 'midi', m)
        print(report(a, b))
        pairs.append((a, b))
    if args.png:
        plot(pairs, args.png)
