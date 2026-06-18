import { useAnnouncement } from '../lib/announce.js';

/**
 * Visually-hidden assertive live region. Mount once inside the authenticated
 * shell. Screen readers announce its content the moment it changes — used for
 * @mention arrivals (see lib/announce.ts). Mirrors <Toaster />, but assertive
 * + atomic and rendered off-screen via `sr-only`.
 */
export function LiveAnnouncer(): JSX.Element {
  const { message } = useAnnouncement();
  return (
    <div aria-live="assertive" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}
