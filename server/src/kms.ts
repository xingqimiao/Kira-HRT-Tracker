/**
 * OCI Key Management — the deployment's master key, held in hardware.
 *
 * What changed, and what did not: the server wrapper on each account's DEK used to
 * be sealed under `SERVER_DEK_KEY`, a secret the process held in memory for its
 * whole lifetime — root on the box could read every record, forever, offline. Under
 * this module the DEK is wrapped by an OCI KMS master key that **lives in an HSM**:
 * the process never sees it, a stolen disk image never contains it, and every wrap
 * or unwrap is one audited KMS API call scoped by IAM to this instance.
 *
 * What this does NOT buy, stated plainly so nobody has to rediscover it: an attacker
 * with root on the live box is inside the dynamic group too, and can call Decrypt
 * while the compromise lasts. HSM stops the key from being *taken away*; it does not
 * stop the operator (or an OCI admin) from reading records. This is still not
 * end-to-end encryption — `session.ts` states the honest bound.
 *
 * The SDK is imported lazily (dynamic import inside `getClient`), so a deployment
 * with KMS unconfigured never loads it, and the test suite never needs instance
 * principals.
 *
 * Envelope: the DEK wrapper reuses `WrapperEnvelope`'s shape with an empty `iv` —
 * there is no local IV, the KMS ciphertext is opaque — and `scheme` is what tells
 * `unwrapWithServer` which path opens it.
 */

/** The deployment's KMS settings, from the environment. */
export interface KmsConfig {
  /** The master encryption key OCID (`ocid1.key.oc1.…`). */
  keyId: string;
  /** The vault's cryptographic endpoint, e.g. https://<id>-crypto.kms.<region>.oraclecloud.com. */
  cryptoEndpoint: string;
}

/** A DEK wrapped under the KMS master key, as stored in `wrappers.server`. */
export interface KmsWrapped {
  cloud: 1;
  iv: '';
  data: string;
  scheme: typeof KMS_SCHEME;
}

export const KMS_SCHEME = 'server-kms-v1';

/**
 * Accept a cryptographic endpoint or name the reason it is refused.
 *
 * The endpoint is where wrapped key material goes, so it is a trust boundary: https
 * only, and a host under a regional `kms.<region>.oraclecloud.com` zone. Anything
 * else — a private address, a lookalike host, a different cloud — is rejected here,
 * at startup, rather than trusted because it happened to be in the environment.
 */
export function kmsEndpointError(raw: string | null | undefined): string | null {
  if (!raw) return 'KMS_CRYPTO_ENDPOINT is required when KMS_KEY_OCID is set';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'KMS_CRYPTO_ENDPOINT is not a URL';
  }
  if (url.protocol !== 'https:') return 'KMS_CRYPTO_ENDPOINT must be https';
  if (!/^[a-z0-9-]+-crypto\.kms\.[a-z0-9-]+\.oraclecloud\.com$/.test(url.hostname)) {
    return `KMS_CRYPTO_ENDPOINT host is not an OCI KMS crypto endpoint: ${url.hostname}`;
  }
  return null;
}

/** Accept a key OCID or name the reason it is refused.
 *
 *  The OCID's trailing structure is versioned and not ours to pin down — real keys
 *  carry extra dot-separated segments after the region — so validation is a prefix
 *  check plus a character-set bound, not a shape the platform could change. */
export function kmsKeyIdError(raw: string | null | undefined): string | null {
  if (!raw) return 'KMS_KEY_OCID is required when KMS_CRYPTO_ENDPOINT is set';
  if (!/^ocid1\.key\.[a-z0-9.-]+$/.test(raw)) {
    return 'KMS_KEY_OCID must be a master-encryption-key OCID (ocid1.key.…)';
  }
  return null;
}

type CryptoClient = {
  encrypt: (req: {
    encryptDataDetails: { keyId: string; plaintext: string; associatedData: Record<string, string> };
  }) => Promise<{ encryptedData: { ciphertext: string } }>;
  decrypt: (req: {
    decryptDataDetails: { keyId: string; ciphertext: string; associatedData: Record<string, string> };
  }) => Promise<{ decryptedData: { plaintext: string } }>;
};

/**
 * The process-wide crypto client, built on first use.
 *
 * Instance Principals: the credentials come from the instance metadata service, so
 * the box carries no secrets at all. The endpoint is per-vault and fixed for a
 * deployment, so one client serves the process's whole lifetime.
 */
let clientPromise: Promise<CryptoClient> | null = null;

function getClient(kms: KmsConfig): Promise<CryptoClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const common = await import('oci-common');
      const kmsMod = await import('oci-keymanagement');
      const provider = await new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
      const client = new kmsMod.KmsCryptoClient({ authenticationDetailsProvider: provider });
      client.endpoint = kms.cryptoEndpoint;
      return client as unknown as CryptoClient;
    })();
  }
  return clientPromise;
}

/**
 * Wrap a DEK under the KMS master key, bound to its owner.
 *
 * `dek` is the base64 of the raw 32 bytes — exactly the form the KMS API wants as
 * `plaintext`. The `userId` travels as associated data, so a ciphertext lifted from
 * one account's metadata is worthless against another's row: decrypting under a
 * different owner fails authentication, the same property the HMAC scheme's
 * per-user KEK provided.
 */
export async function wrapWithKms(dek: string, userId: string, kms: KmsConfig): Promise<KmsWrapped> {
  const client = await getClient(kms);
  const response = await client.encrypt({
    encryptDataDetails: { keyId: kms.keyId, plaintext: dek, associatedData: { userId } },
  });
  return { cloud: 1, iv: '', data: response.encryptedData.ciphertext, scheme: KMS_SCHEME };
}

/**
 * Recover a DEK from its KMS wrapper, or null when it cannot be opened.
 *
 * A null here means: KMS unreachable, the master key disabled, or the wrapper does
 * not belong to this user. Every caller already reports "locked" for a null, which
 * is the right answer for all three — no key is better than a wrong one.
 */
export async function unwrapWithKms(
  wrapped: { data: string },
  userId: string,
  kms: KmsConfig,
): Promise<string | null> {
  try {
    const client = await getClient(kms);
    const response = await client.decrypt({
      decryptDataDetails: { keyId: kms.keyId, ciphertext: wrapped.data, associatedData: { userId } },
    });
    const dek = response.decryptedData.plaintext;
    return typeof dek === 'string' && dek.length > 0 ? dek : null;
  } catch {
    return null;
  }
}
