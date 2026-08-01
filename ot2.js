// Lumio Web — browser port of the OT2 fountain decoder.
// Must stay protocol-compatible with src/lib/fountain.ts in the app:
// frame format OT2:<sid>:<k>:<len>:<crc>:<seed>:<flags>:<base64>,
// same PRNG, same degree distribution, same CRC32.
(function (global) {
  'use strict';

  const BLOCK_SIZE = 420;

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

  function parseFountainFrame(raw) {
    if (!raw.startsWith('OT2:')) return null;
    const parts = raw.split(':');
    if (parts.length !== 8) return null;

    const sid = parts[1];
    const k = parseInt(parts[2], 10);
    const len = parseInt(parts[3], 10);
    const crc = parseInt(parts[4], 36);
    const seed = parseInt(parts[5], 10);
    const flags = parts[6];
    const type = flags[0];
    const compressed = flags.length > 1 && flags[1] === 'z';
    if (!sid || isNaN(k) || isNaN(len) || isNaN(crc) || isNaN(seed)) return null;
    if (type !== 't' && type !== 'i') return null;

    try {
      const data = b64ToBytes(parts[7]);
      if (data.length !== BLOCK_SIZE) return null;
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
      this.blocks = new Map();
      this.pending = [];
      this.seenSeeds = new Set();
    }

    get complete() {
      return this.k > 0 && this.blocks.size === this.k;
    }

    addFrame(frame) {
      if (this.sid && frame.sid !== this.sid) this.reset();

      this.sid = frame.sid;
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
        const offset = i * BLOCK_SIZE;
        bytes.set(block.slice(0, Math.min(BLOCK_SIZE, this.len - offset)), offset);
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

  const OT2 = { parseFountainFrame, FountainDecoder, utf8Decode, BLOCK_SIZE };
  if (typeof module !== 'undefined' && module.exports) module.exports = OT2;
  else global.OT2 = OT2;
})(typeof window !== 'undefined' ? window : this);
