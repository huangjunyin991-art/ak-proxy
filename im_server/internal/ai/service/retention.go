package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	taskRetentionPolicyKey = "task_retention_policy"
	taskRetentionStatusKey = "task_retention_status"

	defaultTaskRetentionDays              = 30
	defaultTaskCleanupIntervalHours       = 24
	defaultTaskCleanupBatchLimit          = 1000
	minTaskRetentionDays                  = 1
	maxTaskRetentionDays                  = 3650
	minTaskCleanupIntervalHours           = 1
	maxTaskCleanupIntervalHours           = 168
	minTaskCleanupBatchLimit              = 50
	maxTaskCleanupBatchLimit              = 10000
	taskRetentionCleanupLockID      int64 = 9372026061101
)

type TaskRetentionPolicy struct {
	Enabled              bool `json:"enabled"`
	RetentionDays        int  `json:"retention_days"`
	CleanupIntervalHours int  `json:"cleanup_interval_hours"`
	BatchLimit           int  `json:"batch_limit"`
}

type TaskRetentionStatus struct {
	Policy                      TaskRetentionPolicy `json:"policy"`
	LastRunAt                   *time.Time          `json:"last_run_at,omitempty"`
	LastFinishedAt              *time.Time          `json:"last_finished_at,omitempty"`
	NextRunAt                   *time.Time          `json:"next_run_at,omitempty"`
	LastDurationMs              int64               `json:"last_duration_ms"`
	LastDeletedTasks            int64               `json:"last_deleted_tasks"`
	LastDeletedRequestLogs      int64               `json:"last_deleted_request_logs"`
	LastDeletedReplySuggestions int64               `json:"last_deleted_reply_suggestions"`
	LastCutoffAt                *time.Time          `json:"last_cutoff_at,omitempty"`
	LastSkipped                 bool                `json:"last_skipped"`
	LastMessage                 string              `json:"last_message,omitempty"`
	LastError                   string              `json:"last_error,omitempty"`
}

type TaskRetentionCleanupResult struct {
	Policy                  TaskRetentionPolicy `json:"policy"`
	StartedAt               time.Time           `json:"started_at"`
	FinishedAt              time.Time           `json:"finished_at"`
	DurationMs              int64               `json:"duration_ms"`
	CutoffAt                time.Time           `json:"cutoff_at"`
	DeletedTasks            int64               `json:"deleted_tasks"`
	DeletedRequestLogs      int64               `json:"deleted_request_logs"`
	DeletedReplySuggestions int64               `json:"deleted_reply_suggestions"`
	Skipped                 bool                `json:"skipped"`
	Message                 string              `json:"message,omitempty"`
}

type AITableStorageOverview struct {
	GeneratedAt  time.Time            `json:"generated_at"`
	TotalBytes   int64                `json:"total_bytes"`
	TotalPretty  string               `json:"total_pretty"`
	ExistingRows int                  `json:"existing_rows"`
	Items        []AITableStorageItem `json:"items"`
}

type AITableStorageItem struct {
	TableName   string `json:"table_name"`
	TotalBytes  int64  `json:"total_bytes"`
	HeapBytes   int64  `json:"heap_bytes"`
	IndexBytes  int64  `json:"index_bytes"`
	TotalPretty string `json:"total_pretty"`
	HeapPretty  string `json:"heap_pretty"`
	IndexPretty string `json:"index_pretty"`
	RowEstimate int64  `json:"row_estimate"`
}

func defaultTaskRetentionPolicy() TaskRetentionPolicy {
	return TaskRetentionPolicy{
		Enabled:              true,
		RetentionDays:        defaultTaskRetentionDays,
		CleanupIntervalHours: defaultTaskCleanupIntervalHours,
		BatchLimit:           defaultTaskCleanupBatchLimit,
	}
}

func normalizeTaskRetentionPolicy(policy TaskRetentionPolicy) TaskRetentionPolicy {
	defaults := defaultTaskRetentionPolicy()
	if policy.RetentionDays <= 0 {
		policy.RetentionDays = defaults.RetentionDays
	}
	if policy.RetentionDays < minTaskRetentionDays {
		policy.RetentionDays = minTaskRetentionDays
	}
	if policy.RetentionDays > maxTaskRetentionDays {
		policy.RetentionDays = maxTaskRetentionDays
	}
	if policy.CleanupIntervalHours <= 0 {
		policy.CleanupIntervalHours = defaults.CleanupIntervalHours
	}
	if policy.CleanupIntervalHours < minTaskCleanupIntervalHours {
		policy.CleanupIntervalHours = minTaskCleanupIntervalHours
	}
	if policy.CleanupIntervalHours > maxTaskCleanupIntervalHours {
		policy.CleanupIntervalHours = maxTaskCleanupIntervalHours
	}
	if policy.BatchLimit <= 0 {
		policy.BatchLimit = defaults.BatchLimit
	}
	if policy.BatchLimit < minTaskCleanupBatchLimit {
		policy.BatchLimit = minTaskCleanupBatchLimit
	}
	if policy.BatchLimit > maxTaskCleanupBatchLimit {
		policy.BatchLimit = maxTaskCleanupBatchLimit
	}
	return policy
}

