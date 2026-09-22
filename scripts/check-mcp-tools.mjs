/**
 * Runnable check that the documented MCP surface matches the code that serves it.
 *
 *   node scripts/check-mcp-tools.mjs
 *
 * The count has already been wrong once in two places at the same time — the table in
 * `src/pages/McpSettings.tsx` said "twelve" above a list of fifteen, and the prose
 * count in every translation said 15 after the surface had grown. Nothing failed,
 * because a number typed into copy cannot fail. This turns the surface into one
 * derived set and compares every place that restates it:
 *
 *   - the tools actually registered in `server/src/mcp.ts` (the source of truth),
 *   - the catalogue `hrt_reference` returns (so an agent reading only that tool is
 *     not told about a subset),
 *   - the table on the app's own MCP page,
 *   - the tables in `server/MCP.md`,
 *   - the count in the copy, which must be a `{count}` placeholder rather than a
 *     number anyone types.
 *
 * The runtime equivalent — the client's `tools/list` against `hrt_reference` — is
 * asserted in `server/test/mcp.protocol.test.ts`; this script is the part that can
 * check the client bundle and the Markdown.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const mcp = read('server/src/mcp.ts');
const page = read('src/pages/McpSettings.tsx');
const doc = read('server/MCP.md');
// The shipped per-language packs, not the pre-split `translations.ts`. That file
// is a build artefact now — nothing imports it, so a check reading it would pass
// while the packs a reader actually loads drifted out from under it.
const packs = {};
for (const file of readdirSync(join(root, 'src/i18n/langs'))) {
    if (file.endsWith('.ts')) {
        packs[file.slice(0, -3)] = (await import(`../src/i18n/langs/${file}`)).default;
    }
}

const sorted = (names) => [...names].sort();

/** The registered tools: what the server actually serves. */
const served = sorted([...mcp.matchAll(/registerTool\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));
assert.ok(served.length > 0, 'found no registerTool calls in server/src/mcp.ts');
assert.equal(new Set(served).size, served.length, 'a tool is registered twice');

/** The catalogue `hrt_reference` returns, read out of its own literal. */
const catalogue = (() => {
    const start = mcp.indexOf('tools: {');
    const end = mcp.indexOf('safety:', start);
    assert.ok(start !== -1 && end > start, 'could not locate the hrt_reference tool catalogue');
    return sorted([...mcp.slice(start, end).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).filter((n) => n.startsWith('hrt_')));
})();

/** The table on the app's MCP page. */
const pageNames = sorted([...page.matchAll(/\{\s*name:\s*'(hrt_[a-z0-9_]+)'/g)].map((m) => m[1]));

/** The tables in server/MCP.md — a row whose first cell is a tool name. */
const docNames = sorted([...doc.matchAll(/^\|\s*`(hrt_[a-z0-9_]+)`/gm)].map((m) => m[1]));

const fail = [];
function check(label, fn) {
    try {
        fn();
        console.log(`ok    ${label}`);
    } catch (error) {
        fail.push(label);
        console.log(`FAIL  ${label} — ${error.message}`);
    }
}

check(`hrt_reference catalogues all ${served.length} tools`, () => {
    assert.deepEqual(catalogue, served);
});

check('the app\'s MCP page table lists exactly those tools', () => {
    assert.deepEqual(pageNames, served);
});

check('server/MCP.md tables list exactly those tools', () => {
    assert.deepEqual(docNames, served);
});

check('the copy derives the count instead of typing it', () => {
    const descs = Object.values(packs).map((pack) => pack['mcp.tools_desc']);
    assert.equal(descs.length, 7, `expected one tools_desc per language, found ${descs.length}`);
    for (const text of descs) {
        assert.ok(text, 'every language needs an mcp.tools_desc');
        assert.ok(text.includes('{count}'), `mcp.tools_desc must carry {count}, got: ${text}`);
    }
    assert.match(page, /MCP_TOOLS\.length/, 'the page must render MCP_TOOLS.length as the count');
});

check('server/MCP.md states the current number and no stale one', () => {
    const words = [
        'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
        'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three',
        'twenty-four', 'twenty-five', 'twenty-six', 'twenty-seven', 'twenty-eight',
        'twenty-nine', 'thirty',
    ];
    const word = words[served.length - 10];
    assert.ok(word, `no number word for ${served.length} tools; extend the list in this script`);
    assert.ok(new RegExp(`\\b${word}\\b`, 'i').test(doc), `MCP.md should say "${word}"`);
    for (const other of words) {
        if (other === word) continue;
        assert.ok(
            !new RegExp(`\\b${other}\\b`, 'i').test(doc),
            `MCP.md still states the stale count "${other}"`,
        );
    }
});

console.log(`\n${served.length} tools, ${fail.length} check(s) failed`);
process.exit(fail.length === 0 ? 0 : 1);
