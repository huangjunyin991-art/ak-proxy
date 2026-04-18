package config

import "os"

type Config struct {
	Addr             string
	DatabaseURL      string
	CookieName       string
	AllowedOrigin    string
	CompressMinBytes int
	EmojiSourceDir   string
	EmojiStoreDir    string
}

func Load() Config {
	return Config{
		Addr:             getEnv("IM_ADDR", ":18081"),
		DatabaseURL:      getEnv("IM_DATABASE_URL", "postgres://ak_proxy:ak2026db@127.0.0.1:5432/ak_proxy?sslmode=disable"),
		CookieName:       getEnv("IM_AUTH_COOKIE", "ak_username"),
		AllowedOrigin:    getEnv("IM_ALLOWED_ORIGIN", "https://ak2025.vip"),
		CompressMinBytes: 1024,
		EmojiSourceDir:   getEnv("IM_EMOJI_SOURCE_DIR", "./imageSource"),
		EmojiStoreDir:    getEnv("IM_EMOJI_STORE_DIR", "./data/im/emoji_assets"),
	}
}

func getEnv(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}
