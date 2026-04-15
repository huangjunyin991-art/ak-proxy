package main

import (
	"log"

	"im_server/internal/app"
	"im_server/internal/config"
)

func main() {
	cfg := config.Load()
	server, err := app.New(cfg)
	if err != nil {
		log.Fatalf("create im server failed: %v", err)
	}
	if err := server.Run(); err != nil {
		log.Fatalf("run im server failed: %v", err)
	}
}
