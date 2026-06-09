package bot

const (
	Username    = "ak_ai_assistant"
	DisplayName = "AK AI Assistant"
	AvatarSeed  = "ak-ai-assistant"
)

func IsBotUsername(username string) bool {
	return username == Username
}
