"""Service package exports.

Keep package import side effects minimal. Several modules (for example
`stock_learner`) import `app.services.<module>` helpers at runtime; eager
imports here can pull in optional integrations (IB) too early and break those
call paths.
"""

from __future__ import annotations

from typing import Any

__all__ = ["run_backtest", "ib_service", "generate_html_report"]


def __getattr__(name: str) -> Any:
	if name == "run_backtest":
		from app.services.backtester import run_backtest

		return run_backtest
	if name == "ib_service":
		from app.services.ib_service import ib_service

		return ib_service
	if name == "generate_html_report":
		from app.services.reporter import generate_html_report

		return generate_html_report
	raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
