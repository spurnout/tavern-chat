import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router.js';
import { Toaster } from './components/Toaster.js';
import { initFocusTracking } from './lib/focus.js';
import { bindSoundSettings } from './lib/notification-settings.js';
import { initSoundUnlock } from './lib/sound.js';
import { applyPreferencesToDom } from './lib/preferences-store.js';
import { startBadging } from './lib/badge.js';
import { installOutboxAutoDrain } from './lib/outbox.js';
import './styles.css';
import './styles/preferences.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('No #root element found');

// Browsers suspend the AudioContext until the first user gesture; this
// attaches the one-time unlock listeners that resume it.
initSoundUnlock();
// Point the sound engine at the (eventually-DB-backed) settings store.
bindSoundSettings();
// Mirror tab/window visibility into the store; the chat-sound gate reads it.
initFocusTracking();

// Wave 3 — appearance prefs, app badging, offline outbox drain.
applyPreferencesToDom();
startBadging();
installOutboxAutoDrain();

// Wave 3 #25 — PWA service worker. Registered lazily; failure (e.g. on
// http without a TLS terminator) is a no-op.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

createRoot(rootEl).render(
  <StrictMode>
    {/* Wave 3 #44 — keyboard users can tab to this link before anything else */}
    <a href="#main-content" className="skip-to-content">
      Skip to main content
    </a>
    <RouterProvider router={router} />
    <Toaster />
  </StrictMode>,
);