func (s *Service) TaskRetentionPolicy(ctx context.Context) (TaskRetentionPolicy, error) {
	policy := defaultTaskRetentionPolicy()
	if s == nil || s.db == nil {
		return policy, nil
	}
	var raw []byte
	err := s.db.QueryRow(ctx, `
		SELECT value_json
		FROM im_ai_config
		WHERE key = $1`, taskRetentionPolicyKey).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return policy, nil
	}
	if err != nil {
		return TaskRetentionPolicy{}, err
	}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &policy)
	}
	return normalizeTaskRetentionPolicy(policy), nil
}

func (s *Service) SetTaskRetentionPolicy(ctx context.Context, policy TaskRetentionPolicy) (TaskRetentionPolicy, error) {
	if s == nil || s.db == nil {
		return TaskRetentionPolicy{}, errors.New("AI service is not available")
	}
	policy = normalizeTaskRetentionPolicy(policy)
	raw, _ := json.Marshal(policy)
	_, err := s.db.Exec(ctx, `
		INSERT INTO im_ai_config (key, value_json, updated_at)
		VALUES ($1, $2::jsonb, NOW())
		ON CONFLICT (key) DO UPDATE
		SET value_json = EXCLUDED.value_json,
		    updated_at = NOW()`, taskRetentionPolicyKey, string(raw))
	if err != nil {
		return TaskRetentionPolicy{}, err
	}
	return policy, nil
}

func (s *Service) TaskRetentionStatus(ctx context.Context) (TaskRetentionStatus, error) {
	policy, err := s.TaskRetentionPolicy(ctx)
	if err != nil {
		return TaskRetentionStatus{}, err
	}
	status := TaskRetentionStatus{Policy: policy}
	if s == nil || s.db == nil {
		return status, nil
	}
	var raw []byte
	err = s.db.QueryRow(ctx, `
		SELECT value_json
		FROM im_ai_cleanup_state
		WHERE key = $1`, taskRetentionStatusKey).Scan(&raw)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return TaskRetentionStatus{}, err
	}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &status)
		status.Policy = policy
	}
	status.NextRunAt = nextTaskRetentionRunAt(status.LastRunAt, policy)
	return status, nil
}

func nextTaskRetentionRunAt(lastRunAt *time.Time, policy TaskRetentionPolicy) *time.Time {
	if !policy.Enabled || lastRunAt == nil || lastRunAt.IsZero() {
		return nil
	}
	next := lastRunAt.Add(time.Duration(policy.CleanupIntervalHours) * time.Hour)
	return &next
}

func (s *Service) RunTaskRetentionCleanupIfDue(ctx context.Context) (TaskRetentionCleanupResult, error) {
	policy, err := s.TaskRetentionPolicy(ctx)
	if err != nil {
		return TaskRetentionCleanupResult{}, err
	}
	result := TaskRetentionCleanupResult{
		Policy:    policy,
		StartedAt: time.Now(),
		Skipped:   true,
	}
	if !policy.Enabled {
		result.Message = "AI 诊断保留策略已关闭"
		result.FinishedAt = time.Now()
		return result, nil
	}
	status, err := s.TaskRetentionStatus(ctx)
	if err != nil {
		return TaskRetentionCleanupResult{}, err
	}
	if status.LastRunAt != nil {
		next := status.LastRunAt.Add(time.Duration(policy.CleanupIntervalHours) * time.Hour)
		if time.Now().Before(next) {
			result.Message = "未到下一次清理时间"
			result.FinishedAt = time.Now()
			return result, nil
		}
	}
	return s.RunTaskRetentionCleanup(ctx)
}

