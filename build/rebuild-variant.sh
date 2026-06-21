#!/usr/bin/env bash
# Rebuild the pinned divx-mp3-avi variant with CORRECT fragments.
set -euo pipefail

VARIANT="divx-mp3-avi"
LIBAVJS_REF="${LIBAVJS_REF:-192bc3aa1979d2fd0b5658471d5ff94ea303587c}"
LIBAVJS_EXPECTED_VER="${LIBAVJS_EXPECTED_VER:-6.8.8.0}"
FFMPEG_VERSION="${FFMPEG_VERSION:-8.0}"
EMSDK_REF="${EMSDK_REF:-298ea18bebd6e65c45e35e39755c989a90058c77}"
EMSDK_VERSION="${EMSDK_VERSION:-6.0.0}"
FRAGMENTS='["avformat","avcodec","demuxer-avi","parser-mpeg4video","decoder-mpeg4","parser-mp3","decoder-mp3"]'
DEST="/mnt/c/Git/_probe/avi_player/lib"
WORK="${LIBAVJS_WORK:-$HOME/libavjs-build}"

cd "$WORK/emsdk"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: tracked changes exist in $WORK/emsdk; commit/stash them before rebuilding."
  exit 1
fi
git fetch --tags origin
git -c advice.detachedHead=false checkout --detach "$EMSDK_REF"
./emsdk install "$EMSDK_VERSION"
./emsdk activate "$EMSDK_VERSION"
source "$WORK/emsdk/emsdk_env.sh" 2>/dev/null || true

cd "$WORK/libav.js"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: tracked changes exist in $WORK/libav.js; commit/stash them before rebuilding."
  exit 1
fi
git fetch --tags origin
git -c advice.detachedHead=false checkout --detach "$LIBAVJS_REF"
echo "libav.js checkout: $(git describe --tags --always --dirty) ($(git rev-parse HEAD))"

echo "[1] regenerate variant config..."
rm -rf "configs/configs/$VARIANT"
(cd configs && ./mkconfig.js "$VARIANT" "$FRAGMENTS")
echo "--- components.txt ---"; cat "configs/configs/$VARIANT/components.txt"
echo "--- ffmpeg-config.txt ---"; cat "configs/configs/$VARIANT/ffmpeg-config.txt"

VER="$(make print-version)"
if [ "$VER" != "$LIBAVJS_EXPECTED_VER" ]; then
  echo "ERROR: expected libav.js version $LIBAVJS_EXPECTED_VER, got $VER."
  exit 1
fi
echo "[2] version=$VER; building frontend + wasm (incremental)..."
make -j"$(nproc)" "dist/libav-${VER}-${VARIANT}.js"
make -j"$(nproc)" "dist/libav-${VER}-${VARIANT}.wasm.js"

echo "[3] copy to $DEST"
cp -f "dist/libav-${VER}-${VARIANT}.js"        "$DEST/"
cp -f "dist/libav-${VER}-${VARIANT}.wasm.js"   "$DEST/"
cp -f "dist/libav-${VER}-${VARIANT}.wasm.wasm" "$DEST/"
PROVENANCE="$DEST/libav-${VER}-${VARIANT}.provenance.txt"
{
  echo "variant=$VARIANT"
  echo "libavjs_version=$VER"
  echo "libavjs_ref=$(git rev-parse HEAD)"
  echo "libavjs_describe=$(git describe --tags --always --dirty)"
  echo "ffmpeg_version=$FFMPEG_VERSION"
  echo "emsdk_ref=$EMSDK_REF"
  echo "emsdk_version=$EMSDK_VERSION"
  echo "emcc_version=$(emcc --version | head -1)"
  echo "fragments=$FRAGMENTS"
  echo
  echo "ffmpeg_config:"
  cat "configs/configs/$VARIANT/ffmpeg-config.txt"
} > "$PROVENANCE"
cp -f "$PROVENANCE" "$DEST/libav-${VARIANT}.provenance.txt"
ls -la "$DEST/"
echo "REBUILD_DONE"
