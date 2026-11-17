import pytest

from validation import ValidationError, validate_samples


def test_valid_samples_pass():
    result = validate_samples([{"sample_id": "S1", "concentration": "1.5"}])
    assert len(result) == 1
    assert result[0]["sample_id"] == "S1"


def test_missing_sample_id_rejected():
    with pytest.raises(ValidationError):
        validate_samples([{"sample_id": "", "concentration": "1.0"}])


def test_missing_concentration_rejected():
    with pytest.raises(ValidationError):
        validate_samples([{"sample_id": "S2"}])


def test_negative_concentration_rejected():
    with pytest.raises(ValidationError):
        validate_samples([{"sample_id": "S3", "concentration": "-2"}])


def test_non_numeric_concentration_rejected():
    with pytest.raises(ValidationError):
        validate_samples([{"sample_id": "S4", "concentration": "abc"}])
