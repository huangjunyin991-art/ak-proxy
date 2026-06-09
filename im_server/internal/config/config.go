package config

import (
	"os"
	"strconv"
)

type Config struct {
	Addr                       string
	DatabaseURL                string
	CookieName                 string
	AllowedOrigin              string
	CompressMinBytes           int
	EmojiSourceDir             string
	EmojiStoreDir              string
	VoiceStoreDir              string
	ImageStoreDir              string
	FileStoreDir               string
	VideoStoreDir              string
	NotifyCenterEnabled        bool
	NotifyCenterWebhookURL     string
	NotifyCenterWebhookSecret  string
	NotifyCenterTimeoutMS      int
	NotifyCenterIdentitySecret string
	NotifyCenterIdentityCookie string
	AllowUnsignedIdentity      bool
	WsTicketTTLSeconds         int
	AISecretKey                string
	AIProviderTimeoutMS        int
	AIWorkerConcurrency        int
}

func Load() Config {
	notifyEnabled := getEnvBool("IM_NOTIFY_CENTER_ENABLED", getEnvBool("NOTIFY_CENTER_ENABLED", false))
	notifySecret := getEnv("IM_NOTIFY_CENTER_WEBHOOK_SECRET", getEnv("NOTIFY_CENTER_INTERNAL_SECRET", ""))
	identitySecret := getEnv("NOTIFY_CENTER_IDENTITY_SECRET", getEnv("NOTIFY_CENTER_INTERNAL_SECRET", notifySecret))
	return Config{
		Addr:                       getEnv("IM_ADDR", "127.0.0.1:18081"),
		DatabaseURL:                getEnv("IM_DATABASE_URL", ""),
		CookieName:                 getEnv("IM_AUTH_COOKIE", "ak_username"),
		AllowedOrigin:              getEnv("IM_ALLOWED_ORIGIN", ""),
		CompressMinBytes:           1024,
		EmojiSourceDir:             getEnv("IM_EMOJI_SOURCE_DIR", "./imageSource"),
		EmojiStoreDir:              getEnv("IM_EMOJI_STORE_DIR", "./data/im/emoji_assets"),
		VoiceStoreDir:              getEnv("IM_VOICE_STORE_DIR", "./data/im/voice_assets"),
		ImageStoreDir:              getEnv("IM_IMAGE_STORE_DIR", "./data/im/image_assets"),
		FileStoreDir:               getEnv("IM_FILE_STORE_DIR", "./data/im/file_assets"),
		VideoStoreDir:              getEnv("IM_VIDEO_STORE_DIR", "./data/im/video_assets"),
		NotifyCenterEnabled:        notifyEnabled,
		NotifyCenterWebhookURL:     getEnv("IM_NOTIFY_CENTER_WEBHOOK_URL", getEnv("NOTIFY_CENTER_WEBHOOK_URL", "http://127.0.0.1:8080/internal/notify-center/im-message")),
		NotifyCenterWebhookSecret:  notifySecret,
		NotifyCenterTimeoutMS:      getEnvInt("IM_NOTIFY_CENTER_TIMEOUT_MS", 1500),
		NotifyCenterIdentitySecret: identitySecret,
		NotifyCenterIdentityCookie: getEnv("NOTIFY_CENTER_IDENTITY_COOKIE", "ak_notify_identity"),
		AllowUnsignedIdentity:      getEnvBool("IM_ALLOW_UNSIGNED_IDENTITY", false),
		WsTicketTTLSeconds:         getEnvInt("WS_TICKET_TTL_SECONDS", 45),
		AISecretKey:                getEnv("IM_AI_SECRET_KEY", ""),
		AIProviderTimeoutMS:        getEnvInt("IM_AI_PROVIDER_TIMEOUT_MS", 60000),
		AIWorkerConcurrency:        getEnvInt("IM_AI_WORKER_CONCURRENCY", 3),
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
