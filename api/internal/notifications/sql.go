package notifications

// SQLRegisterToken stores a device, or moves an already registered token to the
// caller with its new platform and channel. Args: Registration.Token, the user id as
// hyphenated lowercase text (what every other table stores, so joins keep working),
// Registration.Platform, Registration.ChannelID (NULL when nil).
const SQLRegisterToken = `insert into push_tokens (token, user_id, platform, channel_id)
values (?, ?, ?, ?)
on conflict (token) do update
   set user_id = excluded.user_id,
       platform = excluded.platform,
       channel_id = excluded.channel_id`

// SQLUnregisterToken removes the caller's own registration of a token. Args:
// RegisterToken.UnregisterToken(), the user id as hyphenated lowercase text.
const SQLUnregisterToken = `delete from push_tokens where token = ? and user_id = ?`

// SQLDevices lists every registered device with the channel it asked for, in
// whatever order the table returns them. Columns: token, channel_id (nullable).
const SQLDevices = `select token, channel_id from push_tokens`
