package app

import (
	"log"
	"net"
	"net/http"
	"strings"
)

func isLoopbackRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err != nil {
		host = strings.TrimSpace(r.RemoteAddr)
	}
	host = strings.Trim(host, "[]")
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (a *App) withInternalRequestGuard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackRequest(r) {
			log.Printf("im internal request rejected: path=%s remote=%s", r.URL.Path, r.RemoteAddr)
			writeJSON(w, http.StatusForbidden, map[string]any{"error": true, "message": "forbidden"})
			return
		}
		next(w, r)
	}
}
