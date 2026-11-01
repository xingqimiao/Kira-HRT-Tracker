/** Read gzip output with a byte limit before buffering it. */
export async function decompressGzipText(bytes: Uint8Array, limit: number): Promise<string> {
    const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) {
                await reader.cancel();
                throw new Error('decompressed payload too large');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    return new Blob(chunks as BlobPart[]).text();
}
