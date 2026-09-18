/**
 * Passkeys, from the browser's side.
 *
 * The one thing this module has to get right is the **PRF extension**, because a
 * passkey here is not just a login — its PRF output is what opens the account's data
 * key. Without a PRF output there is nothing to unwrap with, so an authenticator that
 * cannot produce one is refused rather than accepted as a weaker login.
 *
 * **Capability is checked by doing, never by probing.** An earlier version asked
 * `prfAvailable()` on mount, which created a throwaway credential to find out — and
 * that meant a system passkey dialog appearing on page load, before the user had asked
 * for anything, and the button *hiding itself* if they dismissed it. A prompt is fine
 * when the person just clicked a button; it is not fine on their behalf at load time.
 * So the only check made up front is `passkeysSupported()`, which is a pure property
 * test that cannot prompt. Everything else is discovered when the user actually acts,
 * and reported then — the PRF requirement is enforced by the ceremony itself.
 */

/** Why a passkey ceremony did not complete, in terms the UI can explain. */
export type PasskeyErrorCode =
  /** This browser has no WebAuthn API at all. */
  | 'unsupported'
  /** The user dismissed the prompt, or no credential on this device matched. */
  | 'cancelled'
  /** The authenticator did not return the PRF output the data key needs. */
  | 'no_prf'
  /** Anything else the platform refused. */
  | 'failed';

export class PasskeyError extends Error {
  constructor(
    readonly code: PasskeyErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'PasskeyError';
  }
}

/**
 * True when this browser can do passkeys at all.
 *
 * A pure property test — it never prompts, so it is safe to call while rendering. It
 * deliberately does *not* try to learn whether PRF works: that can only be answered by
 * creating a credential, which is a prompt, and a prompt here would arrive uninvited.
 */
export function passkeysSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator?.credentials?.create === 'function'
  );
}

/** Map whatever the platform threw into something the UI can translate. */
function asPasskeyError(error: unknown): PasskeyError {
  if (error instanceof PasskeyError) return error;
  // `NotAllowedError` covers both "the user said no" and "nothing matched on this
  // device"; the platform does not distinguish them, so neither do we.
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return new PasskeyError('cancelled', error.message);
  }
  // Anything else is a platform refusal with no code we can translate. Its *name*
  // (`InvalidStateError`, `InvalidCharacterError`, …) is what identifies it, so both go
  // into the message, and the whole error goes to the console: a console line survives a
  // bug report better than a screenshot of a banner.
  if (typeof console !== 'undefined') console.error('[passkey] ceremony failed', error);
  return new PasskeyError(
    'failed',
    error instanceof Error && error.message ? `${error.name}: ${error.message}` : String(error),
  );
}

/**
 * Decode base64url, naming the field when it will not decode.
 *
 * `atob` reports a bad argument as `InvalidCharacterError: Invalid character`, which
 * names neither the value nor which side of the wire it came from — and every value here
 * comes from the server, so a malformed one is a bug there, not something the user asked
 * for. Naming the field is the difference between a report that can be acted on and one
 * that cannot.
 */
function fromB64url(value: string, field: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PasskeyError('failed', `${field} is missing from the server's options`);
  }
  if (!/^[A-Za-z0-9_=-]+$/.test(value)) {
    throw new PasskeyError('failed', `${field} from the server is not valid base64url`);
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const raw = atob(padded);
  // Explicitly backed by an ArrayBuffer: the DOM's WebAuthn types require
  // `BufferSource`, and a `Uint8Array<ArrayBufferLike>` is not assignable to one.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function toB64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The PRF evaluation input, fixed application-wide.
 *
 * It has to match the server's `PRF_SALT` byte for byte, and it has to be a constant:
 * a discoverable sign-in evaluates PRF *before* the server knows which account is
 * involved, so there is no per-account value to fetch. It is an input, not a secret —
 * the PRF output computed over it is what becomes the key.
 */
const PRF_SALT = 'hrt-passkey-salt-v1';

function prfSaltBytes(): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(PRF_SALT);
  const bytes = new Uint8Array(new ArrayBuffer(encoded.length));
  bytes.set(encoded);
  return bytes;
}

interface PrfResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | Uint8Array } };
  [key: string]: unknown;
}

/**
 * The PRF output, or a `no_prf` failure.
 *
 * Required, not optional. A credential that produced no PRF output has nothing to wrap
 * the data key with, so finishing the ceremony would store a passkey that can never
 * open anything while appearing registered — the failure mode with no error message.
 * Refusing here turns it into one the user can act on.
 */
