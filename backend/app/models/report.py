from sqlalchemy import Column, Integer, String, Float, DateTime, Text, JSON
from sqlalchemy.sql import func
from app.database import Base


class BacktestReport(Base):
    __tablename__ = "backtest_reports"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False)
    symbol = Column(String(20), nullable=False)
    strategy_type = Column(String(50), nullable=False)
    parameters = Column(JSON, nullable=False, default={})
    start_date = Column(String(20), nullable=False)
    end_date = Column(String(20), nullable=False)
    initial_capital = Column(Float, nullable=False)

    # Performance metrics
    final_value = Column(Float, nullable=True)
    total_return_pct = Column(Float, nullable=True)
    annualized_return_pct = Column(Float, nullable=True)
    sharpe_ratio = Column(Float, nullable=True)
    max_drawdown_pct = Column(Float, nullable=True)
    win_rate_pct = Column(Float, nullable=True)
    total_trades = Column(Integer, nullable=True)

    # Serialized result data (equity curve, trades list)
    result_data = Column(JSON, nullable=True)

    html_report_path = Column(String(500), nullable=True)
    # Snapshot of the custom script code at the time the backtest was run
    script_snapshot = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
