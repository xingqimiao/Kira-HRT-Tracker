/**
 * Provider avatars, fetched once and stored on our own origin.
 *
 * Why the picture cannot simply be hotlinked: the web app is served with
 *
 *     Content-Security-Policy: img-src 'self' data: blob:
 *
 * so a `pbs.twimg.com` or `lh3.googleusercontent.com` URL in an `<img src>` is
 * blocked by the browser. Widening `img-src` to render an avatar would be the wrong
 * trade — the policy exists to stop an injected response from loading anything, and it
 * would also turn every account-page visit into a request to the provider, i.e. a
 * tracking beacon that names the visitor to X or Google every time they open their own
 * settings.
 *
 * So the image is copied here at link/sign-in time. "Here" has one meaning in this
 * deployment: served from the web app's own origin (`PUBLIC_ORIGIN`, i.e.
 * `hrt.kiramyao.com`), by the reverse proxy that already serves every other static
 * file — not from this API host (`api.kiramyao.com`, which serves no static assets at
 * all), and not from a CDN.
 *
 * The bytes do not live on disk there, and that is deliberate. The build ships the web
 * root with `rsync -a --delete`, so a directory of fetched avatars would be wiped by
 * the next deploy; and inventing a "fetch this URL from the internet" route on the site
 * origin is a new static mechanism, which this is not allowed to be. The bytes instead
 * live in the `oauth_accounts.avatar_image` column, and this route re-serves them under
 * the same origin the rest of the app already uses. One storage location, one reader,
 * nothing to garbage-collect.
 *
 * Not on the CDN either, for a second reason: the image is served by our own server, so
 * the request the browser makes reveals nothing to X or Google.
 */
import { getPool } from './db.ts';

/**
 * Source and ceiling, recorded because they are the two things a later reader cannot
 * recover from the bytes alone: how big the copy was allowed to be, and where it came
 * from.
 *
 * 256 KiB is roughly ten times a 512×512 avatar. X's `_400x400` JPEG and Google's
 * default are both far under 100 KiB, so the cap is not a resize — it is a refusal. A
 * provider CDN that starts answering with something huge means it is no longer serving
 * an avatar, and storing that is worse than storing nothing.
 *
 * `ponytail:` the size is measured by buffering the response and counting. A provider
 * that answered with an unbounded body would be measured only after it had been read
 * into memory. Acceptable because the only caller is an authenticated token endpoint
 * that has just named the URL, but the upgrade path is to stop at the limit while
 * streaming instead of reading to completion and then checking.
 */
const MAX_AVATAR_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const AVATAR_SOURCE = "provider_cdn@256KiB";

/** The snapshot shape, plus the two fields an avatar adds. */
export interface AvatarProfile {
  id: string;
  handle: string | null;
  displayName: string | null;
  /** The provider's URL, kept so a later reader knows where the copy came from. */
  avatarUrl: string | null;
  avatarImage: Buffer | null;
  avatarContentType: string | null;
}

export interface ProfileLike {
  avatarUrl: string | null;
}

/**
 * Read at most `limit` bytes, and refuse rather than truncate past it.
 *
 * A truncated image is not a smaller avatar, it is a corrupt one, so exceeding the cap
 * has to be a refusal. The reader is cancelled on the way out so the connection does not
 * stay open behind a decision already made.
 */
async function readCapped(res: Response, limit: number): Promise<Buffer | null> {
  const length = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(length) && length > limit) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return null;

  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Copy the provider's avatar, or give up quietly.
 *
 * Never throws and never rejects. It is called from the OAuth callback, and an avatar is
 * decoration: a provider outage, a 404, a redirect to an HTML error page or a body over
 * the cap must all end in "no picture" rather than in a failed sign-in. Only these four
 * things count as success, and each has a real failure behind it:
 *
 *   - an http(s) URL — a value that reaches `fetch` unchecked is an SSRF, since the
 *     URL comes from a token we only parse rather than verify;
 *   - `https:` specifically, so the copy cannot be swapped in transit;
 *   - a webp/png/jpeg content type — this is not decoration, it is what keeps
 *     `image/svg+xml` (a script container) and `text/html` (an error page saved as an
 *     avatar) out of the column that is later re-served as an image;
 *   - a body that is non-empty and within the cap.
 */
