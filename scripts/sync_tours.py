#!/usr/bin/env python3
"""
CodeTour 同步工具 — 检测并修正 .tour 文件中因代码变更导致的行号漂移。

用法：
  python scripts/sync_tours.py          # 仅检测，打印漂移报告
  python scripts/sync_tours.py --fix    # 自动修正行号并写回 .tour 文件

退出码：
  0  所有步骤 OK（或修正完成后无 broken）
  1  存在 BROKEN 步骤（pattern 在文件中找不到，需要人工处理）
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
TOURS_DIR = REPO_ROOT / ".tours"
ANCHORS_FILE = REPO_ROOT / "scripts" / "anchors.json"


# ──────────────────────────────────────────────
# 核心工具函数
# ──────────────────────────────────────────────

def grep_file(filepath: Path, pattern: str) -> list[int]:
    """返回文件中 strip 后包含 pattern 的所有行号（1-indexed）。"""
    if not filepath.exists():
        return []
    try:
        lines = filepath.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    return [i + 1 for i, line in enumerate(lines) if pattern in line.strip()]


def nearest(candidates: list[int], target: int) -> int:
    """从候选行号中选出距离 target 最近的一个。"""
    return min(candidates, key=lambda n: abs(n - target))


# ──────────────────────────────────────────────
# 主逻辑
# ──────────────────────────────────────────────

def sync_tours(fix: bool = False) -> bool:
    """
    遍历所有 .tour 文件，按 anchors.json 中的 pattern 检测/修正行号。
    返回 True 表示无 BROKEN 步骤。
    """
    if not ANCHORS_FILE.exists():
        print(f"[ERROR] anchors.json 不存在：{ANCHORS_FILE}", file=sys.stderr)
        return False

    anchors: dict = json.loads(ANCHORS_FILE.read_text(encoding="utf-8"))

    total = drifted = broken = no_anchor = ambiguous = 0
    any_file_changed = False

    for tour_file in sorted(TOURS_DIR.glob("*.tour")):
        tour_name = tour_file.name
        tour_data = json.loads(tour_file.read_text(encoding="utf-8"))
        steps: list[dict] = tour_data.get("steps", [])
        anchor_map: dict[int, str] = {
            a["step"]: a["pattern"]
            for a in anchors.get(tour_name, [])
        }

        file_changed = False
        tour_header_printed = False

        def tour_print(msg: str) -> None:
            nonlocal tour_header_printed
            if not tour_header_printed:
                print(f"\n── {tour_name}")
                tour_header_printed = True
            print(msg)

        for idx, step in enumerate(steps):
            step_num = idx + 1
            total += 1
            current_line: int = step["line"]
            filepath = REPO_ROOT / step["file"]
            pattern = anchor_map.get(step_num)

            # ① 无锚点 → 无法自动处理
            if not pattern:
                no_anchor += 1
                tour_print(
                    f"  [NO ANCHOR]  step {step_num}: {step['file']}:{current_line}"
                )
                continue

            # ② 文件不存在
            if not filepath.exists():
                broken += 1
                tour_print(
                    f"  [BROKEN]     step {step_num}: 文件不存在 {step['file']}"
                )
                continue

            matches = grep_file(filepath, pattern)

            # ③ pattern 在文件中找不到 → 代码可能已重构，需人工处理
            if not matches:
                broken += 1
                tour_print(
                    f"  [BROKEN]     step {step_num}: {step['file']}:{current_line}"
                )
                tour_print(
                    f"               pattern 找不到: {pattern!r}"
                )
                continue

            best = nearest(matches, current_line)

            # ④ 多个匹配 → 标记为模糊，但仍可自动选最近
            if len(matches) > 1:
                ambiguous += 1
                tour_print(
                    f"  [AMBIGUOUS]  step {step_num}: {step['file']}:{current_line}"
                    f"  候选行: {matches}，选 {best}"
                )

            # ⑤ 行号已漂移
            if best != current_line:
                drifted += 1
                if len(matches) == 1:
                    tour_print(
                        f"  [DRIFT]      step {step_num}: {step['file']}:{current_line} → {best}"
                    )
                if fix:
                    step["line"] = best
                    file_changed = True

        # 写回修正后的 tour 文件
        if fix and file_changed:
            tour_file.write_text(
                json.dumps(tour_data, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            tour_print("  → 已写回")
            any_file_changed = True

    # ──────────────────────────────────────────
    # 汇总
    # ──────────────────────────────────────────
    ok = drifted == 0 and broken == 0
    status = "✓ 全部正常" if ok else ("已修正" if fix and drifted > 0 and broken == 0 else "存在问题")

    print(
        f"\n{'─'*50}\n"
        f"总步骤: {total}  |  "
        f"漂移: {drifted}  |  "
        f"BROKEN: {broken}  |  "
        f"无锚点: {no_anchor}  |  "
        f"模糊: {ambiguous}\n"
        f"状态: {status}"
    )

    if broken > 0:
        print(
            "\n[!] BROKEN 步骤需要人工处理：\n"
            "    1. 在源码中找到对应函数/逻辑\n"
            "    2. 更新 .tours/anchors.json 中的 pattern\n"
            "    3. 重新运行 --fix"
        )

    return broken == 0


# ──────────────────────────────────────────────
# 入口
# ──────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="CodeTour 行号同步工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--fix",
        action="store_true",
        help="自动修正漂移的行号并写回 .tour 文件",
    )
    args = parser.parse_args()
    ok = sync_tours(fix=args.fix)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
