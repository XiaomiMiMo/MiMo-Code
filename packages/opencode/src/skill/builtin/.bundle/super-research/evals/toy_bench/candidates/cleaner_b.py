"""Cleaner B: normalizes unicode + collapses internal whitespace. Crashes on empty input."""
import sys, unicodedata, re

def clean(text: str) -> str:
    if not text:
        raise ValueError("empty input")  # intentional bug — surface in benchmark
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text

if __name__ == "__main__":
    sys.stdout.write(clean(sys.stdin.read()))
