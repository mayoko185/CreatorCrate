// Disposable decoder worker: runs the vendored 7-Zip 26.06 WASM build for one job.
// The parent owns every decision; this file only executes bounded commands and reports.
// 7-Zip sees an in-memory filesystem with one read-only node backed by the parent's
// descriptor. No host directory is mounted.
import { readSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

const { gluePath, wasmModule, fd, inputSize, archiveType, limits, outputFd = null, batchLimits = null } = workerData;
const INPUT_DIR = '/in';
const INPUT_PATH = '/in/archive';
// MEMFS file data lives in JS memory outside the WASM cap; listing and -so extraction
// never need to create files, so every writable directory is made read-only.
const WRITABLE_DIRS = ['/', '/tmp', '/home', '/home/web_user', INPUT_DIR];
const EIO = 29;
const EPERM = 63;
// Present so an encrypted archive can never block on a password prompt.
const NO_PASSWORD = '-pcreatorcrate-no-password';
const COMMON_SWITCHES = ['-sccUTF-8', '-bsp0', '-bse2', NO_PASSWORD, '-t' + archiveType];

let failure = null;

// Latch the first limit/failure and tell the parent before anything else is posted.
function latch(code, message) {
  if (failure) return;
  failure = code;
  parentPort.postMessage({ type: 'failed', code, message });
}

class ByteSink {
  constructor(cap, code, label) {
    this.cap = cap;
    this.code = code;
    this.label = label;
    this.chunks = [];
    this.length = 0;
  }

  write(bytes) {
    if (this.length + bytes.length > this.cap) {
      latch(this.code, 'Decoder ' + this.label + ' exceeded ' + this.cap + ' bytes.');
      return false;
    }
    this.chunks.push(bytes.slice());
    this.length += bytes.length;
    return true;
  }

  take() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    this.length = 0;
    return out;
  }
}

// Fixed-size member output: the parent already rejected declared sizes above its cap, and
// anything past the declared size is a decoder/archive inconsistency.
class MemberSink {
  constructor(size) {
    this.bytes = new Uint8Array(size);
    this.length = 0;
  }

  write(bytes) {
    if (this.length + bytes.length > this.bytes.length) {
      latch('OUTPUT_LIMIT_EXCEEDED', 'Decoded member exceeded its permitted size.');
      return false;
    }
    this.bytes.set(bytes, this.length);
    this.length += bytes.length;
    return true;
  }
}

async function createDecoder() {
  const memory = new WebAssembly.Memory({
    initial: 256,
    maximum: Math.floor(limits.maxMemoryBytes / 65536),
  });
  const grow = memory.grow.bind(memory);
  Object.defineProperty(memory, 'grow', {
    value(pages) {
      try {
        return grow(pages);
      } catch (error) {
        latch('MEMORY_LIMIT_EXCEEDED', 'Decoder memory exceeded ' + limits.maxMemoryBytes + ' bytes.');
        throw error;
      }
    },
  });
  const SevenZip = createRequire(import.meta.url)(gluePath);
  let exports = null;
  const module = await SevenZip({
    wasmMemory: memory,
    thisProgram: '7zz',
    arguments: [],
    noInitialRun: true,
    stdin: () => null,
    print: () => {},
    printErr: () => {},
    instantiateWasm(imports, receive) {
      WebAssembly.instantiate(wasmModule, imports).then(
        (instance) => {
          exports = instance.exports;
          receive(instance, wasmModule);
        },
        (error) => latch('DECODER_FAILED', 'The decoder could not start: ' + String(error?.message ?? error).slice(0, 200)),
      );
      return {};
    },
  });
  return { module, memory, stack: commandStack(exports) };
}

// ─── WASM stack per command ───────────────────────────────────────────────────────────────
//
// The glue's callMain (Emscripten, this build) does, with no matching restore:
//   argv = stackAlloc((argc + 1) * 4); each arg (thisProgram first) = stackAlloc(utf8 + 1)
// and _emscripten_stack_alloc rounds every allocation to 16 bytes. Every command therefore
// left its whole argument vector on 7-Zip's 64 KiB stack, and a C++ throw that unwinds out of
// main also left its frames there (measured: 14,112 bytes per 700-selector command, adding up
// across commands until a solid batch trapped). The build is single-threaded (ST_MODE) with no
// Asyncify, so once callMain returns or throws no WASM frame is live and nothing still uses
// those allocations: the stack pointer is put back to the resting top, as Emscripten's own
// ccall does around its stack-allocated arguments. Every command must also start from that
// top, so an allocation that survived a command can never shrink the next one's stack.
function commandStack(exports) {
  const current = exports?.emscripten_stack_get_current;
  const restore = exports?._emscripten_stack_restore;
  if (typeof current !== 'function' || typeof restore !== 'function') {
    throw new Error('The decoder build does not expose its stack pointer.');
  }
  return { current, restore, top: current() };
}

