"""Distribution-level comparison of synth vs real notes (partials 1..14):
median and IQR of log10 T60, mean beat depth, residual attack energy."""
import sys, json, numpy as np
sys.path.insert(0, '../test')
from partials import analyze
REF = '/tmp/claude-0/refs/tonejs-instruments/samples/guitar-acoustic/'
def stats(a, n=14):
    P = a['parts'][:n]
    t = np.array([p['t60_early'] for p in P]); t = t[(t > 0) & (t < 90)]
    lt = np.log10(t)
    b = np.nanmean([p['beat_db'] for p in P])
    rel = np.array([p['rel'] for p in P])
    return dict(t60_med=10 ** np.median(lt), t60_iqr=np.subtract(*np.percentile(lt, [75, 25])), beat=b,
                hi_lvl=np.mean(rel[5:12]), att=a['resid_rel_db']['0-0.01'])
def compare(pairs):
    rows = []
    for ref, syn, m in pairs:
        a, b = stats(analyze(REF + ref, m)), stats(analyze(syn, m))
        rows.append((ref, a, b))
        print(f"{ref:7s} T60med {a['t60_med']:5.2f}/{b['t60_med']:5.2f}  spread {a['t60_iqr']:.2f}/{b['t60_iqr']:.2f}  beat {a['beat']:.2f}/{b['beat']:.2f} dB  hi-partials {a['hi_lvl']:6.1f}/{b['hi_lvl']:6.1f} dB  attack-resid {a['att']:5.1f}/{b['att']:5.1f}")
    return rows
if __name__ == '__main__':
    O = sys.argv[1]
    compare([('E2.wav', O + '_E2.wav', 40), ('D3.wav', O + '_D3.wav', 50), ('E4.wav', O + '_E4.wav', 64)])
