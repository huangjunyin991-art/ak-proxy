package config

import (
	"os"
	"strconv"
)

type Config struct {
	Addr                      string
	DatabaseURL               string
	CookieName                string
	AllowedOrigin             string
	CompressMinBytes          int
	EmojiSourceDir            string
	EmojiStoreDir             string
	VoiceStoreDir             string
	ImageStoreDir             string
	FileStoreDir              string
	VideoStoreDir             string
	NotifyCenterEnabled       bool
	NotifyCenterWebhookURL    string
	NotifyCenterWebhookSecret string
	NotifyCenterTimeoutMS     int
}

func Load() Config {
	return Config{
		Addr:                      getEnv("IM_ADDR", "127.0.0.1:18081"),
		DatabaseURL:               getEnv("IM_DATABASE_URL", ""),
		CookieName:                getEnv("IM_AUTH_COOKIE", "ak_username"),
		AllowedOrigin:             getEnv("IM_ALLOWED_ORIGIN", ""),
		CompressMinBytes:          1024,
		EmojiSourceDir:            getEnv("IM_EMOJI_SOURCE_DIR", "./imageSource"),
		EmojiStoreDir:             getEnv("IM_EMOJI_STORE_DIR", "./data/im/emoji_assets"),
		VoiceStoreDir:             getEnv("IM_VOICE_STORE_DIR", "./data/im/voice_assets"),
		ImageStoreDir:             getEnv("IM_IMAGE_STORE_DIR", "./data/im/image_assets"),
		FileStoreDir:              getEnv("IM_FILE_STORE_DIR", "./data/im/file_assets"),
		VideoStoreDir:             getEnv("IM_VIDEO_STORE_DIR", "./data/im/video_assets"),
		NotifyCenterEnabled:       getEnvBool("IM_NOTIFY_CENTER_ENABLED", false),
		NotifyCenterWebhookURL:    getEnv("IM_NOTIFY_CENTER_WEBHOOK_URL", ""),
		NotifyCenterWebhookSecret: getEnv("IM_NOTIFY_CENTER_WEBHOOK_SECRET", ""),
		NotifyCenterTimeoutMS:     getEnvInt("IM_NOTIFY_CENTER_TIMEOUT_MS", 1500),
	}
}

func getEnv(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func getEnvBool(key string, fallback bool) bool {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	switch value {
	case "1", "true", "TRUE", "yes", "YES", "on", "ON", "enabled", "ENABLED":
		return true
	default:
		return false
	}
}

func getEnvInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}
