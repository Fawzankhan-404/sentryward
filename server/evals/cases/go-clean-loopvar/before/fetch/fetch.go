package fetch

import (
	"context"
	"net/http"
)

// Status returns the HTTP status of each URL, in order.
func Status(ctx context.Context, client *http.Client, urls []string) ([]int, error) {
	statuses := make([]int, len(urls))
	for i, url := range urls {
		code, err := head(ctx, client, url)
		if err != nil {
			return nil, err
		}
		statuses[i] = code
	}
	return statuses, nil
}

func head(ctx context.Context, client *http.Client, url string) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, url, nil)
	if err != nil {
		return 0, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}
