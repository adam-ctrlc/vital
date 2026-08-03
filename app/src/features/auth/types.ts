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
};

export type LoginResponse = {
  token: string;
  user: User;
};
