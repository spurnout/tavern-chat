import { TavernLogo } from '../components/TavernLogo.js';

/**
 * Empty-state landing for the app shell — shown when the user is signed in
 * but hasn't picked a tavern yet. FE-20: the previous copy talked about
 * Phase 0 scaffolding, which leaked the project's internal roadmap to every
 * new user.
 */
export function AppHomePage(): JSX.Element {
  return (
    <div className="grid h-full place-items-center p-12 text-center">
      <div className="max-w-md space-y-4">
        <TavernLogo className="justify-center" />
        <h1 className="font-serif text-2xl font-medium">Pull up a chair.</h1>
        <p className="text-sm text-fg-muted">
          Pick a tavern from the left to step inside, or create a new one to gather
          your group. Voice rooms, campaigns, and dice rolls are all waiting.
        </p>
      </div>
    </div>
  );
}
