/**
 * GET /audit?limit=&offset=&action= (admin), newest first, as a Page. An action ending in
 * "." matches everything under it, such as "user.".
 */
export type AuditEvent = {
  id: number;
  at: string;
  actorId: string | null;
  actorName: string | null;
  /**
   * settings.update, settings.source, relay.open, relay.close, user.create, user.update,
   * user.delete, user.approve, account.update, account.password.
   */
  action: string;
  target: string | null;
  /**
   * settings.update, user.update, account.update: { field: { from, to } }.
   * settings.source: { from, to }. user.create: { email, role, username }.
   * user.delete: { role, username }. user.approve: { username }.
   */
  detail: Record<string, unknown> | null;
};

export type AuditFilter = 'settings' | 'relay' | 'user' | 'account' | null;
