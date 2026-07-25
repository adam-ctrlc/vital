import { API_URL } from '@/lib/api-client';

/**
 * How long to wait before calling the API unreachable.
 *
 * Generous on purpose: the API is a Vercel serverless function, and a cold start can
 * take several seconds. Anything tighter turns a first launch of the day into a false
 * "cannot reach the server".
 */
const PROBE_TIMEOUT_MS = 8000;

/**
 * Asks the API whether it is actually alive.
 *
 * `/health` is the right probe: it is the one route that needs no bearer token and no
 * device key, so this works before sign-in and cannot be confused with an auth failure.
 * It also touches no tables, so probing costs nothing.
 *
 * A device can report a perfectly good Wi-Fi link and still have no usable path to the
 * API: a captive portal that intercepts every request, DNS that resolves nowhere, a
 * deployment that is down. Those all look identical to "connected" at the OS level and
 * only show up when something actually tries to talk to the server.
 */
export async function probeApi(): Promise<boolean> {
  // AbortSignal.timeout is not in the Hermes/React Native runtime, so the timeout is
  // driven by an explicit controller.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_URL}/health`, {
      method: 'GET',
      signal: controller.signal,
      // A captive portal happily returns 200 with its own login page, so the status
      // alone is not proof. The body is checked below.
      headers: { accept: 'application/json' },
    });

    if (!response.ok) return false;

    const payload: unknown = await response.json();

    // Confirms we reached VITAL rather than something that merely answered. A portal
    // returning HTML fails the JSON parse; one returning JSON still will not carry
    // this shape.
    return (
      typeof payload === 'object' &&
      payload !== null &&
      (payload as { status?: unknown }).status === 'ok'
    );
  } catch {
    // Covers the abort, DNS failure, connection refused, TLS failure and a non-JSON
    // body alike. From here they are the same thing: no usable API.
    return false;
  } finally {
    clearTimeout(timer);
  }
}
