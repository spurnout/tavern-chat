import { create } from 'zustand';

export interface LightboxImage {
  attachmentId: string;
  url: string;
  thumbnailUrl: string | null;
  filename: string;
  width: number | null;
  height: number | null;
}

interface LightboxState {
  /** Active image set. Empty when the lightbox is closed. */
  images: LightboxImage[];
  index: number;
  open: boolean;
  show: (images: LightboxImage[], startIndex: number) => void;
  close: () => void;
  next: () => void;
  prev: () => void;
  setIndex: (i: number) => void;
}

export const useLightbox = create<LightboxState>((set, get) => ({
  images: [],
  index: 0,
  open: false,
  show: (images, startIndex) =>
    set({ images, index: Math.max(0, Math.min(startIndex, images.length - 1)), open: true }),
  close: () => set({ open: false }),
  next: () =>
    set(() => {
      const { images, index } = get();
      if (images.length === 0) return {};
      return { index: (index + 1) % images.length };
    }),
  prev: () =>
    set(() => {
      const { images, index } = get();
      if (images.length === 0) return {};
      return { index: (index - 1 + images.length) % images.length };
    }),
  setIndex: (i) => set({ index: i }),
}));
