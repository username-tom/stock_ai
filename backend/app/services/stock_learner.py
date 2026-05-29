"""Stock learner service for directional long/short tagging.

The service builds a compact feature set from recent price/volume history and
combines several common ML-style classifiers implemented with NumPy:
logistic regression, Gaussian naive Bayes, and k-nearest neighbors.

It returns a directional bias tag suitable for watchlist display:
LONG, SHORT, STRONG LONG, STRONG SHORT, or WATCH.
"""
from __future__ import annotations

import asyncio
import contextlib
import math
import time
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from app.services.market_service import get_history

_CACHE_TTL_S = 2 * 60  # refresh every 2 minutes — intraday data changes quickly
_EXTERNAL_SENTIMENT_TIMEOUT_S = 1.5
_MIN_HISTORY_ROWS = 40
_LEARNER_PERIOD = "2d"  # 2 days of 1-minute bars for intraday day-trading context
_TAG_SCORE_THRESHOLD = 0.18
_STRONG_TAG_SCORE_THRESHOLD = 0.55
_TAG_CONFIDENCE_THRESHOLD = 0.45
_STRONG_TAG_CONFIDENCE_THRESHOLD = 0.65
_cache: dict[str, tuple[dict[str, Any], float]] = {}
# Store historical tags for each symbol
_history_cache: dict[str, list[dict[str, Any]]] = {}
_cache_lock = asyncio.Lock()


def _as_float_series(frame: pd.DataFrame, column: str) -> pd.Series:
    return pd.to_numeric(frame[column], errors="coerce")


def _rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _macd_hist(close: pd.Series) -> pd.Series:
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd_line = ema12 - ema26
    signal_line = macd_line.ewm(span=9, adjust=False).mean()
    return macd_line - signal_line


def _feature_frame(records: list[dict]) -> pd.DataFrame:
    frame = pd.DataFrame(records)
    if frame.empty or "close" not in frame.columns:
        return pd.DataFrame()

    for column in ("open", "high", "low", "close", "volume"):
        if column in frame.columns:
            frame[column] = _as_float_series(frame, column)

    close = frame["close"].ffill().bfill()
    has_volume = "volume" in frame.columns
    volume = frame["volume"].ffill().bfill().fillna(0) if has_volume else pd.Series(0.0, index=frame.index)
    has_hl = "high" in frame.columns and "low" in frame.columns
    high = frame["high"].ffill().bfill() if has_hl else close
    low = frame["low"].ffill().bfill() if has_hl else close

    features = pd.DataFrame(index=frame.index)

    # Short-term returns at 1-min resolution
    features["ret_1"] = close.pct_change(1)
    features["ret_3"] = close.pct_change(3)
    features["ret_5"] = close.pct_change(5)
    features["ret_10"] = close.pct_change(10)
    features["ret_20"] = close.pct_change(20)

    # Intraday momentum
    features["momentum_10"] = close / close.shift(10) - 1
    features["momentum_20"] = close / close.shift(20) - 1
    features["momentum_30"] = close / close.shift(30) - 1

    # Price vs short SMAs
    features["sma_5_ratio"] = close / close.rolling(5).mean() - 1
    features["sma_10_ratio"] = close / close.rolling(10).mean() - 1
    features["sma_20_ratio"] = close / close.rolling(20).mean() - 1

    # Short-window volatility
    features["volatility_5"] = close.pct_change().rolling(5).std()
    features["volatility_10"] = close.pct_change().rolling(10).std()

    # Volume relative strength
    features["volume_ratio_5"] = volume / volume.rolling(5).mean().replace(0, np.nan) - 1
    features["volume_ratio_10"] = volume / volume.rolling(10).mean().replace(0, np.nan) - 1

    # RSI at intraday-appropriate periods
    features["rsi_9"] = _rsi(close, period=9)
    features["rsi_14"] = _rsi(close, period=14)

    # MACD histogram (works on any timeframe)
    features["macd_hist"] = _macd_hist(close)

    # Intraday high/low range
    features["range_5"] = (high.rolling(5).max() - low.rolling(5).min()) / close
    features["range_10"] = (high.rolling(10).max() - low.rolling(10).min()) / close

    # Price position within recent range
    _lo10 = low.rolling(10).min()
    _hi10 = high.rolling(10).max()
    features["price_position_10"] = (close - _lo10) / (_hi10 - _lo10).replace(0, np.nan)

    _lo20 = low.rolling(20).min()
    _hi20 = high.rolling(20).max()
    features["price_position_20"] = (close - _lo20) / (_hi20 - _lo20).replace(0, np.nan)

    # VWAP deviation — key intraday mean-reversion/trend signal
    typical_price = (close + high + low) / 3
    _vcum = volume.cumsum()
    vwap = (typical_price * volume).cumsum() / _vcum.where(_vcum > 0, np.nan)
    features["vwap_ratio"] = close / vwap - 1

    # Price acceleration
    features["acceleration_3"] = close.pct_change(1).rolling(3).mean()
    features["acceleration_5"] = close.pct_change(1).rolling(5).mean()

    # Label: 5-bar (5-minute) forward return — 0.1% threshold for intraday
    future_return = close.shift(-5) / close - 1
    labels = pd.Series(np.nan, index=frame.index, dtype=float)
    labels[future_return > 0.001] = 1.0
    labels[future_return < -0.001] = 0.0

    dataset = features.copy()
    dataset["label"] = labels
    dataset = dataset.dropna().reset_index(drop=True)
    return dataset


