"""Measured directivity of a guitar played by a person -> guitar-local coordinates.

Source: Ackermann, Brinkmann, Zotter, Kob & Weinzierl, "A database with directivities of musical instruments"
(JAES 2024; arXiv 2307.02110), data DOI 10.14279/depositonce-5861.3, file Acoustic_guitar_modern_3rdOctave.sofa
(Masaru Kohno 1985 "Concert" classical guitar, played by Hanjo Maempel in TU Berlin's anechoic chamber; 32-capsule
pentakis-dodecahedron array, radius 2.06 m; third-octave band averages over all notes played fortissimo).
License of the data: CC BY-NC-SA 4.0 (the derived table carries the same license).

Measurement frame: musician faces +x, +y is the player's left, +z up. The SOFA file notes "Normal of the soundboard
aimed slightly above Mic#04 (az 0, el -10.8); scroll aiming between Mic#09 and Mic#10 (az 108, el 52.6 / 10.8)".

Guitar-local frame used by the synth (src/space.js): x toward the neck, y across the top toward the bass side,
z out of the top.

usage: python3 -I proto/directivity.py <sofa> <out.json>
"""
import json, sys
import numpy as np
import h5py

sofa, out = sys.argv[1], sys.argv[2]
f = h5py.File(sofa, 'r')
freqs = f['N'][:]
rp = f['ReceiverPosition'][:]
mag = np.abs(f['Data.Real'][0] + 1j * f['Data.Imag'][0])        # (32 mics, 31 bands), Pa

az, el = np.radians(rp[:, 0]), np.radians(rp[:, 1])
U = np.stack([np.cos(el) * np.cos(az), np.cos(el) * np.sin(az), np.sin(el)], 1)

def unit(az_d, el_d):
    a, e = np.radians(az_d), np.radians(el_d)
    return np.array([np.cos(e) * np.cos(a), np.cos(e) * np.sin(a), np.sin(e)])

top = unit(0, -4.0)                                   # "slightly above Mic#04"
neck = unit(108, (52.62 + 10.81) / 2)                 # between Mic#09 and Mic#10
neck = neck - top * neck.dot(top); neck /= np.linalg.norm(neck)
bass = np.cross(top, neck)                            # y = z x x (right-handed x, y, z)
R = np.stack([neck, bass, top])                       # rows: local axes in the measurement frame
L = U @ R.T                                           # mic directions in guitar-local coordinates

# quadrature weights: solid angle of each mic's Voronoi cell (nearest-mic Monte Carlo on a Fibonacci sphere)
n = 200000
i = np.arange(n) + 0.5
phi = np.arccos(1 - 2 * i / n); th = np.pi * (1 + 5 ** 0.5) * i
P = np.stack([np.cos(th) * np.sin(phi), np.sin(th) * np.sin(phi), np.cos(phi)], 1)
w = np.bincount(np.argmax(P @ U.T, 1), minlength=32) / n

# keep 80 Hz .. 8 kHz (below: no partials; above ~10 kHz the band levels are isotropic, i.e. the noise floor)
keep = (freqs >= 80) & (freqs <= 8000)
fb = freqs[keep]
E = mag[:, keep] ** 2
third_db = 10 * np.log10(E / (w @ E))                 # per band: power average over the sphere = 0 dB

# octave bands 125 .. 8k from the three third-octaves around each centre (8k: 6.3k + 8k only)
OCT = [125, 250, 500, 1000, 2000, 4000, 8000]
oct_db = []
for fc in OCT:
    sel = (fb >= fc / 2 ** (1 / 3) * 0.99) & (fb <= fc * 2 ** (1 / 3) * 1.01) & (fb <= 8000)
    Eo = E[:, sel].sum(1)
    oct_db.append(10 * np.log10(Eo / (w @ Eo)))
oct_db = np.array(oct_db).T                           # (32, 7)

def di(db, k):   # directivity index toward local direction k
    return db
front = np.argmax(L[:, 2]); back = np.argmin(L[:, 2])
print('front mic local', L[front].round(2), 'back mic local', L[back].round(2))
print('octave  ' + ' '.join(f'{x:6d}' for x in OCT))
for name, sel in [('front hemisphere', L[:, 2] > 0.3), ('side band', abs(L[:, 2]) <= 0.3), ('back hemisphere', L[:, 2] < -0.3),
                  ('neck side', L[:, 0] > 0.5), ('tail side', L[:, 0] < -0.5), ('bass side (up)', L[:, 1] > 0.5), ('treble side (down)', L[:, 1] < -0.5)]:
    v = 10 * np.log10((w[sel, None] * 10 ** (oct_db[sel] / 10)).sum(0) / w[sel].sum())
    print(f'{name:18s}' + ' '.join(f'{x:6.1f}' for x in v))
print('spread (std over directions, dB):', np.round(oct_db.std(0), 1))

json.dump({
    'source': 'Ackermann et al. 2024, doi 10.14279/depositonce-5861.3, Acoustic_guitar_modern_3rdOctave.sofa (CC BY-NC-SA 4.0)',
    'radius': float(rp[0, 2]),
    'dirs': np.round(L, 4).tolist(), 'weights': np.round(w, 5).tolist(),
    'octaves': OCT, 'octave_db': np.round(oct_db, 2).tolist(),
    'thirds': fb.tolist(), 'third_db': np.round(third_db, 2).tolist(),
}, open(out, 'w'))
print('wrote', out)
