package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/crypto/argon2"
)

// The Rust argon2 crate's Argon2::default(): argon2id, version 0x13, 19 MiB, two
// passes, one lane, a 32 byte output and a 16 byte salt. Hashes are PHC strings:
//
//	$argon2id$v=19$m=19456,t=2,p=1$<salt, base64 unpadded>$<hash, base64 unpadded>
const (
	argonMemory  = 19456
	argonTime    = 2
	argonThreads = 1
	argonKeyLen  = 32
	argonSaltLen = 16
)

var b64 = base64.RawStdEncoding

// HashPassword returns a PHC string the Rust API can verify, and vice versa.
func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		argonMemory, argonTime, argonThreads, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

// VerifyPassword checks password against a PHC string, using the parameters the hash
// records rather than the current defaults, as password-hash's verifier did. A hash
// that cannot be parsed simply does not verify.
func VerifyPassword(password, phc string) bool {
	p, err := parsePHC(phc)
	if err != nil {
		return false
	}
	var key []byte
	switch p.algorithm {
	case "argon2id":
		key = argon2.IDKey([]byte(password), p.salt, p.time, p.memory, p.threads, uint32(len(p.hash)))
	case "argon2i":
		key = argon2.Key([]byte(password), p.salt, p.time, p.memory, p.threads, uint32(len(p.hash)))
	default:
		return false
	}
	return subtle.ConstantTimeCompare(key, p.hash) == 1
}

var (
	padOnce sync.Once
	pad     string
)

// VerifyDummy spends one verification against a fixed hash, so a login for an account
// that does not exist costs the same argon2 work as one that does and timing does not
// reveal which accounts exist. Best effort: if the pad cannot be built, it skips.
func VerifyDummy(password string) {
	padOnce.Do(func() {
		pad, _ = HashPassword("dynavolt-timing-pad")
	})
	if pad != "" {
		VerifyPassword(password, pad)
	}
}

type phc struct {
	algorithm    string
	memory, time uint32
	threads      uint8
	salt, hash   []byte
}

var errPHC = errors.New("malformed PHC string")

func parsePHC(s string) (phc, error) {
	// "", algorithm, [v=19], params, salt, hash
	fields := strings.Split(s, "$")
	if len(fields) < 5 || fields[0] != "" {
		return phc{}, errPHC
	}
	p := phc{algorithm: fields[1]}
	rest := fields[2:]

	if v, ok := strings.CutPrefix(rest[0], "v="); ok {
		if v != "19" {
			return phc{}, errPHC // x/crypto implements only version 0x13
		}
		rest = rest[1:]
	}
	if len(rest) != 3 {
		return phc{}, errPHC
	}

	var haveM, haveT, haveP bool
	for _, kv := range strings.Split(rest[0], ",") {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			return phc{}, errPHC
		}
		n, err := strconv.ParseUint(v, 10, 32)
		if err != nil {
			return phc{}, errPHC
		}
		switch k {
		case "m":
			p.memory, haveM = uint32(n), true
		case "t":
			p.time, haveT = uint32(n), true
		case "p":
			if n == 0 || n > 255 {
				return phc{}, errPHC
			}
			p.threads, haveP = uint8(n), true
		default:
			return phc{}, errPHC // keyid/data are not supported
		}
	}
	if !haveM || !haveT || !haveP || p.time == 0 {
		return phc{}, errPHC
	}

	var err error
	if p.salt, err = b64.DecodeString(rest[1]); err != nil {
		return phc{}, errPHC
	}
	if p.hash, err = b64.DecodeString(rest[2]); err != nil || len(p.hash) < 4 {
		return phc{}, errPHC
	}
	return p, nil
}
