import { TavernLogo } from '../components/TavernLogo.js';

export function AppHomePage(): JSX.Element {
  return (
    <div className="grid h-full place-items-center p-12 text-center">
      <div className="max-w-md space-y-4">
        <TavernLogo className="justify-center" />
        <h1 className="font-serif text-2xl font-medium">Welcome.</h1>
        <p className="text-sm text-fg-muted">
          Pick a room from the left to start chatting. Dens, rooms, voice rooms,
          campaigns, and dice rolling all light up in the next phases — this Phase 0 build
          confirms auth and the app shell are wired correctly.
        </p>
      </div>
    </div>
  );
}
