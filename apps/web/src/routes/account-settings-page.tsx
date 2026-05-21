import { AccountSecuritySection } from '../components/AccountSecuritySection.js';
import { AccountPasskeysSection } from '../components/AccountPasskeysSection.js';
import { AccountSessionsSection } from '../components/AccountSessionsSection.js';
import { AccountDataSection } from '../components/AccountDataSection.js';
import { AccountCalendarSection } from '../components/AccountCalendarSection.js';
import { AccountTokensSection } from '../components/AccountTokensSection.js';
import { AccountAppearanceSection } from '../components/AccountAppearanceSection.js';
import { AccountPushSection } from '../components/AccountPushSection.js';
import { AccountFederationPrivacySection } from '../components/AccountFederationPrivacySection.js';

/**
 * Account-level settings. Server / tavern-scoped settings live elsewhere.
 * Surfaces 2FA, active sessions, data export / deletion, personal API
 * tokens, and the iCal subscription URL.
 */
export function AccountSettingsPage(): JSX.Element {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-canvas">
      <header className="border-b border-subtle bg-sunken px-6 py-4">
        <h1 className="font-serif text-xl">Account</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Your security, sessions, and data. Tavern-level settings live in the gear icon on each
          tavern.
        </p>
      </header>
      <div className="mx-auto w-full max-w-2xl space-y-8 px-6 py-6">
        <AccountAppearanceSection />
        <AccountFederationPrivacySection />
        <AccountSecuritySection />
        <AccountPasskeysSection />
        <AccountPushSection />
        <AccountSessionsSection />
        <AccountDataSection />
        <AccountCalendarSection />
        <AccountTokensSection />
      </div>
    </div>
  );
}
