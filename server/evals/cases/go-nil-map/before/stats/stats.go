package stats

import "strings"

type Event struct {
	Name   string
	UserID string
}

// CountUsers returns how many distinct users appear in events.
func CountUsers(events []Event) int {
	seen := make(map[string]struct{}, len(events))
	for _, e := range events {
		seen[e.UserID] = struct{}{}
	}
	return len(seen)
}

func normalize(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}
