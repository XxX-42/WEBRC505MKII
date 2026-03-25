# Testing And Push Policy

## Minimum gate before push

Every push to `main` should pass:

1. `npm run build`
2. `npm run test:unit`
3. `npm run test:e2e`
4. the current manual browser/native verification checklist

## Automated test intent

- Unit tests protect capability logic, transport lifecycle behavior, and track-control wiring.
- Playwright tests protect page state flow with mocked browser audio and mocked native-bridge responses.
- Automated tests are not used to claim real audio correctness.

## Manual verification intent

Manual checks remain required for:

- real device enumeration
- real recording/playback timing
- THRU monitoring safety
- actual native bridge/device behavior

## Push shape

- Prefer a clean working tree before the final commit.
- Keep test and governance changes in the same push when they are needed to support the shipped code.
- Avoid pushing build output unless explicitly required.
