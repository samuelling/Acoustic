#!/bin/bash
# usage: test/calib.sh '<json overrides>' [png]
R=/tmp/claude-0/refs/tonejs-instruments/samples/guitar-acoustic; O=/tmp/claude-0/out
OV="$1"; [ -z "$OV" ] && OV="{}"
cd "$(dirname "$0")/.."
node test/render.js note $O/s0.wav "{\"s\":0,\"midi\":40,\"seconds\":4,\"params\":{\"override\":$OV}}" >/dev/null
node test/render.js note $O/s2.wav "{\"s\":2,\"midi\":50,\"seconds\":4,\"params\":{\"override\":$OV}}" >/dev/null
node test/render.js note $O/s5.wav "{\"s\":5,\"midi\":64,\"seconds\":4,\"params\":{\"override\":$OV}}" >/dev/null
node test/render.js note $O/s3.wav "{\"s\":3,\"midi\":57,\"seconds\":4,\"params\":{\"override\":$OV}}" >/dev/null
python3 test/analyze.py $R/E2.wav $O/s0.wav $R/D3.wav $O/s2.wav $R/A3.wav $O/s3.wav $R/E4.wav $O/s5.wav --midi 40 50 57 64 ${2:+--png $2} 2>&1 | grep -v Warn