func (s *Service) RunTaskRetentionCleanup(ctx context.Context) (TaskRetentionCleanupResult, error) {
	if s == nil || s.db == nil {
		return TaskRetentionCleanupResult{}, errors.New("AI service is not available")
	}
	policy, err := s.TaskRetentionPolicy(ctx)
	if err != nil {
		return TaskRetentionCleanupResult{}, err
	}
	startedAt := time.Now()
	result := TaskRetentionCleanupResult{
		Policy:    policy,
		StartedAt: startedAt,
		CutoffAt:  startedAt.AddDate(0, 0, -policy.RetentionDays),
	}
	if !policy.Enabled {
		result.Skipped = true
		result.Message = "AI 诊断保留策略已关闭"
		result.FinishedAt = time.Now()
		result.DurationMs = int64(result.FinishedAt.Sub(result.StartedAt).Milliseconds())
		_ = s.saveTaskRetentionStatus(ctx, statusFromRetentionResult(result, ""))
		return result, nil
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return TaskRetentionCleanupResult{}, err
	}
	defer tx.Rollback(ctx)
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, taskRetentionCleanupLockID).Scan(&locked); err != nil {
		return TaskRetentionCleanupResult{}, err
	}
	if !locked {
		result.Skipped = true
		result.Message = "已有清理任务正在执行"
		result.FinishedAt = time.Now()
		result.DurationMs = int64(result.FinishedAt.Sub(result.StartedAt).Milliseconds())
		return result, nil
	}
	taskIDs, err := loadExpiredTaskIDs(ctx, tx, result.CutoffAt, policy.BatchLimit)
	if err != nil {
		return TaskRetentionCleanupResult{}, err
	}
	if len(taskIDs) > 0 {
		tag, err := tx.Exec(ctx, `
			DELETE FROM im_ai_reply_suggestion
			WHERE task_id = ANY($1::text[])`, taskIDs)
		if err != nil {
			return TaskRetentionCleanupResult{}, err
		}
		result.DeletedReplySuggestions += tag.RowsAffected()
		tag, err = tx.Exec(ctx, `
			DELETE FROM im_ai_request_log
			WHERE task_id = ANY($1::text[])`, taskIDs)
		if err != nil {
			return TaskRetentionCleanupResult{}, err
		}
		result.DeletedRequestLogs += tag.RowsAffected()
		tag, err = tx.Exec(ctx, `
			DELETE FROM im_ai_task
			WHERE task_id = ANY($1::text[])`, taskIDs)
		if err != nil {
			return TaskRetentionCleanupResult{}, err
		}
		result.DeletedTasks = tag.RowsAffected()
	}
	tag, err := tx.Exec(ctx, `
		DELETE FROM im_ai_request_log
		WHERE ctid IN (
			SELECT l.ctid
			FROM im_ai_request_log l
			WHERE l.created_at < $1
			  AND (l.task_id = '' OR NOT EXISTS (
			      SELECT 1 FROM im_ai_task t WHERE t.task_id = l.task_id
			  ))
			ORDER BY l.created_at ASC, l.id ASC
			LIMIT $2
		)`, result.CutoffAt, policy.BatchLimit)
	if err != nil {
		return TaskRetentionCleanupResult{}, err
	}
	result.DeletedRequestLogs += tag.RowsAffected()
	tag, err = tx.Exec(ctx, `
		DELETE FROM im_ai_reply_suggestion
		WHERE ctid IN (
			SELECT s.ctid
			FROM im_ai_reply_suggestion s
			WHERE s.created_at < $1
			  AND (s.task_id = '' OR NOT EXISTS (
			      SELECT 1 FROM im_ai_task t WHERE t.task_id = s.task_id
			  ))
			ORDER BY s.created_at ASC, s.message_id ASC
			LIMIT $2
		)`, result.CutoffAt, policy.BatchLimit)
	if err != nil {
		return TaskRetentionCleanupResult{}, err
	}
	result.DeletedReplySuggestions += tag.RowsAffected()
	result.FinishedAt = time.Now()
	result.DurationMs = int64(result.FinishedAt.Sub(result.StartedAt).Milliseconds())
	if err := saveTaskRetentionStatusTx(ctx, tx, statusFromRetentionResult(result, "")); err != nil {
		return TaskRetentionCleanupResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TaskRetentionCleanupResult{}, err
	}
	return result, nil
}

