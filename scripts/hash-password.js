#!/usr/bin/env node
// Phase 12.1 — operator tool: generate a CREATORCRATE_PASSWORD_HASH value.
// Reads the password interactively from stdin (masked when the terminal
// supports raw mode), never from argv, never written to disk, no network
// dependency, and never starts the application.
import { createInterface } from 'node:readline';
import process from 'node:process';
import { hashPassword } from '../src/auth/password-hash.js';

// Non-interactive (piped) input: one shared readline interface for the
// whole run. A fresh interface per prompt does not work here — closing one
// interface tears down the underlying stdin stream so a second interface
// never sees any further lines.
function createLineReader() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const queue = [];
  const waiters = [];
  let closed = false;

  rl.on('line', (line) => {
    if (waiters.length > 0) waiters.shift()(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()(undefined);
  });

  return {
    nextLine() {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      if (closed) return Promise.resolve(undefined);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      rl.close();
    },
  };
}

function readMaskedLine() {
  return new Promise((resolve) => {
    const { stdin } = process;
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let input = '';

    function cleanup() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    }

    function onData(char) {
      if (char === '') {
        cleanup();
        process.stdout.write('\n');
        console.error('Aborted.');
        process.exit(1);
        return;
      }
      if (char === '\r' || char === '\n') {
        cleanup();
        process.stdout.write('\n');
        resolve(input);
        return;
      }
      if (char === '' || char === '\b') {
        input = input.slice(0, -1);
        return;
      }
      input += char;
    }

    stdin.on('data', onData);
  });
}

async function main() {
  const interactive = process.stdin.isTTY;
  const lineReader = interactive ? null : createLineReader();

  async function prompt(text) {
    process.stdout.write(text);
    return interactive ? readMaskedLine() : lineReader.nextLine();
  }

  const password = await prompt('Password: ');
  if (!password) {
    console.error('No password provided.');
    lineReader?.close();
    process.exit(1);
    return;
  }

  const confirmation = await prompt('Confirm password: ');
  lineReader?.close();

  if (password !== confirmation) {
    console.error('Passwords do not match.');
    process.exit(1);
    return;
  }

  console.log(hashPassword(password));
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