const THIS_PROGRAM = '7zz';
const STACK_ALIGN = 16;
const ARGV_POINTER_BYTES = 4;
const aligned = (bytes) => Math.ceil(bytes / STACK_ALIGN) * STACK_ALIGN;

// The glue's lengthBytesUTF8, counted the same way so the budget matches what it allocates.
function utf8Length(text) {
  let length = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) length += 1;
    else if (code <= 0x7ff) length += 2;
    else if (code >= 0xd800 && code <= 0xdfff) {
      length += 4;
      i += 1;
    } else length += 3;
  }
  return length;
}

// Exact bytes callMain takes from the stack for these arguments (thisProgram included).
function argvStackBytes(args) {
  let total = aligned((args.length + 2) * ARGV_POINTER_BYTES) + aligned(utf8Length(THIS_PROGRAM) + 1);
  for (const arg of args) total += aligned(utf8Length(arg) + 1);
  return total;
}

function mountInput(FS) {
  const MEMFS = FS.filesystems.MEMFS;
  FS.mkdir(INPUT_DIR);
  const node = FS.create(INPUT_PATH, 0o444);
  node.usedBytes = inputSize;
  node.node_ops = {
    ...node.node_ops,
    setattr() {
      throw new FS.ErrnoError(EPERM);
    },
  };
  node.stream_ops = {
    llseek: MEMFS.stream_ops.llseek,
    read(stream, buffer, offset, length, position) {
      if (position >= inputSize) return 0;
      const wanted = Math.min(length, inputSize - position);
      let done = 0;
      while (done < wanted) {
        const count = readSync(fd, buffer, offset + done, wanted - done, position + done);
        if (count === 0) break;
        done += count;
      }
      return done;
    },
    write() {
      throw new FS.ErrnoError(EPERM);
    },
    mmap() {
      throw new FS.ErrnoError(EPERM);
    },
  };
}

function routeStream(FS, fdNumber, sink) {
  FS.streams[fdNumber].stream_ops = {
    write(stream, buffer, offset, length) {
      // buffer is the Int8Array heap view; copy out as unsigned bytes.
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      if (failure || !sink.current?.write(bytes)) {
        throw new FS.ErrnoError(EIO);
      }
      return length;
    },
    read() {
      throw new FS.ErrnoError(EPERM);
    },
  };
}

function run(module, stack, args) {
  let exitCode = null;
  if (stack.current() !== stack.top) {
    latch('DECODER_FAILED', 'The decoder stack was not restored between commands.');
  } else {
    try {
      exitCode = module.callMain(args);
    } catch (error) {
      latch('DECODER_FAILED', 'The decoder stopped unexpectedly: ' + String(error?.message ?? error).slice(0, 200));
    } finally {
      stack.restore(stack.top);
    }
  }
  // After a latch only the exit code is reported (no data). The parent has already failed the
  // job; this records that 7-Zip's own status (often 0) was not trusted.
  if (failure) parentPort.postMessage({ type: 'aborted', exitCode });
  return exitCode;
}

function waitForInstruction() {
  return new Promise((resolve) => parentPort.once('message', resolve));
}

// ─── Batch extraction (used only for solid-archive preparation) ──────────────────────────
//
// Only reached after an 'extractBatch' instruction in a worker the parent started with an
// output descriptor. 7-Zip then gets one extra directory, /out, whose nodes admit exactly
// the parent's selected member paths (and their ancestor directories). Each admitted file
// node has no MEMFS storage: its writes go straight from the WASM heap to the parent's
// staging descriptor at an offset this code controls, capped at the member's declared size.
// Members must be written one at a time and sequentially; anything else latches a failure.
// The input node, the read-only directories and the single-member path are unchanged.
const OUTPUT_DIR = '/out';

function refuse(FS, code, message) {
  latch(code, message);
  throw new FS.ErrnoError(EPERM);
}

function mountOutput(FS, state) {
  const node = FS.lookupPath(OUTPUT_DIR).node;
  guardDirectory(FS, node, '', state);
  FS.chmod(OUTPUT_DIR, 0o700);
}

function guardDirectory(FS, node, prefix, state) {
  const base = node.node_ops;
  const forbidden = () => refuse(FS, 'PROTOCOL_ERROR', 'The decoder attempted an unexpected output operation.');
  node.node_ops = {
    ...base,
    mknod(parent, name, mode, dev) {
      const path = prefix + name;
      if (FS.isDir(mode)) {
        if (!state.directories.has(path)) forbidden();
        const child = base.mknod(parent, name, mode, dev);
        guardDirectory(FS, child, path + '/', state);
        return child;
      }
      const member = state.members.get(path);
      if (!FS.isFile(mode) || !member || member.state !== 'pending') forbidden();
      const child = base.mknod(parent, name, mode, dev);
      guardMemberFile(FS, child, member, state);
      return child;
    },
    rename: forbidden,
    unlink: forbidden,
    rmdir: forbidden,
    symlink: forbidden,
  };
}

