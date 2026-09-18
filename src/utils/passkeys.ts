/**
 * Passkeys, from the browser's side.
 *
 * The one thing this module has to get right is the **PRF extension**, because a
 * passkey here is not just a login — its PRF output is what opens the account's data
 * key. Without a PRF output there is nothing to unwrap with, so an authenticator that
 * cannot produce one is refused rather than accepted as a weaker login.
 *
 * That makes the capability check load-bearing rather than a nicety. Registration asks
 * for PRF with an `eval`, and the response's extension results say whether it was
 * honoured; a browser that reports `prf.enabled: false`, or omits the results, cannot
 * be allowed to finish — it would store a credential with no wrapper, and the account
 * would look registered while nothing could open it.
 *
 * PRF is a relatively new extension. Chromium and Safari support it; Firefox's support
 * has been behind flags. Where it is absent the UI says so plainly instead of offering
 * a button that fails at the OS prompt.
 */

export interface PasskeyCapability {
  /** Whether this browser exposes the WebAuthn API at all. */
  supported: boolean;
  /** Whether we have *verified* PRF works, rather than assuming. */
  prfAvailable: boolean;
}

/** True when this browser can plausibly do passkeys at all. */
export function passkeysSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator?.credentials?.create === 'function'
  );
}

/** Explicitly create a credential allowed for this site, then delete it. */
export async function prfAvailable(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  try {
    const publicKey: PublicKeyCredentialCreationOptions = {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Kira Tracker' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'prf-probe',
        displayName: 'PRF probe',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60_000,
      extensions: { prf: {} } as never,
    };
    const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
    if (!credential) return false;
    const extensions = credential.getClientExtensionResults() as { prf?: { enabled?: boolean } };
    return extensions.prf?.enabled === true;
  } catch {
    // No authenticator, a cancelled prompt, or a refusal — all mean "do not offer it".
    return false;
  }
}

function fromB64url(value: string): Uint8Array<ArrayBuffer> {
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

/** Pull the PRF output out of an extension-results object, or null. */
function prfOutputOf(credential: PublicKeyCredential): string | null {
  const extensions = credential.getClientExtensionResults() as PrfResults;
  const first = extensions.prf?.results?.first;
  if (!first) return null;
  const bytes = first instanceof Uint8Array ? first : new Uint8Array(first as ArrayBuffer);
  return bytes.length > 0 ? toB64url(bytes) : null;
}

export interface PasskeyAssertion {
  /** The JSON shape @simplewebauthn/server verifies. */
  response: unknown;
  /** The PRF output, base64url. Null when the authenticator did not provide one. */
  prfOutput: string | null;
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
    challenge: fromB64url(options.challenge),
    rp: options.rp,
    user: { ...options.user, id: fromB64url(options.user.id) },
    pubKeyCredParams: options.pubKeyCredParams,
    ...(options.excludeCredentials
      ? {
          excludeCredentials: options.excludeCredentials.map((c) => ({
            id: fromB64url(c.id),
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

  const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new Error('passkey registration was cancelled');

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
    prfOutput: prfOutputOf(credential),
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
    challenge: fromB64url(options.challenge),
    ...(options.rpId ? { rpId: options.rpId } : {}),
    ...(options.allowCredentials
      ? {
          allowCredentials: options.allowCredentials.map((c) => ({
            id: fromB64url(c.id),
            type: 'public-key' as const,
            ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}),
          })),
        }
      : {}),
    userVerification: options.userVerification ?? 'required',
    timeout: options.timeout,
    extensions: { prf: { eval: { first: prfSaltBytes() } } } as never,
  };

  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new Error('passkey sign-in was cancelled');

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
    prfOutput: prfOutputOf(credential),
    credentialId: credential.id,
  };
}

/** The PRF salt, exposed for the capability probe and diagnostics. */
export function passkeyPrfSalt(): string {
  return PRF_SALT;
}
