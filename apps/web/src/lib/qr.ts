// Minimal QR Code encoder — byte mode, error-correction level M.
//
// Written for A-FE-08: the 2FA setup view needs a scannable QR code for
// the otpauth:// URI, and the repo carries no QR library (and package.json
// changes were out of scope for that fix). This is a from-spec
// implementation of ISO/IEC 18004 QR Code generation: GF(256)
// Reed–Solomon error correction, block interleaving, mask selection by
// the standard penalty rules, and BCH format/version information.
// It auto-selects the smallest version (1–40) that fits the input.
//
// The structure constants (EC codewords per block, block counts, raw
// data-module count, alignment placement) are the ISO/IEC 18004 spec
// tables/formulas; they were cross-checked against Project Nayuki's
// QR Code generator library (MIT License) reference tables, and the
// resulting byte capacities (14, 26, 42, …, 213, …, 2331) match the
// published QR capacity table for EC level M.
//
// The output is a module matrix (true = dark module); `qrSvgPath` turns
// it into SVG path data so the UI can render an inline <svg> with no
// canvas and no client-side image generation.

// --- GF(256) arithmetic (primitive polynomial x^8+x^4+x^3+x^2+1 = 0x11d) ---

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// Reed–Solomon generator polynomial of the given degree:
// product over i=0..degree-1 of (x - alpha^i). Coefficients are returned
// highest-degree first, without the leading 1.
function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]; // x * poly
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]); // alpha^i * poly
    }
    poly = next;
  }
  return poly.slice(1);
}

// Error-correction codewords for one data block: remainder of
// (data * x^degree) divided by the generator polynomial.
function rsRemainder(data: number[], gen: number[]): number[] {
  const result = new Array<number>(gen.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < gen.length; i++) result[i] ^= gfMul(gen[i], factor);
  }
  return result;
}

// --- QR structure constants (ISO/IEC 18004), error-correction level M ---

// EC codewords per block, versions 1..40 (index 0 unused).
const ECC_PER_BLOCK_M = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];

// Number of EC blocks, versions 1..40 (index 0 unused).
const NUM_BLOCKS_M = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33,
  35, 37, 38, 40, 43, 45, 47, 49,
];

// Number of data (non-function) modules in a symbol of the given version,
// including remainder bits. Total codewords = floor(this / 8).
function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCapacityCodewords(version: number): number {
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  return rawCodewords - ECC_PER_BLOCK_M[version] * NUM_BLOCKS_M[version];
}

// Byte-mode character-count field width: 8 bits for versions 1–9,
// 16 bits for versions 10–40.
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

// Alignment pattern center coordinates for a version (spec placement
// formula; version 1 has none).
function alignmentCenters(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const positions = [6];
  for (let pos = size - 7; positions.length < numAlign; pos -= step) positions.splice(1, 0, pos);
  return positions;
}

// --- Bitstream assembly ---

class BitBuffer {
  bits: number[] = [];
  append(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length(): number {
    return this.bits.length;
  }
  toBytes(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      out.push(byte);
    }
    return out;
  }
}

function buildDataCodewords(bytes: Uint8Array, version: number): number[] {
  const capacityBits = dataCapacityCodewords(version) * 8;
  const buf = new BitBuffer();
  buf.append(0b0100, 4); // byte mode
  buf.append(bytes.length, countBits(version));
  for (const byte of bytes) buf.append(byte, 8);
  // Terminator + pad to a byte boundary, then alternating pad bytes.
  buf.append(0, Math.min(4, capacityBits - buf.length));
  buf.append(0, (8 - (buf.length % 8)) % 8);
  for (let pad = 0xec; buf.length < capacityBits; pad ^= 0xec ^ 0x11) buf.append(pad, 8);
  return buf.toBytes();
}

