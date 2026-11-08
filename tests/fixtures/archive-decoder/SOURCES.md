# Archive decoder fixtures

Used by `tests/archive-member-decoder.test.js`.

## From the libarchive test suite

Fetched from `https://github.com/libarchive/libarchive/tree/eb57ffefe20e98eb7ba05829ee1c23b90e589a71/libarchive/test`
(`<name>.uu`, uudecoded). libarchive is distributed under its BSD-style
`COPYING`; these are its own test inputs.

| Fixture | libarchive name | SHA-256 |
| --- | --- | --- |
| `rar4-compressed.rar` | `test_read_format_rar_compress_normal.rar` | `7d32e2ef511d0ade372345440838165df828197eff4d7816880dafde690cce03` |
| `rar4-header-encrypted.rar` | `test_read_format_rar4_encrypted_filenames.rar` | `0201a8cd86c15c117c7541d841c36c0dbabb4824396f19889db5f7d5364e7ef9` |
| `rar4-multivolume.part1.rar` | `test_rar_multivolume_single_file.part1.rar` | `54769cdaa6aeac494b9ba580804598369ba240f61550620434e08350e4428ec2` |
| `rar5-bad-tables.rar` | `test_read_format_rar5_bad_tables.rar` | `a5368fced1d7e0740221699bac2ec2c7f53f6a0f87d6d6eec93ff7b5bb296554` |
| `rar5-blake2.rar` | `test_read_format_rar5_blake2.rar` | `e2889c7498cb8065b9fd2338b142a135b906576a30d24acaf44850cca6fb845a` |
| `rar5-compressed.rar` | `test_read_format_rar5_compressed.rar` | `68f9d7e2662cd5bc5607ba9c6bf1edbf121cf3b08011a7d8643091791750a7c8` |
| `rar5-encrypted.rar` | `test_read_format_rar5_solid_encrypted.rar` | `307de6b76f6b7cc3a221975e14b8a6d7a6b87a30fd1ee7a0e08e4333724e5657` |
| `rar5-multivolume.part01.rar` | `test_read_format_rar5_multiarchive.part01.rar` | `2f3894dc4b8a1bba90830ef1f89f457b0295b6f9030c70febd57283721bc2ce3` |
| `rar5-solid.rar` | `test_read_format_rar5_multiple_files_solid.rar` | `0aa2c652c06304dedd93019663c1d52d5e85055d5fdb8045bfcc4345b90b4a0f` |
| `rar5-symlink.rar` | `test_read_format_rar5_symlink.rar` | `a7336968564786ea5ff106fff2f6ef8dfd8ad5ecca86fbd1db3d63ba42bcd29a` |

Expected member hashes in the test match native 7-Zip 26.06 reference
extractions recorded during A1 qualification.

## Generated for CreatorCrate

Created with the vendored 7-Zip 26.06 build (`-spd -mtc=off -mta=off -mmt=1`,
fixed mtimes). Payloads are synthetic bytes, not images.

| Fixture | Contents | SHA-256 |
| --- | --- | --- |
| `pages-solid.7z` | `book/page-01..04.bin`, 8 KiB each, `-m0=lzma2:d=1m -ms=on` | `4b2c2fa5d8593bd3a7c8f92965724ba61a39044714f41620b58c96fd79cafe47` |
| `pages-nonsolid.7z` | same files, `-ms=off` | `579a11af14d06ee827bde1343bd4e49109ed2eaa35c62e57b2d2643ef2bd82b2` |
| `large-dictionary.7z` | `zeros.bin`, 32 MiB of zeros, `-m0=lzma2:d=32m -mmf=hc4`; decoding needs about 39 MiB of linear memory | `a5c29b67233a718bf49194420745e83cbfb223c8daaf25038d556e7b74337e39` |
| `unsafe-path.7z` | `../evil.txt`, `safe.txt` | `5b66f9dd860fcb75856a20e06298601c743b7886f71b78b43ba61f22d0fa099e` |
| `duplicate-names.7z` | `dup.txt` twice | `eb63f8262b33dd8a31b637181cbc38bfe368f259700f1daf06c2c0d2517181e5` |
| `control-char-name.7z` | `bad\nname.txt` (7-Zip lists it as `bad_name.txt`) | `f87dcfa07665b9647c2180635556c71d7d5eec4b1211b8bc0f358d4c19b7655a` |

The last three were made by archiving placeholder names with uncompressed
headers (`-mhc=off`), replacing the UTF-16 names in place and recomputing the
7z header CRCs.
