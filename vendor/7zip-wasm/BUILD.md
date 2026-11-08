# 7-Zip 26.06 WebAssembly decoder

Prebuilt RAR4/RAR5/7z decoder used by `src/services/archive-member-decoder.js`.
It is loaded from these local files at runtime; no compiler, Docker, 7-Zip
installation or network access is needed to run CreatorCrate.

| File | SHA-256 |
| --- | --- |
| `7zz.cjs` (Emscripten glue, 83,504 bytes) | `87c0349a3fd1a541bebcc24b27f0bdea631208e2e4ff33bbd2fa4a8d735457ce` |
| `7zz.wasm` (1,651,524 bytes) | `ed89509f0dca83dcaa301625ca7c62e92cda8ff8bf52df26b0d868ec7539c941` |

`SHA256SUMS` holds the same values. The decoder module refuses to load files
that do not match them.

## Provenance

- Source: official 7-Zip 26.06 release archive
  `https://github.com/ip7z/7zip/releases/download/26.06/7z2606-src.tar.xz`,
  SHA-256 `a4e374c8f864f51df48c2cfd0e1413ec3b2ea030deae852d6a655402ebb61ac4`
  (upstream tag commit `d3296e39e1f1f92c7b41c0c3848e65640428d42d`).
- Patch: `build/qualified.patch`, SHA-256
  `75f66517e3fbc379175acf4f74401c7ffc316b42bdeafe8b11ca1866ab859a4d`. It is the
  use-strict/7z-wasm build adaptation (revision
  `521d2cf93f5964f4e77b01049e19f1b29305c454`) rebased onto 26.06: Emscripten
  makefile/pre/post files, warning flags, and `System.cpp`/`SystemInfo.cpp`
  guards with a fixed 256 MiB RAM report. No archive-format or codec code is changed.
- Toolchain: `emscripten/emsdk:4.0.10` pinned by digest
  `sha256:90b757eb11fa9a0e3ce4d2d9f76d932a56018e4accc37b5a28b2783751e60eb7`
  (emcc 4.0.10, revision `b7dc6e5747465580df5984e723b9d1f10d8e804b`), linux/amd64.
- Settings (see `build/build.sh`): single-threaded `Alone2` bundle, `-O2`,
  modular CommonJS factory `SevenZip`, no initial run, imported memory with
  16 MiB initial / 256 MiB maximum so each job supplies a smaller cap,
  `SOURCE_DATE_EPOCH=1793923200`.

## Rebuilding

Place `7z2606-src.tar.xz` in an empty directory, then from the repository root:

```bash
docker run --rm --network none \
  -v "<dir with the tarball>:/src:ro" \
  -v "$PWD/vendor/7zip-wasm/build:/recipe:ro" \
  -v "<empty output dir>:/out" \
  emscripten/emsdk@sha256:90b757eb11fa9a0e3ce4d2d9f76d932a56018e4accc37b5a28b2783751e60eb7 \
  bash /recipe/build.sh
```

The script verifies the source and patch hashes, builds in a fresh tree and
prints the output hashes, which must equal the table above. Two clean builds
from different source paths have produced byte-identical files.

A digest pins the image but does not guarantee it stays hosted; mirror the
image if long-term rebuilds matter.

## Updating

Track 7-Zip security releases. For a new version: update the source URL and
hash, rebase `qualified.patch`, rebuild, replace both artifacts, update
`SHA256SUMS`, the table above and the constants in
`src/services/archive-member-decoder.js`, then rerun
`tests/archive-member-decoder.test.js` on Windows and Linux.

## Licensing

`licenses/` contains the notices shipped with this build:

- `License.txt`, `copying.txt`: 7-Zip is GNU LGPL 2.1 or later, with BSD and
  public-domain parts as described there.
- `unRarLicense.txt`: the RAR decompression code may not be used to recreate a
  RAR-compatible compressor. This build only reads RAR archives.
- `emscripten-LICENSE.txt`: MIT/NCSA notice for the Emscripten runtime in `7zz.cjs`.

The corresponding source for the modified LGPL binary is the release archive
above plus `build/qualified.patch` and `build/build.sh`. Keep them with any
distribution of `7zz.wasm`/`7zz.cjs`. The decoder stays a separate, replaceable
file. Confirm distribution terms when packaging; this note is not legal advice.
