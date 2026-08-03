import type { Role } from '@/features/auth/types';

export type ManagedUser = {
  id: string;
  /** Absent when the account was created without one. */
  email: string | null;
  username: string;
  role: Role;
  firstName: string;
  middleName: string | null;
  lastName: string;
  fullName: string;
  createdAt: string;
};

export type NewUser = {
  email: string;
  password: string;
  role: Role;
  firstName: string;
  middleName: string | null;
  lastName: string;
  /** Optional: the server generates one from the name when omitted. */
  username?: string;
};

export type UpdateUser = {
  email: string;
  role: Role;
  firstName: string;
  middleName: string | null;
  lastName: string;
  /** Optional: blank keeps the current username. */
  username?: string;
  /** Optional: blank keeps the current password. */
  password?: string;
};
