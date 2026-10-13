// React.lazy caches a rejected import, so only a full reload can retry a failed
// chunk (and it picks up new asset names after a deploy). A module of its own so
// tests can mock it; jsdom's location.reload cannot be spied on.
export function reloadPage() {
  window.location.reload()
}
