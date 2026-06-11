package messagetree

import (
	"errors"
	"sort"
)

func BuildActivePath(messages []Message, leafID int64) ([]Message, error) {
	if leafID <= 0 {
		return nil, errors.New("missing active leaf")
	}
	byID := make(map[int64]Message, len(messages))
	for _, item := range messages {
		if item.ID > 0 {
			byID[item.ID] = item
		}
	}
	current, ok := byID[leafID]
	if !ok {
		return nil, errors.New("active leaf not found")
	}
	seen := map[int64]struct{}{}
	reversed := make([]Message, 0, 8)
	for {
		if _, ok := seen[current.ID]; ok {
			return nil, errors.New("message tree contains a cycle")
		}
		seen[current.ID] = struct{}{}
		reversed = append(reversed, current)
		if current.ParentID <= 0 {
			break
		}
		parent, ok := byID[current.ParentID]
		if !ok {
			return nil, errors.New("active path parent not found")
		}
		current = parent
	}
	for left, right := 0, len(reversed)-1; left < right; left, right = left+1, right-1 {
		reversed[left], reversed[right] = reversed[right], reversed[left]
	}
	return reversed, nil
}

func VersionSiblings(messages []Message, messageID int64) ([]Message, error) {
	var selected Message
	found := false
	for _, item := range messages {
		if item.ID == messageID {
			selected = item
			found = true
			break
		}
	}
	if !found {
		return nil, errors.New("message not found")
	}
	if selected.VersionGroupID == "" {
		return []Message{selected}, nil
	}
	result := make([]Message, 0, 3)
	for _, item := range messages {
		if item.SessionID == selected.SessionID &&
			item.ParentID == selected.ParentID &&
			item.VersionGroupID == selected.VersionGroupID {
			result = append(result, item)
		}
	}
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].VersionNo == result[j].VersionNo {
			return result[i].ID < result[j].ID
		}
		return result[i].VersionNo < result[j].VersionNo
	})
	return result, nil
}

func NextVersionNo(messages []Message, sessionID int64, versionGroupID string) int {
	if sessionID <= 0 || versionGroupID == "" {
		return 1
	}
	next := 1
	for _, item := range messages {
		if item.SessionID == sessionID && item.VersionGroupID == versionGroupID && item.VersionNo >= next {
			next = item.VersionNo + 1
		}
	}
	return next
}
