#!/usr/bin/env bash
# Builds the LGPL-only FFmpeg WebAssembly core served by weconvertit.com.
# Runs inside the pinned emscripten/emsdk image (see Dockerfile). Inputs: the upstream
# release tarballs in /src/sources (verified against /src/SHA256SUMS). Output: /out.
#
# Licence posture: no --enable-gpl, no --enable-nonfree, no --enable-version3, no x264,
# x265 or fdk-aac. External libraries: LAME (LGPL-2.0+), libvorbis + libogg (BSD-3-Clause),
# zlib (zlib licence). The resulting binary is LGPL-2.1-or-later. FFmpeg source is unmodified.
set -euo pipefail

SRC=/src/sources
PREFIX=/opt/deps
OUT=/out
JOBS=$(nproc)
export CFLAGS="-O3"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
export EM_PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
# Fixed timestamps/paths so two builds of the same inputs give the same bytes.
export SOURCE_DATE_EPOCH=1730937600
export TZ=UTC LC_ALL=C

(cd "$SRC" && sha256sum -c /src/SHA256SUMS)

mkdir -p /work "$OUT" "$PREFIX"
cd /work
for t in "$SRC"/*.tar.*; do tar xf "$t"; done

# zlib 1.3.1 (zlib licence) — compressed QuickTime/MP4 headers ('cmov'), PNG cover art.
(cd zlib-1.3.1 && emconfigure ./configure --prefix="$PREFIX" --static && emmake make -j"$JOBS" && emmake make install)

# LAME 3.100 (LGPL-2.0+) — MP3 encoder (libmp3lame).
(cd lame-3.100 && emconfigure ./configure --prefix="$PREFIX" --host=i686-linux \
  --disable-shared --enable-static --disable-frontend --disable-analyzer-hooks \
  --disable-dependency-tracking --disable-gtktest --disable-decoder \
  && emmake make -j"$JOBS" && emmake make install)

# libogg 1.3.6 + libvorbis 1.3.7 (BSD-3-Clause) — OGG Vorbis encoder (libvorbis).
(cd libogg-1.3.6 && emconfigure ./configure --prefix="$PREFIX" --host=i686-linux \
  --disable-shared --enable-static && emmake make -j"$JOBS" && emmake make install)
# Its configure adds -mno-ieee-fp for i686 hosts, which clang (wasm) rejects; drop that flag
# from the configure script only. The library source is untouched.
sed -i 's/-mno-ieee-fp//g' libvorbis-1.3.7/configure
(cd libvorbis-1.3.7 && emconfigure ./configure --prefix="$PREFIX" --host=i686-linux \
  --disable-shared --enable-static --disable-docs --disable-examples --disable-oggtest \
  --with-ogg="$PREFIX" && emmake make -j"$JOBS" && emmake make install)

# FFmpeg 5.1.10 (LGPL-2.1+). 5.1 is the newest series whose ffmpeg CLI builds without
# threads (6.0+ requires them, which in wasm means SharedArrayBuffer + COOP/COEP site-wide).
# All native components stay enabled (same breadth as the core it replaces); GPL-only parts
# are excluded automatically because --enable-gpl is absent.
cd ffmpeg-5.1.10
emconfigure ./configure \
  --target-os=none --arch=x86_32 --enable-cross-compile \
  --disable-asm --disable-x86asm --disable-inline-asm --disable-stripping \
  --disable-programs --disable-doc --disable-debug --disable-runtime-cpudetect \
  --disable-autodetect --disable-pthreads --disable-w32threads --disable-os2threads \
  --disable-network --disable-avdevice --disable-indevs --disable-outdevs --disable-hwaccels \
  --disable-postproc \
  --nm=emnm --ar=emar --ranlib=emranlib --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc \
  --pkg-config=pkg-config --pkg-config-flags=--static \
  --extra-cflags="-O3 -I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib" \
  --enable-zlib --enable-libmp3lame --enable-libvorbis
emmake make -j"$JOBS"

# The CLI itself (fftools) linked into one modularized Emscripten module. The page's
# worker compiles the wasm once and instantiates a fresh module per job, so FFmpeg's
# global state never carries over between calls and no fftools patches are needed.
emcc -O3 -I. -Ifftools -Wno-deprecated-declarations \
  fftools/cmdutils.c fftools/opt_common.c fftools/ffmpeg.c fftools/ffmpeg_filter.c \
  fftools/ffmpeg_hw.c fftools/ffmpeg_mux.c fftools/ffmpeg_opt.c \
  -Llibavfilter -Llibavformat -Llibavcodec -Llibswresample -Llibswscale -Llibavutil -L"$PREFIX/lib" \
  -lavfilter -lavformat -lavcodec -lswresample -lswscale -lavutil \
  -lmp3lame -lvorbisenc -lvorbis -logg -lz -lm \
  -sMODULARIZE=1 -sEXPORT_NAME=createFFmpegCore -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  -sENVIRONMENT=worker,node -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 \
  -sMAXIMUM_MEMORY=4294967296 -sSTACK_SIZE=5242880 -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_FUNCTIONS=_main,_malloc,_free -sEXPORTED_RUNTIME_METHODS=FS,callMain \
  -o "$OUT/ffmpeg-core.js"

ls -la "$OUT"
# The evidence step (smoke.js: configure line, licence, component lists, encode check) runs
# as its own Dockerfile step after this one.
