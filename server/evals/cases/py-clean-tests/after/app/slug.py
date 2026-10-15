import re
import unicodedata


def slugify(text, max_length=60):
    normalized = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", normalized.lower()).strip("-")
    return slug[:max_length].rstrip("-")
