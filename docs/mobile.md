# Tavern Android mobile

Tavern mobile is an Expo / React Native Android client for the existing
self-hosted Tavern API. It is a second client, not a second backend.

## Current slice

- Connect to a self-hosted instance by URL.
- Use native-safe session storage for refresh tokens.
- Login, register, and first-run bootstrap.
- Load taverns, rooms, and recent messages through the existing REST API.
- Send text messages.
- Maintain live state through the existing `/gateway` WebSocket lifecycle.

The mobile client currently uses the existing `/api/auth/refresh` body-token
path so the app can work before a permanent native-session route is introduced.
Keep that isolated behind the mobile auth store.

## Local Android dev

Start the API normally:

```bash
pnpm dev:api
```

Then start the mobile app:

```bash
pnpm mobile:android
```

For the Android emulator, connect to the API with:

```text
http://10.0.2.2:3001
```

For a physical device, use the LAN address of the machine running the API and
make sure the API is reachable from that device.

## Validation

```bash
pnpm --filter @tavern/mobile typecheck
pnpm --filter @tavern/mobile lint
```
