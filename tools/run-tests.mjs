/**
 * Runs the server test suite and writes its output to files.
 *
 * `tools/run-restricted.ps1` starts this under a non-elevated token, which postgres
 * requires. It exists because a batch file redirecting into the same files is not
 * reliable here: cmd buffers, and when the child dies the redirect never flushes,
 * which looks exactly like a hung suite. Piping through a Node process that owns the
 * file descriptors means the output lands even if the runner is interrupted.
 *
 *   pwsh -File tools/run-restricted.ps1 -App 'C:\Program Files\nodejs\node.exe' \
 *       -CommandLine 'C:\Program Files\nodejs\node.exe E:\HRT\tools\run-tests.mjs' -WorkDir E:\HRT\server
 *
 * Results: `server/t.out`, `server/t.err`, and `server/t.exit` with the code.
 */
import { spawn } from 'node:child_process';
import { openSync, writeSync } from 'node:fs';

const root = 'E:/HRT/server';
const out = openSync(root + '/t.out', 'w');
const err = openSync(root + '/t.err', 'w');

const child = spawn(process.execPath, [
    '--experimental-transform-types',
    '--import', './resolve-hook.mjs',
    '--test',
    'test/*.test.ts',
], { cwd: root, stdio: ['ignore', out, err] });

child.on('exit', (code, signal) => {
    const marker = openSync(root + '/t.exit', 'w');
    writeSync(marker, 'code=' + code + ' signal=' + signal + '\n');
});
