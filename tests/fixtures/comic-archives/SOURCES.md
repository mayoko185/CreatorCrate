# Comic archive fixtures

Used by `tests/cbr-cb7-page-reader.test.js`. CB7 (7z) comics are generated inside
the test with the `7z-wasm` writer CreatorCrate already depends on; RAR cannot be
written by 7-Zip, so the CBR comics are stored here.

Created with RarLab RAR 6.24 for Linux (`rarlinux-x64-624.tar.gz`, SHA-256
`88e22a8e84125c947637bbf28c746e338a0a63279d80f9f9d7373603875db1eb`), the last
release that can still write RAR4 (`-ma4`). Every file was given the mtime
`2024-01-02 03:04:05` and added in this order:

```
ch1/page10.webp ch2/page1.gif ch1/page1.jpg ch2/page2.png ch1/page2.png
__MACOSX/ch1/._page1.jpg ch1/._page2.png .DS_Store ComicInfo.xml Thumbs.db
extras/nested.cbz notes.txt ch10/page1.png
```

Pages are synthetic gradients made with Sharp: JPEG 48x64, PNG 48x64 and 96x128
(compression level 0, so RAR genuinely compresses them), lossless WebP 48x64 and
a two-frame animated GIF 16x24. `ch2/page2.png` is text, not an image. The other
members are junk, metadata or a nested archive that must never become pages.

| Fixture | Switches | SHA-256 |
| --- | --- | --- |
| `comic-rar4.cbr` | `-ma4 -m3 -mt1` | `acc60a28bea821186e6b0285ca00fdfc65098ebcbc735548d0e7a1152a4fbde4` |
| `comic-rar4-solid.cbr` | `-ma4 -m5 -s -mt1` | `d6e7b7e8ed654d7a5944fc24a76440d34b600e3ba197caae7dbe8585ac0c4d29` |
| `comic-rar5.cbr` | `-ma5 -m3 -mt1` | `d5cbf73863b462ec134433941f5e02837fdb6d094f9aa3820aac07ad77023d76` |
| `comic-rar5-solid.cbr` | `-ma5 -m5 -s -mt1` | `f24f78dd616d83c27c17200d88c4a61b333d14d98f66a48f902cb0f56d29beef` |

All four pass `7z t` (7-Zip 22.01) and the vendored 7-Zip 26.06 decoder. Solid
RAR stores members grouped by extension, so stored order differs from page order.
