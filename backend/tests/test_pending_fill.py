from app.services.pending_fill import assess_pending_fill


def test_assess_pending_fill_requires_price_inside_fill_range_and_sufficient_volume():
    result = assess_pending_fill(
        reference_price=100.0,
        quantity=50,
        low=99.5,
        high=100.5,
        volume=500,
        drift_threshold_pct=25.0,
    )

    assert result["within_fill_range"] is True
    assert result["sufficient_volume"] is True
    assert result["eligible_to_attempt"] is True


def test_assess_pending_fill_keeps_order_pending_when_inside_drift_band_but_outside_fill_range():
    result = assess_pending_fill(
        reference_price=100.0,
        quantity=50,
        low=100.1,
        high=100.5,
        volume=500,
        drift_threshold_pct=50.0,
    )

    assert result["within_fill_range"] is False
    assert result["within_drift_range"] is True
    assert result["eligible_to_attempt"] is False


def test_assess_pending_fill_rejects_insufficient_volume_and_outside_drift_band():
    low = 101.2
    high = 101.8
    result = assess_pending_fill(
        reference_price=100.0,
        quantity=100,
        low=low,
        high=high,
        volume=50,
        drift_threshold_pct=10.0,
    )

    assert result["within_drift_range"] is False
    assert result["sufficient_volume"] is False
    assert result["eligible_to_attempt"] is False