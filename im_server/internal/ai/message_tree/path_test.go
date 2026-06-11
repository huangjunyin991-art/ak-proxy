package messagetree

import "testing"

func TestBuildActivePathUsesOnlySelectedBranch(t *testing.T) {
	messages := []Message{
		{ID: 1, SessionID: 7, Role: RoleUser, Content: "A", VersionGroupID: "u1", VersionNo: 1},
		{ID: 2, SessionID: 7, ParentID: 1, Role: RoleAssistant, Content: "B v1", VersionGroupID: "a1", VersionNo: 1},
		{ID: 3, SessionID: 7, ParentID: 1, Role: RoleAssistant, Content: "B v2", VersionGroupID: "a1", VersionNo: 2},
		{ID: 4, SessionID: 7, ParentID: 3, Role: RoleUser, Content: "C", VersionGroupID: "u2", VersionNo: 1},
		{ID: 5, SessionID: 7, ParentID: 4, Role: RoleAssistant, Content: "D", VersionGroupID: "a2", VersionNo: 1},
	}

	path, err := BuildActivePath(messages, 5)
	if err != nil {
		t.Fatalf("BuildActivePath returned error: %v", err)
	}
	got := ids(path)
	want := []int64{1, 3, 4, 5}
	if !sameIDs(got, want) {
		t.Fatalf("active path ids = %v, want %v", got, want)
	}
}

func TestVersionSiblingsSortsByVersion(t *testing.T) {
	messages := []Message{
		{ID: 10, SessionID: 2, ParentID: 1, VersionGroupID: "answer", VersionNo: 3},
		{ID: 8, SessionID: 2, ParentID: 1, VersionGroupID: "answer", VersionNo: 1},
		{ID: 9, SessionID: 2, ParentID: 1, VersionGroupID: "answer", VersionNo: 2},
		{ID: 11, SessionID: 2, ParentID: 1, VersionGroupID: "other", VersionNo: 1},
		{ID: 12, SessionID: 3, ParentID: 1, VersionGroupID: "answer", VersionNo: 1},
	}

	siblings, err := VersionSiblings(messages, 9)
	if err != nil {
		t.Fatalf("VersionSiblings returned error: %v", err)
	}
	got := ids(siblings)
	want := []int64{8, 9, 10}
	if !sameIDs(got, want) {
		t.Fatalf("siblings ids = %v, want %v", got, want)
	}
}

func TestNextVersionNo(t *testing.T) {
	messages := []Message{
		{ID: 1, SessionID: 1, VersionGroupID: "g", VersionNo: 1},
		{ID: 2, SessionID: 1, VersionGroupID: "g", VersionNo: 3},
		{ID: 3, SessionID: 2, VersionGroupID: "g", VersionNo: 9},
	}
	if got := NextVersionNo(messages, 1, "g"); got != 4 {
		t.Fatalf("NextVersionNo = %d, want 4", got)
	}
	if got := NextVersionNo(messages, 1, "missing"); got != 1 {
		t.Fatalf("NextVersionNo missing group = %d, want 1", got)
	}
}

func TestBuildActivePathDetectsCycle(t *testing.T) {
	messages := []Message{
		{ID: 1, SessionID: 7, ParentID: 2},
		{ID: 2, SessionID: 7, ParentID: 1},
	}
	if _, err := BuildActivePath(messages, 1); err == nil {
		t.Fatal("BuildActivePath should reject cyclic tree")
	}
}

func ids(items []Message) []int64 {
	result := make([]int64, 0, len(items))
	for _, item := range items {
		result = append(result, item.ID)
	}
	return result
}

func sameIDs(a []int64, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}
