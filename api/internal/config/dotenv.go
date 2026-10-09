package config

import (
	"bufio"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"
)

// LoadDotenv loads the first of paths that exists into the process environment,
// without overriding variables that are already set (as dotenvy does). It returns the
// path it loaded, or "" when none existed. Local development only: on Vercel the
// environment is set by the platform.
func LoadDotenv(paths ...string) (string, error) {
	for _, path := range paths {
		f, err := os.Open(path)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", fmt.Errorf("open %s: %w", path, err)
		}
		defer f.Close()

		vars, err := parseDotenv(bufio.NewScanner(f))
		if err != nil {
			return "", fmt.Errorf("parse %s: %w", path, err)
		}
		for k, v := range vars {
			if _, set := os.LookupEnv(k); !set {
				if err := os.Setenv(k, v); err != nil {
					return "", fmt.Errorf("set %s: %w", k, err)
				}
			}
		}
		return path, nil
	}
	return "", nil
}

// parseDotenv understands KEY=value, optional "export ", # comments, and single or
// double quoted values. No interpolation: none of this project's files use it.
func parseDotenv(sc *bufio.Scanner) (map[string]string, error) {
	vars := make(map[string]string)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("line %d: expected KEY=value", n)
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)

		switch {
		case len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"':
			value = strings.NewReplacer(`\n`, "\n", `\"`, `"`, `\\`, `\`).Replace(value[1 : len(value)-1])
		case len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'':
			value = value[1 : len(value)-1]
		default:
			// An unquoted value ends at an inline comment.
			if i := strings.Index(value, " #"); i >= 0 {
				value = strings.TrimSpace(value[:i])
			}
		}
		vars[key] = value
	}
	return vars, sc.Err()
}
