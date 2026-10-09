// Package notifications registers devices for push and announces alerts to them
// through Expo's push service.
//
// Routes: POST /api/v1/notifications/register and /unregister, both for any signed-in
// caller and 204 on success. Service implements alerts.Notifier.
package notifications
