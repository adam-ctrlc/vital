export type Role = 'admin' | 'user';

export type User = {
  id: string;
  /** Absent when the account was created without one. */
  email: string | null;
  username: string;
  role: Role;
  firstName: string;
  middleName: string | null;
  lastName: string;
  fullName: string;
  /** A data URL of the compressed photo, or null for initials. */
  avatar: string | null;
};

export type LoginResponse = {
  token: string;
  user: User;
};
