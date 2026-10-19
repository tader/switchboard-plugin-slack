// Read-only LevelDB table blocks. No database locks, repairs, or writes.
const invalid = () => new Error("unsupported_slack_storage");
function varint(b, cursor) {
  let value = 0,
    shift = 0;
  for (let i = 0; i < 8; i++) {
    if (cursor.pos >= b.length) throw invalid();
    const n = b[cursor.pos++];
    value += (n & 127) * 2 ** shift;
    if (!(n & 128)) {
      if (!Number.isSafeInteger(value)) throw invalid();
      return value;
    }
    shift += 7;
  }
  throw invalid();
}
export function unsnappy(b, max = 32 * 1024 * 1024) {
  const c = { pos: 0 },
    length = varint(b, c);
  if (length > max) throw invalid();
  const out = Buffer.alloc(length);
  let at = 0;
  while (c.pos < b.length && at < length) {
    const tag = b[c.pos++],
      type = tag & 3;
    let size, offset;
    if (type === 0) {
      size = tag >> 2;
      if (size < 60) size++;
      else {
        const n = size - 59;
        if (n > 4 || c.pos + n > b.length) throw invalid();
        size = b.readUIntLE(c.pos, n) + 1;
        c.pos += n;
      }
      if (c.pos + size > b.length || at + size > length) throw invalid();
      b.copy(out, at, c.pos, c.pos + size);
      c.pos += size;
      at += size;
      continue;
    }
    if (type === 1) {
      size = 4 + ((tag >> 2) & 7);
      if (c.pos >= b.length) throw invalid();
      offset = ((tag & 224) << 3) | b[c.pos++];
    } else {
      const n = type === 2 ? 2 : 4;
      size = 1 + (tag >> 2);
      if (c.pos + n > b.length) throw invalid();
      offset = b.readUIntLE(c.pos, n);
      c.pos += n;
    }
    if (offset < 1 || offset > at || at + size > length) throw invalid();
    for (let i = 0; i < size; i++) out[at + i] = out[at + i - offset];
    at += size;
  }
  if (at !== length || c.pos !== b.length) throw invalid();
  return out;
}
export function tableBlocks(file) {
  if (
    file.length < 48 ||
    file.subarray(-8).toString("hex") !== "57fb808b247547db"
  )
    return [];
  const footer = { pos: file.length - 48 };
  varint(file, footer);
  varint(file, footer);
  const indexOffset = varint(file, footer),
    indexSize = varint(file, footer);
  function block(offset, size) {
    if (offset < 0 || size < 0 || offset + size + 5 > file.length - 48)
      throw invalid();
    const raw = file.subarray(offset, offset + size),
      compression = file[offset + size];
    if (compression === 0) return Buffer.from(raw);
    if (compression === 1) return unsnappy(raw);
    throw invalid();
  }
  const index = block(indexOffset, indexSize),
    blocks = [];
  let total = 0;
  try {
    if (index.length < 4) throw invalid();
    const restartCount = index.readUInt32LE(index.length - 4),
      end = index.length - 4 - restartCount * 4;
    if (end < 0) throw invalid();
    const c = { pos: 0 };
    while (c.pos < end) {
      varint(index, c);
      const keyLength = varint(index, c),
        valueLength = varint(index, c);
      c.pos += keyLength;
      if (c.pos + valueLength > end) throw invalid();
      const value = index.subarray(c.pos, c.pos + valueLength),
        v = { pos: 0 };
      c.pos += valueLength;
      const offset = varint(value, v),
        size = varint(value, v);
      const data = block(offset, size);
      total += data.length;
      if (total > 64 * 1024 * 1024) {
        data.fill(0);
        throw invalid();
      }
      blocks.push(data);
    }
    return blocks;
  } catch (e) {
    for (const b of blocks) b.fill(0);
    throw e;
  } finally {
    index.fill(0);
  }
}
