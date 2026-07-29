#!/usr/bin/env node
import 'dotenv/config';

import { createInterface } from 'node:readline';
import process from 'node:process';
import { createConfig } from '../src/config.js';
import { hashPassword } from '../src/auth/password-hash.js';
import { createManagedCredentialProvider, CredentialError, validateNewPassword } from '../src/auth/credential-provider.js';

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
    close() { rl.close(); },
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
      if (char === '\u0003') {
        cleanup();
        process.stdout.write('\n');
        console.error('Aborted.');
        process.exit(1);
      }
      if (char === '\r' || char === '\n') {
        cleanup();
        process.stdout.write('\n');
        resolve(input);
        return;
      }
      if (char === '\u007f' || char === '\b') {
        input = input.slice(0, -1);
        return;
      }
      input += char;
    }
    stdin.on('data', onData);
  });
}

async function main() {
  const config = createConfig();
  const provider = createManagedCredentialProvider({
    appDataRoot: config.appDataRoot,
    bootstrapUsername: config.auth.username,
    bootstrapPasswordHash: config.auth.passwordHash,
  });
  const interactive = process.stdin.isTTY;
  const lineReader = interactive ? null : createLineReader();
  async function prompt(text) {
    process.stdout.write(text);
    return interactive ? readMaskedLine() : lineReader.nextLine();
  }
  const password = await prompt('New password: ');
  const confirmation = await prompt('Confirm new password: ');
  lineReader?.close();
  const errors = validateNewPassword(password, confirmation);
  if (errors.length > 0) {
    console.error(errors.join(' '));
    process.exit(1);
  }
  provider.updatePasswordHash(hashPassword(password));
  console.log('Managed operator credential replaced. Restart CreatorCrate and sign in with the new password.');
}

main().catch((err) => {
  if (err instanceof CredentialError) console.error(`Credential error: ${err.message}`);
  else console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
