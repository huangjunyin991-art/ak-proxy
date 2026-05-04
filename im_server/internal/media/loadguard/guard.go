package loadguard

import (
	"errors"
	"math"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	defaultReserveCPUPercent      = 50
	defaultMemoryHighWaterPercent = 75
	defaultMinAvailableBytes      = 512 * 1024 * 1024
)

type Config struct {
	ReserveCPUPercent      int
	MemoryHighWaterPercent int
	MinAvailableBytes      uint64
	MaxConcurrency         int
}

type Guard struct {
	config   Config
	previous cpuTimes
}

type Snapshot struct {
	LogicalCPUs          int
	CPUUsagePercent      float64
	MemoryUsagePercent   float64
	AvailableMemoryBytes uint64
	AllowedSlots         int
	BlockedReason        string
	SampledAt            time.Time
}

type cpuTimes struct {
	Idle  uint64
	Total uint64
}

func New(config Config) *Guard {
	if config.ReserveCPUPercent <= 0 || config.ReserveCPUPercent >= 100 {
		config.ReserveCPUPercent = defaultReserveCPUPercent
	}
	if config.MemoryHighWaterPercent <= 0 || config.MemoryHighWaterPercent >= 100 {
		config.MemoryHighWaterPercent = defaultMemoryHighWaterPercent
	}
	if config.MinAvailableBytes == 0 {
		config.MinAvailableBytes = defaultMinAvailableBytes
	}
	return &Guard{config: config}
}

func (g *Guard) AllowedSlots(maxBatch int) Snapshot {
	if g == nil {
		g = New(Config{})
	}
	snapshot := Snapshot{
		LogicalCPUs:  runtime.NumCPU(),
		SampledAt:    time.Now(),
		AllowedSlots: 0,
	}
	if maxBatch <= 0 {
		snapshot.BlockedReason = "batch_limit"
		return snapshot
	}
	cpuUsage, cpuErr := g.sampleCPUUsage()
	if cpuErr == nil {
		snapshot.CPUUsagePercent = cpuUsage
	}
	memoryUsage, availableBytes, memoryErr := sampleMemoryUsage()
	if memoryErr == nil {
		snapshot.MemoryUsagePercent = memoryUsage
		snapshot.AvailableMemoryBytes = availableBytes
	}
	usableCPUPercent := 100 - g.config.ReserveCPUPercent
	if cpuErr == nil && snapshot.CPUUsagePercent >= float64(usableCPUPercent) {
		snapshot.BlockedReason = "cpu_busy"
		return snapshot
	}
	if memoryErr == nil && snapshot.MemoryUsagePercent >= float64(g.config.MemoryHighWaterPercent) {
		snapshot.BlockedReason = "memory_busy"
		return snapshot
	}
	if memoryErr == nil && snapshot.AvailableMemoryBytes < g.config.MinAvailableBytes {
		snapshot.BlockedReason = "memory_low"
		return snapshot
	}
	cpuSlots := int(math.Floor(float64(maxInt(1, snapshot.LogicalCPUs)) * float64(usableCPUPercent) / 100.0))
	if cpuSlots <= 0 {
		cpuSlots = 1
	}
	allowed := minInt(maxBatch, cpuSlots)
	if g.config.MaxConcurrency > 0 {
		allowed = minInt(allowed, g.config.MaxConcurrency)
	}
	if allowed <= 0 {
		snapshot.BlockedReason = "no_capacity"
		return snapshot
	}
	snapshot.AllowedSlots = allowed
	return snapshot
}

func (g *Guard) sampleCPUUsage() (float64, error) {
	current, err := readProcStatCPU()
	if err != nil {
		return 0, err
	}
	previous := g.previous
	g.previous = current
	if previous.Total == 0 || current.Total <= previous.Total {
		return 0, nil
	}
	totalDelta := current.Total - previous.Total
	idleDelta := current.Idle - previous.Idle
	if totalDelta == 0 || idleDelta > totalDelta {
		return 0, nil
	}
	return float64(totalDelta-idleDelta) * 100 / float64(totalDelta), nil
}

func readProcStatCPU() (cpuTimes, error) {
	content, err := os.ReadFile("/proc/stat")
	if err != nil {
		return cpuTimes{}, err
	}
	lines := strings.Split(string(content), "\n")
	if len(lines) == 0 || !strings.HasPrefix(lines[0], "cpu ") {
		return cpuTimes{}, errors.New("invalid proc stat")
	}
	fields := strings.Fields(lines[0])
	if len(fields) < 5 {
		return cpuTimes{}, errors.New("invalid cpu stat")
	}
	values := make([]uint64, 0, len(fields)-1)
	for _, field := range fields[1:] {
		value, err := strconv.ParseUint(field, 10, 64)
		if err != nil {
			return cpuTimes{}, err
		}
		values = append(values, value)
	}
	var total uint64
	for _, value := range values {
		total += value
	}
	idle := values[3]
	if len(values) > 4 {
		idle += values[4]
	}
	return cpuTimes{Idle: idle, Total: total}, nil
}

func sampleMemoryUsage() (float64, uint64, error) {
	content, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0, err
	}
	var totalKB uint64
	var availableKB uint64
	for _, line := range strings.Split(string(content), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch strings.TrimSuffix(fields[0], ":") {
		case "MemTotal":
			totalKB = value
		case "MemAvailable":
			availableKB = value
		}
	}
	if totalKB == 0 {
		return 0, 0, errors.New("missing memory total")
	}
	if availableKB > totalKB {
		availableKB = totalKB
	}
	availableBytes := availableKB * 1024
	usedPercent := float64(totalKB-availableKB) * 100 / float64(totalKB)
	return usedPercent, availableBytes, nil
}

func minInt(a int, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a int, b int) int {
	if a > b {
		return a
	}
	return b
}
