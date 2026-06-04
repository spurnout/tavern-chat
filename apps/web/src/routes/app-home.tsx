import { EmptyState } from '../components/EmptyState.js';
import { TavernLogo } from '../components/TavernLogo.js';

/**
 * Empty-state landing for the app shell — shown when the user is signed in
 * but hasn't picked a tavern yet. FE-20: the previous copy talked about
 * Phase 0 scaffolding, which leaked the project's internal roadmap to every
 * new user.
 */
export function AppHomePage(): JSX.Element {
  return (
    <EmptyState
      icon={<TavernLogo className="justify-center" />}
      title="Pull up a chair."
      description="Pick a tavern from the left to step inside, or create a new one to gather your group. Voice rooms, campaigns, and dice rolls are all waiting."
    />
  );
}
