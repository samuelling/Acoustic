"""Prototype: modal string coupled to a modal body through the bridge admittance.

Physics
  String n-th transverse mode: f_n = n f0 sqrt(1 + B n^2), B = pi^3 E d^4 / (64 T L^2)
  Intrinsic damping (Valette & Cuesta): Q^-1 = Q_air^-1 + Q_ve^-1 + Q_te^-1
      Q_air^-1 = R / (2 pi mu f),  R = 2 pi eta + 2 pi d sqrt(pi eta rho_air f)
      Q_ve^-1  = 4 pi^2 mu E I delta_ve f^2 / T^2
      Q_te^-1  = const
      sigma_int = pi f Q^-1
  Bridge coupling (weak coupling, Gough / Woodhouse): a string end on admittance Y gives each mode a complex
  frequency shift  ds = -(T/L) * Y(w_n). With two polarizations the shift is the 2x2 matrix -(T/L) Y2(w_n);
  its eigenvalues give each partial two components with their own decay and pitch (-> double decay, beating);
  its eigenvectors say how a pluck in a given direction splits between them.
  Body admittance at the bridge: Y(w) = sum_k i w / (m_k (w_k^2 - w^2 + i w w_k / Q_k))  (+ dense high modes).
  Radiation: pressure ~ sum_k g_k * (modal velocity of body mode k), driven by the bridge force.
"""
import numpy as np

SR = 48000


def string_set(kind='steel'):
    # (open midi, tension N, diameter m, wound?, core diameter m)
    if kind == 'steel':  # 12-53 phosphor bronze light, 25.4" scale
        L = 0.645
        S = [(40, 107.0, 0.00135, True, 0.00043), (45, 125.0, 0.00107, True, 0.00038),
             (50, 132.0, 0.00081, True, 0.00033), (55, 132.0, 0.00061, True, 0.00028),
             (59, 103.0, 0.00041, False, 0.00041), (64, 103.0, 0.000305, False, 0.000305)]
        E = 2.0e11
    else:  # nylon normal tension, 650 mm
        L = 0.650
        S = [(40, 71.0, 0.00110, True, 0.00055), (45, 72.0, 0.00089, True, 0.00045),
             (50, 70.0, 0.00075, True, 0.00038), (55, 58.0, 0.00102, False, 0.00102),
             (59, 61.0, 0.00082, False, 0.00082), (64, 70.0, 0.00071, False, 0.00071)]
        E = 4.0e9  # nylon; wound bass strings: multifilament core, low bending stiffness
    return L, S, E


class Body:
    def __init__(self, modes, hf=None, inplane=0.25, cross=0.15, seed=3):
        """modes: list of (f, Q, m_eff_kg, radiation_gain). hf: dict(f0,f1,count,qlo,qhi,mlo,mhi,g)."""
        rng = np.random.default_rng(seed)
        self.f = [m[0] for m in modes]; self.Q = [m[1] for m in modes]
        self.m = [m[2] for m in modes]; self.g = [m[3] for m in modes]
        if hf:
            n = hf['count']
            fs = np.exp(np.linspace(np.log(hf['f0']), np.log(hf['f1']), n)) * (1 + (rng.random(n) - 0.5) * 0.15)
            for i, f in enumerate(fs):
                t = i / n
                self.f.append(f); self.Q.append(hf['qlo'] + (hf['qhi'] - hf['qlo']) * rng.random())
                self.m.append(hf['mlo'] * (hf['mhi'] / hf['mlo']) ** t * np.exp(rng.normal(0, 0.5)))
                self.g.append(hf['g'] * rng.choice([-1, 1]) * (0.5 + rng.random()))
        self.f = np.array(self.f); self.Q = np.array(self.Q); self.m = np.array(self.m); self.g = np.array(self.g)
        n = len(self.f)
        # in-plane participation per mode (random-ish around `inplane`), and cross coupling
        self.ry = inplane * (0.4 + 1.2 * rng.random(n))
        self.rc = cross * (rng.random(n) * 2 - 1)

    def Y(self, w):
        """2x2 admittance matrix [[Yyy, Yyz],[Yzy, Yzz]] at angular frequency w (z = perpendicular to top)."""
        wk = 2 * np.pi * self.f
        modal = 1j * w / (self.m * (wk ** 2 - w ** 2 + 1j * w * wk / self.Q))
        # each body mode moves the bridge in a direction (y,z) = (ry, 1) scaled; outer product gives the matrix
        yy = np.sum(modal * self.ry ** 2); zz = np.sum(modal); yz = np.sum(modal * self.rc)
        return np.array([[yy, yz], [yz, zz]])


def valette_sigma(f, mu, d, T, E, wound, kind, dcore=None):
    eta, rho = 1.8e-5, 1.2
    R = 2 * np.pi * eta + 2 * np.pi * d * np.sqrt(np.pi * eta * rho * f)
    q_air = R / (2 * np.pi * mu * f)
    if kind == 'steel':
        I = np.pi * (dcore if dcore else d) ** 4 / 64
        delta = 0.012 if wound else 0.0025
        q_te = 2.0e-4 if not wound else 0.5e-4
    else:
        I = np.pi * d ** 4 / 64
        delta = 0.06 if wound else 0.02
        q_te = 0.0
    q_ve = 4 * np.pi ** 2 * mu * E * I * delta * f ** 2 / T ** 2
    return np.pi * f * (q_air + q_ve + q_te)


