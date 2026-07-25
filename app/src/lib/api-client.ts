export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080/api/v1';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
};

let onUnauthorized: (() => void) | null = null;

/**
 * Registers what to do when the server rejects a token we sent. Kept as a callback
 * rather than importing the auth context here, which would be a cycle: the context
 * already imports this module.
 */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token, signal } = options;

  const response = await fetch(`${API_URL}${path}`, {
    method,
    signal,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  // A 5xx from Vercel can be an HTML error page, not JSON; treat any body we
  // cannot parse as null so the !ok path falls through to its status message.
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    // A 401 on a request that carried a token means the token is dead, so end the
    // session rather than leaving every poll to fail forever behind a "cannot reach
    // the API" card. Sign-in carries no token, so a wrong password does not land here.
    if (response.status === 401 && token) {
      onUnauthorized?.();
    }

    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `request failed with ${response.status}`;
    throw new ApiError(response.status, message);
  }

  return payload as T;
}
