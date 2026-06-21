#!/usr/bin/env bash
# Rebuild the divx-mp3-avi variant with CORRECT fragments (explicit components).
set -euo pipefail
cd "$HOME/libavjs-build/libav.js"
source "$HOME/libavjs-build/emsdk/emsdk_env.sh" 2>/dev/null || true

VARIANT="divx-mp3-avi"
FRAGMENTS='["avformat","avcodec","demuxer-avi","parser-mpeg4video","decoder-mpeg4","parser-mp3","decoder-mp3"]'
DEST="/mnt/c/Git/_probe/avi_player/lib"

echo "[1] regenerate variant config..."
rm -rf "configs/configs/$VARIANT"
(cd configs && ./mkconfig.js "$VARIANT" "$FRAGMENTS")
echo "--- components.txt ---"; cat "configs/configs/$VARIANT/components.txt"
echo "--- ffmpeg-config.txt ---"; cat "configs/configs/$VARIANT/ffmpeg-config.txt"

VER="$(make print-version)"
echo "[2] version=$VER; building frontend + wasm (incremental)..."
make -j"$(nproc)" "dist/libav-${VER}-${VARIANT}.js"
make -j"$(nproc)" "dist/libav-${VER}-${VARIANT}.wasm.js"

echo "[3] copy to $DEST"
cp -f "dist/libav-${VER}-${VARIANT}.js"        "$DEST/"
cp -f "dist/libav-${VER}-${VARIANT}.wasm.js"   "$DEST/"
cp -f "dist/libav-${VER}-${VARIANT}.wasm.wasm" "$DEST/"
ls -la "$DEST/"
echo "REBUILD_DONE"
