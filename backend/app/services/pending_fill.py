from __future__ import annotations

from typing import Any


def _positive_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number <= 0:
        return None
    return number


def assess_pending_fill(
    *,
    reference_price: Any,
    quantity: Any,
    low: Any,
    high: Any,
    volume: Any,
    drift_threshold_pct: Any,
) -> dict[str, Any]:
    """Evaluate whether a pending order can fill against the current price range.

    A pending order is only fill-eligible when its reference price is inside the
    actual traded range and the reported volume can cover the order quantity.
    Drift cancellation uses the high/low span with an extra percentage buffer.
    """
    ref_price = _positive_float(reference_price)
    qty = _positive_float(quantity)
    low_price = _positive_float(low)
    high_price = _positive_float(high)
    reported_volume = _positive_float(volume)
    drift_pct = max(0.0, float(drift_threshold_pct or 0.0))

    if ref_price is None or qty is None or low_price is None or high_price is None:
        return {
            "has_range": False,
            "within_fill_range": False,
            "within_drift_range": False,
            "sufficient_volume": False,
            "eligible_to_attempt": False,
            "range_low": None,
            "range_high": None,
            "drift_buffer": None,
        }

    range_low = min(low_price, high_price)
    range_high = max(low_price, high_price)
    range_size = max(0.0, range_high - range_low)
    drift_buffer = range_size * (drift_pct / 100.0)
    within_fill_range = range_low <= ref_price <= range_high
    within_drift_range = (range_low - drift_buffer) <= ref_price <= (range_high + drift_buffer)
    sufficient_volume = reported_volume is not None and qty <= reported_volume

    return {
        "has_range": True,
        "within_fill_range": within_fill_range,
        "within_drift_range": within_drift_range,
        "sufficient_volume": sufficient_volume,
        "eligible_to_attempt": within_fill_range and sufficient_volume,
        "range_low": range_low,
        "range_high": range_high,
        "drift_buffer": drift_buffer,
    }