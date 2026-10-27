"""High-resolution partial analysis by heterodyne demodulation.

For each partial n: refine its frequency, mix the signal down by that frequency, lowpass, and read the complex
envelope a_n(t). From it:
  * level in dB over time, early decay rate (T60 over 0.05-0.6 s) and late decay rate (1-3 s)  -> double decay
  * beating depth (std of detrended dB envelope) and dominant beat rate
  * instantaneous frequency deviation over the first 300 ms (cents) -> pitch glide from tension modulation
Also a residual: the signal minus the resynthesized partials, giving the non-harmonic part (pick noise, body knock).

usage: python3 test/partials.py file.wav --midi 40 [--n 20] [--json out.json] [--png out.png]
"""
import argparse, json
import numpy as np
import scipy.io.wavfile as wavfile
from scipy.signal import butter, sosfiltfilt


def load(path):
    sr, x = wavfile.read(path)
    x = x.astype(np.float64)
    if x.ndim > 1:
        x = x.mean(1)
    if np.abs(x).max() > 2:
        x /= 32768.0
    return sr, x


def onset(x, sr):
    a = np.abs(x)
    thr = 0.1 * a.max()
    i = int(np.argmax(a > thr))
    w = int(0.002 * sr)
    j = i
    while j > w and np.abs(x[j - w:j]).max() > 0.01 * a.max():
        j -= w
    return j


def refine_freqs(x, sr, f0, n):
    seg = x[int(0.03 * sr): int(0.03 * sr) + int(1.0 * sr)]
    N = 1 << 19
    S = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), N))
    fr = np.fft.rfftfreq(N, 1 / sr)
    out = []
    est_B = 0.0
    for k in range(1, n + 1):
        guess = k * f0 * np.sqrt(1 + est_B * k * k)
        if guess > sr * 0.45:
            break
        sel = (fr > guess * (1 - 0.6 / k - 0.004)) & (fr < guess * (1 + 0.6 / k + 0.004))
        if not sel.any():
            break
        i = np.argmax(S[sel]) + np.argmax(sel)
        # parabolic interpolation
        if 0 < i < len(S) - 1:
            a, b, c = np.log(S[i - 1] + 1e-20), np.log(S[i] + 1e-20), np.log(S[i + 1] + 1e-20)
            d = 0.5 * (a - c) / (a - 2 * b + c)
        else:
            d = 0
        fk = (i + d) * sr / N
        out.append(fk)
        if k >= 3:
            ks = np.arange(1, k + 1)
            r = (np.array(out) / (ks * out[0])) ** 2 - 1
            est_B = max(0.0, np.polyfit(ks ** 2 - 1, r, 1)[0])
    return np.array(out), est_B


def track(x, sr, f, bw):
    t = np.arange(len(x)) / sr
    z = x * np.exp(-2j * np.pi * f * t)
    sos = butter(4, bw / (sr / 2), output='sos')
    zr = sosfiltfilt(sos, z.real)
    zi = sosfiltfilt(sos, z.imag)
    return 2 * (zr + 1j * zi)


