"""Validation helpers for imported sample records."""

REQUIRED_FIELDS = ("sample_id", "concentration")


class ValidationError(ValueError):
    """Raised when a sample record fails validation."""


def validate_samples(samples):
    """Return the list of samples, raising ValidationError for invalid records."""
    validated = []
    for index, sample in enumerate(samples):
        if not sample.get("sample_id"):
            raise ValidationError(f"Row {index}: missing sample_id")
        validated.append(sample)
    return validated


def summarize(samples):
    """Return a small summary dictionary for a list of validated samples."""
    concentrations = [float(s["concentration"]) for s in samples]
    return {
        "count": len(samples),
        "max_concentration": max(concentrations, default=None),
    }
