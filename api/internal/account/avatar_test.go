package account

import (
	"bytes"
	"encoding/base64"
	"testing"
)

var (
	webpBytes = append([]byte("RIFF\x24\x00\x00\x00WEBPVP8 "), bytes.Repeat([]byte{1}, 20)...)
	jpegBytes = append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, bytes.Repeat([]byte{2}, 20)...)
	pngBytes  = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{3}, 20)...)
)

func dataURL(mime string, b []byte) string {
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(b)
}

func TestValidAvatar(t *testing.T) {
	sized := func(magic []byte, n int) []byte {
		return append(append([]byte{}, magic...), make([]byte, n-len(magic))...)
	}

	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"webp", dataURL("image/webp", webpBytes), true},
		{"jpeg", dataURL("image/jpeg", jpegBytes), true},
		{"png", dataURL("image/png", pngBytes), true},
		{"exactly 100 KB", dataURL("image/jpeg", sized(jpegBytes, 100<<10)), true},
		{"one byte over 100 KB", dataURL("image/jpeg", sized(jpegBytes, 100<<10+1)), false},
		{"gif not allowed", dataURL("image/gif", []byte("GIF89a")), false},
		{"no data prefix", base64.StdEncoding.EncodeToString(pngBytes), false},
		{"prefix case matters", "DATA:image/png;base64," + base64.StdEncoding.EncodeToString(pngBytes), false},
		{"not base64", "data:image/png;base64,***not base64***", false},
		{"url-safe alphabet rejected", "data:image/png;base64,-_-_", false},
		{"png declared, jpeg bytes", dataURL("image/png", jpegBytes), false},
		{"webp declared, riff but not webp", dataURL("image/webp", []byte("RIFF\x24\x00\x00\x00WAVEfmt ")), false},
		{"jpeg declared, too short", dataURL("image/jpeg", []byte{0xFF, 0xD8}), false},
		{"empty payload", "data:image/webp;base64,", false},
		{"empty string", "", false},
	}
	for _, c := range cases {
		if got := validAvatar(c.in); got != c.want {
			t.Errorf("%s: validAvatar = %v, want %v", c.name, got, c.want)
		}
	}
}
