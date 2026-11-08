// F1a test helper: a misbehaving stand-in for comic-rendition-child.js, launched by
// createComicRenditionSupervisor({ childModule, childArgs: [mode] }). Each mode breaks one rule
// of the parent/child protocol. It never renders anything. F1b adds 'answer' (a well-behaved
// child that answers its job at once with a valid result, and anything sent to it while idle
// too) and two broken spares: 'garbage-ready' and 'ready-then-exit' <ms>.
const mode = process.argv[2];
const valid = { type: 'result', ok: true, unchanged: true, mimeType: 'image/png', width: 48, height: 64 };

function spin() {
  // Busy JavaScript: no event (not even 'disconnect') can run in this process any more.
  for (;;) { /* hold the CPU until killed */ }
}

process.on('message', (job) => {
  switch (mode) {
    case 'garbage':
      process.send('not a message');
      break;
    case 'malformed-result':
      process.send({ ...valid, width: 'wide' });
      break;
    case 'extra-key':
      process.send({ ...valid, path: '/secret/project/file.png' });
      break;
    case 'unknown-type':
      process.send({ type: 'shell', command: 'echo' });
      break;
    case 'phase-order':
      process.send({ type: 'phase', phase: 'stats' });
      process.send({ type: 'phase', phase: 'metadata' });
      break;
    case 'duplicate':
      process.send(valid);
      process.send(valid);
      break;
    case 'unchanged-animated':
      // Claims an animated page may be served as its original bytes.
      process.send(valid);
      break;
    case 'oversized': {
      const bytes = Buffer.alloc(job.limits.maxOutputBytes + 1, 1);
      process.send({ type: 'result', ok: true, unchanged: false, bytes, mimeType: 'image/png', width: 48, height: 64 });
      break;
    }
    case 'exit-after-job':
      process.exit(3);
      break;
    case 'crash-after-job':
      process.abort();
      break;
    case 'late': {
      // A phase report at once, then a valid result after the given delay.
      process.send({ type: 'phase', phase: 'metadata' });
      setTimeout(() => process.send(valid), Number(process.argv[3]));
      break;
    }
    case 'answer':
      process.send(valid);
      break;
    case 'converted': {
      // P3-A: a converted result claiming the given dimensions (argv: width height), with a
      // small valid-looking JPEG payload; the parent must check the claim itself.
      const width = Number(process.argv[3]);
      const height = Number(process.argv[4]);
      process.send({ type: 'result', ok: true, unchanged: false, bytes: Buffer.alloc(16, 1), mimeType: 'image/jpeg', width, height });
      break;
    }
    case 'hang':
      process.send({ type: 'phase', phase: 'metadata' }, () => setTimeout(spin, 20));
      break;
    case 'ignore':
    default:
      break;
  }
});

if (mode === 'exit-before-ready') process.exit(4);
else if (mode === 'wrong-version') process.send({ type: 'ready', v: 99 });
else if (mode === 'garbage-ready') process.send({ type: 'ready', v: 1, extra: true });
else if (mode === 'ready-then-exit') {
  process.send({ type: 'ready', v: 1 });
  setTimeout(() => process.exit(5), Number(process.argv[3]));
}
else if (mode !== 'never-ready') process.send({ type: 'ready', v: 1 });