function guardMemberFile(FS, node, member, state) {
  const nodeOps = node.node_ops;
  const forbidden = () => refuse(FS, 'PROTOCOL_ERROR', 'The decoder attempted an unexpected output operation.');
  node.node_ops = {
    ...nodeOps,
    setattr(target, attr) {
      if (attr.size !== undefined) forbidden();
      return nodeOps.setattr(target, attr);
    },
  };
  node.stream_ops = {
    open() {
      if (state.open || member.state !== 'pending') forbidden();
      member.state = 'open';
      member.offset = state.offset;
      member.length = 0;
      state.open = member;
    },
    write(stream, buffer, offset, length, position) {
      if (failure || state.open !== member || position !== member.length) {
        if (!failure) latch('PROTOCOL_ERROR', 'The decoder wrote a member out of order.');
        throw new FS.ErrnoError(EIO);
      }
      if (member.length + length > member.size) {
        latch('OUTPUT_LIMIT_EXCEEDED', 'Decoded member exceeded its permitted size.');
        throw new FS.ErrnoError(EIO);
      }
      try {
        let done = 0;
        while (done < length) {
          done += writeSync(outputFd, buffer, offset + done, length - done, member.offset + member.length + done);
        }
      } catch (error) {
        latch('OUTPUT_WRITE_FAILED', 'Prepared output could not be written: ' + String(error?.code ?? 'error'));
        throw new FS.ErrnoError(EIO);
      }
      member.length += length;
      return length;
    },
    llseek(stream, offset, whence) {
      const target = whence === 0 ? offset : whence === 1 ? stream.position + offset : -1;
      if (target !== member.length) forbidden();
      return target;
    },
    close() {
      if (state.open !== member) return;
      closeMember(state);
    },
    read: forbidden,
    mmap: forbidden,
    allocate: forbidden,
  };
}

function closeMember(state) {
  const member = state.open;
  state.open = null;
  member.state = 'closed';
  state.offset += member.length;
  parentPort.postMessage({ type: 'member', index: member.index, offset: member.offset, length: member.length });
}

function validBatch(instruction) {
  const { runs } = instruction;
  if (!Number.isInteger(outputFd) || outputFd < 0 || outputFd === fd || !batchLimits || !Array.isArray(runs) || runs.length === 0) {
    return null;
  }
  const members = new Map();
  let total = 0;
  for (const run of runs) {
    if (!Array.isArray(run) || run.length === 0) return null;
    for (const item of run) {
      if (typeof item?.path !== 'string' || !Number.isSafeInteger(item.size) || item.size < 0
        || item.size > limits.maxMemberBytes || members.has(item.path)) return null;
      total += item.size;
      members.set(item.path, { index: members.size, path: item.path, size: item.size, state: 'pending' });
    }
  }
  if (members.size > batchLimits.maxMembers || total > batchLimits.maxBytes) return null;
  return members;
}

