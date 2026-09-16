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
import { buildServer } from './mcp.ts';
import { lookupSession } from './session.ts';

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
  TOTP_ENC_KEY      >=32 chars; encrypts TOTP secrets at rest (required)
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
  // a missing TOTP_ENC_KEY or a malformed origin should stop the process at boot
  // rather than surface as a 500 on the first sign-in attempt. Validation errors
  // are ordinary `main()` failures, so they print one line and exit non-zero.
  const config = getConfig();

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
      return lookupSession(token);
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