// Split into blocks (short blocks first, then long blocks one codeword
// longer), compute EC per block, interleave data then EC.
function addErrorCorrection(data: number[], version: number): number[] {
  const ecPerBlock = ECC_PER_BLOCK_M[version];
  const numBlocks = NUM_BLOCKS_M[version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks); // data + EC per short block
  const gen = rsGenerator(ecPerBlock);
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i++) {
    const dataLen = shortBlockLen - ecPerBlock + (i < numShortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + dataLen);
    offset += dataLen;
    blocks.push(block);
    ecBlocks.push(rsRemainder(block, gen));
  }
  const out: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const block of blocks) if (i < block.length) out.push(block[i]);
  for (let i = 0; i < ecPerBlock; i++) for (const block of ecBlocks) out.push(block[i]);
  return out;
}

// --- Matrix construction ---

type Matrix = boolean[][];

function makeGrid(size: number): Matrix {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
}

// 15-bit format information: 2 EC-level bits (M = 00) + 3 mask bits,
// BCH(15,5) with generator 0x537, XOR mask 0x5412.
function formatBitsValue(mask: number): number {
  const data = mask; // EC level M contributes 0b00 in the top two bits
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

// 18-bit version information (versions >= 7): 6 version bits +
// BCH(18,6) with generator 0x1f25.
function versionBitsValue(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1f25);
  return (version << 12) | rem;
}

function buildMatrix(codewords: number[], version: number): Matrix {
  const size = version * 4 + 17;
  const modules = makeGrid(size);
  const isFunction = makeGrid(size);
  const setFunction = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };
  const getBit = (value: number, i: number) => ((value >>> i) & 1) !== 0;

  // Timing patterns (drawn first; finder patterns overwrite the corners).
  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  // Finder patterns with separators, centered at the three corners.
  const drawFinder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  // Alignment patterns (skipping the three finder corners).
  const centers = alignmentCenters(version);
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      const skip =
        (i === 0 && j === 0) || (i === 0 && j === centers.length - 1) || (i === centers.length - 1 && j === 0);
      if (skip) continue;
      const cx = centers[j];
      const cy = centers[i];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  const drawFormatBits = (mask: number) => {
    const bits = formatBitsValue(mask);
    // First copy, around the top-left finder.
    for (let i = 0; i <= 5; i++) setFunction(8, i, getBit(bits, i));
    setFunction(8, 7, getBit(bits, 6));
    setFunction(8, 8, getBit(bits, 7));
    setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, getBit(bits, i));
    // Second copy, split along the top-right and bottom-left edges.
    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, getBit(bits, i));
    setFunction(8, size - 8, true); // dark module (always dark)
  };

  // Reserve the format areas (mask 0 placeholder) and draw version info.
  drawFormatBits(0);
  if (version >= 7) {
    const bits = versionBitsValue(version);
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      setFunction(Math.floor(i / 3), (i % 3) + size - 11, bit);
      setFunction((i % 3) + size - 11, Math.floor(i / 3), bit);
    }
  }

  // Place the codeword bits in the standard zigzag, skipping column 6.
  // Any leftover modules are remainder bits and stay light (they are
  // still masked below, like data modules).
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && bitIndex < totalBits) {
          modules[y][x] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
          bitIndex++;
        }
      }
    }
  }

  // Apply each mask, score the penalty, keep the best.
  const maskCondition = (mask: number, x: number, y: number): boolean => {
    switch (mask) {
      case 0:
        return (x + y) % 2 === 0;
      case 1:
        return y % 2 === 0;
      case 2:
        return x % 3 === 0;
      case 3:
        return (x + y) % 3 === 0;
      case 4:
        return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5:
        return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6:
        return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default:
        return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };
  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunction[y][x] && maskCondition(mask, x, y)) modules[y][x] = !modules[y][x];
      }
    }
  };

  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormatBits(mask);
    const penalty = penaltyScore(modules, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    applyMask(mask); // undo
  }
  applyMask(bestMask);
  drawFormatBits(bestMask);
  return modules;
}

