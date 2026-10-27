import numpy as np, sys
from modal_proto import *
modes=[(100,20,0.6,1.0),(188,25,0.07,0.8),(204,25,0.12,0.7),(245,30,0.3,0.3),(290,30,0.25,0.3),(380,35,0.15,0.4),(420,35,0.2,0.3),(505,40,0.15,0.3),(590,40,0.2,0.25),(680,40,0.2,0.25),(765,40,0.25,0.2),(880,45,0.25,0.2)]
body=Body(modes,hf=dict(f0=950,f1=8000,count=60,qlo=30,qhi=80,mlo=0.08,mhi=0.6,g=0.15))
for s,fret in [(0,0),(2,0),(5,0)]:
    sm=string_modes(s,fret,body)
    print(f"string {s} f0={sm['f0']:.1f} B={sm['B']:.2e} modes={len(sm['modes'])}")
    print("  n   f      T60a   T60b   split_Hz")
    for i in range(0,min(32,len(sm['modes'])),2):
        k,s1,v1=sm['modes'][i]; _,s2,v2=sm['modes'][i+1]
        t1,t2=6.91/-s1.real,6.91/-s2.real
        print(f"{k:3d} {s1.imag/2/np.pi:7.1f} {t1:6.2f} {t2:6.2f} {abs(s1.imag-s2.imag)/2/np.pi:7.3f}  v1=({abs(v1[0]):.2f},{abs(v1[1]):.2f})")
