"""US market calendar helpers for NYSE trading-day calculations."""
from __future__ import annotations

from datetime import date, datetime, timedelta
from functools import lru_cache


def _nth_weekday_of_month(year: int, month: int, weekday: int, n: int) -> date:
    d = date(year, month, 1)
    while d.weekday() != weekday:
        d += timedelta(days=1)
    return d + timedelta(days=(n - 1) * 7)


def _last_weekday_of_month(year: int, month: int, weekday: int) -> date:
    if month == 12:
        d = date(year + 1, 1, 1) - timedelta(days=1)
    else:
        d = date(year, month + 1, 1) - timedelta(days=1)
    while d.weekday() != weekday:
        d -= timedelta(days=1)
    return d


def _easter_sunday(year: int) -> date:
    # Anonymous Gregorian algorithm.
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def _observed_holiday(d: date) -> date:
    if d.weekday() == 5:  # Saturday -> Friday
        return d - timedelta(days=1)
    if d.weekday() == 6:  # Sunday -> Monday
        return d + timedelta(days=1)
    return d


@lru_cache(maxsize=64)
def nyse_holidays(year: int) -> frozenset[date]:
    """Return the set of full-day NYSE holidays for the given year."""
    holidays: set[date] = set()

    # Include New Year's observed day that can spill into this year.
    ny_this = _observed_holiday(date(year, 1, 1))
    if ny_this.year == year:
        holidays.add(ny_this)
    ny_next_obs = _observed_holiday(date(year + 1, 1, 1))
    if ny_next_obs.year == year:
        holidays.add(ny_next_obs)

    holidays.add(_nth_weekday_of_month(year, 1, 0, 3))      # MLK Day
    holidays.add(_nth_weekday_of_month(year, 2, 0, 3))      # Presidents' Day
    holidays.add(_easter_sunday(year) - timedelta(days=2))  # Good Friday
    holidays.add(_last_weekday_of_month(year, 5, 0))        # Memorial Day

    # Juneteenth became a market holiday in 2022.
    if year >= 2022:
        holidays.add(_observed_holiday(date(year, 6, 19)))

    holidays.add(_observed_holiday(date(year, 7, 4)))       # Independence Day
    holidays.add(_nth_weekday_of_month(year, 9, 0, 1))      # Labor Day
    holidays.add(_nth_weekday_of_month(year, 11, 3, 4))     # Thanksgiving
    holidays.add(_observed_holiday(date(year, 12, 25)))     # Christmas

    return frozenset(holidays)


def is_nyse_trading_day(day: date) -> bool:
    """Return True when the provided date is a normal NYSE trading day."""
    if day.weekday() >= 5:
        return False
    return day not in nyse_holidays(day.year)


def count_nyse_trading_days(start_dt: datetime, end_dt: datetime) -> int:
    """Count NYSE trading days between two datetimes by date, inclusive."""
    start_date = start_dt.date()
    end_date = end_dt.date()
    if end_date < start_date:
        return 0

    days = 0
    cursor = start_date
    while cursor <= end_date:
        if is_nyse_trading_day(cursor):
            days += 1
        cursor += timedelta(days=1)
    return days
