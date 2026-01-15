#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass
class SlideSpec:
    index: int
    kind: str
    title: str
    core: str
    visual: str


@dataclass
class Section:
    title: str
    level: int
    lines: list[str]


BASE_CSS = r"""
:root {
  --bg: #070B14;
  --card: #0D1526;
  --card-2: #111C33;
  --text: #E6F0FF;
  --muted: #9FB2D9;
  --accent: #00D4FF;
  --accent-2: #5B8CFF;
  --stroke: #1B2A46;
  --pad-x: 88px;
  --pad-y: 64px;
}
html, body {
  width: 1280px;
  height: 720px;
  margin: 0;
  padding: 0;
}
body {
  background-color: var(--bg);
  background-image:
    radial-gradient(900px 480px at 10% 15%, rgba(0, 212, 255, 0.1), transparent 60%),
    radial-gradient(900px 480px at 85% 20%, rgba(91, 140, 255, 0.1), transparent 60%),
    linear-gradient(rgba(255, 255, 255, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
  background-size: auto, auto, 40px 40px, 40px 40px;
  color: var(--text);
  font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
}
.slide {
  box-sizing: border-box;
  width: 1280px;
  height: 720px;
  padding: var(--pad-y) var(--pad-x);
  position: relative;
}
.header {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 26px;
}
.section-title {
  font-size: 40px;
  font-weight: 700;
}
.subtitle {
  font-size: 20px;
  color: var(--muted);
}
.accent {
  color: var(--accent);
}
.card {
  background: var(--card);
  border: 1px solid var(--stroke);
  border-radius: 16px;
  padding: 20px;
}
.card-title {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 10px;
}
.card-subtitle {
  font-size: 16px;
  color: var(--muted);
  margin-bottom: 8px;
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 18px;
}
.card-grid.three {
  grid-template-columns: repeat(3, 1fr);
}
.kpi {
  display: flex;
  gap: 16px;
  align-items: center;
  margin-bottom: 16px;
}
.kpi .score {
  font-size: 48px;
  font-weight: 700;
  color: var(--accent);
}
.kpi .desc {
  font-size: 18px;
  color: var(--muted);
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 18px;
}
.table th {
  text-align: left;
  padding: 12px 14px;
  background: var(--card-2);
  color: var(--accent);
  border-bottom: 1px solid var(--stroke);
}
.table td {
  padding: 12px 14px;
  border-bottom: 1px solid var(--stroke);
  color: var(--text);
}
.list {
  margin: 0;
  padding-left: 20px;
  font-size: 18px;
  line-height: 1.55;
}
.list li {
  margin-bottom: 8px;
}
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
.timeline {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.timeline-item {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.timeline-tag {
  min-width: 120px;
  padding: 6px 10px;
  border-radius: 10px;
  text-align: center;
  background: rgba(0, 212, 255, 0.12);
  color: var(--accent);
  font-size: 14px;
  border: 1px solid rgba(0, 212, 255, 0.3);
}
.timeline-body {
  background: var(--card);
  border: 1px solid var(--stroke);
  border-radius: 12px;
  padding: 12px 16px;
  flex: 1;
}
.kv {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 18px;
}
.kv-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}
.kv-label {
  color: var(--muted);
}
.cover-title {
  font-size: 52px;
  font-weight: 700;
  margin-bottom: 16px;
  text-align: center;
}
.cover-sub {
  font-size: 22px;
  color: var(--muted);
  margin-bottom: 22px;
  text-align: center;
}
.cover-card {
  width: 560px;
  margin: 0 auto;
}
.transition {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 520px;
  gap: 16px;
}
.transition-title {
  font-size: 48px;
  font-weight: 700;
}
.transition-sub {
  font-size: 20px;
  color: var(--muted);
}
"""

HTML_TEMPLATE = """<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <style>
{css}
    </style>
  </head>
  <body>
{body}
  </body>
</html>
"""


def clean_text(text: str) -> str:
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"__([^_]+)__", r"\1", text)
    text = re.sub(r"\[(.*?)\]\([^)]*\)", r"\1", text)
    text = text.replace("**", "")
    return text.strip()


def parse_report_sections(text: str) -> list[Section]:
    sections: list[Section] = []
    current: Section | None = None
    in_code = False
    for line in text.splitlines():
        if line.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        heading = re.match(r"^(#{1,6})\\s+(.*)", line)
        if heading:
            if current:
                sections.append(current)
            level = len(heading.group(1))
            title = clean_text(heading.group(2))
            current = Section(title=title, level=level, lines=[])
            continue
        if current is not None:
            current.lines.append(line.rstrip())
    if current:
        sections.append(current)
    return sections