def _standardize(matrix: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mean = np.nanmean(matrix, axis=0)
    std = np.nanstd(matrix, axis=0)
    std = np.where(std == 0, 1.0, std)
    return (matrix - mean) / std, mean, std


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -35, 35)))


def _fit_logistic(x: np.ndarray, y: np.ndarray, steps: int = 250, lr: float = 0.08) -> np.ndarray:
    weights = np.zeros(x.shape[1] + 1, dtype=float)
    x_bias = np.column_stack([np.ones(x.shape[0]), x])
    for _ in range(steps):
        preds = _sigmoid(x_bias @ weights)
        gradient = (x_bias.T @ (preds - y)) / max(1, len(y))
        weights -= lr * gradient
    return weights


def _predict_logistic(weights: np.ndarray, x: np.ndarray) -> float:
    x_bias = np.concatenate([[1.0], x])
    return float(_sigmoid(np.array([x_bias @ weights]))[0])


@dataclass
class _GaussianNBModel:
    prior_pos: float
    mean_pos: np.ndarray
    var_pos: np.ndarray
    prior_neg: float
    mean_neg: np.ndarray
    var_neg: np.ndarray


def _fit_gaussian_nb(x: np.ndarray, y: np.ndarray) -> _GaussianNBModel:
    pos = x[y == 1]
    neg = x[y == 0]
    eps = 1e-6
    return _GaussianNBModel(
        prior_pos=float(len(pos) / max(1, len(x))),
        mean_pos=np.nanmean(pos, axis=0),
        var_pos=np.nanvar(pos, axis=0) + eps,
        prior_neg=float(len(neg) / max(1, len(x))),
        mean_neg=np.nanmean(neg, axis=0),
        var_neg=np.nanvar(neg, axis=0) + eps,
    )


def _log_gaussian_pdf(x: np.ndarray, mean: np.ndarray, var: np.ndarray) -> np.ndarray:
    return -0.5 * (np.log(2 * np.pi * var) + ((x - mean) ** 2) / var)


def _predict_gaussian_nb(model: _GaussianNBModel, x: np.ndarray) -> float:
    log_pos = math.log(max(model.prior_pos, 1e-9)) + float(np.sum(_log_gaussian_pdf(x, model.mean_pos, model.var_pos)))
    log_neg = math.log(max(model.prior_neg, 1e-9)) + float(np.sum(_log_gaussian_pdf(x, model.mean_neg, model.var_neg)))
    denom = np.logaddexp(log_pos, log_neg)
    return float(np.exp(log_pos - denom))


