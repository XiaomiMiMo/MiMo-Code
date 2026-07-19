"""Cleaner A: strips leading/trailing whitespace only. Ignores unicode normalization."""
import sys

def clean(text: str) -> str:
    return text.strip()

if __name__ == "__main__":
    sys.stdout.write(clean(sys.stdin.read()))
