// Escapes every regex metacharacter, so `text` matches only itself.
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
