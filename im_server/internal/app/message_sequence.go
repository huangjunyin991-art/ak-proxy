package app

import (
	"context"

	"github.com/jackc/pgx/v5"
)

func (a *App) allocateMessageSeqNoTx(ctx context.Context, tx pgx.Tx, conversationID int64) (int64, error) {
	var nextSeqNo int64
	err := tx.QueryRow(ctx, `
		UPDATE im_conversation AS c
		SET last_seq_no = CASE
				WHEN COALESCE(c.last_seq_no, 0) > 0 THEN c.last_seq_no + 1
				ELSE COALESCE((SELECT MAX(m.seq_no) FROM im_message m WHERE m.conversation_id = c.id), 0) + 1
			END,
			updated_at = NOW()
		WHERE c.id = $1 AND c.deleted_at IS NULL
		RETURNING c.last_seq_no`, conversationID).Scan(&nextSeqNo)
	if err != nil {
		return 0, err
	}
	return nextSeqNo, nil
}