def _fit_knn(x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    return x, y


def _predict_knn(model: tuple[np.ndarray, np.ndarray], x: np.ndarray, k: int = 7) -> float:
    train_x, train_y = model
    if len(train_x) == 0:
        return 0.5
    distances = np.linalg.norm(train_x - x, axis=1)
    nearest = np.argsort(distances)[: max(1, min(k, len(distances)))]
    weights = 1.0 / np.maximum(distances[nearest], 1e-6)
    weighted_vote = float(np.sum(train_y[nearest] * weights) / np.sum(weights))
    return max(0.0, min(1.0, weighted_vote))


def _directional_agreement(probs: list[float]) -> float:
    long_votes = float(np.mean([1.0 if p >= 0.5 else 0.0 for p in probs]))
    return max(long_votes, 1.0 - long_votes)


def _tag_from_score(score: float, confidence: float) -> str:
    if score >= _STRONG_TAG_SCORE_THRESHOLD and confidence >= _STRONG_TAG_CONFIDENCE_THRESHOLD:
        return "STRONG LONG"
    if score >= _TAG_SCORE_THRESHOLD and confidence >= _TAG_CONFIDENCE_THRESHOLD:
        return "LONG"
    if score <= -_STRONG_TAG_SCORE_THRESHOLD and confidence >= _STRONG_TAG_CONFIDENCE_THRESHOLD:
        return "STRONG SHORT"
    if score <= -_TAG_SCORE_THRESHOLD and confidence >= _TAG_CONFIDENCE_THRESHOLD:
        return "SHORT"
    return "WATCH"


def _make_watch_result(sym: str, reason: str) -> dict[str, Any]:
    return {
        "symbol": sym,
        "learner_score": 0.0,
        "learner_tag": "WATCH",
        "learner_direction": "neutral",
        "learner_confidence": 0.0,
        "learner_model": "stock_learner",
        "learner_reason": reason,
    }


async def classify_symbol(symbol: str, period: str = _LEARNER_PERIOD) -> dict[str, Any]:
    sym = symbol.upper().strip()
    if not sym:
        return _make_watch_result(sym, "empty symbol")

    cache_key = f"{sym}:{period}"
    now = time.monotonic()
    async with _cache_lock:
        cached = _cache.get(cache_key)
        if cached and (now - cached[1]) < _CACHE_TTL_S:
            return dict(cached[0])

    try:
        history = await get_history(sym, period)
        records = history.get("data", []) if isinstance(history, dict) else history
    except Exception as exc:
        result = _make_watch_result(sym, f"history unavailable: {exc}")
        async with _cache_lock:
            _cache[cache_key] = (result, now)
            _history_cache.setdefault(sym, []).append(result)
        return result

    try:
        dataset = _feature_frame(records)

        if len(dataset) < _MIN_HISTORY_ROWS:
            result = _make_watch_result(sym, f"insufficient history ({len(dataset)} rows)")
            async with _cache_lock:
                _cache[cache_key] = (result, now)
                _history_cache.setdefault(sym, []).append(result)
            return result

        feature_cols = [c for c in dataset.columns if c != "label"]
        x_raw = dataset[feature_cols].to_numpy(dtype=float)
        y = dataset["label"].to_numpy(dtype=float)

        valid_mask = np.isfinite(x_raw).all(axis=1) & np.isfinite(y)
        x_raw = x_raw[valid_mask]
        y = y[valid_mask].astype(int)

        if len(x_raw) < _MIN_HISTORY_ROWS or len(np.unique(y)) < 2:
            result = _make_watch_result(sym, "not enough directional labels")
            async with _cache_lock:
                _cache[cache_key] = (result, now)
                _history_cache.setdefault(sym, []).append(result)
            return result

        x, mean, std = _standardize(x_raw)
        latest = ((dataset[feature_cols].iloc[-1].to_numpy(dtype=float) - mean) / std).astype(float)

        logistic_w = _fit_logistic(x, y)
        nb_model = _fit_gaussian_nb(x, y)
        knn_model = _fit_knn(x, y)

        probs = [
            _predict_logistic(logistic_w, latest),
            _predict_gaussian_nb(nb_model, latest),
            _predict_knn(knn_model, latest),
        ]
        avg_long_prob = float(np.mean(probs))
        score = (avg_long_prob - 0.5) * 2.0
        agreement = _directional_agreement(probs)
        confidence = float(min(1.0, 0.6 * abs(score) + 0.4 * agreement))
        tag = _tag_from_score(score, confidence)
        direction = "long" if "LONG" in tag else "short" if "SHORT" in tag else "neutral"

        result = {
            "symbol": sym,
            "learner_score": round(score, 3),
            "learner_tag": tag,
            "learner_direction": direction,
            "learner_confidence": round(confidence, 3),
            "learner_model": "logistic_regression+naive_bayes+knn",
            "learner_reason": f"long_prob={avg_long_prob:.3f}; agreement={agreement:.3f}",
        }
    except Exception as exc:
        result = _make_watch_result(sym, f"model error: {exc}")

    async with _cache_lock:
        _cache[cache_key] = (result, now)
        _history_cache.setdefault(sym, []).append(result)
        if len(_history_cache[sym]) > 100:
            _history_cache[sym] = _history_cache[sym][-100:]
    return result

# New: API to get historical learner tags for a symbol
async def get_learner_history(symbol: str) -> list[dict[str, Any]]:
    sym = symbol.upper().strip()
    return _history_cache.get(sym, [])


def _clamp_weight(weight: float | int | None) -> float:
    try:
        w = float(weight or 0.0)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(w):
        return 0.0
    return max(0.0, min(1.0, w))


def _blend_external(
    learner: dict[str, Any],
    external: dict[str, Any] | None,
    weight: float,
) -> dict[str, Any]:
    """Blend an external sentiment payload into a learner result dict.

    Mutates and returns a new dict. The blended score replaces
    ``learner_score`` so downstream tag routing benefits automatically,
    while the original learner output is preserved under ``learner_score_raw``
    / ``learner_tag_raw``.
    """
    result = dict(learner)
    if weight <= 0.0 or not isinstance(external, dict):
        return result

    try:
        ext_score = float(external.get("score", 0.0) or 0.0)
        ext_conf = float(external.get("confidence", 0.0) or 0.0)
    except (TypeError, ValueError):
        return result

    if not math.isfinite(ext_score) or not math.isfinite(ext_conf) or ext_conf <= 0.0:
        return result

    raw_score = float(result.get("learner_score", 0.0) or 0.0)
    raw_conf = float(result.get("learner_confidence", 0.0) or 0.0)
    raw_tag = result.get("learner_tag", "WATCH")

    # Effective weight is scaled by external confidence so weak signals
    # have less influence even at high configured weight.
    eff_w = weight * ext_conf
    blended_score = (1.0 - eff_w) * raw_score + eff_w * ext_score
    blended_score = max(-1.0, min(1.0, blended_score))

    # Confidence: boost when learner and external agree on direction, dampen
    # on disagreement. Bounded to [0, 1].
    agree = 1.0 if (raw_score == 0.0 or ext_score == 0.0 or (raw_score > 0) == (ext_score > 0)) else -1.0
    blended_conf = raw_conf + agree * weight * ext_conf * 0.25
    blended_conf = max(0.0, min(1.0, blended_conf))

    blended_tag = _tag_from_score(blended_score, blended_conf)
    direction = "long" if "LONG" in blended_tag else "short" if "SHORT" in blended_tag else "neutral"

    result["learner_score_raw"] = round(raw_score, 3)
    result["learner_tag_raw"] = raw_tag
    result["learner_score"] = round(blended_score, 3)
    result["learner_confidence"] = round(blended_conf, 3)
    result["learner_tag"] = blended_tag
    result["learner_direction"] = direction
    result["learner_blend_weight"] = round(weight, 3)
    result["external_score"] = round(ext_score, 3)
    result["external_bucket"] = external.get("bucket", "neutral")
    result["external_confidence"] = round(ext_conf, 3)
    result["external_event_flag"] = bool(external.get("event_flag", False))
    result["external_as_of"] = external.get("as_of")
    reason = result.get("learner_reason") or ""
    result["learner_reason"] = (
        f"{reason}; blended ext={ext_score:+.3f} (w={weight:.2f}, conf={ext_conf:.2f})"
    ).lstrip("; ")
    return result


async def classify_symbols(
    symbols: list[str],
    period: str = _LEARNER_PERIOD,
    *,
    external_sentiment_weight: float = 0.0,
) -> dict[str, dict[str, Any]]:
    requested = [s.upper().strip() for s in symbols if s and s.strip()]
    if not requested:
        return {}

    unique_symbols = list(dict.fromkeys(requested))
    weight = _clamp_weight(external_sentiment_weight)

    if weight > 0.0:
        # Fetch learner + external sentiment concurrently for the whole batch.
        from app.services import sentiment_aggregator
        learner_task = asyncio.gather(
            *(classify_symbol(sym, period=period) for sym in unique_symbols)
        )
        sentiment_task = asyncio.create_task(
            sentiment_aggregator.get_bulk_sentiment(unique_symbols)
        )
        sentiment_map: dict[str, dict[str, Any]] = {}
        try:
            sentiment_map = await asyncio.wait_for(
                sentiment_task,
                timeout=_EXTERNAL_SENTIMENT_TIMEOUT_S,
            )
        except Exception:
            # Don't block learner output on external/news feed delays.
            if not sentiment_task.done():
                sentiment_task.cancel()
                with contextlib.suppress(Exception):
                    await sentiment_task
        learner_results = await learner_task
        if not isinstance(sentiment_map, dict):
            sentiment_map = {}
        return {
            item["symbol"]: _blend_external(item, sentiment_map.get(item["symbol"]), weight)
            for item in learner_results
        }

    results = await asyncio.gather(*(classify_symbol(sym, period=period) for sym in unique_symbols))
    return {item["symbol"]: item for item in results}