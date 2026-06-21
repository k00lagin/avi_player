#!/usr/bin/env bash
# ============================================================================
#  Build a custom libav.js variant that decodes DivX (MPEG-4 Part 2) + MP3 in
#  AVI.  Run this inside WSL (Ubuntu). Produces three files copied to ./lib .
#
#    lib/libav-<ver>-divx-mp3-avi.{js, wasm.js, wasm.wasm}
#
#  Idempotent: re-running skips already-done steps.
# ============================================================================
set -euo pipefail

VARIANT="divx-mp3-avi"
# NOTE: "avformat" and "avcodec" are the COMPONENT fragments that emit the
# JS wrappers (writeFile, ff_init_demuxer_file, ff_decode_multi, etc.). Without
# them the demuxer/decoder/*-gated wrappers are not exported. demuxer-avi /
# decoder-mpeg4 / decoder-mp3 only enable the FFmpeg configure flags.
FRAGMENTS='["avformat","avcodec","demuxer-avi","parser-mpeg4video","decoder-mpeg4","parser-mp3","decoder-mp3"]'

# Resolve the Windows project dir from this script's location (under /mnt/c).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$PROJECT_DIR/lib"
mkdir -p "$DEST"

WORK="${LIBAVJS_WORK:-$HOME/libavjs-build}"
mkdir -p "$WORK"
LOG="$SCRIPT_DIR/build.log"
exec > >(tee -a "$LOG") 2>&1
echo "==========================================================="
echo " libav.js custom variant build: $VARIANT"
echo " $(date)"
echo " work=$WORK"
echo " dest=$DEST"
echo "==========================================================="

# ---- 0. Dependency check --------------------------------------------------
need=(git make python3 pkg-config node npm curl)
for t in "${need[@]}"; do
  if ! command -v "$t" >/dev/null 2>&1; then
    echo "ERROR: '$t' is missing. Install deps first:"
    echo "  sudo apt-get update && sudo apt-get install -y build-essential pkg-config nodejs npm"
    exit 1
  fi
done
echo "[ok] build tools present"
node --version

# ---- 1. emsdk -------------------------------------------------------------
if [ ! -d "$WORK/emsdk/.git" ]; then
  echo "[1/5] cloning emsdk..."
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$WORK/emsdk"
fi
cd "$WORK/emsdk"
echo "[1/5] updating emsdk..."
git pull --rebase --autostash || true
if [ ! -d "$HOME/.emsdk_portable" ] || [ ! -f "$HOME/.emsdk_portable/.emscripten" ]; then
  echo "[1/5] installing latest emsdk..."
  ./emsdk install latest
fi
echo "[1/5] activating emsdk..."
./emsdk activate latest
# shellcheck disable=SC1091
source "$WORK/emsdk/emsdk_env.sh" 2>/dev/null || true
emcc --version | head -1
echo "[ok] emcc ready"

# ---- 2. libav.js source ---------------------------------------------------
if [ ! -d "$WORK/libav.js/.git" ]; then
  echo "[2/5] cloning libav.js..."
  git clone https://github.com/Yahweasel/libav.js.git "$WORK/libav.js"
fi
cd "$WORK/libav.js"
echo "[2/5] updating libav.js..."
git fetch --tags
git checkout master
git pull --rebase --autostash || true

echo "[2/5] npm install..."
npm install

LIBAVJS_VER="$(make print-version)"
echo "[ok] libav.js version = $LIBAVJS_VER"

# ---- 3. create the custom variant ----------------------------------------
echo "[3/5] creating variant '$VARIANT' with fragments: $FRAGMENTS"
cd configs
if [ -d "configs/$VARIANT" ]; then
  echo "[3/5] variant config already exists, recreating..."
  rm -rf "configs/$VARIANT"
fi
./mkconfig.js "$VARIANT" "$FRAGMENTS"
cd ..
echo "[ok] variant configured"
echo "--- components ---"; cat "configs/configs/$VARIANT/components.txt" || true
echo "--- ffmpeg-config ---"; cat "configs/configs/$VARIANT/ffmpeg-config.txt" || true

# ---- 4. build the three files we need (skip asm/threaded/debug) -----------
echo "[4/5] building frontend + wasm target (this compiles FFmpeg, ~15-30 min)..."
JOBS="$(nproc)"
make -j"${JOBS}" "dist/libav-${LIBAVJS_VER}-${VARIANT}.js"
make -j"${JOBS}" "dist/libav-${LIBAVJS_VER}-${VARIANT}.wasm.js"
echo "[ok] build complete"

# ---- 5. copy artifacts ----------------------------------------------------
echo "[5/5] copying artifacts to $DEST"
cp -v "dist/libav-${LIBAVJS_VER}-${VARIANT}.js"       "$DEST/"
cp -v "dist/libav-${LIBAVJS_VER}-${VARIANT}.wasm.js"  "$DEST/"
cp -v "dist/libav-${LIBAVJS_VER}-${VARIANT}.wasm.wasm" "$DEST/"

# Convenience unversioned copies so the HTML can reference either name.
cp -v "dist/libav-${LIBAVJS_VER}-${VARIANT}.js"       "$DEST/libav-${VARIANT}.js"
cp -v "dist/libav-${LIBAVJS_VER}-${VARIANT}.wasm.js"  "$DEST/libav-${VARIANT}.wasm.js"
cp -v "dist/libav-${LIBAVJS_VER}-${VARIANT}.wasm.wasm" "$DEST/libav-${VARIANT}.wasm.wasm"

echo "==========================================================="
echo " DONE. Files in $DEST :"
ls -la "$DEST"
echo " Now run server.cmd (Windows) and open http://localhost:8000/"
echo "==========================================================="