def extract_markdown_table(lines: list[str]) -> list[list[str]]:
    rows: list[list[str]] = []
    header: list[str] | None = None
    for line in lines:
        if not line.strip().startswith("|"):
            break
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if header is None:
            header = cells
            continue
        if all(re.match(r"^-+$", c.replace(" ", "")) for c in cells):
            continue
        rows.append(cells)
    if header and rows:
        return [header] + rows
    return []


def extract_bullets(lines: list[str]) -> list[str]:
    bullets: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        bullet = re.match(r"^[-*+]\\s+(.*)$", stripped)
        numbered = re.match(r"^\\d+\\.\\s+(.*)$", stripped)
        if bullet:
            bullets.append(clean_text(bullet.group(1)))
        elif numbered:
            bullets.append(clean_text(numbered.group(1)))
    return bullets


def extract_grouped_items(lines: list[str]) -> list[dict[str, list[str] | str]]:
    groups: list[dict[str, list[str] | str]] = []
    current: dict[str, list[str] | str] | None = None
    for line in lines:
        title_match = re.match(r"^\\d+\\.\\s+\\*\\*(.+?)\\*\\*\\s*(.*)$", line.strip())
        if title_match:
            if current:
                groups.append(current)
            title = clean_text(title_match.group(1))
            tail = clean_text(title_match.group(2))
            if tail:
                title = f"{title} {tail}".strip()
            current = {"title": title, "items": []}
            continue
        bullet = re.match(r"^\\s*[-*+]\\s+(.*)$", line)
        if bullet and current:
            current["items"].append(clean_text(bullet.group(1)))
    if current:
        groups.append(current)
    return groups


def extract_student_info(sections: list[Section]) -> dict[str, str]:
    info: dict[str, str] = {}
    for section in sections:
        if "学生信息" in section.title:
            for line in section.lines:
                match = re.match(r"^\\s*-\\s*\\*\\*(.+?)\\*\\*[:：]\\s*(.+)$", line)
                if match:
                    info[clean_text(match.group(1))] = clean_text(match.group(2))
            break
    return info


def parse_mermaid_gantt(text: str) -> list[dict[str, list[str]]]:
    sections: list[dict[str, list[str]]] = []
    in_mermaid = False
    current: dict[str, list[str]] | None = None
    for line in text.splitlines():
        if line.strip().startswith("```mermaid"):
            in_mermaid = True
            continue
        if in_mermaid and line.strip().startswith("```"):
            in_mermaid = False
            continue
        if not in_mermaid:
            continue
        section_match = re.match(r"\\s*section\\s+(.+)", line)
        if section_match:
            current = {"title": clean_text(section_match.group(1)), "items": []}
            sections.append(current)
            continue
        task_match = re.match(r"\\s*([^:]+):\\s*(.+)", line)
        if task_match and current:
            task = clean_text(task_match.group(1))
            if task:
                current["items"].append(task)
    return sections


def parse_plan(plan_text: str) -> tuple[str, list[str], list[SlideSpec]]:
    title = "PPT 报告"
    toc: list[str] = []
    slides: list[SlideSpec] = []
    lines = plan_text.splitlines()
    for line in lines:
        if line.startswith("#") and "标题" in line:
            title = clean_text(line.split("：", 1)[-1]) if "：" in line else clean_text(line.split(":", 1)[-1])
            break
    if title == "PPT 报告":
        for line in lines:
            if line.startswith("# "):
                title = clean_text(line[2:])
                break

    in_toc = False
    for line in lines:
        if line.strip().startswith("## 目录"):
            in_toc = True
            continue
        if in_toc and line.strip().startswith("## "):
            in_toc = False
        if in_toc:
            match = re.match(r"\\d+\\.\\s+(.*)", line.strip())
            if match:
                toc.append(clean_text(match.group(1)))

    table_lines: list[str] = []
    in_table = False
    for line in lines:
        if line.strip().startswith("## 分页计划"):
            in_table = True
            continue
        if in_table and line.strip().startswith("## "):
            break
        if in_table:
            if "|" in line:
                table_lines.append(line)
            elif table_lines:
                break

    table = extract_markdown_table(table_lines)
    if table:
        header = table[0]
        idx_map = {name: idx for idx, name in enumerate(header)}
        for row in table[1:]:
            def cell(name: str) -> str:
                return row[idx_map.get(name, 0)] if idx_map.get(name, -1) < len(row) else ""

            page_raw = cell("页码") or cell("页")
            try:
                page = int(re.sub(r"\\D", "", page_raw)) if page_raw else len(slides) + 1
            except ValueError:
                page = len(slides) + 1

            slides.append(
                SlideSpec(
                    index=page,
                    kind=cell("类型") or "内容",
                    title=cell("标题") or "",
                    core=cell("核心信息点") or "",
                    visual=cell("视觉/素材") or cell("可视化/素材") or "",
                )
            )
    return title, toc, slides