function requirePrf(credential: PublicKeyCredential): string {
  const extensions = credential.getClientExtensionResults() as PrfResults;
  const first = extensions.prf?.results?.first;
  if (!first) throw new PasskeyError('no_prf');
  const bytes = first instanceof Uint8Array ? first : new Uint8Array(first as ArrayBuffer);
  if (bytes.length === 0) throw new PasskeyError('no_prf');
  return toB64url(bytes);
}

export interface PasskeyAssertion {
  /** The JSON shape @simplewebauthn/server verifies. */
  response: unknown;
  /** The PRF output, base64url. Never null — a ceremony without one is a failure. */
  prfOutput: string;
  /** The credential id, base64url. */
  credentialId: string;
}

/**
 * Register a passkey and evaluate PRF, returning both the attestation and the output.
 *
 * The browser evaluates PRF over the fixed app-wide salt, which is what makes the
 * output directly usable as the key-derivation input.
 
 */
export async function createPasskey(optionsJson: unknown): Promise<PasskeyAssertion> {
  const options = optionsJson as {
    challenge: string;
    rp: { id?: string; name: string };
    user: { id: string; name: string; displayName: string };
    pubKeyCredParams: PublicKeyCredentialParameters[];
    excludeCredentials?: { id: string; type: 'public-key'; transports?: string[] }[];
    authenticatorSelection?: AuthenticatorSelectionCriteria;
    timeout?: number;
    extensions?: Record<string, unknown>;
  };

  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: fromB64url(options.challenge, 'challenge'),
    rp: options.rp,
    user: { ...options.user, id: fromB64url(options.user.id, 'user.id') },
    pubKeyCredParams: options.pubKeyCredParams,
    ...(options.excludeCredentials
      ? {
          excludeCredentials: options.excludeCredentials.map((c) => ({
            id: fromB64url(c.id, 'excludeCredentials[].id'),
            type: 'public-key' as const,
            // The wire type is a plain string[]; the DOM wants the transport union.
            ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}),
          })),
        }
      : {}),
    authenticatorSelection: options.authenticatorSelection,
    timeout: options.timeout,
    attestation: 'none',
    extensions: { prf: { eval: { first: prfSaltBytes() } } } as never,
  };

  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  } catch (error) {
    throw asPasskeyError(error);
  }
  if (!credential) throw new PasskeyError('cancelled');

  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    response: {
      id: credential.id,
      rawId: toB64url(new Uint8Array(credential.rawId)),
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: toB64url(new Uint8Array(response.clientDataJSON)),
        attestationObject: toB64url(new Uint8Array(response.attestationObject)),
        ...(response.getTransports ? { transports: response.getTransports() } : {}),
      },
    },
    prfOutput: requirePrf(credential),
    credentialId: credential.id,
  };
}

/**
 * Assert an existing passkey and evaluate PRF.
 *
 * `useBrowserAutofill` stays off: the discoverable prompt is what makes a
 * username-less sign-in work, and conditional mediation would race the visible button.
 */
export async function getPasskeyAssertion(optionsJson: unknown): Promise<PasskeyAssertion> {
  const options = optionsJson as {
    challenge: string;
    rpId?: string;
    allowCredentials?: { id: string; type: 'public-key'; transports?: string[] }[];
    userVerification?: UserVerificationRequirement;
    timeout?: number;
  };

  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: fromB64url(options.challenge, 'challenge'),
    ...(options.rpId ? { rpId: options.rpId } : {}),
    ...(options.allowCredentials
      ? {
          allowCredentials: options.allowCredentials.map((c) => ({
            id: fromB64url(c.id, 'allowCredentials[].id'),
            type: 'public-key' as const,
            ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}),
          })),
        }
      : {}),
    userVerification: options.userVerification ?? 'required',
    timeout: options.timeout,
    extensions: { prf: { eval: { first: prfSaltBytes() } } } as never,
  };

  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  } catch (error) {
    throw asPasskeyError(error);
  }
  if (!credential) throw new PasskeyError('cancelled');

  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    response: {
      id: credential.id,
      rawId: toB64url(new Uint8Array(credential.rawId)),
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: toB64url(new Uint8Array(response.clientDataJSON)),
        authenticatorData: toB64url(new Uint8Array(response.authenticatorData)),
        signature: toB64url(new Uint8Array(response.signature)),
        userHandle: response.userHandle ? toB64url(new Uint8Array(response.userHandle)) : null,
      },
    },
    prfOutput: requirePrf(credential),
    credentialId: credential.id,
  };
}

/** The PRF salt, exposed for diagnostics and the salt-agreement test. */
export function passkeyPrfSalt(): string {
  return PRF_SALT;
}
