import json
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd


ROOT = Path(__file__).resolve().parent
RAW_PATH = ROOT / "pm_current_preset_asym_raw.json"
RANKED_PATH = ROOT / "pm_current_preset_asym_ranked.json"
META_PATH = ROOT / "pm_current_preset_asym_meta.json"

RETURN_CHART = ROOT / "pm_current_preset_asym_return.png"
SHARPE_CHART = ROOT / "pm_current_preset_asym_sharpe.png"
DRAWDOWN_CHART = ROOT / "pm_current_preset_asym_drawdown.png"
HEATMAP_CHART = ROOT / "pm_current_preset_asym_score_heatmap.png"
REPORT_MD = ROOT / "pm_current_preset_asym_report.md"


def _load_json(path: Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _to_label(row: pd.Series) -> str:
    return f"B{int(row['buy_fill_pct'])}-S{int(row['sell_fill_pct'])}"


def _save_line_chart(df: pd.DataFrame, y_col: str, title: str, ylabel: str, out_path: Path):
    plot_df = df.copy().sort_values(["buy_fill_pct", "sell_fill_pct"], ascending=[False, False])
    labels = plot_df.apply(_to_label, axis=1)

    plt.figure(figsize=(12, 5))
    plt.plot(labels, plot_df[y_col], marker="o", linewidth=2)
    plt.xticks(rotation=45, ha="right")
    plt.title(title)
    plt.ylabel(ylabel)
    plt.xlabel("Profile (Buy-Sell Fill %)")
    plt.grid(alpha=0.3)
    plt.tight_layout()
    plt.savefig(out_path, dpi=150)
    plt.close()


def _save_heatmap(df: pd.DataFrame, out_path: Path):
    pivot = df.pivot_table(
        index="buy_fill_pct",
        columns="sell_fill_pct",
        values="score",
        aggfunc="mean",
    ).sort_index(ascending=False)

    fig, ax = plt.subplots(figsize=(8, 6))
    im = ax.imshow(pivot.values, aspect="auto")

    ax.set_xticks(range(len(pivot.columns)))
    ax.set_xticklabels([f"S{int(c)}" for c in pivot.columns])
    ax.set_yticks(range(len(pivot.index)))
    ax.set_yticklabels([f"B{int(i)}" for i in pivot.index])
    ax.set_title("Score Heatmap by Fill-Rate Pair")
    ax.set_xlabel("Sell Fill %")
    ax.set_ylabel("Buy Fill %")

    for i in range(pivot.shape[0]):
        for j in range(pivot.shape[1]):
            val = pivot.iloc[i, j]
            if pd.notna(val):
                ax.text(j, i, f"{val:.1f}", ha="center", va="center", fontsize=8)

    fig.colorbar(im, ax=ax, label="Score")
    plt.tight_layout()
    plt.savefig(out_path, dpi=150)
    plt.close()


def _write_report(df_raw: pd.DataFrame, df_ranked: pd.DataFrame, meta: dict):
    top = df_ranked.head(5).copy()
    top["pair"] = top.apply(_to_label, axis=1)

    control = df_raw[(df_raw["buy_fill_pct"] == 90) & (df_raw["sell_fill_pct"] == 90)]
    baseline_return = float(control.iloc[0]["total_return_pct"]) if not control.empty else None

    lines = []
    lines.append("# Current PM Preset Asymmetrical Fill-Rate Sweep\n")
    lines.append(f"- Generated at: {meta.get('generated_at')}\n")
    lines.append(f"- Baseline report id: {meta.get('baseline_report_id')} ({meta.get('baseline_name')})\n")
    lines.append(f"- Backtest window: {meta.get('start_date')} to {meta.get('end_date')}\n")
    lines.append(f"- Symbols: {', '.join(meta.get('symbols', []))}\n")
    lines.append(f"- Runs: {meta.get('run_count')}\n")

    pm = meta.get("pm_settings_used", {})
    lines.append("\n## PM Settings Used (Unchanged During Sweep)\n")
    lines.append(f"- stop_loss_pct: {pm.get('stop_loss_pct')}\n")
    lines.append(f"- take_profit_pct: {pm.get('take_profit_pct')}\n")
    lines.append(f"- hold_positions_overnight: {pm.get('hold_positions_overnight')}\n")
    lines.append(f"- sentiment_bucket_persistence: {pm.get('sentiment_bucket_persistence')}\n")

    if baseline_return is not None:
        lines.append(f"\n- Control return at B90-S90: {baseline_return:.4f}%\n")

    lines.append("\n## Top 5 Profiles by Score\n")
    lines.append("| Rank | Pair | Return % | Sharpe | Max DD % | Win Rate % | Trades | Score |\n")
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|\n")
    for idx, row in enumerate(top.itertuples(index=False), start=1):
        lines.append(
            f"| {idx} | {row.pair} | {row.total_return_pct:.4f} | {row.sharpe_ratio:.4f} | "
            f"{row.max_drawdown_pct:.4f} | {row.win_rate_pct:.4f} | {int(row.total_trades)} | {row.score:.4f} |\n"
        )

    lines.append("\n## Charts\n")
    lines.append(f"- Return profile: {RETURN_CHART.name}\n")
    lines.append(f"- Sharpe profile: {SHARPE_CHART.name}\n")
    lines.append(f"- Drawdown profile: {DRAWDOWN_CHART.name}\n")
    lines.append(f"- Score heatmap: {HEATMAP_CHART.name}\n")

    REPORT_MD.write_text("".join(lines), encoding="utf-8")


def main():
    raw = _load_json(RAW_PATH)
    ranked = _load_json(RANKED_PATH)
    meta = _load_json(META_PATH)

    df_raw = pd.DataFrame(raw)
    df_ranked = pd.DataFrame(ranked)

    if df_raw.empty:
        raise RuntimeError("Raw sweep data is empty; run the PowerShell sweep first.")

    _save_line_chart(
        df_raw,
        y_col="total_return_pct",
        title="Total Return by Asymmetrical Fill Pair",
        ylabel="Total Return (%)",
        out_path=RETURN_CHART,
    )

    _save_line_chart(
        df_raw,
        y_col="sharpe_ratio",
        title="Sharpe Ratio by Asymmetrical Fill Pair",
        ylabel="Sharpe Ratio",
        out_path=SHARPE_CHART,
    )

    _save_line_chart(
        df_raw,
        y_col="max_drawdown_pct",
        title="Max Drawdown by Asymmetrical Fill Pair",
        ylabel="Max Drawdown (%)",
        out_path=DRAWDOWN_CHART,
    )

    _save_heatmap(df_raw, HEATMAP_CHART)
    _write_report(df_raw, df_ranked, meta)

    print(f"Saved: {RETURN_CHART}")
    print(f"Saved: {SHARPE_CHART}")
    print(f"Saved: {DRAWDOWN_CHART}")
    print(f"Saved: {HEATMAP_CHART}")
    print(f"Saved: {REPORT_MD}")


if __name__ == "__main__":
    main()