def analyze(path, midi, n=20, tmax=3.5):
    sr, x = load(path)
    o = onset(x, sr)
    x = x[o: o + int(tmax * sr)]
    x = x / (np.abs(x).max() + 1e-12)
    f0n = 440 * 2 ** ((midi - 69) / 12)
    freqs, B = refine_freqs(x, sr, f0n, n)
    f0 = freqs[0]
    bw = min(0.45 * f0, 60)
    hop = int(0.005 * sr)
    res = x.copy()
    parts = []
    for k, fk in enumerate(freqs, 1):
        z = track(x, sr, fk, bw)
        amp = np.abs(z)
        db = 20 * np.log10(amp[::hop] + 1e-9)
        tt = np.arange(len(db)) * hop / sr
        # resynth for residual
        tfull = np.arange(len(x)) / sr
        res -= np.real(z * np.exp(2j * np.pi * fk * tfull))
        pk = db[(tt > 0.01) & (tt < 0.12)].max()
        def slope(t0, t1):
            sel = (tt >= t0) & (tt <= t1) & (db > pk - 70)
            if sel.sum() < 8:
                return np.nan
            s = np.polyfit(tt[sel], db[sel], 1)[0]
            return -60 / s if s < -0.3 else 99.0
        e_t60, l_t60 = slope(0.05, 0.6), slope(1.0, 3.0)
        # beating: residual of a linear fit in dB over 0.1-2.5 s
        sel = (tt > 0.1) & (tt < 2.5) & (db > pk - 60)
        beat_db, beat_hz = np.nan, np.nan
        if sel.sum() > 30:
            p = np.polyfit(tt[sel], db[sel], 2)
            r = db[sel] - np.polyval(p, tt[sel])
            beat_db = float(r.std())
            R = np.abs(np.fft.rfft(r * np.hanning(len(r)), 4096))
            fr = np.fft.rfftfreq(4096, hop / sr)
            m = fr > 0.2
            beat_hz = float(fr[m][np.argmax(R[m])])
        # pitch glide: instantaneous frequency over first 300 ms vs final
        ph = np.unwrap(np.angle(z[: int(0.6 * sr)]))
        inst = np.gradient(ph) * sr / (2 * np.pi)
        w = int(0.02 * sr)
        early = np.median(inst[int(0.01 * sr): int(0.04 * sr)])
        late = np.median(inst[int(0.4 * sr): int(0.55 * sr)])
        glide_c = 1200 * np.log2((fk + early) / (fk + late)) if amp[int(0.02 * sr)] > 1e-4 else np.nan
        parts.append(dict(n=k, f=float(fk), level=float(pk), t60_early=float(e_t60), t60_late=float(l_t60),
                          beat_db=beat_db, beat_hz=beat_hz, glide_cents=float(glide_c), env=db.tolist(), t=tt.tolist()))
    lv0 = parts[0]['level']
    for p in parts:
        p['rel'] = p['level'] - lv0
    # residual energy over time relative to total
    def band_e(sig, t0, t1):
        s = sig[int(t0 * sr): int(t1 * sr)]
        return 10 * np.log10((s ** 2).mean() + 1e-20)
    resid = {f'{t0}-{t1}': band_e(res, t0, t1) - band_e(x, t0, t1) for t0, t1 in ((0, 0.01), (0.01, 0.03), (0.03, 0.1), (0.1, 0.5))}
    # residual spectrum in first 30 ms
    seg = res[: int(0.03 * sr)]
    S = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), 8192)) ** 2
    fr = np.fft.rfftfreq(8192, 1 / sr)
    bands = [(50, 200), (200, 500), (500, 1500), (1500, 4000), (4000, 10000), (10000, 20000)]
    rspec = {f'{a}-{b}': float(10 * np.log10(S[(fr >= a) & (fr < b)].mean() + 1e-20)) for a, b in bands}
    mx = max(rspec.values())
    rspec = {k: round(v - mx, 1) for k, v in rspec.items()}
    return dict(path=path, f0=float(f0), B=float(B), parts=parts, resid_rel_db=resid, resid_spec=rspec)


def summary(a):
    lines = [f"{a['path'].split('/')[-1]}  f0={a['f0']:.2f}  B={a['B']:.2e}"]
    lines.append('  n   freq    rel   T60e   T60l  beat_dB beat_Hz glide_c')
    for p in a['parts']:
        lines.append(f"{p['n']:3d} {p['f']:7.1f} {p['rel']:6.1f} {p['t60_early']:6.2f} {p['t60_late']:6.2f} {p['beat_db']:7.2f} {p['beat_hz']:6.2f} {p['glide_cents']:7.1f}")
    lines.append('  residual (non-partial) energy rel. to total, dB: ' + ', '.join(f"{k}s:{v:.1f}" for k, v in a['resid_rel_db'].items()))
    lines.append('  residual spectrum first 30 ms (dB re max band): ' + ', '.join(f"{k}:{v}" for k, v in a['resid_spec'].items()))
    return '\n'.join(lines)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='+')
    ap.add_argument('--midi', type=float, nargs='+', required=True)
    ap.add_argument('--n', type=int, default=20)
    ap.add_argument('--json')
    ap.add_argument('--png')
    args = ap.parse_args()
    res = []
    for i, f in enumerate(args.files):
        m = args.midi[i] if len(args.midi) > 1 else args.midi[0]
        a = analyze(f, m, args.n)
        print(summary(a))
        res.append(a)
    if args.json:
        json.dump([{k: v for k, v in a.items()} for a in res], open(args.json, 'w'))
    if args.png:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        fig, axes = plt.subplots(len(res), 1, figsize=(13, 3.3 * len(res)))
        axes = np.atleast_1d(axes)
        for ax, a in zip(axes, res):
            for p in a['parts'][:12]:
                ax.plot(p['t'], np.array(p['env']) - a['parts'][0]['level'], lw=0.9, label=str(p['n']))
            ax.set_ylim(-75, 15); ax.set_xlim(0, 3.5); ax.set_title(a['path'].split('/')[-1], fontsize=9)
            ax.legend(ncol=12, fontsize=6, loc='upper right')
        fig.tight_layout(); fig.savefig(args.png, dpi=75)
