"""Import sample records from CSV files."""

import csv
from pathlib import Path

from validation import validate_samples


def load_data(path):
    """Load sample records from a CSV file and validate them."""
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(path)
    with path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    return validate_samples(rows)


if __name__ == "__main__":
    import sys

    records = load_data(sys.argv[1] if len(sys.argv) > 1 else "data/samples.csv")
    print(f"Loaded {len(records)} samples")