export async function fetchAvatarImage(url: string | null): Promise<
  { bytes: Buffer; contentType: string } | null
> {
  if (!url) return null;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== 'https:') return null;

  try {
    const res = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const declared = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    // `image/jpg` is not a registered type but is common enough to accept; browsers
    // sniff it the same way.
    const contentType = declared === 'image/jpg' ? 'image/jpeg' : declared;
    if (contentType !== 'image/webp' && contentType !== 'image/png' && contentType !== 'image/jpeg') {
      return null;
    }

    const bytes = await readCapped(res, MAX_AVATAR_BYTES);
    if (!bytes || bytes.byteLength === 0) return null;
    return { bytes, contentType };
  } catch {
    return null;
  }
}

/**
 * Download the avatar, then attach it to the profile.
 *
 * The order matters: the row is written by whoever calls this, so the image has to be in
 * hand before the insert rather than fetched afterwards. A failed fetch leaves the
 * profile exactly as it was — the URL is cleared too, because keeping a URL whose bytes
 * we could not copy would put a hotlink back in front of the browser, which is the bug
 * this exists to avoid.
 */
export async function withAvatarImage<T extends ProfileLike>(profile: T): Promise<T & {
  avatarImage: Buffer | null;
  avatarContentType: string | null;
}> {
  const image = await fetchAvatarImage(profile.avatarUrl);
  return {
    ...profile,
    avatarImage: image?.bytes ?? null,
    avatarContentType: image?.contentType ?? null,
    avatarUrl: image ? profile.avatarUrl : null,
  };
}

/** What a stored avatar is, or null when there is no usable one. */
export interface StoredAvatar {
  bytes: Buffer;
  contentType: string;
  /** The provider URL the bytes were copied from — the "where it came from" record. */
  sourceUrl: string | null;
  updatedAt: Date;
}

/**
 * The avatar of whichever provider has one, newest first.
 *
 * Scoped to the owner in the query itself rather than filtered afterwards: this
 * identifies an account from a URL, so the `user_id` predicate is what stops one account
 * reading another's picture.
 */
export async function avatarForUser(userId: string): Promise<StoredAvatar | null> {
  const { rows } = await getPool().query<{
    avatar_image: Buffer | null;
    avatar_content_type: string | null;
    avatar_url: string | null;
    avatar_fetched_at: Date | null;
  }>(
    `SELECT avatar_image, avatar_content_type, avatar_url, avatar_fetched_at
       FROM oauth_accounts
      WHERE user_id = $1 AND avatar_image IS NOT NULL
      ORDER BY avatar_fetched_at DESC NULLS LAST, linked_at ASC
      LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  if (!row?.avatar_image || !row.avatar_content_type) return null;
  return {
    bytes: row.avatar_image,
    contentType: row.avatar_content_type,
    sourceUrl: row.avatar_url,
    updatedAt: row.avatar_fetched_at ?? new Date(0),
  };
}

/**
 * A weak ETag for a stored avatar.
 *
 * Weak deliberately: the bytes come from a provider that re-encodes the same picture,
 * and revalidating on every account-page load is exactly the request this design exists
 * to avoid. A weak validator lets the browser reuse its copy and still notice a new
 * upload, because the stamp changes when the row does.
 *
 * The stamp is in the tag because the bytes and the timestamp are written in the same
 * `UPDATE`, so a tag built from the timestamp cannot describe a row that no longer
 * exists.
 */
export function avatarEtag(avatar: StoredAvatar): string {
  return `W/"${avatar.updatedAt.getTime().toString(36)}"`;
}

export { MAX_AVATAR_BYTES, AVATAR_SOURCE };
