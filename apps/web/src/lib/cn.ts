import clsx, { type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge about the design-system tokens so conflicting utilities
// in the same group (e.g. `cn('bg-ember', 'bg-tint-ember')`) resolve to the
// last one. Without this, custom token names aren't recognised and both
// classes leak through.
//
// Border tiers (`subtle`, `default`, `strong`, `danger`) are listed under
// `theme.borderColor` explicitly so `border-{tier}` resolution doesn't rely
// on tailwind-merge's implicit `borderColor → colors` fallback — that would
// silently break if upstream ever tightens the `colors` validator or if we
// switch `extend` to `override`.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      colors: [
        // Surfaces
        'canvas',
        'sunken',
        'surface',
        'raised',
        'elevated',
        'overlay',
        // Foregrounds
        'fg',
        'fg-muted',
        'fg-faint',
        'fg-on-accent',
        // Accents
        'ember',
        'ember-hi',
        'ember-lo',
        'mead',
        'moss',
        'rust',
        'lavender',
        'dusk',
        // Tints (bg-only, but registering here is harmless)
        'tint-ember',
        'tint-mead',
        'tint-moss',
        'tint-rust',
        'tint-lavender',
        'tint-fg-04',
        'tint-danger',
        // Destructive status
        'danger',
        'danger-hi',
      ],
      borderColor: ['subtle', 'default', 'strong', 'danger'],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
