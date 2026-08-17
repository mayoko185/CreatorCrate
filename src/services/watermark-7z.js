import SevenZip from '7z-wasm';

const SEVEN_Z_SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);

export class Watermark7zError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message);
    this.name = 'Watermark7zError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function assertEntryName(name) {
  if (typeof name !== 'string'
    || name.length === 0
    || name.startsWith('/')
    || name.includes('\\')
    || name.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Watermark7zError('Archive entry path is unsafe.', { code: 'ARCHIVE_ENTRY_UNSAFE' });
  }
}

function mkdirp(fs, directory) {
  let current = '';
  for (const part of directory.split('/')) {
    if (!part) continue;
    current += '/' + part;
    try {
      fs.mkdir(current);
    } catch (err) {
      if (err?.code !== 'EEXIST' && err?.errno !== 20) throw err;
    }
  }
}

function runCommand(module, args, label) {
  let exitCode;
  try {
    exitCode = module.callMain([...args]);
  } catch (cause) {
    throw new Watermark7zError('7z ' + label + ' failed.', {
      code: 'SEVEN_ZIP_COMMAND_FAILED',
      cause,
    });
  }
  if (exitCode !== 0) {
    throw new Watermark7zError('7z ' + label + ' failed.', {
      code: 'SEVEN_ZIP_COMMAND_FAILED',
    });
  }
}

function walkFiles(fs, directory, prefix = '') {
  const entries = [];
  for (const name of fs.readdir(directory)) {
    if (name === '.' || name === '..') continue;
    const filePath = directory + '/' + name;
    const relativePath = prefix ? prefix + '/' + name : name;
    const stats = fs.stat(filePath);
    if (fs.isDir(stats.mode)) {
      entries.push(...walkFiles(fs, filePath, relativePath));
    } else if (fs.isFile(stats.mode)) {
      entries.push({ name: relativePath, buffer: Buffer.from(fs.readFile(filePath)) });
    }
  }
  return entries;
}

function assert7zSignature(buffer) {
  if (buffer.length <= SEVEN_Z_SIGNATURE.length
    || !buffer.subarray(0, SEVEN_Z_SIGNATURE.length).equals(SEVEN_Z_SIGNATURE)) {
    throw new Watermark7zError('Generated archive is not a valid 7z container.', {
      code: 'INVALID_7Z_SIGNATURE',
    });
  }
}

async function withSevenZip(run) {
  let module;
  try {
    module = await SevenZip({
      print: () => {},
      printErr: () => {},
    });
    return run(module);
  } catch (cause) {
    if (cause instanceof Watermark7zError) throw cause;
    throw new Watermark7zError('The bundled 7z runtime could not be initialized.', {
      code: 'SEVEN_ZIP_RUNTIME_UNAVAILABLE',
      cause,
    });
  }
}

export async function read7zArchiveEntries(archiveBuffer) {
  if (!Buffer.isBuffer(archiveBuffer) && !(archiveBuffer instanceof Uint8Array)) {
    throw new Watermark7zError('Archive bytes are required.', { code: 'INVALID_7Z_ARCHIVE' });
  }
  const buffer = Buffer.from(archiveBuffer);
  assert7zSignature(buffer);
  return withSevenZip((module) => {
    module.FS.writeFile('/archive.7z', buffer);
    runCommand(module, ['t', '/archive.7z'], 'validation');
    module.FS.mkdir('/extract');
    runCommand(module, ['x', '/archive.7z', '-y', '-o/extract'], 'extraction');
    return walkFiles(module.FS, '/extract');
  });
}

export async function create7zArchive(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Watermark7zError('At least one archive entry is required.', { code: 'INVALID_7Z_ARCHIVE' });
  }
  const expected = new Map();
  for (const entry of entries) {
    assertEntryName(entry?.name);
    if (!Buffer.isBuffer(entry.buffer) && !(entry.buffer instanceof Uint8Array)) {
      throw new Watermark7zError('Archive entry bytes are required.', { code: 'INVALID_7Z_ARCHIVE' });
    }
    if (expected.has(entry.name)) {
      throw new Watermark7zError('Archive entry paths must be unique.', { code: 'ARCHIVE_ENTRY_COLLISION' });
    }
    expected.set(entry.name, Buffer.from(entry.buffer));
  }

  return withSevenZip(async (module) => {
    module.FS.mkdir('/input');
    module.FS.mkdir('/output');
    for (const [name, buffer] of expected) {
      const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
      if (parent) mkdirp(module.FS, '/input/' + parent);
      module.FS.writeFile('/input/' + name, buffer);
    }

    module.FS.chdir('/input');
    // Double dash stops 7z option parsing before untrusted entry names.
    runCommand(module, ['a', '/output/archive.7z', '--', ...expected.keys()], 'creation');
    const archive = Buffer.from(module.FS.readFile('/output/archive.7z'));
    assert7zSignature(archive);

    const actualEntries = await read7zArchiveEntries(archive);
    if (actualEntries.length !== expected.size) {
      throw new Watermark7zError('Generated archive has an unexpected entry count.', {
        code: 'INVALID_7Z_ARCHIVE',
      });
    }
    for (const entry of actualEntries) {
      const expectedBuffer = expected.get(entry.name);
      if (!expectedBuffer || !entry.buffer.equals(expectedBuffer)) {
        throw new Watermark7zError('Generated archive contents did not validate.', {
          code: 'INVALID_7Z_ARCHIVE',
        });
      }
    }
    return archive;
  });
}
