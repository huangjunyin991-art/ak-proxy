package app

import (
	"encoding/json"
	"math"
	"strings"
)

type locationMessagePayload struct {
	Latitude   float64 `json:"latitude"`
	Longitude  float64 `json:"longitude"`
	Name       string  `json:"name,omitempty"`
	Address    string  `json:"address,omitempty"`
	Provider   string  `json:"provider,omitempty"`
	Coordinate string  `json:"coordinate,omitempty"`
}

func normalizeLocationMessagePayload(raw string) (locationMessagePayload, error) {
	normalizedRaw := strings.TrimSpace(raw)
	if normalizedRaw == "" {
		return locationMessagePayload{}, errInvalidLocationPayload
	}
	var payload locationMessagePayload
	if err := json.Unmarshal([]byte(normalizedRaw), &payload); err != nil {
		return locationMessagePayload{}, errInvalidLocationPayload
	}
	if !isValidLocationLatitude(payload.Latitude) || !isValidLocationLongitude(payload.Longitude) {
		return locationMessagePayload{}, errInvalidLocationPayload
	}
	payload.Latitude = roundLocationCoordinate(payload.Latitude)
	payload.Longitude = roundLocationCoordinate(payload.Longitude)
	payload.Name = sanitizeLocationText(payload.Name, "位置", 48)
	payload.Address = sanitizeLocationText(payload.Address, "", 120)
	payload.Provider = sanitizeLocationText(payload.Provider, "amap", 16)
	payload.Coordinate = normalizeLocationCoordinate(payload.Coordinate)
	return payload, nil
}

func isValidLocationLatitude(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= -90 && value <= 90
}

func isValidLocationLongitude(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= -180 && value <= 180
}

func roundLocationCoordinate(value float64) float64 {
	return math.Round(value*1e6) / 1e6
}

func sanitizeLocationText(value string, fallback string, limit int) string {
	normalized := strings.TrimSpace(value)
	if normalized == "" {
		normalized = fallback
	}
	if limit > 0 {
		runes := []rune(normalized)
		if len(runes) > limit {
			normalized = string(runes[:limit])
		}
	}
	return strings.TrimSpace(normalized)
}

func normalizeLocationCoordinate(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "gaode":
		return "gaode"
	case "wgs84":
		return "wgs84"
	default:
		return "gaode"
	}
}

func formatLocationMessagePreview(payload locationMessagePayload) string {
	label := strings.TrimSpace(payload.Name)
	if label == "" || label == "位置" {
		label = strings.TrimSpace(payload.Address)
	}
	label = sanitizeLocationText(label, "", 32)
	if label == "" {
		return "[位置]"
	}
	return "[位置] " + label
}
