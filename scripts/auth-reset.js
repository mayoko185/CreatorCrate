#!/usr/bin/env node
// Phase 13 — offline authentication recovery. Runs outside any running
// server process: it cannot call into a live app context (there isn't one
// from the CLI's perspective), so it only ever changes durable state on
// disk — exactly what a restart of `pnpm start` would then pick up. A
// currently-running server process keeps using its in-memory auth mode
// until it is restarted; this command does not and cannot change that.
import 'dotenv/config';

import { createInterface } from 'node:readline';
import process from 'node:process';
import { createConfig } from '../src/config.js';
import { openDatabase, closeDatabase } from '../src/db.js';
import { readAuthEnablement, disableAuthState, AuthStateError } from '../src/auth/auth-state.js';
import { invalidateAllSessionsForDb } from '../src/services/auth-service.js';

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

async function main() {
  const config = createConfig();

  let authState;
  try {
    authState = readAuthEnablement(config.appDataRoot);
  } catch (err) {
    if (err instanceof AuthStateError) {
      console.error(`Auth-state error: ${err.message}`);
      process.exit(1);
      return;
    }
    throw err;
  }

  if (!authState.enabled) {
    console.error('Authentication is already disabled. Nothing to do.');
    process.exit(1);
    return;
  }

  console.log(
    'This will disable CreatorCrate authentication by changing the managed\n' +
    `state under "${config.appDataRoot}". It does not restart or otherwise\n` +
    'affect any currently-running server process — a running "pnpm start"\n' +
    'process keeps using its current in-memory auth mode until you restart it.\n'
  );

  const lineReader = createLineReader();
  process.stdout.write('Disable authentication now? [y/N] ');
  const answer = (await lineReader.nextLine()) || '';
  lineReader.close();

  if (answer.trim().toLowerCase() !== 'y') {
    console.error('Aborted. No changes were made.');
    process.exit(1);
    return;
  }

  const db = openDatabase(config.databasePath);
  try {
    // Required, not best-effort — matches the ordering discipline in
    // auth-transition-service.js: sessions are invalidated before the
    // managed state is flipped to disabled.
    invalidateAllSessionsForDb(db);
    // operator-credential.json is left inert, exactly as the HTTP
    // disable() path leaves it — see auth-transition-service.js's
    // credential-file contract. No deletion, no password/hash/secret ever
    // printed.
    disableAuthState(config.appDataRoot, { csrfPepper: authState.csrfPepper });
  } finally {
    closeDatabase(db);
  }

  console.log('Authentication disabled. Restart CreatorCrate for a running process to pick this up.');
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
