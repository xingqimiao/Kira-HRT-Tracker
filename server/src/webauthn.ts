/**
 * WebAuthn passkeys: the relying-party half.
 *
 * The narrow job of this file is to verify a ceremony and hand back the credential's
 * public key, or the fact that user verification happened. All the *key* work lives in
 * `session.ts` (wrappers) and `logic.ts` (the PRF→KEK derivation), because a passkey
 * here has to be more than an authentication method: it has to be able to open the
 * account's data key. That is why PRF is required and not merely requested — without a
 * PRF output there is no key material, and a passkey that cannot open the data key
 * would be a second login factor pretending to be a data credential.
 *
 * The design choice worth stating: **the server unwraps.** The browser evaluates PRF,
 * sends the 32-byte output over TLS, and the server derives the KEK and opens the DEK.
 * That is the same trust shape as the password path, and deliberately so — the product
 * does not claim the server cannot decrypt during an unlock, only that it cannot unlock
 * on its own. Doing it client-side would be strictly better cryptographically and was
 * not chosen, because it forces every read endpoint to return ciphertext.
 *
 * What the salt is *not* is per-credential. Every wrapper over one account's DEK must
 * come from the same PRF evaluation input, because a discoverable sign-in has to
 * evaluate PRF before the server knows which account is involved. A per-account random
 * salt gives the essential property (an attacker cannot precompute across accounts)
 * while keeping a usernameless flow possible.
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';

import { getConfig } from './config.ts';
import { PRF_SALT } from './session.ts';
import type { Result } from './domain.ts';

/** A passkey ceremony is short — the user is looking at an OS prompt. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * `PRF`, as the extension input. The output is what the KEK is derived from.
 *
 * Required rather than optional: a credential that registers without PRF must be
 * refused, because accepting it would store a wrapper nothing can ever open. The
 * browser surfaces `prf.enabled` in the extension results, and registration checks it.
 */
type PrfExtensionInput = { prf: { eval: { first: Uint8Array } } };

function prfSaltBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(PRF_SALT, 'utf8'));
}

interface PendingChallenge {
  challenge: string;
  /**
   * The account the ceremony belongs to, or null for a discoverable sign-in where the
   * account is not known until the assertion names a credential.
   */
  userId: string | null;
  expiresAt: number;
}

/**
 * In-flight challenges.
 *
 * `ponytail:` in-memory, single instance, same ceiling as the session store — with
 * more than one instance a ceremony could start on one and finish on another, which
 * sticky routing or a shared table would fix. The interface is these two functions.
 */
const challenges = new Map<string, PendingChallenge>();

function sweep(now: number): void {
  for (const [key, entry] of challenges) {
    if (entry.expiresAt <= now) challenges.delete(key);
  }
}

function store(challenge: string, userId: string | null): void {
  sweep(Date.now());
  challenges.set(challenge, { challenge, userId, expiresAt: Date.now() + CHALLENGE_TTL_MS });
}

/**
 * Consume a challenge.
 *
 * Single use, and scoped to the account it was minted for. Single use is the replay
 * guard — the whole point of a challenge. The scope check matters for a different
 * reason: without it, a challenge minted for account A could be answered with a
 * credential registered to account B, which would let a user whose own passkey was
 * revoked still assert someone else's.
 */
function take(challenge: string, userId: string | null): boolean {
  sweep(Date.now());
  const entry = challenges.get(challenge);
  if (!entry) return false;
  if (entry.userId !== userId) return false;
  challenges.delete(challenge);
  return true;
}

/** Test seam. */
export function __clearChallengesForTest(): void {
  challenges.clear();
}

export function webauthnAvailable(): boolean {
  return getConfig().webauthn !== null;
}

/**
 * Registration options for adding a passkey to a known account.
 *
 * `residentKey: 'required'` is what makes the credential discoverable, so it can be
 * used to sign in without typing a username. `userVerification: 'required'` is what
 * the step-up story depends on: an assertion must prove the person was present with
 * their authenticator, not merely that a key was held.
 */
