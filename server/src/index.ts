/**
 * Entry point.
 *
 * Two transports, one core:
 *   - `http`  — the hosted deployment: web API plus the Streamable HTTP MCP
 *     endpoint at `/mcp`, for agents that connect over the network.
 *   - `stdio`  — local development and debugging: an MCP server on stdin/stdout,
 *     so an agent can talk to it without a network, and tests can drive it
 *     directly.
 *
 * Neither transport owns any business logic; both resolve a credential into an
 * `AuthContext` and call the same services.
 */
import { getPool, migrate } from './db.ts';
import { getConfig } from './config.ts';
import { startServer } from './http.ts';
import { startPushScanner } from './push.ts';
import { startAfdianSync } from './afdianSync.ts';
import { buildServer } from './mcp.ts';
import { AccountService } from './accounts.ts';

const USAGE = `hrt-server — multi-user HRT record service

Usage:
  node dist/index.js http          Start the HTTP API + MCP endpoint (default)
  node dist/index.js stdio         Run an MCP server over stdio (local/dev)
  node dist/index.js migrate       Apply schema.sql and exit

Environment:
  DATABASE_URL      Postgres connection string (required)
  PUBLIC_ORIGIN     Where the web app is served, e.g. https://hrt.example.com
                    (the single origin allowed by CORS)
  API_ORIGIN        This server's public origin, e.g. https://api.example.com
  PORT              HTTP port (default 8788)
  BIND_HOST         Interface to bind (default 127.0.0.1 — put a proxy in front)
  X_CLIENT_ID       Optional. All three are needed to enable X sign-in.
  X_CLIENT_SECRET
  X_REDIRECT_URI    Must match the X app's Callback URI exactly
  HRT_UNLOCK_TOKEN  For stdio: an unlock token, so the local MCP server can read
                    records without a password in the shell.
`;

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'http';

  // Load and validate configuration before anything else, including `migrate`:
  // a missing DATABASE_URL or a malformed origin should stop the process at boot
  // rather than surface as a 500 on the first sign-in attempt. Validation errors
  // are ordinary `main()` failures, so they print one line and exit non-zero.
  const config = getConfig();

  // Say which key material is in force, once. The KMS master key is the only way the
  // deployment can open an account, so a boot without it configured is worth naming
  // loudly rather than discovering at the first unlock.
  if (config.kms) {
    process.stdout.write(`hrt-server: data keys wrapped under the KMS master key (${config.kms.cryptoEndpoint})\n`);
  } else if (command === 'http' || command === 'migrate') {
    process.stdout.write('hrt-server: no KMS configured — accounts minted now carry no server wrapper\n');
  }

  // Supplementary push is a silent no-op when unconfigured, which is a confusing
  // state to diagnose from the outside ("why did nobody get a nudge?"). Say it once
  // at boot, the same way the KMS line does.
  if (command === 'http') {
    process.stdout.write(config.fcm
      ? `hrt-server: FCM supplementary push on (project ${config.fcm.projectId}, grace ${config.fcm.graceMinutes}m)\n`
      : 'hrt-server: no FCM service account — supplementary push is off\n');
  }

  // Every production guard is keyed on NODE_ENV: https-only origins, the required
  // KMS, and — the dangerous one — a CORS allowance for development origins. A
  // deployment that forgets the flag loses all of them silently, and a plain
  // https reverse proxy hides every symptom until the day one matters. If this
  // boot looks like a real deployment while the flag says otherwise, refuse to
  // pass quietly.
  if (command === 'http' && process.env.NODE_ENV !== 'production') {
    const bindHost = process.env.BIND_HOST ?? '127.0.0.1';
    const loopback = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/.test(bindHost);
    const looksProduction =
      config.publicOrigin.startsWith('https://') || config.apiOrigin.startsWith('https://') || !loopback;
    if (looksProduction) {
      process.stderr.write(
        `hrt-server: WARNING — NODE_ENV is ${JSON.stringify(process.env.NODE_ENV ?? null)}, not "production", ` +
        `but this boot looks like a real deployment\n` +
        `  (public=${config.publicOrigin} api=${config.apiOrigin}${loopback ? '' : `, bound to ${bindHost}`}).\n` +
        `  Production-only guards are OFF: https origins are not enforced, KMS is optional, and\n` +
        `  development origins are allowed by CORS. Set NODE_ENV=production on this unit.\n`,
      );
    }
  }

  if (command === 'migrate') {
    await migrate();
    process.stdout.write('schema applied\n');
    await getPool().end();
    return;
  }

  if (command === 'http') {
    // Fail loudly at boot rather than on the first request: a missing
    // DATABASE_URL should not look like a working server with broken endpoints.
    getPool();
    await migrate();
    process.stdout.write(
      `hrt-server: public=${config.publicOrigin} api=${config.apiOrigin} x_login=${config.x ? 'on' : 'off'}
`,
    );
    startServer(config.port);
    // Supplementary push only runs when a service account is configured; the
    // scanner is a no-op otherwise, so a deployment that opted out spins no timer.
    startPushScanner();
    // Afdian's webhook client cannot complete a modern TLS handshake, so the sponsor
    // list is polled instead. Unconfigured credentials mean no timer.
    if (config.afdian) {
      const minutes = config.afdianSyncMinutes ?? 30;
      process.stdout.write(`hrt-server: Afdian sponsor sync on (${minutes}-minute poll)\n`);
      startAfdianSync(minutes * 60_000);
    }
    // Drain in-flight queries on shutdown instead of severing connections.
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        void getPool()
          .end()
          .finally(() => process.exit(0));
      });
    }
    return;
  }

  if (command === 'stdio') {
    getPool();
    // `config` was already validated above and is only needed by the HTTP paths;
    // the stdio transport reads no origin or CORS setting.
    void config;
    const token = process.env.HRT_UNLOCK_TOKEN;
    if (!token) {
      // Not fatal: reference and validation tools still work, and it keeps the
      // server usable for schema exploration without credentials on hand.
      process.stderr.write(
        'hrt-server: HRT_UNLOCK_TOKEN not set — record tools will report the account is locked\n',
      );
    }
    const server = buildServer(async () => {
      if (!token) return null;
      // The same resolver the HTTP mount uses, so a stale `HRT_UNLOCK_TOKEN` cannot
      // behave differently here than it would over the network.
      return AccountService.resolveApiContext(token);
    });
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    await server.connect(new StdioServerTransport());
    return;
  }

  process.stderr.write(USAGE);
  process.exit(2);
}

main().catch((error: unknown) => {
  process.stderr.write(`hrt-server: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
