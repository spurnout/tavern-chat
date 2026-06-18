import { describe, expect, it } from 'vitest';
import { filesFromClipboard } from './clipboard-files.js';

function fileItem(file: File): DataTransferItem {
  return {
    kind: 'file',
    type: file.type,
    getAsFile: () => file,
  } as unknown as DataTransferItem;
}

function stringItem(): DataTransferItem {
  return {
    kind: 'string',
    type: 'text/plain',
    getAsFile: () => null,
  } as unknown as DataTransferItem;
}

function clipboard(items: DataTransferItem[], files: File[] = []): DataTransfer {
  return { items, files } as unknown as DataTransfer;
}

const bytes = () => new Uint8Array([1, 2, 3]);

describe('filesFromClipboard', () => {
  it('returns nothing for an absent clipboard', () => {
    expect(filesFromClipboard(null)).toEqual([]);
  });

  it('ignores plain-text pastes so the default paste can proceed', () => {
    expect(filesFromClipboard(clipboard([stringItem()]))).toEqual([]);
  });

  it('extracts a pasted image and renames a generic blob name', () => {
    const screenshot = new File([bytes()], 'image.png', { type: 'image/png' });
    const out = filesFromClipboard(clipboard([stringItem(), fileItem(screenshot)]));
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('image/png');
    expect(out[0]!.name).toMatch(/^pasted-[a-z0-9-]+\.png$/);
  });

  it('maps the mime type to a friendly extension for nameless blobs', () => {
    const blob = new File([bytes()], '', { type: 'image/jpeg' });
    const out = filesFromClipboard(clipboard([fileItem(blob)]));
    expect(out[0]!.name).toMatch(/^pasted-[a-z0-9-]+\.jpg$/);
  });

  it('preserves a real filename', () => {
    const named = new File([bytes()], 'diagram.png', { type: 'image/png' });
    const out = filesFromClipboard(clipboard([fileItem(named)]));
    expect(out[0]!.name).toBe('diagram.png');
  });

  it('falls back to clipboardData.files when items are empty', () => {
    const named = new File([bytes()], 'report.pdf', { type: 'application/pdf' });
    const out = filesFromClipboard(clipboard([], [named]));
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('report.pdf');
  });
});
