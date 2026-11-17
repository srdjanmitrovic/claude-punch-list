/**
 * A raw deflate stream (RFC 1951) written in plain JavaScript, for
 * tools/build.mjs.
 *
 * Its bytes depend on nothing but this file. `node:zlib` would compress a
 * little better, but its output is a property of whichever zlib Node was
 * linked against: Node 20 and 22 with their bundled copy and Homebrew's
 * Node 24 with the system's zlib 1.2.12 packed the same 0.5.0 tree to two
 * different checksums. Any inflater reads this stream, since it uses nothing
 * but the format: one dynamic Huffman block per file, after LZ77 matching
 * with zlib's own lazy rule.
 *
 * Every choice below (hash, chain length, tie breaks in the Huffman build) is
 * part of the release checksum. Changing one is fine, but it changes the
 * archive for the same input, which test/build.test.mjs pins on purpose.
 */

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const WINDOW = 32768;
// The format allows a distance of the whole window. zlib never writes one
// over 262 short of it, so an inflater that was only ever tested against
// zlib never sees one; staying inside that costs nothing measurable here.
const MAX_DISTANCE = WINDOW - 262;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const MAX_CHAIN = 1024; // candidates tried per position
const GOOD_MATCH = 32; // past this, try a quarter as many for the next position
const HASH_SIZE = 1 << 15;

// Length 3..258 to its code (0..28), and distance 1..32768 to its code
// (0..29). Code 28 is filled last because 258 has a code of its own, though
// code 27's range would reach it.
const LENGTH_CODE = new Uint8Array(MAX_MATCH + 1);
for (let code = 0; code < LENGTH_BASE.length; code += 1) {
  for (let n = 0; n < 1 << LENGTH_EXTRA[code]; n += 1) {
    if (LENGTH_BASE[code] + n <= MAX_MATCH) LENGTH_CODE[LENGTH_BASE[code] + n] = code;
  }
}
const DIST_CODE = new Uint8Array(WINDOW + 1);
for (let code = 0; code < DIST_BASE.length; code += 1) {
  for (let n = 0; n < 1 << DIST_EXTRA[code]; n += 1) {
    if (DIST_BASE[code] + n <= WINDOW) DIST_CODE[DIST_BASE[code] + n] = code;
  }
}

/**
 * Find repeats. Returns parallel arrays: a literal byte with distance 0, or a
 * match length with the distance back to where it was seen.
 *
 * Positions are chained by a hash of their first three bytes. A match found at
 * one position is held back a step, as zlib does, in case the next position
 * starts a longer one.
 */
function lz77(data) {
  const n = data.length;
  const values = new Uint16Array(n);
  const distances = new Uint16Array(n);
  let count = 0;

  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(WINDOW).fill(-1);
  const hash = (i) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH_SIZE - 1);
  const insert = (i) => {
    if (i + MIN_MATCH > n) return;
    const h = hash(i);
    prev[i & (WINDOW - 1)] = head[h];
    head[h] = i;
  };

  // The slot of a position is reused WINDOW positions later. A candidate
  // within MAX_DISTANCE has not had its slot reused yet, because the position
  // that would reuse it is later than the current one, and is not inserted.
  let bestDistance = 0;
  const longest = (i, chainLimit) => {
    const max = Math.min(MAX_MATCH, n - i);
    bestDistance = 0;
    if (max < MIN_MATCH) return 0;
    let best = MIN_MATCH - 1;
    let candidate = head[hash(i)];
    let chain = chainLimit;
    while (candidate >= 0 && i - candidate <= MAX_DISTANCE && chain > 0) {
      chain -= 1;
      if (data[candidate + best] === data[i + best] && data[candidate] === data[i]) {
        let length = 0;
        while (length < max && data[candidate + length] === data[i + length]) length += 1;
        if (length > best) {
          best = length;
          bestDistance = i - candidate;
          if (length >= max) break;
        }
      }
      candidate = prev[candidate & (WINDOW - 1)];
    }
    return bestDistance ? best : 0;
  };

  let i = 0;
  let pending = false; // position i - 1 has not been emitted yet
  let pendingLength = 0;
  let pendingDistance = 0;
  while (i < n) {
    const chainLimit = pending && pendingLength >= GOOD_MATCH ? MAX_CHAIN >> 2 : MAX_CHAIN;
    const length = longest(i, chainLimit);
    const distance = bestDistance;
    insert(i);
    if (pending && pendingLength >= MIN_MATCH && length <= pendingLength) {
      // The match from i - 1 is at least as good as the one from here.
      values[count] = pendingLength;
      distances[count] = pendingDistance;
      count += 1;
      const end = i - 1 + pendingLength;
      for (let k = i + 1; k < end; k += 1) insert(k);
      i = end;
      pending = false;
      continue;
    }
    if (pending) {
      values[count] = data[i - 1];
      distances[count] = 0;
      count += 1;
    }
    pending = true;
    pendingLength = length;
    pendingDistance = distance;
    i += 1;
  }
  // A match needs three bytes, so the last position can only be a literal.
  if (pending) {
    values[count] = data[n - 1];
    distances[count] = 0;
    count += 1;
  }
  return { values, distances, count };
}

