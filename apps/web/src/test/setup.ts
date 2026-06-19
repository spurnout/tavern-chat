// Setup for the jsdom ("dom") Vitest project. Loaded via setupFiles.
//
// - jest-dom adds DOM matchers (toHaveTextContent, toBeDisabled, …) and
//   augments Vitest's expect itself via the /vitest entrypoint.
// - jest-axe adds toHaveNoViolations. Its types target Jest, so we augment
//   Vitest's matcher interfaces by hand below.
// Testing Library auto-cleanup runs between tests because the dom project
// enables `globals` (afterEach is registered automatically).
import '@testing-library/jest-dom/vitest';
import { expect } from 'vitest';
import { toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

declare module 'vitest' {
  // Signature must match Vitest's own `Assertion<T = any>` declaration exactly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Assertion<T = any> {
    toHaveNoViolations(): T;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): unknown;
  }
}
