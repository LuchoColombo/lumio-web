// Lumio Web — browser port of the OT3 fountain decoder.
// Must stay protocol-compatible with src/lib/fountain.ts in the app:
// frame format OT3:<SID>:<k>:<len>:<CRC>:<seed>:<FLAGS>:<base45>,
// same PRNG, same degree distribution, same CRC32.
(function (global) {
  'use strict';

  // Mirrors the app: small payloads use handheld-friendly QRs, big ones
  // use denser frames. The receiver reads the block size off each frame.
  const BLOCK_SIZE_SMALL = 560;
  const BLOCK_SIZE_BIG = 1450;
  const BIG_PAYLOAD_MIN = 8 * 1024;
  const MAX_BLOCK_SIZE = 2000;

  // --- deterministic PRNG (identical to the app's mulberry32) ---
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // --- CRC32 ---
  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let i = 0; i < 8; i++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function utf8Decode(bytes) {
    return new TextDecoder().decode(bytes);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // --- base45 (RFC 9285) — must mirror bytesToB45/b45ToBytes in the app ---
  const B45_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  const B45_REVERSE = {};
  for (let i = 0; i < B45_ALPHABET.length; i++) B45_REVERSE[B45_ALPHABET[i]] = i;

  function bytesToB45(bytes) {
    let out = '';
    let i = 0;
    for (; i + 1 < bytes.length; i += 2) {
      let v = bytes[i] * 256 + bytes[i + 1];
      const e = Math.floor(v / 2025);
      v -= e * 2025;
      const d = Math.floor(v / 45);
      out += B45_ALPHABET[v - d * 45] + B45_ALPHABET[d] + B45_ALPHABET[e];
    }
    if (i < bytes.length) {
      const v = bytes[i];
      const d = Math.floor(v / 45);
      out += B45_ALPHABET[v - d * 45] + B45_ALPHABET[d];
    }
    return out;
  }

  function b45ToBytes(s) {
    const n = s.length;
    if (n % 3 === 1) throw new Error('invalid base45 length');
    const out = new Uint8Array(Math.floor(n / 3) * 2 + (n % 3 === 2 ? 1 : 0));
    let o = 0;
    let i = 0;
    for (; i + 2 < n; i += 3) {
      const c = B45_REVERSE[s[i]];
      const d = B45_REVERSE[s[i + 1]];
      const e = B45_REVERSE[s[i + 2]];
      if (c === undefined || d === undefined || e === undefined) throw new Error('bad base45 char');
      const v = c + d * 45 + e * 2025;
      if (v > 0xffff) throw new Error('base45 overflow');
      out[o++] = v >> 8;
      out[o++] = v & 0xff;
    }
    if (i < n) {
      const c = B45_REVERSE[s[i]];
      const d = B45_REVERSE[s[i + 1]];
      if (c === undefined || d === undefined) throw new Error('bad base45 char');
      const v = c + d * 45;
      if (v > 0xff) throw new Error('base45 overflow');
      out[o++] = v;
    }
    return out;
  }

  function frameIndices(seed, k) {
    if (seed < k) return [seed];

    const rand = mulberry32(seed * 2654435761 + k);
    const r = rand();
    let degree;
    if (r < 0.5) degree = 2;
    else if (r < 0.75) degree = 3;
    else if (r < 0.9) degree = 4;
    else degree = 5 + Math.floor(rand() * 4);
    degree = Math.min(degree, k);

    const chosen = new Set();
    while (chosen.size < degree) {
      chosen.add(Math.floor(rand() * k));
    }
    return Array.from(chosen);
  }

  function xorInto(target, source) {
    for (let i = 0; i < target.length; i++) target[i] ^= source[i];
  }

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function deflateRaw(bytes) {
    const cs = new CompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  function utf8Encode(str) {
    return new TextEncoder().encode(str);
  }

  function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  // File payloads (type 'f') embed their name:
  // [2-byte BE name length][name utf8][file bytes]
  function packFilePayload(name, bytes) {
    const nameBytes = utf8Encode(name).slice(0, 255);
    const out = new Uint8Array(2 + nameBytes.length + bytes.length);
    out[0] = nameBytes.length >> 8;
    out[1] = nameBytes.length & 0xff;
    out.set(nameBytes, 2);
    out.set(bytes, 2 + nameBytes.length);
    return out;
  }

  function unpackFilePayload(payload) {
    const nameLen = (payload[0] << 8) | payload[1];
    return {
      name: utf8Decode(payload.slice(2, 2 + nameLen)),
      bytes: payload.slice(2 + nameLen),
    };
  }

  function parseFountainFrame(raw) {
    if (!raw.startsWith('OT3:')) return null;

    // ':' is a valid base45 character, so the payload may contain colons and
    // cannot be split blindly. The seven header fields are colon-free, so walk
    // to the seventh separator and treat everything past it as payload.
    let cut = -1;
    for (let n = 0; n < 7; n++) {
      cut = raw.indexOf(':', cut + 1);
      if (cut === -1) return null;
    }
    const parts = raw.slice(0, cut).split(':');
    if (parts.length !== 7) return null;
    const payload = raw.slice(cut + 1);

    const sid = parts[1];
    const k = parseInt(parts[2], 10);
    const len = parseInt(parts[3], 10);
    const crc = parseInt(parts[4], 36);
    const seed = parseInt(parts[5], 10);
    const flags = parts[6].toLowerCase();
    const type = flags[0];
    const compressed = flags.length > 1 && flags[1] === 'z';
    if (!sid || isNaN(k) || isNaN(len) || isNaN(crc) || isNaN(seed)) return null;
    if (type !== 't' && type !== 'i' && type !== 'f') return null;

    try {
      const data = b45ToBytes(payload);
      if (data.length < 1 || data.length > MAX_BLOCK_SIZE) return null;
      return { sid, k, len, crc, seed, type, compressed, data };
    } catch (e) {
      return null;
    }
  }

  class FountainDecoder {
    constructor() {
      this.reset();
      this.type = 't';
      this.k = 0;
    }

    reset() {
      this.sid = '';
      this.k = 0;
      this.len = 0;
      this.crc = 0;
      this.compressed = false;
      this.blockSize = 0;
      this.blocks = new Map();
      this.pending = [];
      this.seenSeeds = new Set();
    }

    get complete() {
      return this.k > 0 && this.blocks.size === this.k;
    }

    addFrame(frame) {
      if (this.sid && (frame.sid !== this.sid || frame.data.length !== this.blockSize)) {
        this.reset();
      }

      this.sid = frame.sid;
      this.blockSize = frame.data.length;
      this.k = frame.k;
      this.len = frame.len;
      this.crc = frame.crc;
      this.type = frame.type;
      this.compressed = frame.compressed;

      if (!this.complete && !this.seenSeeds.has(frame.seed)) {
        this.seenSeeds.add(frame.seed);
        this._insert(new Set(frameIndices(frame.seed, frame.k)), frame.data.slice());
      }

      return { progress: this.blocks.size / this.k, complete: this.complete };
    }

    // Resolves with {type, bytes} or null if the CRC check fails.
    async result() {
      const bytes = new Uint8Array(this.len);
      for (let i = 0; i < this.k; i++) {
        const block = this.blocks.get(i);
        const offset = i * this.blockSize;
        bytes.set(block.slice(0, Math.min(this.blockSize, this.len - offset)), offset);
      }

      if (crc32(bytes) !== this.crc) {
        this.reset();
        return null;
      }

      let payload = bytes;
      if (this.compressed) {
        try {
          payload = await inflateRaw(bytes);
        } catch (e) {
          this.reset();
          return null;
        }
      }
      return { type: this.type, bytes: payload };
    }

    _insert(indices, data) {
      for (const idx of Array.from(indices)) {
        const known = this.blocks.get(idx);
        if (known) {
          xorInto(data, known);
          indices.delete(idx);
        }
      }
      if (indices.size === 0) return;
      if (indices.size > 1) {
        this.pending.push({ indices, data });
        return;
      }

      let newlyKnown = { idx: Array.from(indices)[0], data };
      while (newlyKnown) {
        this.blocks.set(newlyKnown.idx, newlyKnown.data);
        const learnedIdx = newlyKnown.idx;
        const learnedData = newlyKnown.data;
        newlyKnown = null;

        const stillPending = [];
        for (const p of this.pending) {
          if (p.indices.has(learnedIdx)) {
            xorInto(p.data, learnedData);
            p.indices.delete(learnedIdx);
          }
          if (p.indices.size === 1 && !newlyKnown) {
            const idx = Array.from(p.indices)[0];
            if (!this.blocks.has(idx)) {
              newlyKnown = { idx, data: p.data };
              continue;
            }
          }
          if (p.indices.size > 0) stillPending.push(p);
        }
        this.pending = stillPending;
      }
    }
  }

  // --- encoder (mirror of the app's FountainEncoder in fountain.ts) ---
  // `bytes` are the raw payload bytes (UTF-8 text, or image file bytes);
  // `type` is 't' | 'i'. Compression is applied only when it helps.
  const REPAIR_RATIO = 0.5;
  const MIN_REPAIR = 4;

  async function createFountainEncoder(rawBytes, type) {
    let bytes = rawBytes;
    let compressed = false;
    try {
      const deflated = await deflateRaw(rawBytes);
      if (deflated.length < rawBytes.length) {
        bytes = deflated;
        compressed = true;
      }
    } catch (e) {
      // uncompressed fallback
    }

    // Uppercase keeps the frame in QR alphanumeric mode; parsed back to
    // lowercase on the receiving side.
    const flags = (type + (compressed ? 'z' : '')).toUpperCase();
    const blockSize = bytes.length >= BIG_PAYLOAD_MIN ? BLOCK_SIZE_BIG : BLOCK_SIZE_SMALL;
    const k = Math.max(1, Math.ceil(bytes.length / blockSize));

    const blocks = [];
    for (let i = 0; i < k; i++) {
      const block = new Uint8Array(blockSize);
      block.set(bytes.slice(i * blockSize, (i + 1) * blockSize));
      blocks.push(block);
    }

    const sid = Math.random().toString(36).slice(2, 7).toUpperCase();
    const crc = (crc32(bytes) >>> 0).toString(36).toUpperCase();
    const headerPrefix = 'OT3:' + sid + ':' + k + ':' + bytes.length + ':' + crc;

    const firstCycleRepairs = [];
    let maxSeed = k - 1;
    if (k > 1) {
      const minRepairs = Math.max(MIN_REPAIR, Math.ceil(k * REPAIR_RATIO));
      const uncovered = new Set(Array.from({ length: k }, (_, i) => i));
      for (let seed = k; firstCycleRepairs.length < minRepairs || uncovered.size > 0; seed++) {
        const indices = frameIndices(seed, k);
        if (firstCycleRepairs.length >= minRepairs && !indices.some((i) => uncovered.has(i)))
          continue;
        firstCycleRepairs.push(seed);
        for (const i of indices) uncovered.delete(i);
        maxSeed = seed;
      }
    }
    const freshSeedBase = maxSeed + 1;
    const cycleLength = k + firstCycleRepairs.length;

    function frameAt(i) {
      const cycle = Math.floor(i / cycleLength);
      const pos = i % cycleLength;

      let seed;
      if (pos < k) seed = pos;
      else if (cycle === 0) seed = firstCycleRepairs[pos - k];
      else seed = freshSeedBase + (cycle - 1) * (cycleLength - k) + (pos - k);

      const data = new Uint8Array(blockSize);
      for (const idx of frameIndices(seed, k)) {
        xorInto(data, blocks[idx]);
      }
      return headerPrefix + ':' + seed + ':' + flags + ':' + bytesToB45(data);
    }

    return { k, cycleLength, frameAt };
  }

  const OT2 = {
    parseFountainFrame,
    FountainDecoder,
    createFountainEncoder,
    packFilePayload,
    unpackFilePayload,
    utf8Decode,
    utf8Encode,
    BLOCK_SIZE_SMALL,
    BLOCK_SIZE_BIG,
    BIG_PAYLOAD_MIN,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = OT2;
  else global.OT2 = OT2;
})(typeof window !== 'undefined' ? window : this);
