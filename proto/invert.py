"""Infer Re Y(f) of the real guitar's bridge from measured partial decays:  Re Y = (sigma - sigma_int) * L / T."""
import json, sys, numpy as np
sys.path.insert(0, '../test')
from partials import analyze
from modal_proto import valette_sigma, string_set
REF = '/tmp/claude-0/refs/tonejs-instruments/samples/guitar-acoustic/'
L, S, E = string_set('steel')
rows = []
for name, s_idx, midi in [('E2', 0, 40), ('A2', 1, 45), ('D3', 2, 50), ('G3', 3, 55), ('B3', 4, 59), ('E4', 5, 64)]:
    a = analyze(REF + name + '.wav', midi, n=24)
    m, T, d, wound, dc = S[s_idx]
    f0 = 440 * 2 ** ((midi - 69) / 12); mu = T / (2 * L * f0) ** 2
    for p in a['parts']:
        ts = [t for t in (p['t60_early'], p['t60_late']) if t == t and 0.1 < t < 60]
        if not ts: continue
        t60 = float(np.median(ts))
        sig = 6.91 / t60
        si = valette_sigma(np.array([p['f']]), mu, d, T, E, wound, 'steel', dc)[0]
        rows.append((p['f'], name, p['n'], t60, sig, si, (sig - si) * L / T))
rows.sort()
json.dump(rows, open('/tmp/claude-0/out/reY.json', 'w'))
print('  f(Hz)  note n   T60   sigma  sig_int   ReY(s/kg)')
for r in rows: print(f"{r[0]:7.0f} {r[1]:>3} {r[2]:2d} {r[3]:6.2f} {r[4]:6.2f} {r[5]:6.3f}  {r[6]:.4f}")
fs = np.array([r[0] for r in rows]); ys = np.array([max(r[6], 1e-5) for r in rows])
for lo, hi in [(70, 150), (150, 300), (300, 600), (600, 1200), (1200, 2400), (2400, 5000)]:
    sel = (fs >= lo) & (fs < hi)
    if sel.any(): print(f"band {lo}-{hi} Hz: median ReY {np.median(ys[sel]):.4f}  (n={sel.sum()})  p25 {np.percentile(ys[sel],25):.4f} p75 {np.percentile(ys[sel],75):.4f}")
