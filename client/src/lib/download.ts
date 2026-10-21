// Saves text as a file through a temporary object URL, since the content is
// fetched with the session's headers and can't be a plain link.
export function downloadText(text: string, filename: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
