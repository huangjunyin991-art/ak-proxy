package preview

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type VipsGenerator struct {
	LongEdge int
}

func (g VipsGenerator) EnsureAvailable() error {
	_, err := findVipsCommand()
	return err
}

func (g VipsGenerator) Generate(ctx context.Context, sourcePath string, outputPath string) error {
	longEdge := g.LongEdge
	if longEdge <= 0 {
		longEdge = 1920
	}
	commandName, err := findVipsCommand()
	if err != nil {
		return err
	}
	if filepath.Base(commandName) == "vipsthumbnail" || strings.EqualFold(filepath.Base(commandName), "vipsthumbnail") {
		cmd := exec.CommandContext(ctx, commandName, sourcePath, "--size", strconv.Itoa(longEdge)+"x"+strconv.Itoa(longEdge), "--output", outputPath)
		cmd.Env = constrainedVipsEnv(cmd)
		return cmd.Run()
	}
	cmd := exec.CommandContext(ctx, commandName, "thumbnail", sourcePath, outputPath, strconv.Itoa(longEdge), "--size", "down")
	cmd.Env = constrainedVipsEnv(cmd)
	return cmd.Run()
}

func constrainedVipsEnv(cmd *exec.Cmd) []string {
	return append(cmd.Environ(),
		"VIPS_CONCURRENCY=1",
		"VIPS_CACHE_MAX=0",
		"VIPS_CACHE_MAX_MEM=0",
		"VIPS_CACHE_MAX_FILES=0",
		"G_DEBUG=gc-friendly",
		"G_SLICE=always-malloc",
		"MALLOC_ARENA_MAX=1",
		"MALLOC_TRIM_THRESHOLD_=131072",
	)
}

func findVipsCommand() (string, error) {
	if path, err := exec.LookPath("vipsthumbnail"); err == nil {
		return path, nil
	}
	if path, err := exec.LookPath("vips"); err == nil {
		return path, nil
	}
	return "", errors.New("libvips command not found")
}
