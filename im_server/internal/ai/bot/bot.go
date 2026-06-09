package bot

const (
	Username    = "ak_ai_assistant"
	DisplayName = "小A"
	AvatarSeed  = "ak-ai-assistant"
)

func IsBotUsername(username string) bool {
	return username == Username
}
