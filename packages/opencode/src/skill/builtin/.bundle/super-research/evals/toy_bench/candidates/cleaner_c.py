"""Cleaner C: full pipeline — unicode + whitespace + lowercased, tolerates empty."""
import sys, unicodedata, re

def clean(text: str) -> str:
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text

if __name__ == "__main__":
    sys.stdout.write(clean(sys.stdin.read()))
