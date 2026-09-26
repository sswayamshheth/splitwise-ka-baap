import { inflate, inflateRaw } from "pako";

/**
 * Minimal PDF text extractor.
 *
 * Walks the raw bytes for `stream … endstream` blocks, inflates the ones
 * marked /FlateDecode, and pulls the string operands out of the text-showing
 * operators (Tj, TJ, ' and "). That covers ordinary text-layer PDFs — the
 * kind a hotel or a travel agent emails you.
 *
 * It deliberately does NOT do OCR. A scanned/photographed itinerary has no
 * text layer, and this returns nothing rather than inventing content; the
 * caller then offers manual entry.
 */

const decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("latin1") : null;

function bytesToLatin1(bytes: Uint8Array): string {
  if (decoder) return decoder.decode(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

function indexOfSeq(haystack: Uint8Array, needle: number[], from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Decodes a PDF literal string body, handling escapes and octal codes. */
function decodeLiteral(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "b" || next === "f") out += " ";
    else if (next === "\n") continue;
    else if (next >= "0" && next <= "7") {
      let oct = next;
      while (oct.length < 3 && body[i + 1] >= "0" && body[i + 1] <= "7") oct += body[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += next;
  }
  return out;
}

function decodeHex(body: string): string {
  const hex = body.replace(/[^0-9a-fA-F]/g, "");
  let out = "";
  // UTF-16BE is common for hex strings; detect the BOM, otherwise treat as bytes.
  if (/^feff/i.test(hex)) {
    for (let i = 4; i + 3 < hex.length + 1; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return out;
  }
  for (let i = 0; i + 1 < hex.length + 1; i += 2) {
    const code = parseInt(hex.slice(i, i + 2).padEnd(2, "0"), 16);
    if (code) out += String.fromCharCode(code);
  }
  return out;
}

/** Pulls readable text out of one decoded content stream. */
function textFromContentStream(content: string): string {
  const out: string[] = [];
  let i = 0;
  let pendingLineBreak = false;

  const readString = (): string | null => {
    if (content[i] === "(") {
      let depth = 1;
      let body = "";
      i++;
      while (i < content.length && depth > 0) {
        const ch = content[i];
        if (ch === "\\") {
          body += ch + (content[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        body += ch;
        i++;
      }
      return decodeLiteral(body);
    }
    if (content[i] === "<" && content[i + 1] !== "<") {
      const end = content.indexOf(">", i);
      if (end < 0) return null;
      const body = content.slice(i + 1, end);
      i = end + 1;
      return decodeHex(body);
    }
    return null;
  };

  while (i < content.length) {
    const ch = content[i];
    if (ch === "(" || (ch === "<" && content[i + 1] !== "<")) {
      const start = i;
      const s = readString();
      if (s === null) {
        i = start + 1;
        continue;
      }
      // Look ahead for the operator that consumes this string.
      const rest = content.slice(i, i + 24);
      if (/^\s*(Tj|TJ|'|")/.test(rest) || /^\s*[-\d.\s]*\]\s*TJ/.test(rest) || /^[^()<>]{0,20}$/.test(rest)) {
        if (pendingLineBreak) {
          out.push("\n");
          pendingLineBreak = false;
        }
        out.push(s);
      }
      continue;
    }
    // Td / TD / T* / ' / " all move to a new line.
    if (/[Tt]/.test(ch)) {
      const op = content.slice(i, i + 3);
      if (op.startsWith("Td") || op.startsWith("TD") || op.startsWith("T*")) {
        pendingLineBreak = true;
        i += 2;
        continue;
      }
      if (op.startsWith("ET")) {
        pendingLineBreak = true;
        i += 2;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

/** Extracts the text layer of a PDF given its raw bytes. Returns "" if there is none. */
export function extractPdfText(bytes: Uint8Array): string {
  const streamTok = ascii("stream");
  const endTok = ascii("endstream");
  const chunks: string[] = [];
  let cursor = 0;
  let guard = 0;

  while (guard++ < 5000) {
    const start = indexOfSeq(bytes, streamTok, cursor);
    if (start < 0) break;
    // Skip the EOL after "stream".
    let dataStart = start + streamTok.length;
    if (bytes[dataStart] === 0x0d) dataStart++;
    if (bytes[dataStart] === 0x0a) dataStart++;
    const end = indexOfSeq(bytes, endTok, dataStart);
    if (end < 0) break;
    const dictStart = Math.max(0, start - 900);
    const dict = bytesToLatin1(bytes.subarray(dictStart, start));
    const raw = bytes.subarray(dataStart, end);
    cursor = end + endTok.length;

    if (/\/Image\b|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode/.test(dict)) continue;

    let content: string | null = null;
    if (/\/FlateDecode/.test(dict)) {
      try {
        content = bytesToLatin1(inflate(raw));
      } catch {
        try {
          content = bytesToLatin1(inflateRaw(raw));
        } catch {
          content = null;
        }
      }
    } else if (!/\/Filter/.test(dict)) {
      content = bytesToLatin1(raw);
    }
    if (!content) continue;
    if (!/(\(|<)[^]*?(Tj|TJ)/.test(content)) continue;
    const text = textFromContentStream(content);
    if (text.trim()) chunks.push(text);
  }

  return chunks
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}
