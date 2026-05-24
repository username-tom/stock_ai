import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parent
SUMMARY_PATH = ROOT / "pm_full_grid_repeats10_summary.json"
OUT_HEATMAP = ROOT / "pm_full_grid_repeats10_confidence_heatmap.png"
OUT_REPORT = ROOT / "pm_full_grid_repeats10_confidence_heatmap.md"


def load_summary(path: Path) -> pd.DataFrame:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    df = pd.DataFrame(data)
    if df.empty:
        raise RuntimeError("Summary data is empty.")
    return df


def make_heatmap(df: pd.DataFrame, out_path: Path) -> None:
    buy_levels = sorted(df["buy_fill_pct"].unique(), reverse=True)
    sell_levels = sorted(df["sell_fill_pct"].unique())

    ret_grid = np.full((len(buy_levels), len(sell_levels)), np.nan)

    fig, ax = plt.subplots(figsize=(14, 10))

    for i, b in enumerate(buy_levels):
        for j, s in enumerate(sell_levels):
            row = df[(df["buy_fill_pct"] == b) & (df["sell_fill_pct"] == s)]
            if row.empty:
                continue
            r = row.iloc[0]
            ret_grid[i, j] = float(r["avg_total_return_pct"])

    im = ax.imshow(ret_grid, aspect="auto", cmap="viridis")

    ax.set_xticks(range(len(sell_levels)))
    ax.set_xticklabels([f"S{int(x)}" for x in sell_levels], fontsize=11)
    ax.set_yticks(range(len(buy_levels)))
    ax.set_yticklabels([f"B{int(x)}" for x in buy_levels], fontsize=11)
    ax.set_xlabel("Sell Fill %", fontsize=12)
    ax.set_ylabel("Buy Fill %", fontsize=12)
    ax.set_title("10-Run Confidence Heatmap (Color = Avg Return %)", fontsize=14, pad=14)

    for i, b in enumerate(buy_levels):
        for j, s in enumerate(sell_levels):
            row = df[(df["buy_fill_pct"] == b) & (df["sell_fill_pct"] == s)]
            if row.empty:
                continue
            r = row.iloc[0]
            label = (
                f"R {r['avg_total_return_pct']:.2f}%\n"
                f"CI [{r['ci95_return_low']:.2f}, {r['ci95_return_high']:.2f}]\n"
                f"Sc {r['avg_score']:.1f}\n"
                f"SD {r['std_total_return_pct']:.2f}"
            )
            ax.text(j, i, label, ha="center", va="center", fontsize=7.8, color="white")

    cbar = fig.colorbar(im, ax=ax)
    cbar.set_label("Avg Return (%)")

    ax.set_xticks(np.arange(-0.5, len(sell_levels), 1), minor=True)
    ax.set_yticks(np.arange(-0.5, len(buy_levels), 1), minor=True)
    ax.grid(which="minor", color="w", linestyle="-", linewidth=0.5, alpha=0.35)
    ax.tick_params(which="minor", bottom=False, left=False)

    plt.tight_layout()
    plt.savefig(out_path, dpi=180)
    plt.close()


def write_report(df: pd.DataFrame, out_path: Path) -> None:
    top_by_mean = df.sort_values("avg_total_return_pct", ascending=False).head(5)
    top_by_floor = df.sort_values("ci95_return_low", ascending=False).head(5)

    lines = []
    lines.append("# 10-Run Confidence Heatmap\n")
    lines.append("- Color scale: avg total return (%)\n")
    lines.append("- Cell text line 1: avg return (%)\n")
    lines.append("- Cell text line 2: 95% CI for return\n")
    lines.append("- Cell text line 3: avg composite score\n")
    lines.append("- Cell text line 4: return std dev\n")
    lines.append(f"- Output image: {OUT_HEATMAP.name}\n")

    lines.append("\n## Top 5 by Avg Return\n")
    lines.append("| Combo | Avg Return % | 95% CI | Avg Score | Return SD |\n")
    lines.append("|---|---:|---|---:|---:|\n")
    for r in top_by_mean.itertuples(index=False):
        lines.append(
            f"| {r.combo} | {r.avg_total_return_pct:.4f} | "
            f"[{r.ci95_return_low:.4f}, {r.ci95_return_high:.4f}] | {r.avg_score:.4f} | {r.std_total_return_pct:.4f} |\n"
        )

    lines.append("\n## Top 5 by CI Floor\n")
    lines.append("| Combo | Avg Return % | 95% CI | CI Low |\n")
    lines.append("|---|---:|---|---:|\n")
    for r in top_by_floor.itertuples(index=False):
        lines.append(
            f"| {r.combo} | {r.avg_total_return_pct:.4f} | "
            f"[{r.ci95_return_low:.4f}, {r.ci95_return_high:.4f}] | {r.ci95_return_low:.4f} |\n"
        )

    out_path.write_text("".join(lines), encoding="utf-8")


def main() -> None:
    df = load_summary(SUMMARY_PATH)
    make_heatmap(df, OUT_HEATMAP)
    write_report(df, OUT_REPORT)
    print(f"Saved: {OUT_HEATMAP}")
    print(f"Saved: {OUT_REPORT}")


if __name__ == "__main__":
    main()
