package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// TokenTTL is how long an issued token lasts.
const TokenTTL = 12 * time.Hour

// leeway is jsonwebtoken's default Validation leeway: a token is accepted up to a
// minute past its exp, so a Rust-issued token expires at the same moment here.
const leeway = 60 * time.Second

// header is exactly what jsonwebtoken's Header::default() serializes to, so a token
// minted here is byte-identical to one minted by the Rust API for the same claims.
var header = base64.RawURLEncoding.EncodeToString([]byte(`{"typ":"JWT","alg":"HS256"}`))

// Claims are the token's claims, in the Rust struct's field order: sub (the account
// id), role, exp (unix seconds).
type Claims struct {
	Sub  uuid.UUID `json:"sub"`
	Role Role      `json:"role"`
	Exp  int64     `json:"exp"`
}

// ErrInvalidToken is any reason a token is refused. The reason is deliberately not
// distinguished: the client is told 401 either way.
var ErrInvalidToken = errors.New("invalid token")

// EncodeToken mints an HS256 token for an account, valid for TokenTTL from now.
func EncodeToken(secret []byte, id uuid.UUID, role Role, now time.Time) (string, error) {
	return encodeClaims(secret, Claims{Sub: id, Role: role, Exp: now.Add(TokenTTL).Unix()})
}

func encodeClaims(secret []byte, c Claims) (string, error) {
	payload, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	signingInput := header + "." + base64.RawURLEncoding.EncodeToString(payload)
	return signingInput + "." + sign(secret, signingInput), nil
}

func sign(secret []byte, input string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(input))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// DecodeToken verifies a token the way jsonwebtoken's Validation::default() did: the
// header's alg must be HS256, the signature must match, exp is required and checked
// with a 60 s leeway, a token carrying aud is refused (no audience is configured), and
// the claims must decode (sub a uuid, role admin or user).
func DecodeToken(secret []byte, token string, now time.Time) (Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Claims{}, ErrInvalidToken
	}

	rawHeader, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	var h struct {
		Alg string `json:"alg"`
	}
	if json.Unmarshal(rawHeader, &h) != nil || h.Alg != "HS256" {
		return Claims{}, ErrInvalidToken
	}

	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return Claims{}, ErrInvalidToken
	}

	rawClaims, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Claims{}, ErrInvalidToken
	}

	var raw struct {
		Sub  *string         `json:"sub"`
		Role *string         `json:"role"`
		Exp  json.RawMessage `json:"exp"`
		Aud  json.RawMessage `json:"aud"`
	}
	if json.Unmarshal(rawClaims, &raw) != nil || raw.Exp == nil || raw.Sub == nil || raw.Role == nil || raw.Aud != nil {
		return Claims{}, ErrInvalidToken
	}
	// An integer literal only: serde refused a quoted or fractional exp.
	exp, err := strconv.ParseInt(string(raw.Exp), 10, 64)
	if err != nil || exp < now.Add(-leeway).Unix() {
		return Claims{}, ErrInvalidToken
	}
	sub, err := uuid.Parse(*raw.Sub)
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	role, err := ParseRole(*raw.Role)
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	return Claims{Sub: sub, Role: role, Exp: exp}, nil
}