/**
 * Huffman code lengths for these frequencies, none longer than `limit`.
 *
 * Built with two queues, leaves sorted by weight and then symbol, ties going
 * to the leaf, so the result is the same on every engine. Too deep a tree is
 * rebuilt from halved weights until it fits, which is cruder than zlib's
 * repair but always ends: weights of all 1 give a balanced tree.
 */
export function codeLengths(frequencies, limit) {
  let weights = Array.from(frequencies);
  for (;;) {
    const lengths = new Uint8Array(weights.length);
    const leaves = [];
    for (let symbol = 0; symbol < weights.length; symbol += 1) {
      if (weights[symbol] > 0) leaves.push({ weight: weights[symbol], symbol });
    }
    leaves.sort((a, b) => a.weight - b.weight || a.symbol - b.symbol);
    const merged = [];
    let leaf = 0;
    let node = 0;
    const take = () =>
      node < merged.length && (leaf >= leaves.length || merged[node].weight < leaves[leaf].weight)
        ? merged[node++]
        : leaves[leaf++];
    while (leaves.length - leaf + merged.length - node > 1) {
      const a = take();
      const b = take();
      merged.push({ weight: a.weight + b.weight, children: [a, b] });
    }
    const stack = [[merged[merged.length - 1], 0]];
    let deepest = 0;
    while (stack.length) {
      const [current, depth] = stack.pop();
      if (current.children) {
        for (const child of current.children) stack.push([child, depth + 1]);
      } else {
        lengths[current.symbol] = depth;
        deepest = Math.max(deepest, depth);
      }
    }
    if (deepest <= limit) return lengths;
    weights = weights.map((weight) => (weight ? Math.max(1, weight >> 1) : 0));
  }
}

/**
 * Every tree must hold at least two codes: a single code of one bit leaves
 * the code incomplete, which zlib refuses for the code length tree. The
 * extra symbol gets a code that is never written.
 */
function atLeastTwo(frequencies) {
  for (let symbol = 0; frequencies.filter(Boolean).length < 2; symbol += 1) {
    if (!frequencies[symbol]) frequencies[symbol] = 1;
  }
  return frequencies;
}

/** Canonical codes for these lengths (RFC 1951 3.2.2), bit reversed for writing. */
function canonicalCodes(lengths) {
  const count = new Uint16Array(16);
  for (const length of lengths) if (length) count[length] += 1;
  const next = new Uint16Array(16);
  let code = 0;
  for (let bits = 1; bits < 16; bits += 1) {
    code = (code + count[bits - 1]) << 1;
    next[bits] = code;
  }
  const codes = new Uint16Array(lengths.length);
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol];
    if (!length) continue;
    let value = next[length]++;
    let reversed = 0;
    for (let bit = 0; bit < length; bit += 1) {
      reversed = (reversed << 1) | (value & 1);
      value >>= 1;
    }
    codes[symbol] = reversed;
  }
  return codes;
}

/** Deflate writes bits from the least significant end of each byte. */
function bitWriter(capacity) {
  let bytes = new Uint8Array(Math.max(64, capacity));
  let size = 0;
  let pending = 0;
  let bits = 0;
  return {
    write(value, width) {
      pending |= value << bits;
      bits += width;
      while (bits >= 8) {
        if (size === bytes.length) {
          const grown = new Uint8Array(bytes.length * 2);
          grown.set(bytes);
          bytes = grown;
        }
        bytes[size++] = pending & 0xff;
        pending >>>= 8;
        bits -= 8;
      }
    },
    finish() {
      if (bits > 0) this.write(0, 8 - bits);
      return Buffer.from(bytes.buffer, 0, size);
    },
  };
}

