#!/bin/bash
# Build the Cyno final kit (SVG, PNG, ICO, check sheet) and copy the web assets into packages/web/public.
set -e
S="$(cd "$(dirname "$0")" && pwd)"
WT="$(cd "$S/../../.." && pwd)"
F=$WT/brand/cyno/final
P=$WT/packages/web/public
cd $S
export PYTHONDONTWRITEBYTECODE=1
python3 gen7.py $F >/dev/null
mkdir -p $F/png
tmpk="$(mktemp -d)"
node render.cjs png $tmpk 16 $F/cyno-tile-small.svg $F/cyno-mark-small.svg >/dev/null
node render.cjs png $tmpk 32 $F/cyno-tile.svg $F/cyno-tile-small.svg >/dev/null
for s in 48 180 192 512; do node render.cjs png $tmpk $s $F/cyno-tile.svg >/dev/null; done
node render.cjs png $tmpk 180 $F/cyno-tile-square.svg >/dev/null
node render.cjs png $tmpk 512 $F/cyno-mark.svg $F/cyno-mark-escuro.svg >/dev/null
mv $tmpk/cyno-tile-small-16.png $F/png/cyno-tile-16.png
mv $tmpk/cyno-tile-small-32.png $F/png/cyno-tile-32-pixel.png
mv $tmpk/cyno-tile-square-180.png $F/png/apple-touch-icon.png
mv $tmpk/*.png $F/png/
python3 -I make_ico.py $F/favicon.ico $F/png/cyno-tile-16.png $F/png/cyno-tile-32.png $F/png/cyno-tile-48.png
python3 folha.py $F $tmpk/folha.html >/dev/null
node render.cjs html $tmpk/folha.html $F/folha-final.png 1500
cp $F/cyno-tile.svg $P/cyno-tile.svg
cp $F/favicon.ico $P/favicon.ico
cp $F/png/apple-touch-icon.png $P/apple-touch-icon.png
cp $F/png/cyno-tile-192.png $P/icon-192.png
cp $F/png/cyno-tile-512.png $P/icon-512.png
echo done