type retentionTx interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func loadExpiredTaskIDs(ctx context.Context, tx retentionTx, cutoff time.Time, limit int) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT task_id
		FROM im_ai_task
		WHERE status IN ($1, $2)
		  AND finished_at IS NOT NULL
		  AND finished_at < $3
		ORDER BY finished_at ASC, created_at ASC
		LIMIT $4`, taskStatusSucceeded, taskStatusFailed, cutoff, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	taskIDs := make([]string, 0, limit)
	for rows.Next() {
		var taskID string
		if err := rows.Scan(&taskID); err != nil {
			return nil, err
		}
		taskID = strings.TrimSpace(taskID)
		if taskID != "" {
			taskIDs = append(taskIDs, taskID)
		}
	}
	return taskIDs, rows.Err()
}

func statusFromRetentionResult(result TaskRetentionCleanupResult, errorText string) TaskRetentionStatus {
	lastRunAt := result.StartedAt
	lastFinishedAt := result.FinishedAt
	lastCutoffAt := result.CutoffAt
	status := TaskRetentionStatus{
		Policy:                      result.Policy,
		LastRunAt:                   &lastRunAt,
		LastFinishedAt:              &lastFinishedAt,
		LastDurationMs:              result.DurationMs,
		LastDeletedTasks:            result.DeletedTasks,
		LastDeletedRequestLogs:      result.DeletedRequestLogs,
		LastDeletedReplySuggestions: result.DeletedReplySuggestions,
		LastCutoffAt:                &lastCutoffAt,
		LastSkipped:                 result.Skipped,
		LastMessage:                 result.Message,
		LastError:                   strings.TrimSpace(errorText),
	}
	status.NextRunAt = nextTaskRetentionRunAt(status.LastRunAt, status.Policy)
	return status
}

func (s *Service) saveTaskRetentionStatus(ctx context.Context, status TaskRetentionStatus) error {
	if s == nil || s.db == nil {
		return errors.New("AI service is not available")
	}
	raw, _ := json.Marshal(status)
	_, err := s.db.Exec(ctx, `
		INSERT INTO im_ai_cleanup_state (key, value_json, updated_at)
		VALUES ($1, $2::jsonb, NOW())
		ON CONFLICT (key) DO UPDATE
		SET value_json = EXCLUDED.value_json,
		    updated_at = NOW()`, taskRetentionStatusKey, string(raw))
	return err
}

func saveTaskRetentionStatusTx(ctx context.Context, tx retentionTx, status TaskRetentionStatus) error {
	raw, _ := json.Marshal(status)
	_, err := tx.Exec(ctx, `
		INSERT INTO im_ai_cleanup_state (key, value_json, updated_at)
		VALUES ($1, $2::jsonb, NOW())
		ON CONFLICT (key) DO UPDATE
		SET value_json = EXCLUDED.value_json,
		    updated_at = NOW()`, taskRetentionStatusKey, string(raw))
	return err
}

func (s *Service) AITableStorage(ctx context.Context) (AITableStorageOverview, error) {
	if s == nil || s.db == nil {
		return AITableStorageOverview{}, errors.New("AI service is not available")
	}
	rows, err := s.db.Query(ctx, `
		SELECT c.relname,
		       pg_total_relation_size(c.oid)::bigint AS total_bytes,
		       pg_relation_size(c.oid)::bigint AS heap_bytes,
		       pg_indexes_size(c.oid)::bigint AS index_bytes,
		       GREATEST(c.reltuples::bigint, 0)::bigint AS row_estimate
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public'
		  AND c.relkind IN ('r', 'p')
		  AND c.relname LIKE 'im_ai_%'
		ORDER BY pg_total_relation_size(c.oid) DESC, c.relname ASC`)
	if err != nil {
		return AITableStorageOverview{}, err
	}
	defer rows.Close()
	overview := AITableStorageOverview{
		GeneratedAt: time.Now(),
		Items:       []AITableStorageItem{},
	}
	for rows.Next() {
		var item AITableStorageItem
		if err := rows.Scan(&item.TableName, &item.TotalBytes, &item.HeapBytes, &item.IndexBytes, &item.RowEstimate); err != nil {
			return AITableStorageOverview{}, err
		}
		item.TotalPretty = formatBytes(item.TotalBytes)
		item.HeapPretty = formatBytes(item.HeapBytes)
		item.IndexPretty = formatBytes(item.IndexBytes)
		overview.TotalBytes += item.TotalBytes
		overview.Items = append(overview.Items, item)
	}
	if err := rows.Err(); err != nil {
		return AITableStorageOverview{}, err
	}
	overview.ExistingRows = len(overview.Items)
	overview.TotalPretty = formatBytes(overview.TotalBytes)
	return overview, nil
}

func formatBytes(value int64) string {
	if value < 0 {
		value = 0
	}
	units := []string{"B", "KB", "MB", "GB", "TB"}
	size := float64(value)
	unit := 0
	for size >= 1024 && unit < len(units)-1 {
		size /= 1024
		unit++
	}
	if unit == 0 {
		return fmt.Sprintf("%d %s", value, units[unit])
	}
	if size >= 100 {
		return fmt.Sprintf("%.0f %s", size, units[unit])
	}
	return fmt.Sprintf("%.1f %s", size, units[unit])
}
