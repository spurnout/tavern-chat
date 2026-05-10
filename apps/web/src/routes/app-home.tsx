import { TavernLogo } from '../components/TavernLogo.js';

export function AppHomePage(): JSX.Element {
  return (
    <div className="grid h-full place-items-center p-12 text-center">
      <div className="max-w-md space-y-4">
        <TavernLogo className="justify-center" />
        <h1 className="text-2xl font-semibold">Welcome.</h1>
        <p className="text-sm text-tavern-mist">
          Pick a channel from the left to start chatting. Servers, channels, voice rooms,
          campaigns, and dice rolling all light up in the next phases — this Phase 0 build
          confirms auth and the app shell are wired correctly.
        </p>
      </div>
    </div>
  );
}