def string_modes(s_idx, fret, body, kind='steel', fmax=11000, B_scale=1.0):
    L0, S, E = string_set(kind)
    midi, T, d, wound, dcore = S[s_idx]
    f_open = 440 * 2 ** ((midi - 69) / 12)
    mu = T / (2 * L0 * f_open) ** 2
    L = L0 * 2 ** (-fret / 12)
    f0 = 440 * 2 ** ((midi + fret - 69) / 12)
    Ecore = E * (1.0 if kind == 'steel' else (0.3 if wound else 1.0))
    B = B_scale * np.pi ** 3 * Ecore * dcore ** 4 / (64 * T * L ** 2)
    n = np.arange(1, int(fmax / f0) + 1)
    fn = n * f0 * np.sqrt(1 + B * n ** 2)
    n = n[fn < fmax]; fn = fn[fn < fmax]
    sig_int = valette_sigma(fn, mu, d, T, Ecore, wound, kind, dcore)
    modes = []  # per partial: two components (complex s, eigvec)
    for k, f in zip(n, fn):
        w = 2 * np.pi * f
        M = -(T / L) * body.Y(w)
        ev, V = np.linalg.eig(M)
        for j in range(2):
            s = 1j * w + ev[j] - sig_int[k - 1]
            modes.append((k, s, V[:, j]))
    return dict(L=L, T=T, mu=mu, f0=f0, B=B, modes=modes)


def pluck(sm, xp_frac=0.2, theta=0.25, h=0.002, tau_r=1.5e-4, width=0.002):
    """Initial amplitudes for a triangular pluck at xp (fraction of speaking length), polarization angle theta
    (radians from the top's plane), released over tau_r seconds, contact width `width` (m)."""
    L, T = sm['L'], sm['T']
    xp = xp_frac * L
    dirv = np.array([np.cos(theta), np.sin(theta)])  # (y parallel, z perpendicular)
    amps = []
    for (k, s, v) in sm['modes']:
        a = 2 * h * L ** 2 / (np.pi ** 2 * k ** 2 * xp * (L - xp)) * np.sin(k * np.pi * xp / L)
        a *= np.sinc(k * width / (2 * L))
        w = abs(s.imag)
        a *= 1 / np.sqrt(1 + (w * tau_r / 2.2) ** 4)
        amps.append(a)
    # project direction onto the eigenvector pair of each partial
    out = []
    for i in range(0, len(sm['modes']), 2):
        V = np.column_stack([sm['modes'][i][2], sm['modes'][i + 1][2]])
        c = np.linalg.solve(V, dirv)
        out.append(amps[i] * c[0]); out.append(amps[i + 1] * c[1])
    return np.array(out)


def synth_bridge_force(sm, amps, dur=4.0, sr=SR):
    """Bridge force (y,z) time series from the modal sum."""
    t = np.arange(int(dur * sr)) / sr
    Fy = np.zeros_like(t); Fz = np.zeros_like(t)
    T, L = sm['T'], sm['L']
    for (k, s, v), a in zip(sm['modes'], amps):
        if abs(a) < 1e-12:
            continue
        x = np.real(a * np.exp(s * t))  # displacement of this component
        f = T * k * np.pi / L * x
        Fy += np.real(v[0]) * f; Fz += np.real(v[1]) * f
    return Fy, Fz


def static_force(sm, xp_frac, theta, h):
    """Force the loaded string exerts on the bridge just before release (T * slope at the bridge)."""
    F = sm['T'] * h / (xp_frac * sm['L'])
    return F * np.cos(theta), F * np.sin(theta)


def radiate(body, Fy, Fz, sr=SR, gy=0.3, direct=0.0, Fs=(0.0, 0.0)):
    """Pressure from modal body velocities (bandpass resonators scaled by Q/(m w)) times radiation gains.
    Fs: static (y,z) force held by the pick before release; after release it is gone, so relative to the
    pre-loaded equilibrium the body sees a step of -Fs at t=0 (the 'thump')."""
    from scipy.signal import lfilter
    F = Fz + gy * Fy - (Fs[1] + gy * Fs[0])
    p = np.zeros_like(F)
    for f, Q, m, g in zip(body.f, body.Q, body.m, body.g):
        w = 2 * np.pi * f / sr
        if w >= np.pi * 0.95:
            continue
        al = np.sin(w) / (2 * Q); a0 = 1 + al
        b = np.array([al, 0, -al]) / a0; a = np.array([1, -2 * np.cos(w) / a0, (1 - al) / a0])
        v = lfilter(b, a, F) * (Q / (m * 2 * np.pi * f))  # modal velocity (peak = Q/(m w))
        p += g * 2 * np.pi * f * v  # monopole-ish radiation ~ acceleration
    if direct:
        p += direct * np.diff(F, prepend=0) * sr / 1000
    return p
