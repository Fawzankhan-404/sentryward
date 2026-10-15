package fetch

import (
	"context"
	"net/http"

	"golang.org/x/sync/errgroup"
)

// Status returns the HTTP status of each URL, in order, checking them
// concurrently.
func Status(ctx context.Context, client *http.Client, urls []string) ([]int, error) {
	statuses := make([]int, len(urls))
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(8)
	for i, url := range urls {
		g.Go(func() error {
			code, err := head(ctx, client, url)
			if err != nil {
				return err
			}
			statuses[i] = code
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return nil, err
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
