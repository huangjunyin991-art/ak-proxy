package billing

import (
	"math"
	"strings"
)

type ChargeStrategy interface {
	Mode() string
	Calculate(cfg Config, item Settlement) int64
	Estimate(cfg Config) int64
}

type perRequestChargeStrategy struct{}

func (perRequestChargeStrategy) Mode() string {
	return ChargeModePerRequest
}

func (perRequestChargeStrategy) Calculate(cfg Config, _ Settlement) int64 {
	charge := cfg.UserUnitsPerRequest
	if charge <= 0 {
		charge = defaultConfig().UserUnitsPerRequest
	}
	return charge
}

func (s perRequestChargeStrategy) Estimate(cfg Config) int64 {
	return s.Calculate(cfg, Settlement{})
}

type perTokenChargeStrategy struct{}

func (perTokenChargeStrategy) Mode() string {
	return ChargeModePerToken
}

func (perTokenChargeStrategy) Calculate(cfg Config, item Settlement) int64 {
	tokens := item.TotalTokens
	if tokens <= 0 {
		tokens = item.EstimatedTokens
	}
	charge := int64(0)
	if tokens > 0 {
		charge = int64(math.Ceil((float64(tokens) / 1000) * cfg.UserUnitsPer1KTokens * cfg.DefaultMarkup))
	}
	if cfg.MinimumChargeUnits > 0 && charge < cfg.MinimumChargeUnits {
		charge = cfg.MinimumChargeUnits
	}
	return charge
}

func (perTokenChargeStrategy) Estimate(cfg Config) int64 {
	if cfg.MinimumChargeUnits > 0 {
		return cfg.MinimumChargeUnits
	}
	return 0
}

func chargeStrategyFor(cfg Config) ChargeStrategy {
	switch normalizeChargeMode(cfg.DeductionMode) {
	case ChargeModePerToken:
		return perTokenChargeStrategy{}
	default:
		return perRequestChargeStrategy{}
	}
}

func calculateChargeUnits(cfg Config, item Settlement) int64 {
	return chargeStrategyFor(cfg).Calculate(cfg, item)
}

func estimateNextChargeUnits(cfg Config) int64 {
	return chargeStrategyFor(cfg).Estimate(cfg)
}

func normalizeChargeMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "request", "per_request", "per-request", "by_request":
		return ChargeModePerRequest
	case "token", "tokens", "per_token", "per-token", "per_1k_tokens", "by_token":
		return ChargeModePerToken
	default:
		return ChargeModePerRequest
	}
}
