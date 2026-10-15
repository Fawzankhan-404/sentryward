package cache

import (
	"sync"
	"time"
)

type entry struct {
	value     []byte
	expiresAt time.Time
}

type Cache struct {
	mu      sync.Mutex
	entries map[string]entry
}

func New() *Cache {
	return &Cache{entries: make(map[string]entry)}
}

func (c *Cache) Set(key string, value []byte, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = entry{value: value, expiresAt: time.Now().Add(ttl)}
}

// Get returns the value for key, dropping it if it has expired.
func (c *Cache) Get(key string) ([]byte, bool) {
	c.mu.Lock()
	e, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	if time.Now().After(e.expiresAt) {
		delete(c.entries, key)
		c.mu.Unlock()
		return nil, false
	}
	c.mu.Unlock()
	return e.value, true
}
