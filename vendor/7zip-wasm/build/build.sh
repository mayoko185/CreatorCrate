#!/bin/bash
# Rebuilds vendor/7zip-wasm/7zz.cjs and 7zz.wasm from pinned 7-Zip 26.06 source.
# Run inside the pinned Emscripten image (see ../BUILD.md):
#   /src  read-only: 7z2606-src.tar.xz
#   /recipe read-only: this directory (build.sh, qualified.patch)
#   /out  writable: receives 7zz.cjs and 7zz.wasm
set -euo pipefail

SOURCE_SHA256=a4e374c8f864f51df48c2cfd0e1413ec3b2ea030deae852d6a655402ebb61ac4
PATCH_SHA256=75f66517e3fbc379175acf4f74401c7ffc316b42bdeafe8b11ca1866ab859a4d

export SOURCE_DATE_EPOCH=1793923200
export LC_ALL=C

echo "${SOURCE_SHA256}  /src/7z2606-src.tar.xz" | sha256sum -c -
echo "${PATCH_SHA256}  /recipe/qualified.patch" | sha256sum -c -
emcc --version | head -n 1

work=$(mktemp -d)
mkdir "$work/src2606"
tar -xJf /src/7z2606-src.tar.xz -C "$work/src2606"
cd "$work/src2606"
git apply --ignore-whitespace /recipe/qualified.patch

cd CPP/7zip/Bundles/Alone2
export ST_MODE=1
export LDFLAGS_EMCC="-O2 -lnodefs.js -lworkerfs.js -s EXPORTED_RUNTIME_METHODS=['FS','NODEFS','WORKERFS','callMain'] -s ALLOW_MEMORY_GROWTH=1 -s IMPORTED_MEMORY=1 -s INITIAL_MEMORY=16777216 -s MAXIMUM_MEMORY=268435456 -s MODULARIZE=1 -s EXPORT_NAME=SevenZip --post-js post.js --pre-js pre.js"
emmake make -j4 -f makefile.emcc CC=emcc CXX=em++

cp _o/7zz.js /out/7zz.cjs
cp _o/7zz.wasm /out/7zz.wasm
cd /out
sha256sum 7zz.cjs 7zz.wasm
