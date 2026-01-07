#!/usr/bin/env python3
"""Generate charts from structured job data."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np

COLOR_HIGH = "#FF6B6B"
COLOR_MID = "#4ECDC4"
COLOR_LOW = "#95A5A6"
UNKNOWN_LABEL = "未知"
UNKNOWN_ALIASES = {alias.casefold() for alias in ["未知", "不详", "未说明", "待定", "暂无", "n/a", "na", "-"]}
MIN_KNOWN_RATIO = 0.5


def parse_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    text = str(value).strip()
    if not text:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def normalize_label(value: Any, unknown_aliases: set[str]) -> str:
    if value is None:
        return UNKNOWN_LABEL
    text = str(value).strip()
    if not text:
        return UNKNOWN_LABEL
    if text.casefold() in unknown_aliases:
        return UNKNOWN_LABEL
    return text


def filter_known_counts(counts: dict[str, int], min_known_ratio: float) -> dict[str, int] | None:
    total = sum(counts.values())
    if total == 0:
        return None
    unknown_count = counts.get(UNKNOWN_LABEL, 0)
    known_count = total - unknown_count
    if known_count == 0:
        return None
    if known_count / total < min_known_ratio:
        return None
    return {label: value for label, value in counts.items() if label != UNKNOWN_LABEL}


def load_jobs(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and "jobs" in data:
            data = data["jobs"]
        if not isinstance(data, list):
            raise ValueError("JSON must be a list of job objects")
        return [normalize_job(item) for item in data]

    if path.suffix.lower() == ".csv":
        jobs: list[dict[str, Any]] = []
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                jobs.append(normalize_job(row))
        return jobs

    raise ValueError("Input file must be .json or .csv")


def normalize_job(item: dict[str, Any]) -> dict[str, Any]:
    job = dict(item)
    job["salary_min"] = parse_int(job.get("salary_min"))
    job["salary_max"] = parse_int(job.get("salary_max"))
    job["match_score"] = parse_int(job.get("match_score")) or 0
    job["company"] = str(job.get("company") or "").strip()
    job["title"] = str(job.get("title") or "").strip()
    job["experience"] = normalize_label(job.get("experience"), UNKNOWN_ALIASES)
    job["platform"] = normalize_label(job.get("platform"), UNKNOWN_ALIASES)
    return job


def match_color(score: int) -> str:
    if score >= 80:
        return COLOR_HIGH
    if score >= 60:
        return COLOR_MID
    return COLOR_LOW


def ensure_output_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def plot_salary_range(jobs: list[dict[str, Any]], output_dir: Path, top_n: int) -> None:
    filtered = [job for job in jobs if job["salary_min"] and job["salary_max"]]
    if not filtered:
        return

    filtered.sort(key=lambda x: x.get("match_score", 0), reverse=True)
    top_jobs = filtered[:top_n]

    labels = [f"{job['company']} {job['title']}".strip() for job in top_jobs]
    min_vals = [job["salary_min"] for job in top_jobs]
    max_vals = [job["salary_max"] for job in top_jobs]
    widths = [max_v - min_v for min_v, max_v in zip(min_vals, max_vals)]
    colors = [match_color(job.get("match_score", 0)) for job in top_jobs]

    fig, ax = plt.subplots(figsize=(12, max(6, len(top_jobs) * 0.5)))
    y_pos = np.arange(len(top_jobs))
    ax.barh(y_pos, widths, left=min_vals, color=colors, alpha=0.85)

    for idx, (low, high) in enumerate(zip(min_vals, max_vals)):
        ax.text(high + 300, idx, f"{low/1000:.0f}K-{high/1000:.0f}K", va="center", fontsize=9)

    ax.set_yticks(y_pos)
    ax.set_yticklabels(labels, fontsize=9)
    ax.set_xlabel("月薪 (元)", fontsize=11)
    ax.set_title("岗位薪资范围对比", fontsize=14, fontweight="bold")
    ax.invert_yaxis()
    plt.tight_layout()
    plt.savefig(output_dir / "salary_range.png", dpi=150)
    plt.close()


def plot_experience_distribution(jobs: list[dict[str, Any]], output_dir: Path) -> None:
    counts: dict[str, int] = {}
    for job in jobs:
        key = normalize_label(job.get("experience"), UNKNOWN_ALIASES)
        counts[key] = counts.get(key, 0) + 1

    known_counts = filter_known_counts(counts, MIN_KNOWN_RATIO)
    if not known_counts:
        return

    labels = list(known_counts.keys())
    values = list(known_counts.values())
    colors = [COLOR_HIGH, COLOR_MID, "#45B7D1", "#96CEB4", "#FFEAA7", "#DDA0DD"]

    fig, ax = plt.subplots(figsize=(8, 6))
    ax.pie(values, labels=labels, autopct="%1.1f%%", colors=colors[: len(values)], startangle=90)
    ax.set_title("岗位经验要求分布", fontsize=14, fontweight="bold")
    plt.tight_layout()
    plt.savefig(output_dir / "experience_distribution.png", dpi=150)
    plt.close()


def plot_platform_comparison(jobs: list[dict[str, Any]], output_dir: Path) -> None:
    counts: dict[str, int] = {}
    for job in jobs:
        key = normalize_label(job.get("platform"), UNKNOWN_ALIASES)
        counts[key] = counts.get(key, 0) + 1

    known_counts = filter_known_counts(counts, MIN_KNOWN_RATIO)
    if not known_counts:
        return

    labels = list(known_counts.keys())
    values = list(known_counts.values())

    fig, ax = plt.subplots(figsize=(8, 5))
    bars = ax.bar(labels, values, color=[COLOR_HIGH, COLOR_MID, "#45B7D1"])
    for bar, value in zip(bars, values):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.1, str(value), ha="center", va="bottom", fontsize=10)

    ax.set_xlabel("招聘平台", fontsize=11)
    ax.set_ylabel("岗位数量", fontsize=11)
    ax.set_title("平台岗位数量对比", fontsize=14, fontweight="bold")
    plt.tight_layout()
    plt.savefig(output_dir / "platform_comparison.png", dpi=150)
    plt.close()


def plot_match_ranking(jobs: list[dict[str, Any]], output_dir: Path, top_n: int) -> None:
    if not jobs:
        return

    sorted_jobs = sorted(jobs, key=lambda x: x.get("match_score", 0), reverse=True)[:top_n]
    labels = [f"{job['company']} {job['title']}".strip() for job in sorted_jobs]
    scores = [job.get("match_score", 0) for job in sorted_jobs]
    colors = [match_color(score) for score in scores]

    fig, ax = plt.subplots(figsize=(12, max(6, len(sorted_jobs) * 0.5)))
    y_pos = np.arange(len(sorted_jobs))
    ax.barh(y_pos, scores, color=colors, alpha=0.85)

    for idx, score in enumerate(scores):
        ax.text(score + 1, idx, f"{score}", va="center", fontsize=9, fontweight="bold")

    ax.set_yticks(y_pos)
    ax.set_yticklabels(labels, fontsize=9)
    ax.set_xlabel("匹配度", fontsize=11)
    ax.set_title("岗位匹配度排名", fontsize=14, fontweight="bold")
    ax.set_xlim(0, 100)
    ax.invert_yaxis()
    plt.tight_layout()
    plt.savefig(output_dir / "match_ranking.png", dpi=150)
    plt.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate charts for job search report")
    parser.add_argument("--input", required=True, help="Path to jobs_data.json or jobs_data.csv")
    parser.add_argument("--output", required=True, help="Output directory for charts")
    parser.add_argument("--top", type=int, default=12, help="Top N jobs to visualize")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_dir = Path(args.output)

    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    ensure_output_dir(output_dir)

    plt.rcParams["font.sans-serif"] = ["Noto Sans CJK SC", "SimHei", "Arial Unicode MS", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False

    jobs = load_jobs(input_path)
    if not jobs:
        raise ValueError("No job data found in input")

    plot_salary_range(jobs, output_dir, args.top)
    plot_experience_distribution(jobs, output_dir)
    plot_platform_comparison(jobs, output_dir)
    plot_match_ranking(jobs, output_dir, args.top)


if __name__ == "__main__":
    main()
