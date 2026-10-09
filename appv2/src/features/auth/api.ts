import type { LoginResponse, Role, User } from '@/features/auth/types';
import { request } from '@/lib/api-client';

export function login(identifier: string, password: string, role?: Role) {
  return request<LoginResponse>('/auth/login', {
    method: 'POST',
    body: role ? { identifier, password, role } : { identifier, password },
  });
}

export type Registration = {
  firstName: string;
  middleName: string | null;
  lastName: string;
  /** Blank lets the server generate one from the name. */
  username?: string;
  email?: string;
  password: string;
};

/**
 * Creates an account that waits for an admin's approval. Always a standard user; the
 * server decides the username when none is given and returns it.
 */
export function register(registration: Registration) {
  return request<{ username: string }>('/auth/register', { method: 'POST', body: registration });
}

export function profile(token: string) {
  return request<User>('/auth/me', { token });
}

export type ProfileUpdate = {
  firstName: string;
  middleName: string | null;
  lastName: string;
  email?: string;
  username?: string;
};

export function updateProfile(token: string, update: ProfileUpdate) {
  return request<User>('/auth/me', { method: 'PUT', token, body: update });
}

export function changePassword(token: string, currentPassword: string, newPassword: string) {
  return request<void>('/auth/password', {
    method: 'PUT',
    token,
    body: { currentPassword, newPassword },
  });
}
