from sqlalchemy import Column, Integer, String, Float, DateTime, Text, JSON
from sqlalchemy.sql import func
from app.database import Base


class Strategy(Base):
    __tablename__ = "strategies"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False, unique=True)
    strategy_type = Column(String(50), nullable=False)
    parameters = Column(JSON, nullable=False, default={})
    description = Column(Text, nullable=True)
    is_active = Column(Integer, default=0)  # 0=inactive, 1=active
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