// Standard QR penalty rules used for mask selection (ISO/IEC 18004):
// same-color runs, 2x2 blocks, finder-like patterns, dark-ratio balance.
// The finder-like check uses a 7-run history so patterns at the symbol
// edge count the implicit light border outside the symbol.
function penaltyScore(modules: Matrix, size: number): number {
  const N1 = 3;
  const N2 = 3;
  const N3 = 40;
  const N4 = 10;
  let penalty = 0;

  const addHistory = (runLength: number, history: number[]) => {
    if (history[0] === 0) runLength += size; // light border before the first run
    history.pop();
    history.unshift(runLength);
  };
  const countFinderPatterns = (history: number[]): number => {
    const n = history[1];
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (
      (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
      (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
    );
  };
  const terminateAndCount = (runColor: boolean, runLength: number, history: number[]): number => {
    if (runColor) {
      addHistory(runLength, history);
      runLength = 0;
    }
    addHistory(runLength + size, history); // light border after the last run
    return countFinderPatterns(history);
  };

  // Rules 1 + 3 over rows, then columns.
  for (let y = 0; y < size; y++) {
    let runColor = false;
    let runLength = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let x = 0; x < size; x++) {
      if (modules[y][x] === runColor) {
        runLength++;
        if (runLength === 5) penalty += N1;
        else if (runLength > 5) penalty++;
      } else {
        addHistory(runLength, history);
        if (!runColor) penalty += countFinderPatterns(history) * N3;
        runColor = modules[y][x];
        runLength = 1;
      }
    }
    penalty += terminateAndCount(runColor, runLength, history) * N3;
  }
  for (let x = 0; x < size; x++) {
    let runColor = false;
    let runLength = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let y = 0; y < size; y++) {
      if (modules[y][x] === runColor) {
        runLength++;
        if (runLength === 5) penalty += N1;
        else if (runLength > 5) penalty++;
      } else {
        addHistory(runLength, history);
        if (!runColor) penalty += countFinderPatterns(history) * N3;
        runColor = modules[y][x];
        runLength = 1;
      }
    }
    penalty += terminateAndCount(runColor, runLength, history) * N3;
  }

  // Rule 2: 2x2 blocks of the same color.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) penalty += N2;
    }
  }

  // Rule 4: deviation of the dark-module ratio from 50%.
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  if (k > 0) penalty += k * N4;

  return penalty;
}

// --- Public API ---

export type QrCode = {
  version: number;
  size: number;
  modules: Matrix; // modules[y][x], true = dark
};

/** Encode text as a QR code (byte mode, EC level M, smallest fitting version). */
export function qrMatrix(text: string): QrCode {
  const bytes = new TextEncoder().encode(text);
  for (let version = 1; version <= 40; version++) {
    const neededBits = 4 + countBits(version) + bytes.length * 8;
    if (neededBits <= dataCapacityCodewords(version) * 8) {
      const data = buildDataCodewords(bytes, version);
      const codewords = addErrorCorrection(data, version);
      const modules = buildMatrix(codewords, version);
      return { version, size: version * 4 + 17, modules };
    }
  }
  throw new Error(`Text too long for a QR code (${bytes.length} bytes; max 2331 at EC level M)`);
}

/**
 * SVG path data for the QR code, with a quiet-zone margin (in modules)
 * included in the returned size. Render as:
 * <svg viewBox={`0 0 ${size} ${size}`}><path d={path} /></svg>
 * Dark modules in each row are merged into single horizontal runs.
 */
export function qrSvgPath(text: string, margin = 4): { size: number; path: string } {
  const { size, modules } = qrMatrix(text);
  const parts: string[] = [];
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!modules[y][x]) {
        x++;
        continue;
      }
      let length = 1;
      while (x + length < size && modules[y][x + length]) length++;
      parts.push(`M${x + margin} ${y + margin}h${length}v1h${-length}z`);
      x += length;
    }
  }
  return { size: size + margin * 2, path: parts.join("") };
}
