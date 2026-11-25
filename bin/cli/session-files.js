const fs = require('fs');
const zlib = require('zlib');

const ZSTD_MAGIC = 0xFD2FB528;
const ZSTD_INCOMPLETE = Infinity;

function isCompressedSession(file) {
  return /\.zstd?$/.test(file);
}

// Returns where the zstd frame starting at `start` ends, or ZSTD_INCOMPLETE while a writer is still appending it.
function zstdFrameEnd(buffer, start) {
  if (start + 8 > buffer.length) return ZSTD_INCOMPLETE;
  const magic = buffer.readUInt32LE(start);
  if ((magic & 0xFFFFFFF0) >>> 0 === 0x184D2A50) return start + 8 + buffer.readUInt32LE(start + 4);
  if (magic !== ZSTD_MAGIC) throw new Error('invalid zstd frame');
  const descriptor = buffer[start + 4];
  const singleSegment = (descriptor >> 5) & 1;
  const contentSizeBytes = [singleSegment, 2, 4, 8][descriptor >> 6];
  let offset = start + 5 + (singleSegment ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + contentSizeBytes;
  for (;;) {
    if (offset + 3 > buffer.length) return ZSTD_INCOMPLETE;
    const header = buffer.readUIntLE(offset, 3);
    const type = (header >> 1) & 3;
    if (type === 3) throw new Error('invalid zstd block');
    offset += 3 + (type === 1 ? 1 : header >>> 3);
    if (header & 1) return offset + ((descriptor >> 2) & 1 ? 4 : 0);
  }
}

// Node's zstd stream stops at the first frame, and DSH appends one frame per write, so frames are decoded one by one.
function* zstdChunks(file) {
  if (!zstdAvailable()) throw new Error('zstd decompression is unavailable');
  const buffer = fs.readFileSync(file);
  let offset = 0;
  while (offset < buffer.length) {
    const end = zstdFrameEnd(buffer, offset);
    if (end > buffer.length) return;
    if (buffer.readUInt32LE(offset) === ZSTD_MAGIC) yield zlib.zstdDecompressSync(buffer.subarray(offset, end));
    offset = end;
  }
}

async function readJsonLines(file, start, onLine) {
  // Offsets count decompressed bytes; a zstd file cannot seek, so earlier lines are skipped.
  const compressed = isCompressedSession(file);
  const stream = compressed ? zstdChunks(file) : fs.createReadStream(file, { start });
  let pending = Buffer.alloc(0);
  let offset = compressed ? 0 : start;
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, chunk]);
    let newline;
    while ((newline = pending.indexOf(0x0a)) >= 0) {
      let line = pending.subarray(0, newline);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      const lineStart = offset;
      offset += newline + 1;
      pending = pending.subarray(newline + 1);
      if (lineStart < start) continue;
      if (!await onLine(line.toString('utf8'), lineStart, offset)) return lineStart;
    }
  }
  return offset;
}

function zstdAvailable() {
  return typeof zlib.createZstdDecompress === 'function';
}

module.exports = {
  isCompressedSession,
  readJsonLines,
  zstdAvailable,
};
