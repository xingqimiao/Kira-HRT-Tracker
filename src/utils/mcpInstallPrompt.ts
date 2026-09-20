import { MCP_ENDPOINT } from '../constants';

/**
 * The prompt a user pastes into their own assistant so it installs the MCP
 * server by itself.
 *
 * One definition, two surfaces: the AI-assistant settings page and the
 * onboarding step that introduces it. Written to be self-contained, because the
 * reader is an assistant that has never heard of this service — so it states the
 * transport, the auth header, where a client keeps its config file, how to tell
 * it worked, and what the token really is: the account's full credential, usable
 * with no browser session and no unlock.
 *
 * The token is left as a placeholder on purpose. A prompt is often pasted into a
 * chat that keeps history, and a real token in a transcript is a leaked token.
 */
export const buildMcpInstallPrompt = (endpoint: string = MCP_ENDPOINT): string => [
    'Add an MCP server to my AI client by editing its configuration file yourself.',
    '',
    'Server name: kira-tracker',
    'Transport:  Streamable HTTP (POST only)',
    `URL:        ${endpoint}`,
    'Auth:       header `Authorization: Bearer <TOKEN>`',
    '',
    'Steps:',
    "1. Find my client's MCP config file and show me the path before you change it.",
    '   Common locations: claude_desktop_config.json for Claude Desktop,',
    '   .cursor/mcp.json for Cursor, .vscode/mcp.json for VS Code.',
    '2. Add this entry under "mcpServers":',
    '',
    '   {',
    '     "kira-tracker": {',
    '       "type": "http",',
    `       "url": "${endpoint}",`,
    '       "headers": { "Authorization": "Bearer <TOKEN>" }',
    '     }',
    '   }',
    '',
    '3. Replace <TOKEN> with the token I give you. Ask me for it if I have not.',
    '4. Restart the client, then call hrt_reference to confirm it works. That tool',
    '   needs no records and no unlock, so it is the right one to test with.',
    '',
    'Two things to expect:',
    '- The token is a full credential for my records: it reads and writes them with no',
    '  browser session and no unlock, and signing out does not stop it. Only revoking',
    '  the token or changing my password does.',
    '- hrt_create_share publishes a link that anyone can open. Confirm with me before',
    '  calling it, and propose an expiry rather than picking one silently.',
    '',
    'Start with hrt_reference to learn the accepted routes, esters and units, then',
    'hrt_get_timeline to see what I have already logged.',
].join('\n');