/** Compress `data` into a raw deflate stream that depends on nothing but this file. */
export function deflateRaw(data) {
  const { values, distances, count } = lz77(data);

  const literalFrequencies = new Array(286).fill(0);
  const distanceFrequencies = new Array(30).fill(0);
  for (let k = 0; k < count; k += 1) {
    if (distances[k]) {
      literalFrequencies[257 + LENGTH_CODE[values[k]]] += 1;
      distanceFrequencies[DIST_CODE[distances[k]]] += 1;
    } else {
      literalFrequencies[values[k]] += 1;
    }
  }
  literalFrequencies[256] = 1; // end of block

  const literalLengths = codeLengths(atLeastTwo(literalFrequencies), 15);
  const distanceLengths = codeLengths(atLeastTwo(distanceFrequencies), 15);
  const literalCodes = canonicalCodes(literalLengths);
  const distanceCodes = canonicalCodes(distanceLengths);

  let literalCount = 286;
  while (literalCount > 257 && !literalLengths[literalCount - 1]) literalCount -= 1;
  let distanceCount = 30;
  while (distanceCount > 1 && !distanceLengths[distanceCount - 1]) distanceCount -= 1;

  // Both trees' lengths are sent as one run length coded sequence, which the
  // format allows to run across from one tree to the next.
  const sequence = [
    ...literalLengths.subarray(0, literalCount),
    ...distanceLengths.subarray(0, distanceCount),
  ];
  const runs = []; // [symbol, extra value, extra bits]
  for (let k = 0; k < sequence.length; ) {
    const length = sequence[k];
    let run = 1;
    while (k + run < sequence.length && sequence[k + run] === length) run += 1;
    k += run;
    if (length === 0) {
      while (run >= 11) {
        const take = Math.min(run, 138);
        runs.push([18, take - 11, 7]);
        run -= take;
      }
      if (run >= 3) {
        runs.push([17, run - 3, 3]);
        run = 0;
      }
    } else {
      runs.push([length, 0, 0]);
      run -= 1;
      while (run >= 3) {
        const take = Math.min(run, 6);
        runs.push([16, take - 3, 2]);
        run -= take;
      }
    }
    for (; run > 0; run -= 1) runs.push([length, 0, 0]);
  }

  const runFrequencies = new Array(19).fill(0);
  for (const [symbol] of runs) runFrequencies[symbol] += 1;
  const runLengths = codeLengths(atLeastTwo(runFrequencies), 7);
  const runCodes = canonicalCodes(runLengths);
  let runCount = 19;
  while (runCount > 4 && !runLengths[CODE_LENGTH_ORDER[runCount - 1]]) runCount -= 1;

  const out = bitWriter(data.length >> 1);
  out.write(1, 1); // the final block
  out.write(2, 2); // with dynamic Huffman codes
  out.write(literalCount - 257, 5);
  out.write(distanceCount - 1, 5);
  out.write(runCount - 4, 4);
  for (let k = 0; k < runCount; k += 1) out.write(runLengths[CODE_LENGTH_ORDER[k]], 3);
  for (const [symbol, extra, width] of runs) {
    out.write(runCodes[symbol], runLengths[symbol]);
    if (width) out.write(extra, width);
  }

  for (let k = 0; k < count; k += 1) {
    if (!distances[k]) {
      out.write(literalCodes[values[k]], literalLengths[values[k]]);
      continue;
    }
    const code = LENGTH_CODE[values[k]];
    out.write(literalCodes[257 + code], literalLengths[257 + code]);
    if (LENGTH_EXTRA[code]) out.write(values[k] - LENGTH_BASE[code], LENGTH_EXTRA[code]);
    const distanceCode = DIST_CODE[distances[k]];
    out.write(distanceCodes[distanceCode], distanceLengths[distanceCode]);
    if (DIST_EXTRA[distanceCode]) {
      out.write(distances[k] - DIST_BASE[distanceCode], DIST_EXTRA[distanceCode]);
    }
  }
  out.write(literalCodes[256], literalLengths[256]);
  return out.finish();
}
