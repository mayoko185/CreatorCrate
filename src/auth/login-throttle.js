import net from 'node:net';
import { normalizeUsername } from './credential-provider.js';

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30 * 1000;
const DEFAULT_MAX_ENTRIES = 512;

function normalizeAddress(value) {
  if (typeof value !== 'string') return 'unknown';
  const candidate = value.trim();
  if (!candidate) return 'unknown';
  if (candidate.startsWith('::ffff:') && net.isIP(candidate.slice(7))) return candidate.slice(7);
  if (net.isIP(candidate)) return candidate;
  return 'unknown';
}

export function getClientAddress(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof first === 'string') {
      const address = normalizeAddress(first.split(',')[0]);
      if (address !== 'unknown') return address;
    }
  }
  return normalizeAddress(req.socket?.remoteAddress || req.ip);
}

export class LoginThrottler {
  constructor({ now = Date.now, windowMs = DEFAULT_WINDOW_MS, baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.now = now;
    this.windowMs = windowMs;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.maxEntries = maxEntries;
    this.records = new Map();
  }

  key(username, address) {
    return `${normalizeUsername(username)}\u0000${normalizeAddress(address)}`;
  }

  prune(now = this.now()) {
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(key);
    }
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next().value;
      this.records.delete(oldest);
    }
  }

  check(username, address) {
    const now = this.now();
    this.prune(now);
    const record = this.records.get(this.key(username, address));
    if (!record || record.availableAt <= now) return { limited: false };
    return { limited: true, retryAfterMs: record.availableAt - now };
  }

  recordFailure(username, address) {
    const now = this.now();
    this.prune(now);
    const key = this.key(username, address);
    const previous = this.records.get(key);
    const failures = previous ? previous.failures + 1 : 1;
    const delay = Math.min(this.baseDelayMs * 2 ** Math.max(0, failures - 1), this.maxDelayMs);
    this.records.set(key, {
      failures,
      availableAt: now + delay,
      expiresAt: now + this.windowMs,
    });
    this.prune(now);
    return { delayMs: delay, failures };
  }

  recordSuccess(username, address) {
    this.records.delete(this.key(username, address));
  }

  size() {
    this.prune(this.now());
    return this.records.size;
  }
}

export function createLoginThrottler(opts = {}) {
  return new LoginThrottler(opts);
}
