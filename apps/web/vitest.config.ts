import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Plain Node env — the realtime store + the PRESENCE_UPDATE dispatch
    // path don't touch the DOM. If a future test needs jsdom, install it
    // and switch the environment locally with the `// @vitest-environment`
    // pragma.
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
