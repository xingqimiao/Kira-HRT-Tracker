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
 * The token is left as a placeholder on purpose, and the prompt tells the assistant
 * not to ask for it: a chat transcript is a log the user does not control, and a real
 * token in one is a leaked token. The user pastes the credential into the config file
 * themselves — locally, never through the model.
 */
export const buildMcpInstallPrompt = (endpoint: string = MCP_ENDPOINT): string => [
    'Add an MCP server to my AI client by editing its configuration file yourself.',
    '',
    'Do not ask me for the token and do not put any credential in this chat. Write the',
    'placeholder shown below and leave it for me to replace in the file.',
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
    '3. Leave "Bearer <TOKEN>" exactly as written. I will replace <TOKEN> in that file',
    '   myself, and you must not read it, print it back, or ask me for it.',
    '4. Restart the client, then call hrt_reference to confirm it works. That tool',
    '   needs no records and no unlock, so it is the right one to test with. Until I',
    '   paste the token in, an auth failure there is expected.',
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
