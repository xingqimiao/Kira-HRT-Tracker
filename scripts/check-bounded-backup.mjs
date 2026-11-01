import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decompressGzipText } from '../src/utils/boundedDecompression.ts';
import { compressData, decompressData } from '../logic.ts';

const gzip = (text) => new Uint8Array(gzipSync(Buffer.from(text)));
assert.equal(await decompressGzipText(gzip('正常 backup'), 32), '正常 backup');
assert.equal(await decompressData(await compressData('正常 backup')), '正常 backup');
await assert.rejects(decompressGzipText(gzip('a'.repeat(10000)), 100), /too large/);
await assert.rejects(decompressGzipText(gzip('猫'.repeat(40)), 100), /too large/);
await assert.rejects(decompressGzipText(new Uint8Array([1, 2, 3]), 100));
console.log('bounded backup decompression: ok');
