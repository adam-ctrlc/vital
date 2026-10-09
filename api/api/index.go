// Package handler is the Vercel Go runtime entrypoint. vercel.json rewrites
// /api/v1/:path* here.
//
// It must not import internal/... directly: the runtime rewrites go.mod to
// "module handler" before building this file, and Go then rejects the internal import
// as coming from another module ("use of internal package ... not allowed"). The app is
// reached through the vercel package instead, which lives inside the module.
package handler

import (
	"net/http"

	"github.com/adam-ctrlc/vital/api/vercel"
)

// Handler serves every /api/v1 request.
func Handler(w http.ResponseWriter, r *http.Request) {
	vercel.Handler(w, r)
}
