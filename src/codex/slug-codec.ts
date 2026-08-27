/**
 * Reversible encoding for Ollama ids that contain `/`.
 * Only `%` and `/` are escaped so tag colons stay literal (`name:tag`).
 * Encoding `%` first makes `foo/bar` and `foo%2Fbar` distinct slugs.
 */
export function encodeOllamaId(id: string): string {
  let out = "";
  for (const char of id) {
    if (char === "%") out += "%25";
    else if (char === "/") out += "%2F";
    else out += char;
  }
  return out;
}

export function decodeOllamaId(encoded: string): string {
  let out = "";
  for (let i = 0; i < encoded.length; i += 1) {
    if (encoded[i] === "%" && i + 2 < encoded.length) {
      const hex = encoded.slice(i + 1, i + 3);
      if (hex === "2F" || hex === "2f") {
        out += "/";
        i += 2;
        continue;
      }
      if (hex === "25") {
        out += "%";
        i += 2;
        continue;
      }
    }
    out += encoded[i] ?? "";
  }
  return out;
}
