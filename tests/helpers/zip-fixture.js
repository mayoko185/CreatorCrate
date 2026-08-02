import zlib from 'node:zlib';

const CRC32_TABLE = (() => {
  const table = [];
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[value] = crc >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUInt16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xffff);
  return buffer;
}

function writeUInt32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function localHeader(entry) {
  return Buffer.concat([
    Buffer.from('PK\x03\x04', 'binary'),
    writeUInt16(20),
    writeUInt16(entry.flags),
    writeUInt16(entry.compressionMethod),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt32(entry.crc32),
    writeUInt32(entry.localCompressedSize),
    writeUInt32(entry.localUncompressedSize),
    writeUInt16(entry.nameBuffer.length),
    writeUInt16(entry.extra.length),
    entry.nameBuffer,
    entry.extra,
  ]);
}

function centralHeader(entry) {
  return Buffer.concat([
    Buffer.from('PK\x01\x02', 'binary'),
    writeUInt16(20),
    writeUInt16(20),
    writeUInt16(entry.flags),
    writeUInt16(entry.compressionMethod),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt32(entry.crc32),
    writeUInt32(entry.compressedSize),
    writeUInt32(entry.uncompressedSize),
    writeUInt16(entry.nameBuffer.length),
    writeUInt16(entry.extra.length),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt32(0),
    writeUInt32(entry.localOffset),
    entry.nameBuffer,
    entry.extra,
  ]);
}

/**
 * Build a small single-disk ZIP fixture without using an archive executable
 * or production parser. Entries may override metadata to exercise malformed
 * and resource-limit paths.
 */
export function makeZip(entries, { entryCount } = {}) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const input of entries) {
    const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data ?? '');
    const compressionMethod = input.compressionMethod ?? (input.compression === 'deflate' ? 8 : 0);
    const compressedData = input.compressedData ?? (
      compressionMethod === 8 ? zlib.deflateRawSync(data) : data
    );
    const nameBuffer = Buffer.from(input.name, 'utf8');
    const extra = input.extra ?? Buffer.alloc(0);
    const normalized = {
      flags: input.flags ?? 0x800,
      compressionMethod,
      crc32: input.crc32 ?? crc32(data),
      compressedSize: input.compressedSize ?? compressedData.length,
      uncompressedSize: input.uncompressedSize ?? data.length,
      localCompressedSize: input.localCompressedSize ?? input.compressedSize ?? compressedData.length,
      localUncompressedSize: input.localUncompressedSize ?? input.uncompressedSize ?? data.length,
      nameBuffer,
      extra,
      localOffset,
    };
    const local = localHeader(normalized);
    localParts.push(local, compressedData);
    localOffset += local.length + compressedData.length;
    centralParts.push(centralHeader(normalized));
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localData = Buffer.concat(localParts);
  const count = entryCount ?? entries.length;
  const endOfCentralDirectory = Buffer.concat([
    Buffer.from('PK\x05\x06', 'binary'),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(count),
    writeUInt16(count),
    writeUInt32(centralDirectory.length),
    writeUInt32(localData.length),
    writeUInt16(0),
  ]);

  return Buffer.concat([localData, centralDirectory, endOfCentralDirectory]);
}
