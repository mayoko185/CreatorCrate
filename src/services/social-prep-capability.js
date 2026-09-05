import { timingSafeEqual } from 'node:crypto';

import { digestToken } from './social-prep-tokens.js';

const DUMMY_DIGEST = '0'.repeat(64);
const BEARER_TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/;

export class SocialPrepCapabilityError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'SocialPrepCapabilityError';
    this.code = code;
    this.status = status;
  }
}

function timestampAtOrAfter(now, timestamp) {
  return now.getTime() >= new Date(`${timestamp.replace(' ', 'T')}Z`).getTime();
}

function sameDigest(actual, expected) {
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function invalidToken() {
  return new SocialPrepCapabilityError('media_token_invalid', 403, 'The media token is invalid.');
}

/**
 * Authenticate an already redeemed Social Preparation media capability.
 * The order is deliberately fixed: bearer, deadline, then session state.
 */
export function createSocialPrepCapabilityService({ socialPrepRepository, now = () => new Date() } = {}) {
  if (!socialPrepRepository) throw new Error('createSocialPrepCapabilityService requires socialPrepRepository.');

  function authenticate({ authorization, sessionId }) {
    if (typeof authorization !== 'string' || authorization.length === 0) {
      throw new SocialPrepCapabilityError('media_token_missing', 401, 'A media token is required.');
    }
    const match = BEARER_TOKEN.exec(authorization);
    if (!match) throw new SocialPrepCapabilityError('media_token_malformed', 401, 'The media token is malformed.');

    const suppliedDigest = digestToken(match[1]);
    const session = socialPrepRepository.findSessionById(sessionId);
    const expectedDigest = session?.media_token_hash ?? DUMMY_DIGEST;
    if (!sameDigest(suppliedDigest, expectedDigest) || !session) throw invalidToken();

    if (!session.attempt_deadline_at || timestampAtOrAfter(now(), session.attempt_deadline_at)) {
      throw new SocialPrepCapabilityError('media_token_expired', 401, 'The media token has expired.');
    }
    if (session.state === 'superseded') {
      throw new SocialPrepCapabilityError('attempt_superseded', 409, 'The preparation attempt was superseded.');
    }
    if (session.state === 'finished') {
      throw new SocialPrepCapabilityError('attempt_finished', 409, 'The preparation attempt has finished.');
    }
    if (session.state !== 'redeemed') {
      throw new SocialPrepCapabilityError('attempt_not_active', 409, 'The preparation attempt is not active.');
    }
    return session;
  }

  return Object.freeze({ authenticate });
}
