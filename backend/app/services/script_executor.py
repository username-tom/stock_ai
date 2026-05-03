"""Safe execution service for user-provided Python trading scripts.

Scripts must define at least ``generate_signals(df, **params) -> pd.DataFrame``.
They may also define ``get_default_params() -> dict``.

Allowed imports inside scripts: pandas (as pd), numpy (as np), math, statistics.
"""
from __future__ import annotations

import math
import statistics
import types
import logging
from typing import Any

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Default script template shown to new users
# ---------------------------------------------------------------------------
DEFAULT_SCRIPT = '''\
import pandas as pd
import numpy as np


def get_default_params() -> dict:
    """Return default parameter values used when none are supplied."""
    return {}


def generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame:
    """
    Receive OHLCV data and return the DataFrame with a \'signal\' column added.

    Signal values:
        +1  – buy
        -1  – sell
         0  – hold / no action

    Available columns: Open, High, Low, Close, Volume
    """
    df = df.copy()
    df["signal"] = 0
    # ── your logic here ──────────────────────────────────────────────────────
    # Example: buy when Close crosses above its 20-day SMA
    sma = df["Close"].rolling(20).mean()
    df.loc[df["Close"] > sma, "signal"] = 1
    df.loc[df["Close"] < sma, "signal"] = -1
    # ─────────────────────────────────────────────────────────────────────────
    return df
'''

# ---------------------------------------------------------------------------
# Safe builtins permitted inside user scripts
# ---------------------------------------------------------------------------
_SAFE_BUILTINS: dict[str, Any] = {
    # built-in types
    "None": None,
    "True": True,
    "False": False,
    "bool": bool,
    "int": int,
    "float": float,
    "str": str,
    "list": list,
    "dict": dict,
    "tuple": tuple,
    "set": set,
    "frozenset": frozenset,
    "bytes": bytes,
    "bytearray": bytearray,
    "range": range,
    "enumerate": enumerate,
    "zip": zip,
    "map": map,
    "filter": filter,
    "sorted": sorted,
    "reversed": reversed,
    "len": len,
    "sum": sum,
    "min": min,
    "max": max,
    "abs": abs,
    "round": round,
    "pow": pow,
    "divmod": divmod,
    "all": all,
    "any": any,
    "isinstance": isinstance,
    "issubclass": issubclass,
    "hasattr": hasattr,
    "getattr": getattr,
    "setattr": setattr,
    "type": type,
    "print": print,
    "repr": repr,
    "format": format,
    "hash": hash,
    "id": id,
    "iter": iter,
    "next": next,
    "slice": slice,
    "super": super,
    "property": property,
    "staticmethod": staticmethod,
    "classmethod": classmethod,
    "object": object,
    # exceptions commonly needed
    "ValueError": ValueError,
    "TypeError": TypeError,
    "KeyError": KeyError,
    "IndexError": IndexError,
    "AttributeError": AttributeError,
    "RuntimeError": RuntimeError,
    "StopIteration": StopIteration,
    "Exception": Exception,
    "NotImplementedError": NotImplementedError,
}

# Allowed module aliases that the script may reference (pre-imported).
_ALLOWED_MODULES: dict[str, Any] = {
    "pd": pd,
    "np": np,
    "pandas": pd,
    "numpy": np,
    "math": math,
    "statistics": statistics,
}


def _safe_import(name: str, globs: dict, locs: dict, fromlist: tuple, level: int):
    """Custom __import__ that only allows whitelisted modules."""
    allowed = {"pandas", "numpy", "math", "statistics"}
    # Resolve top-level module name
    top = name.split(".")[0]
    if top not in allowed:
        raise ImportError(
            f"Import of '{name}' is not allowed inside custom scripts. "
            f"Permitted modules: {sorted(allowed)}"
        )
    return __import__(name, globs, locs, fromlist, level)


def _build_globals(extra: dict | None = None) -> dict:
    """Build the globals dict used when executing user scripts.

    ``__import__`` must live inside ``__builtins__`` — that is where Python
    looks when executing import statements inside exec'd code.
    """
    safe_builtins = dict(_SAFE_BUILTINS)
    safe_builtins["__import__"] = _safe_import
    globs: dict[str, Any] = {"__builtins__": safe_builtins}
    globs.update(_ALLOWED_MODULES)
    if extra:
        globs.update(extra)
    return globs


def validate_script(script_code: str) -> dict:
    """
    Compile and execute the script to verify it is syntactically and
    semantically valid.

    Returns a dict with keys:
      - ``valid`` (bool)
      - ``error`` (str | None)
      - ``default_params`` (dict)
    """
    try:
        code = compile(script_code, "<custom_script>", "exec")
    except SyntaxError as exc:
        return {"valid": False, "error": f"Syntax error: {exc}", "default_params": {}}

    globs = _build_globals()
    try:
        # exec() is intentional here; user-supplied code is sandboxed via
        # a restricted __builtins__ dict and a custom __import__ that only
        # allows a fixed whitelist of safe modules (pandas, numpy, math,
        # statistics).  No file-system or network access is available.
        exec(code, globs)  # noqa: S102
    except Exception as exc:
        return {"valid": False, "error": f"Execution error: {exc}", "default_params": {}}

    if "generate_signals" not in globs or not callable(globs["generate_signals"]):
        return {
            "valid": False,
            "error": "Script must define a callable 'generate_signals(df, **params)'.",
            "default_params": {},
        }

    default_params: dict = {}
    if "get_default_params" in globs and callable(globs["get_default_params"]):
        try:
            default_params = globs["get_default_params"]()
        except Exception as exc:
            return {
                "valid": False,
                "error": f"'get_default_params()' raised an error: {exc}",
                "default_params": {},
            }

    return {"valid": True, "error": None, "default_params": default_params}


def execute_script(script_code: str, df: pd.DataFrame, **params) -> pd.DataFrame:
    """
    Execute a validated custom script against *df* and return the DataFrame
    with a populated ``signal`` column.

    Raises ``ValueError`` if the script is invalid or execution fails.
    """
    result = validate_script(script_code)
    if not result["valid"]:
        raise ValueError(result["error"])

    code = compile(script_code, "<custom_script>", "exec")
    globs = _build_globals()
    exec(code, globs)  # noqa: S102

    generate_signals = globs["generate_signals"]

    # Merge script defaults then overlay caller-supplied params, dropping
    # empty-string values that the frontend sends for unfilled fields.
    merged_params: dict = {}
    if "get_default_params" in globs and callable(globs["get_default_params"]):
        try:
            merged_params.update(globs["get_default_params"]())
        except Exception:
            pass
    merged_params.update(
        {k: v for k, v in params.items()
         if v is not None and not (isinstance(v, str) and not v.strip())}
    )

    try:
        output = generate_signals(df, **merged_params)
    except Exception as exc:
        import traceback
        logger.error(
            "generate_signals() crashed.\n"
            "  merged_params: %s\n"
            "  traceback:\n%s",
            merged_params,
            traceback.format_exc(),
        )
        raise ValueError(f"generate_signals() raised an error: {exc}") from exc

    if not isinstance(output, pd.DataFrame):
        raise ValueError("generate_signals() must return a pandas DataFrame.")
    if "signal" not in output.columns:
        raise ValueError("generate_signals() must add a 'signal' column to the DataFrame.")

    return output