async function extractBatch(module, stack, FS, instruction, stdout, stderr) {
  const members = validBatch(instruction);
  if (!members) {
    latch('PROTOCOL_ERROR', 'Invalid batch extraction instruction.');
    return;
  }
  const directories = new Set();
  for (const path of members.keys()) {
    for (let slash = path.indexOf('/'); slash > 0; slash = path.indexOf('/', slash + 1)) directories.add(path.slice(0, slash));
  }
  const state = { members, directories, offset: 0, open: null };
  mountOutput(FS, state);
  for (const [runIndex, batchRun] of instruction.runs.entries()) {
    const paths = batchRun.map((item) => item.path);
    const selectArgs = ['l', '-slt', '-spd', ...COMMON_SWITCHES, '--', INPUT_PATH, ...paths];
    const extractArgs = ['x', '-o' + OUTPUT_DIR, '-aoa', '-bso0', '-spd', ...COMMON_SWITCHES, '--', INPUT_PATH, ...paths];
    // callMain puts argv on 7-Zip's own stack (see commandStack); see BATCH_ARGV_BYTES in the parent.
    if (argvStackBytes(selectArgs) > batchLimits.maxArgvBytes || argvStackBytes(extractArgs) > batchLimits.maxArgvBytes) {
      latch('PROTOCOL_ERROR', 'Batch run arguments exceed the permitted size.');
      return;
    }
    // Selection proof for this run, checked by the parent before anything is extracted.
    stdout.current = new ByteSink(limits.maxListingBytes, 'LISTING_LIMIT_EXCEEDED', 'listing');
    stderr.current = new ByteSink(limits.maxLogBytes, 'LOG_LIMIT_EXCEEDED', 'diagnostics');
    const selectExit = run(module, stack, selectArgs);
    if (failure) return;
    const selection = stdout.current.take();
    parentPort.postMessage({
      type: 'selected',
      run: runIndex,
      exitCode: selectExit,
      stdout: selection,
      stderr: new TextDecoder().decode(stderr.current.take()),
    }, [selection.buffer]);
    const reply = await waitForInstruction();
    if (reply?.type !== 'proceed' || reply.run !== runIndex) return;

    // -bso0 leaves stdout empty; any output still goes through a bounded sink.
    stdout.current = new ByteSink(limits.maxListingBytes, 'LISTING_LIMIT_EXCEEDED', 'output');
    stderr.current = new ByteSink(limits.maxLogBytes, 'LOG_LIMIT_EXCEEDED', 'diagnostics');
    const extractExit = run(module, stack, extractArgs);
    if (failure) return;
    // A member 7-Zip left open still ends here, so offsets stay contiguous for the parent.
    if (state.open) closeMember(state);
    parentPort.postMessage({
      type: 'ran',
      run: runIndex,
      exitCode: extractExit,
      stdoutLength: stdout.current.length,
      stderr: new TextDecoder().decode(stderr.current.take()),
    });
  }
}

async function main() {
  const { module, stack } = await createDecoder();
  const { FS } = module;
  mountInput(FS);
  // Batch workers get /out now, while / is still writable, but read-only and unguarded
  // nodes cannot be created in it until mountOutput guards it after the parent's choice.
  if (outputFd !== null) FS.mkdir(OUTPUT_DIR, 0o555);
  for (const dir of WRITABLE_DIRS) FS.chmod(dir, 0o555);
  const stdout = { current: null };
  const stderr = { current: null };
  routeStream(FS, 1, stdout);
  routeStream(FS, 2, stderr);

  stdout.current = new ByteSink(limits.maxListingBytes, 'LISTING_LIMIT_EXCEEDED', 'listing');
  stderr.current = new ByteSink(limits.maxLogBytes, 'LOG_LIMIT_EXCEEDED', 'diagnostics');
  const listExit = run(module, stack, ['l', '-slt', ...COMMON_SWITCHES, '--', INPUT_PATH]);
  if (failure) return;
  const listing = stdout.current.take();
  parentPort.postMessage({
    type: 'listed',
    exitCode: listExit,
    stdout: listing,
    stderr: new TextDecoder().decode(stderr.current.take()),
  }, [listing.buffer]);

  const instruction = await waitForInstruction();
  if (instruction?.type === 'extractBatch') {
    await extractBatch(module, stack, FS, instruction, stdout, stderr);
    return;
  }
  if (instruction?.type !== 'extract') return;
  if (!Number.isSafeInteger(instruction.size) || instruction.size < 0 || instruction.size > limits.maxMemberBytes
    || typeof instruction.member !== 'string') {
    latch('PROTOCOL_ERROR', 'Invalid extraction instruction.');
    return;
  }
  // Same selector as the extraction below, so the parent can check what it selects.
  stdout.current = new ByteSink(limits.maxListingBytes, 'LISTING_LIMIT_EXCEEDED', 'listing');
  stderr.current = new ByteSink(limits.maxLogBytes, 'LOG_LIMIT_EXCEEDED', 'diagnostics');
  const selectExit = run(module, stack, ['l', '-slt', '-spd', ...COMMON_SWITCHES, '--', INPUT_PATH, instruction.member]);
  if (failure) return;
  const selection = {
    exitCode: selectExit,
    stdout: stdout.current.take(),
    stderr: new TextDecoder().decode(stderr.current.take()),
  };
  const member = new MemberSink(instruction.size);
  stdout.current = member;
  stderr.current = new ByteSink(limits.maxLogBytes, 'LOG_LIMIT_EXCEEDED', 'diagnostics');
  const extractExit = run(module, stack, ['e', '-so', '-bso0', '-spd', ...COMMON_SWITCHES, '--', INPUT_PATH, instruction.member]);
  if (failure) return;
  const output = member.bytes;
  parentPort.postMessage({
    type: 'extracted',
    exitCode: extractExit,
    length: member.length,
    output,
    stderr: new TextDecoder().decode(stderr.current.take()),
    selection,
  }, [output.buffer, selection.stdout.buffer]);
}

main().catch((error) => {
  latch('DECODER_FAILED', 'The decoder could not run: ' + String(error?.message ?? error).slice(0, 200));
});
