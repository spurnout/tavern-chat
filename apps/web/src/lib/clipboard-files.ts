// Pulls pasteable files out of a clipboard payload so the composers can treat
// a pasted screenshot / copied image the same as a file-picker selection.
// Kept framework-agnostic and side-effect-free so it can be unit-tested under
// the src/lib coverage gate.

// Names browsers hand to clipboard blobs when there's no real source file:
// a bare screenshot is usually `image.png`, a generic blob is `blob`, and a
// drag from some apps yields an empty name. Rename those so the attachment
// chip and the stored filename are meaningful.
const GENERIC_PASTE_NAMES = new Set(['', 'image.png', 'blob']);

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

/**
 * Extract any files from a clipboard paste — screenshots, images copied from a
 * web page, or files copied in the OS file manager.
 *
 * Returns an empty array for plain-text pastes so callers can let the browser's
 * default paste insert the text. Generically-named blobs are given a unique,
 * human-readable filename; real filenames are preserved untouched.
 */
export function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];

  const files: File[] = [];

  // `items` is the reliable source for an image copied from a web page or a
  // screenshot placed on the clipboard — iterate it first.
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }

  // Some sources (e.g. copying a file in the OS file manager) only populate
  // `files`. Fall back to it when `items` yielded nothing.
  if (files.length === 0 && data.files && data.files.length > 0) {
    files.push(...Array.from(data.files));
  }

  return files.map(nameClipboardFile);
}

function nameClipboardFile(file: File): File {
  if (!GENERIC_PASTE_NAMES.has(file.name)) return file;
  const ext = MIME_EXTENSIONS[file.type] ?? subtypeOf(file.type) ?? 'bin';
  // Cosmetic uniqueness only — attachments are keyed by id, not filename — so
  // a low-collision timestamp + random suffix is plenty.
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return new File([file], `pasted-${stamp}.${ext}`, { type: file.type });
}

function subtypeOf(mime: string): string | undefined {
  const slash = mime.indexOf('/');
  if (slash === -1) return undefined;
  return mime.slice(slash + 1) || undefined;
}