export async function registrationOptions(opts: {
  userId: string;
  username: string;
  excludeCredentialIds: string[];
}): Promise<Result<PublicKeyCredentialCreationOptionsJSON>> {
  const { webauthn } = getConfig();
  if (!webauthn) return { ok: false, error: 'passkeys are not configured on this server' };

  const options = await generateRegistrationOptions({
    rpName: webauthn.rpName,
    rpID: webauthn.rpId,
    userName: opts.username,
    userID: new Uint8Array(Buffer.from(opts.userId.replace(/-/g, ''), 'hex')),
    userDisplayName: opts.username,
    attestationType: 'none',
    excludeCredentials: opts.excludeCredentialIds.map((id) => ({ id })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    extensions: { prf: { eval: { first: prfSaltBytes() } } } as never,
  });

  store(options.challenge, opts.userId);
  return { ok: true, value: options };
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | undefined;
  deviceType: string | undefined;
  backedUp: boolean;
}

export async function verifyRegistration(opts: {
  response: RegistrationResponseJSON;
  userId: string;
}): Promise<Result<VerifiedRegistration>> {
  const { webauthn } = getConfig();
  if (!webauthn) return { ok: false, error: 'passkeys are not configured on this server' };

  const clientData = decodeClientData(opts.response.response.clientDataJSON);
  if (!clientData) return { ok: false, error: 'the passkey response was malformed' };
  if (!take(clientData.challenge, opts.userId)) {
    return { ok: false, error: 'this passkey request expired or was already used' };
  }

  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response: opts.response,
      expectedChallenge: clientData.challenge,
      expectedOrigin: webauthn.origins,
      expectedRPID: webauthn.rpId,
      requireUserVerification: true,
    });
  } catch {
    return { ok: false, error: 'that passkey could not be verified' };
  }
  if (!verified.verified || !verified.registrationInfo) {
    return { ok: false, error: 'that passkey could not be verified' };
  }

  const info = verified.registrationInfo;
  return {
    ok: true,
    value: {
      credentialId: info.credential.id,
      publicKey: info.credential.publicKey,
      counter: info.credential.counter,
      transports: info.credential.transports,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    },
  };
}

/**
 * Authentication options.
 *
 * Without `allowCredentials` the ceremony is discoverable: the authenticator picks a
 * credential for this RP, and the assertion names it. That is the usernameless path —
 * no account is known here, which is why the challenge is stored with a null owner and
 * the caller resolves the account from the credential id afterwards.
 */
export async function authenticationOptions(opts: {
  userId: string | null;
  allowCredentialIds?: string[];
}): Promise<Result<PublicKeyCredentialRequestOptionsJSON>> {
  const { webauthn } = getConfig();
  if (!webauthn) return { ok: false, error: 'passkeys are not configured on this server' };

  const options = await generateAuthenticationOptions({
    rpID: webauthn.rpId,
    userVerification: 'required',
    ...(opts.allowCredentialIds && opts.allowCredentialIds.length > 0
      ? { allowCredentials: opts.allowCredentialIds.map((id) => ({ id })) }
      : {}),
  });

  store(options.challenge, opts.userId);
  return { ok: true, value: options };
}

export interface VerifiedAssertion {
  credentialId: string;
  newCounter: number;
}

export async function verifyAuthentication(opts: {
  response: AuthenticationResponseJSON;
  /** The credential row, already loaded by caller from the response's credential id. */
  stored: { credentialId: string; publicKey: Uint8Array; counter: number; transports?: string[] };
  /** The account the challenged owner must match, or null for discoverable. */
  expectedUserId: string | null;
  expectedUserIdOfCredential: string;
}): Promise<Result<VerifiedAssertion>> {
  const { webauthn } = getConfig();
  if (!webauthn) return { ok: false, error: 'passkeys are not configured on this server' };

  const clientData = decodeClientData(opts.response.response.clientDataJSON);
  if (!clientData) return { ok: false, error: 'the passkey response was malformed' };
  if (!take(clientData.challenge, opts.expectedUserId)) {
    return { ok: false, error: 'this passkey request expired or was already used' };
  }

  // For a discoverable ceremony the challenge was ownerless, so the credential is what
  // names the account — but a *non*-discoverable one was scoped, and the credential
  // must belong to that same account.
  if (opts.expectedUserId !== null && opts.expectedUserId !== opts.expectedUserIdOfCredential) {
    return { ok: false, error: 'that passkey does not belong to this account' };
  }

  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response: opts.response,
      expectedChallenge: clientData.challenge,
      expectedOrigin: webauthn.origins,
      expectedRPID: webauthn.rpId,
      credential: {
        id: opts.stored.credentialId,
        publicKey: new Uint8Array(opts.stored.publicKey),
        counter: opts.stored.counter,
        ...(opts.stored.transports ? { transports: opts.stored.transports } : {}),
      },
      requireUserVerification: true,
    });
  } catch {
    return { ok: false, error: 'that passkey could not be verified' };
  }
  if (!verified.verified) return { ok: false, error: 'that passkey could not be verified' };

  // Refuse a *decrease* only. Synced passkeys report a constant 0, so requiring an
  // increase would reject every iCloud/Google credential; a decrease cannot happen
  // honestly and is a cloning signal.
  const newCounter = verified.authenticationInfo.newCounter;
  if (opts.stored.counter > 0 && newCounter < opts.stored.counter) {
    return { ok: false, error: 'that passkey reported a stale signature counter' };
  }
  return { ok: true, value: { credentialId: opts.stored.credentialId, newCounter } };
}

/** Read `challenge` out of a clientDataJSON without trusting it for anything else. */
function decodeClientData(clientDataJSON: string): { challenge: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as {
      challenge?: unknown;
    };
    if (typeof parsed.challenge !== 'string' || parsed.challenge.length === 0) return null;
    return { challenge: parsed.challenge };
  } catch {
    return null;
  }
}
