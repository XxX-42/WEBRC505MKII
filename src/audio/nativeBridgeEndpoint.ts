/** The isolated E2E Vite mode never connects to a user's running audio host. */
export function nativeBridgeEndpoint(mode = import.meta.env.MODE): string {
  return `http://127.0.0.1:${mode === 'e2e' ? 18755 : 17755}`;
}