def tokenize(title: str) -> list[str]:
    cleaned = re.sub(r"[·•—–\\-()/（）:：]", " ", title)
    tokens = [t.strip() for t in cleaned.split() if len(t.strip()) >= 2]
    return tokens


def normalize(text: str) -> str:
    return re.sub(r"[\\s\\W_]+", "", text)


def find_section(title: str, sections: list[Section]) -> Section | None:
    tokens = tokenize(title)
    best: Section | None = None
    best_score = 0
    title_norm = normalize(title)
    for section in sections:
        score = 0
        section_norm = normalize(section.title)
        if title_norm and (title_norm in section_norm or section_norm in title_norm):
            score += 2
        for token in tokens:
            if token in section.title:
                score += 1
        if score > best_score:
            best_score = score
            best = section
    return best if best_score > 0 else None


def render_cover(deck_title: str, student_info: dict[str, str]) -> str:
    name = student_info.get("姓名", "学生")
    grade = student_info.get("年级", "在读")
    target = student_info.get("目标岗位", "目标岗位")
    time = student_info.get("评估时间", "")
    period = student_info.get("规划周期", "")
    return f"""
    <div class="slide">
      <div class="cover-title">{deck_title}</div>
      <div class="cover-sub">目标岗位 · {target} {f"· {time}" if time else ""}</div>
      <div class="card cover-card">
        <div class="card-title">学生信息</div>
        <div class="card-subtitle">{name} · {grade}</div>
        <div class="kv">
          <div class="kv-row"><span class="kv-label">目标岗位</span><span>{target}</span></div>
          <div class="kv-row"><span class="kv-label">规划周期</span><span>{period or "—"}</span></div>
        </div>
      </div>
    </div>
    """


def render_toc(toc: list[str]) -> str:
    items = "\n".join(f"<li>{item}</li>" for item in toc[:8])
    return f"""
    <div class="slide">
      <div class="header">
        <div class="section-title">目录</div>
        <div class="subtitle">6 个章节，逐步推进从诊断到行动</div>
      </div>
      <div class="card">
        <ol class="list">
          {items}
        </ol>
      </div>
    </div>
    """


def render_transition(title: str, subtitle: str) -> str:
    subtitle = subtitle or "本章聚焦关键结论与行动要点"
    return f"""
    <div class="slide">
      <div class="transition">
        <div class="transition-title">{title}</div>
        <div class="transition-sub">{subtitle}</div>
      </div>
    </div>
    """


def render_thanks(title: str, subtitle: str) -> str:
    subtitle = subtitle or "感谢阅读，期待下一步行动"
    title = title or "致谢"
    return f"""
    <div class="slide">
      <div class="transition">
        <div class="transition-title">{title}</div>
        <div class="transition-sub">{subtitle}</div>
      </div>
    </div>
    """


def render_table(title: str, subtitle: str, table: list[list[str]]) -> str:
    header = table[0]
    rows = table[1:]
    header_html = "".join(f"<th>{clean_text(h)}</th>" for h in header)
    row_html = []
    for row in rows:
        cells = "".join(f"<td>{clean_text(cell)}</td>" for cell in row)
        row_html.append(f"<tr>{cells}</tr>")
    return f"""
    <div class="slide">
      <div class="header">
        <div class="section-title">{title}</div>
        <div class="subtitle">{subtitle}</div>
      </div>
      <table class="table">
        <thead><tr>{header_html}</tr></thead>
        <tbody>
          {''.join(row_html)}
        </tbody>
      </table>
    </div>
    """


def render_cards(title: str, subtitle: str, groups: list[dict[str, list[str] | str]]) -> str:
    cards = []
    for group in groups[:4]:
        items = group.get("items", [])
        items_html = "\n".join(f"<li>{clean_text(item)}</li>" for item in items[:4])
        cards.append(
            f"""
            <div class="card">
              <div class="card-title">{clean_text(str(group.get('title', '重点')))}</div>
              <ul class="list">
                {items_html}
              </ul>
            </div>
            """
        )
    return f"""
    <div class="slide">
      <div class="header">
        <div class="section-title">{title}</div>
        <div class="subtitle">{subtitle}</div>
      </div>
      <div class="card-grid">
        {''.join(cards)}
      </div>
    </div>
    """


