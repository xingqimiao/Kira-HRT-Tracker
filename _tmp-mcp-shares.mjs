// One-off: add the share tools to the MCP server.
//
// The user asked for sharing to be agentic. Two tools, and the reason they are a pair
// rather than one: creating a link is a *disclosure* — it makes health data readable by
// anyone holding a URL — so the agent should be able to make one and to see what is
// currently exposed, and should not need to leave the conversation to clean up.
//
// Deliberately no update tool. A share is either current (live) or frozen, and changing
// what a link shows while someone may be reading it is not something to expose as a
// one-liner: revoke and create is the honest sequence.
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'server/src/mcp.ts'
let s = readFileSync(FILE, 'utf8')

s = s.replace(
  "import { buildExportPayload } from './import.ts';",
  "import { buildExportPayload } from './import.ts';\nimport { ShareService } from './shares.ts';",
)

const anchor = '  return server;\n}'
if (s.split(anchor).length !== 2) throw new Error('return anchor is not unique')

const tools = `  // --- Shares --------------------------------------------------------------
  //
  // The one pair of tools that publishes data outside the account. `hrt_create_share`
  // is the only write in this server whose effect is visible to someone who is not the
  // user, which is why its description leads with that rather than with the arguments.

  server.registerTool(
    'hrt_create_share',
    {
      title: 'Create a share link',
      description:
        'Publish a read-only link to the user\\'s dose history and modelled curve. Anyone with ' +
        'the URL can read it until it expires, so confirm with the user before calling this. ' +
        'Lab results, body weight and profile details are never included — the server refuses ' +
        'a payload carrying them. Returns the URL once; it cannot be retrieved again.',
      inputSchema: {
        password: z.string().min(8).optional()
          .describe('Require this password to open the link. Omit for a link anyone can read.'),
        expires_in_hours: z.number().positive().max(2160).optional()
          .describe('How long the link lives, in hours (default 24, maximum 2160 = 90 days)'),
        live: z.boolean().optional()
          .describe('Keep the snapshot current as records change. Default false: a frozen link.'),
        limit: z.number().int().min(1).max(500).optional()
          .describe('How many recent doses to include (default 100)'),
      },
    },
    async ({ password, expires_in_hours, live, limit }) => {
      const r = await withContext(async (ctx) => {
        const events = await TimelineService.get(ctx, { limit: limit ?? 100 });
        const doses = events
          .filter((e) => e.kind === 'dose')
          .map((e) => ({ id: e.id, ester: e.event.ester, route: e.event.route, doseMG: e.event.doseMG, at: e.at }));

        // The snapshot shape the web app sends, so a link created here opens in the same
        // page. `assertShareable` on the server is what actually guarantees the exclusion
        // list, not this construction — this only avoids sending what would be refused.
        const snapshot = {
          version: 1,
          mode: ctx.mode ?? 'transfem',
          timezone: 'UTC',
          createdAt: Date.now(),
          events: doses,
          simulation: null,
        };

        const result = await ShareService.create(ctx.userId, {
          snapshot,
          password,
          expiresAt: Date.now() + (expires_in_hours ?? 24) * 3600_000,
          live: live ?? false,
        });
        return result;
      });
      if ('error' in r) return toolError(r.error);
      if (!r.value.ok) return toolError(r.value.error);
      return toolResult({
        url: r.value.value.url,
        expires_at: new Date(r.value.value.expiresAt).toISOString(),
        password_required: r.value.value.passwordRequired,
        live: r.value.value.live,
        included: 'dose history and the modelled curve',
        not_included: 'lab results, body weight, account details',
        note: 'The URL is shown once. It cannot be retrieved again — only revoked.',
      });
    },
  );

  server.registerTool(
    'hrt_list_shares',
    {
      title: 'List active share links',
      description:
        'What the user currently has published, including whether each link has expired. ' +
        'Use this before creating another, and to find the id for hrt_revoke_share.',
      inputSchema: {},
    },
    async () => {
      const r = await withContext((ctx) => ShareService.list(ctx.userId));
      if ('error' in r) return toolError(r.error);
      return toolResult(r.value.map((share) => ({
        id: share.id,
        created_at: new Date(share.createdAt).toISOString(),
        expires_at: new Date(share.expiresAt).toISOString(),
        expired: share.expired,
        password_required: share.passwordRequired,
        live: share.live,
      })));
    },
  );

  server.registerTool(
    'hrt_revoke_share',
    {
      title: 'Revoke a share link',
      description:
        'Delete a share so its URL stops working immediately. Takes the id from ' +
        'hrt_list_shares — the token itself is never stored and cannot be passed here.',
      inputSchema: {
        id: z.string().uuid().describe('The share id, from hrt_list_shares'),
      },
    },
    async ({ id }) => {
      const r = await withContext((ctx) => ShareService.revoke(ctx.userId, id));
      if ('error' in r) return toolError(r.error);
      if (!r.value) return toolError('no share with that id on this account');
      return toolResult({ revoked: true, id });
    },
  );

`
s = s.replace(anchor, tools + anchor)
writeFileSync(FILE, s)
console.log('share tools added')
