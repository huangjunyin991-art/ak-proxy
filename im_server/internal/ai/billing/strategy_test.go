package billing

import "testing"

func TestNormalizeConfigDefaultsToPerRequest(t *testing.T) {
	cfg := normalizeConfig(Config{})
	if cfg.DeductionMode != ChargeModePerRequest {
		t.Fatalf("DeductionMode = %q, want %q", cfg.DeductionMode, ChargeModePerRequest)
	}
	if cfg.UserUnitsPerRequest != 1 {
		t.Fatalf("UserUnitsPerRequest = %d, want 1", cfg.UserUnitsPerRequest)
	}
	got := calculateChargeUnits(cfg, Settlement{TotalTokens: 100000, EstimatedTokens: 100000})
	if got != 1 {
		t.Fatalf("per-request charge = %d, want 1", got)
	}
}

func TestPerRequestChargeIgnoresTokenSize(t *testing.T) {
	cfg := normalizeConfig(Config{
		DeductionMode:        ChargeModePerRequest,
		UserUnitsPerRequest:  3,
		UserUnitsPer1KTokens: 100,
		DefaultMarkup:        10,
		MinimumChargeUnits:   99,
	})
	got := calculateChargeUnits(cfg, Settlement{TotalTokens: 50000, EstimatedTokens: 50000})
	if got != 3 {
		t.Fatalf("per-request charge = %d, want 3", got)
	}
	if estimateNextChargeUnits(cfg) != 3 {
		t.Fatalf("per-request estimate = %d, want 3", estimateNextChargeUnits(cfg))
	}
}

func TestPerTokenChargePreservesTokenFormula(t *testing.T) {
	cfg := normalizeConfig(Config{
		DeductionMode:        ChargeModePerToken,
		UnitLabel:            "AI额度",
		UserUnitsPerRequest:  1,
		UserUnitsPer1KTokens: 2,
		DefaultMarkup:        1.5,
		MinimumChargeUnits:   1,
	})
	got := calculateChargeUnits(cfg, Settlement{TotalTokens: 1250})
	if got != 4 {
		t.Fatalf("per-token charge = %d, want 4", got)
	}
	got = calculateChargeUnits(cfg, Settlement{EstimatedTokens: 500})
	if got != 2 {
		t.Fatalf("per-token estimated charge = %d, want 2", got)
	}
	if estimateNextChargeUnits(cfg) != 1 {
		t.Fatalf("per-token estimate = %d, want 1", estimateNextChargeUnits(cfg))
	}
}