def render_list(title: str, subtitle: str, bullets: list[str]) -> str:
    bullets = bullets[:8] if bullets else []
    if len(bullets) > 5:
        mid = (len(bullets) + 1) // 2
        left = "\n".join(f"<li>{clean_text(item)}</li>" for item in bullets[:mid])
        right = "\n".join(f"<li>{clean_text(item)}</li>" for item in bullets[mid:])
        return f"""
        <div class="slide">
          <div class="header">
            <div class="section-title">{title}</div>
            <div class="subtitle">{subtitle}</div>
          </div>
          <div class="two-col">
            <div class="card"><ul class="list">{left}</ul></div>
            <div class="card"><ul class="list">{right}</ul></div>
          </div>
        </div>
        """
    items_html = "\n".join(f"<li>{clean_text(item)}</li>" for item in bullets)
    return f"""
    <div class="slide">
      <div class="header">
        <div class="section-title">{title}</div>
        <div class="subtitle">{subtitle}</div>
      </div>
      <div class="card">
        <ul class="list">
          {items_html}
        </ul>
      </div>
    </div>
    """


def render_timeline(title: str, subtitle: str, stages: list[dict[str, list[str]]]) -> str:
    items_html = []
    for stage in stages[:4]:
        tasks = " · ".join(stage["items"][:3]) if stage["items"] else "阶段任务梳理"
        items_html.append(
            f"""
            <div class="timeline-item">
              <div class="timeline-tag">{clean_text(stage['title'])}</div>
              <div class="timeline-body">
                <div class="card-title">{clean_text(stage['title'])}</div>
                <div>{clean_text(tasks)}</div>
              </div>
            </div>
            """
        )
    return f"""
    <div class="slide">
      <div class="header">
        <div class="section-title">{title}</div>
        <div class="subtitle">{subtitle}</div>
      </div>
      <div class="timeline">
        {''.join(items_html)}
      </div>
    </div>
    """


def wrap_html(body: str) -> str:
    return HTML_TEMPLATE.format(css=BASE_CSS, body=body)


def write_slide(out_dir: Path, index: int, body: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"slide-{index:03d}.html"
    path.write_text(wrap_html(body), encoding="utf-8")


def build_slides(report_text: str, plan_text: str, out_dir: Path) -> int:
    deck_title, toc, slides = parse_plan(plan_text)
    sections = parse_report_sections(report_text)
    student_info = extract_student_info(sections)
    gantt_sections = parse_mermaid_gantt(report_text)

    total = 0
    for spec in slides:
        kind = spec.kind.strip()
        title = spec.title.strip() or deck_title
        subtitle = spec.core.strip()
        if kind == "封面":
            body = render_cover(deck_title, student_info)
        elif kind == "目录":
            body = render_toc(toc)
        elif kind == "过渡":
            body = render_transition(title, subtitle)
        elif kind == "致谢":
            body = render_thanks(title, subtitle)
        else:
            section = find_section(title, sections)
            bullets = extract_bullets(section.lines) if section else []
            table = extract_markdown_table(section.lines) if section else []
            groups = extract_grouped_items(section.lines) if section else []
            if ("时间线" in spec.visual) or ("路线图" in title and gantt_sections):
                body = render_timeline(title, subtitle or "阶段节奏与任务安排", gantt_sections or [])
            elif ("表格" in spec.visual or "表" in spec.visual) and table:
                body = render_table(title, subtitle or "核心数据汇总", table)
            elif ("卡片" in spec.visual or "网格" in spec.visual or "优势" in title) and groups:
                body = render_cards(title, subtitle or "核心优势概览", groups)
            elif table:
                body = render_table(title, subtitle or "核心数据汇总", table)
            else:
                fallback = bullets or [subtitle] if subtitle else ["内容待补充"]
                body = render_list(title, subtitle or "核心信息点", fallback)

        write_slide(out_dir, spec.index, body)
        total += 1
    return total


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate HTML slides from report.md and plan.md.")
    parser.add_argument("--report", required=True, help="Path to report.md")
    parser.add_argument("--plan", required=True, help="Path to plan.md")
    parser.add_argument("--out-dir", default="workspace/html2pptx/slides", help="Output slides directory")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report_text = Path(args.report).read_text(encoding="utf-8")
    plan_text = Path(args.plan).read_text(encoding="utf-8")
    out_dir = Path(args.out_dir)
    total = build_slides(report_text, plan_text, out_dir)
    print(f"Generated {total} slides in {out_dir}")


if __name__ == "__main__":
    main()
