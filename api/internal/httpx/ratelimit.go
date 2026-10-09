package httpx

import (
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// RateLimit is a per-IP limiter for one public route, with the semantics of the
// governor crate the Rust API used: a burst up front, then one request per period
// (GCRA, equivalent to a token bucket of size Burst refilled every Period).
//
// Each serverless instance holds its own buckets, so this caps a single source per
// instance rather than globally. It raises the cost of the easy case; the warn logs
// on failed logins are what make a distributed attack visible.
type RateLimit struct {
	Burst  int
	Period time.Duration
	Name   string

	// now is the clock; tests replace it.
	now func() time.Time

	mu        sync.Mutex
	tat       map[string]time.Time // theoretical arrival time per key
	lastSweep time.Time
}

// NewRateLimit returns a limiter allowing burst requests, then one per period.
func NewRateLimit(name string, burst int, period time.Duration) *RateLimit {
	return &RateLimit{Burst: burst, Period: period, Name: name, now: time.Now, tat: make(map[string]time.Time)}
}

// Allow records a request from key. When it is refused, wait is how long until the
// next one would be allowed.
func (l *RateLimit) Allow(key string) (ok bool, wait time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	l.sweep(now)

	tau := l.Period * time.Duration(l.Burst)
	tat, seen := l.tat[key]
	if !seen {
		tat = now.Add(l.Period)
	}

	earliest := tat.Add(-tau)
	if now.Before(earliest) {
		return false, earliest.Sub(now)
	}

	next := tat
	if now.After(next) {
		next = now
	}
	l.tat[key] = next.Add(l.Period)
	return true, 0
}

// sweep drops keys whose bucket has refilled completely, at most once a minute, so
// the map does not grow with every address that ever called.
func (l *RateLimit) sweep(now time.Time) {
	if now.Sub(l.lastSweep) < time.Minute {
		return
	}
	l.lastSweep = now
	for k, tat := range l.tat {
		if !tat.After(now) {
			delete(l.tat, k)
		}
	}
}

// Middleware refuses over-limit callers with a 429 {"error": "Too many attempts, try
// again in Ns"}, N floored at one second as the Rust handler did (governor reports
// whole seconds, and "0s" reads as an invitation to retry at once).
func (l *RateLimit) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip, ok := ClientIP(r)
		if !ok {
			// Only reachable when neither a proxy header nor the peer address exists,
			// which is a wiring fault; the Rust handler answered 500 the same way.
			slog.ErrorContext(r.Context(), l.Name+" rate limiter could not identify the caller")
			WriteError(w, r, ErrToken)
			return
		}
		if allowed, wait := l.Allow(ip); !allowed {
			WriteError(w, r, TooManyRequests(max(uint64(wait/time.Second), 1)))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ClientIP identifies the caller the way tower_governor's SmartIpKeyExtractor did:
// the first parseable address in X-Forwarded-For (Vercel sets it), then X-Real-IP,
// then Forwarded's for=, then the peer address.
func ClientIP(r *http.Request) (string, bool) {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		for _, part := range strings.Split(xff, ",") {
			if ip, err := netip.ParseAddr(strings.TrimSpace(part)); err == nil {
				return ip.String(), true
			}
		}
	}
	if real := strings.TrimSpace(r.Header.Get("X-Real-IP")); real != "" {
		if ip, err := netip.ParseAddr(real); err == nil {
			return ip.String(), true
		}
	}
	if fwd := r.Header.Get("Forwarded"); fwd != "" {
		for _, elem := range strings.FieldsFunc(fwd, func(c rune) bool { return c == ',' || c == ';' }) {
			k, v, ok := strings.Cut(strings.TrimSpace(elem), "=")
			if !ok || !strings.EqualFold(k, "for") {
				continue
			}
			v = strings.Trim(v, `"`)
			if ip, err := netip.ParseAddr(v); err == nil {
				return ip.String(), true
			}
			if ap, err := netip.ParseAddrPort(v); err == nil {
				return ap.Addr().String(), true
			}
			if strings.HasPrefix(v, "[") {
				if ip, err := netip.ParseAddr(strings.Trim(v, "[]")); err == nil {
					return ip.String(), true
				}
			}
		}
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		if ip, err := netip.ParseAddr(host); err == nil {
			return ip.String(), true
		}
	}
	return "", false
}
