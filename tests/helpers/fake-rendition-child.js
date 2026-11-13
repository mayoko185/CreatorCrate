import { projectImageGeneratedOutput } from '../../src/services/project-image-policy.js';

// Disposable protocol fixture launched with childArgs: [mode]. Derivative modes encode real
// image bytes, then vary result identity, payload or termination. Reader and spare modes
// exercise handshake, cancellation and malformed-message handling without native rendering.
const mode = process.argv[2];
const valid = { type: 'result', ok: true, unchanged: true, mimeType: 'image/png', width: 48, height: 64 };

function spin() {
  // Busy JavaScript: no event (not even 'disconnect') can run in this process any more.
  for (;;) { /* hold the CPU until killed */ }
}

process.on('message', async (job) => {
  if (mode.startsWith('derivative-')) {
    const sharp = (await import('sharp')).default;
    const output = projectImageGeneratedOutput(job.policy, false)[job.kind];
    const buffer = await sharp({ create: { width: 48, height: 64, channels: 3, background: 'red' } })
      [output.format]().toBuffer();
    const result = { type: 'result', ok: true, purpose: job.purpose, jobId: job.jobId,
      buffer, width: 48, height: 64, animated: false, frameCount: 1,
      format: output.format, filename: `${job.kind}.${output.format}` };
    if (mode === 'derivative-identity') result.jobId = '0'.repeat(36);
    if (mode === 'derivative-purpose') result.purpose = 'thumbnail';
    if (mode === 'derivative-extra') result.path = 'C:/secret.png';
    if (mode === 'derivative-format') result.format = 'jpeg';
    if (mode === 'derivative-dimensions') result.width = 49;
    if (mode === 'derivative-animation') result.animated = true;
    if (mode === 'derivative-malformed') result.buffer = Buffer.from('not an image');
    if (mode === 'derivative-trailing') result.buffer = Buffer.concat([buffer, Buffer.from('trailing')]);
    if (mode === 'derivative-oversized') result.buffer = Buffer.alloc(job.limits.maxOutputBytes + 1);
    if (mode === 'derivative-corrupt-pixels') {
      result.buffer = Buffer.from(buffer);
      // Keep the PNG catalogue/header valid but invalidate its compressed pixel stream.
      const offset = result.buffer.indexOf(Buffer.from('IDAT'));
      result.buffer.fill(0, offset + 4, offset + 12);
    }
    process.send({ type: 'phase', phase: 'metadata' });
    process.send({ type: 'phase', phase: 'stats' });
    process.send({ type: 'phase', phase: 'convert' });
    if (mode === 'derivative-hang') return;
    if (mode === 'derivative-zero-no-result') { process.exit(0); return; }
    if (mode === 'derivative-disconnect') { process.disconnect(); return; }
    process.send(result, () => {
      if (mode === 'derivative-duplicate') process.send(result);
      if (mode === 'derivative-protocol-error') process.send({ type: 'unexpected' });
      if (mode === 'derivative-stall') return;
      if (mode === 'derivative-failed-exit') process.exit(3);
      else if (mode === 'derivative-delayed-exit') setTimeout(() => process.disconnect(), 250);
      else process.disconnect();
    });
    return;
  }
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
