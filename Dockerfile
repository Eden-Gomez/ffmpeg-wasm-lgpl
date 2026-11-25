# Reproducible build of the LGPL-only FFmpeg WebAssembly core.
#   docker build --no-cache --output type=local,dest=dist vendor/ffmpeg-lgpl
# Every input is pinned: the toolchain image by digest, every source tarball by SHA-256.
FROM emscripten/emsdk:3.1.40@sha256:c1e807a6e03ac5bd5b37bae2ace3c46c08579e2ddeb951037a3b8dac7067f2cc AS build
# pkg-config: FFmpeg's configure finds libvorbis through it. Exact Ubuntu 22.04 package version.
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config=0.29.2-1ubuntu3 && rm -rf /var/lib/apt/lists/*
COPY SHA256SUMS build.sh /src/
COPY sources/ /src/sources/
RUN bash /src/build.sh
# Evidence produced by the binary itself; fails the build on any GPL/non-free flag.
COPY smoke.js /src/
RUN node /src/smoke.js /out && cd /out && sha256sum ffmpeg-core.js ffmpeg-core.wasm > SHA256SUMS

FROM scratch AS export
COPY --from=build /out/ /
