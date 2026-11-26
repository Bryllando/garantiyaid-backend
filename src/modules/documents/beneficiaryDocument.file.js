const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function decodeDocumentFileName(name) {
  // Multipart parameters arrive as Latin-1 in Busboy, while modern file pickers send UTF-8.
  if (!/^[\u0000-\u00ff]*$/.test(name)) return name;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(name, "latin1")); }
  catch { return name; }
}

export function detectAllowedDocumentMimeType(buffer) {
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }

  if (
    buffer.length >= 3
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return "image/png";
  }

  return null;
}
