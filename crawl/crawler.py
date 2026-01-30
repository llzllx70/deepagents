from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import re
import time
from collections import Counter, deque
from dataclasses import dataclass
from typing import Any, Iterable
from urllib.parse import urldefrag, urljoin, urlparse

from bs4 import BeautifulSoup
import httpx
from playwright.async_api import async_playwright
from openai import OpenAI

LOG = logging.getLogger("query_crawler")


@dataclass(frozen=True)
class CrawlConfig:
    start_url: str
    query: str
    max_depth: int
    max_items: int
    top_k: int = 5
    max_links_per_page: int = 80
    relevance_threshold: float = 0.18
    llm_model: str = "gpt-4o-mini"
    llm_base_url: str | None = None
    llm_api_key_env: str = "OPENAI_API_KEY"
    output_path: str = "crawl/results.jsonl"
    per_page_text_limit: int = 8000
    fetcher: str = "playwright"
    save_pages: bool = True
    pages_dir: str = "crawl/pages"
    headless: bool = True
    page_wait_ms: int = 1000


def _tokenize(text: str) -> list[str]:
    return re.findall(r"[a-zA-Z0-9\u4e00-\u9fff]+", text.lower())


def _score_text(query_tokens: list[str], text: str) -> float:
    if not query_tokens:
        return 0.0
    tokens = _tokenize(text)
    if not tokens:
        return 0.0
    counts = Counter(tokens)
    hits = 0.0
    for token in query_tokens:
        if token in counts:
            hits += min(counts[token], 2)
    return hits / max(len(query_tokens) * 2, 1)


def _normalize_url(base_url: str, href: str) -> str | None:
    href = href.strip()
    if not href or href.startswith("#"):
        return None
    lowered = href.lower()
    if lowered.startswith(("javascript:", "mailto:", "tel:")):
        return None
    joined = urljoin(base_url, href)
    joined, _ = urldefrag(joined)
    parsed = urlparse(joined)
    if parsed.scheme not in {"http", "https"}:
        return None
    return joined


def _extract_page_text(html: str) -> tuple[str, str]:
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "noscript", "svg", "iframe"]):
        tag.decompose()
    title = soup.title.get_text(strip=True) if soup.title else ""
    chunks: list[str] = []
    for tag in soup.find_all(["h1", "h2", "h3", "p", "li", "article", "section"]):
        text = tag.get_text(" ", strip=True)
        if text and len(text) >= 20:
            chunks.append(text)
    return title, "\n".join(chunks)


def _inject_base_tag(html: str, base_url: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    if not soup.head:
        head = soup.new_tag("head")
        if soup.html:
            soup.html.insert(0, head)
        else:
            soup.insert(0, head)
    base = soup.head.find("base")
    if not base:
        base = soup.new_tag("base", href=base_url)
        soup.head.insert(0, base)
    return str(soup)


def _safe_page_filename(url: str) -> str:
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()
    return f"{digest}.html"


def _save_page(html: str, url: str, output_dir: str) -> str:
    os.makedirs(output_dir, exist_ok=True)
    filename = _safe_page_filename(url)
    path = os.path.join(output_dir, filename)
    html_with_base = _inject_base_tag(html, url)
    with open(path, "w", encoding="utf-8") as f:
        f.write(html_with_base)
    return path


def _select_relevant_excerpt(query_tokens: list[str], text: str, limit: int) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return ""
    scored: list[tuple[float, str]] = [
        (_score_text(query_tokens, line), line) for line in lines
    ]
    scored.sort(key=lambda item: item[0], reverse=True)
    excerpt: list[str] = []
    total = 0
    for score, line in scored:
        if score <= 0 and excerpt:
            break
        if total + len(line) + 1 > limit:
            continue
        excerpt.append(line)
        total += len(line) + 1
        if total >= limit:
            break
    if not excerpt:
        return "\n".join(lines[: max(1, limit // 200)])
    return "\n".join(excerpt)


def _extract_links(html: str, base_url: str, limit: int) -> list[dict[str, str]]:
    soup = BeautifulSoup(html, "lxml")
    links: list[dict[str, str]] = []
    for anchor in soup.find_all("a", href=True):
        href = str(anchor.get("href", "")).strip()
        url = _normalize_url(base_url, href)
        if not url:
            continue
        text = anchor.get_text(" ", strip=True)
        links.append({"url": url, "text": text})
        if len(links) >= limit:
            break
    return links


def _rank_links(query_tokens: list[str], links: Iterable[dict[str, str]]) -> list[dict[str, Any]]:
    ranked: list[dict[str, Any]] = []
    for link in links:
        text = link.get("text", "")
        url = link.get("url", "")
        url_score = _score_text(query_tokens, url)
        text_score = _score_text(query_tokens, text)
        score = text_score * 0.8 + url_score * 0.2
        ranked.append({**link, "score": score})
    ranked.sort(key=lambda item: item["score"], reverse=True)
    return ranked


def _init_openai_client(config: CrawlConfig) -> OpenAI | None:
    api_key = os.getenv(config.llm_api_key_env, "").strip()
    if not api_key:
        return None
    if config.llm_base_url:
        return OpenAI(api_key=api_key, base_url=config.llm_base_url)
    return OpenAI(api_key=api_key)


def _parse_jsonish(text: str) -> dict[str, Any]:
    if not text:
        return {}
    try:
        payload = json.loads(text)
        if isinstance(payload, dict):
            return payload
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if match:
        try:
            payload = json.loads(match.group(0))
            if isinstance(payload, dict):
                return payload
        except json.JSONDecodeError:
            pass
    return {"raw": text.strip()}


def _build_llm_messages(query: str, url: str, excerpt: str) -> list[dict[str, str]]:
    system = (
        "You are a data extraction assistant. Extract only content relevant to the query. "
        "Return JSON with keys: relevant (bool), relevance_score (0-1), summary, key_points "
        "(array of short strings), snippets (array of text snippets)."
    )
    user = (
        f"Query: {query}\n"
        f"URL: {url}\n"
        "Page excerpt:\n"
        f"{excerpt}\n"
        "Return JSON only."
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _run_llm_extract(client: OpenAI, model: str, query: str, url: str, excerpt: str) -> dict[str, Any]:
    completion = client.chat.completions.create(
        model=model,
        messages=_build_llm_messages(query, url, excerpt),
        temperature=0,
        max_tokens=800,
    )
    content = completion.choices[0].message.content or ""
    return _parse_jsonish(content)


async def _llm_extract(
    client: OpenAI | None,
    config: CrawlConfig,
    query: str,
    url: str,
    excerpt: str,
) -> dict[str, Any]:
    if client is None:
        return {"error": "missing_api_key", "relevant": False}
    return await asyncio.to_thread(_run_llm_extract, client, config.llm_model, query, url, excerpt)


async def _fetch_html_httpx(client: httpx.AsyncClient, url: str) -> str:
    response = await client.get(url)
    if response.status_code >= 400:
        raise RuntimeError(f"http status {response.status_code}")
    return response.text or ""


async def _fetch_html_playwright(browser: Any, url: str, wait_ms: int) -> str:
    context = await browser.new_context(
        user_agent=(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0 Safari/537.36"
        ),
        locale="zh-CN",
        viewport={"width": 1280, "height": 720},
        java_script_enabled=True,
    )
    page = await context.new_page()
    try:
        await page.goto(url, wait_until="networkidle", timeout=35000)
        if wait_ms > 0:
            await page.wait_for_timeout(wait_ms)
        html = await page.content()
    finally:
        await context.close()
    return html or ""


class QueryCrawler:
    def __init__(self, config: CrawlConfig) -> None:
        self.config = config
        self.client = _init_openai_client(config)
        self.visited: set[str] = set()
        self.results: list[dict[str, Any]] = []

    async def crawl(self) -> list[dict[str, Any]]:
        query_tokens = _tokenize(self.config.query)
        queue = deque([(self.config.start_url, 0)])
        os.makedirs(os.path.dirname(self.config.output_path), exist_ok=True)

        timeout = httpx.Timeout(20.0, connect=10.0)
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0 Safari/537.36"
            )
        }
        async with httpx.AsyncClient(timeout=timeout, headers=headers, follow_redirects=True) as httpx_client:
            if self.config.fetcher == "playwright":
                async with async_playwright() as pw:
                    browser = await pw.chromium.launch(
                        headless=self.config.headless,
                        args=["--disable-blink-features=AutomationControlled"],
                    )
                    try:
                        await self._crawl_loop(queue, query_tokens, httpx_client, browser)
                    finally:
                        await browser.close()
            else:
                await self._crawl_loop(queue, query_tokens, httpx_client, None)

        return self.results

    async def _crawl_loop(
        self,
        queue: deque[tuple[str, int]],
        query_tokens: list[str],
        httpx_client: httpx.AsyncClient,
        browser: Any | None,
    ) -> None:
        while queue and len(self.results) < self.config.max_items:
            url, depth = queue.popleft()
            if url in self.visited:
                continue
            if depth > self.config.max_depth:
                continue
            self.visited.add(url)
            LOG.info("fetching url=%s depth=%s", url, depth)

            html = ""
            try:
                if self.config.fetcher == "playwright" and browser is not None:
                    html = await _fetch_html_playwright(browser, url, self.config.page_wait_ms)
                else:
                    html = await _fetch_html_httpx(httpx_client, url)
            except Exception as exc:
                if self.config.fetcher == "playwright":
                    LOG.warning("playwright failed url=%s error=%s; fallback to httpx", url, exc)
                    try:
                        html = await _fetch_html_httpx(httpx_client, url)
                    except Exception as fallback_exc:
                        LOG.warning("httpx failed url=%s error=%s", url, fallback_exc)
                        continue
                else:
                    LOG.warning("httpx failed url=%s error=%s", url, exc)
                    continue

            if not html:
                continue

            saved_path = None
            if self.config.save_pages:
                saved_path = _save_page(html, url, self.config.pages_dir)

            title, text = _extract_page_text(html)
            relevance_score = _score_text(query_tokens, f"{title}\n{text}")

            if relevance_score >= self.config.relevance_threshold:
                excerpt = _select_relevant_excerpt(query_tokens, text, self.config.per_page_text_limit)
                llm_payload = await _llm_extract(self.client, self.config, self.config.query, url, excerpt)
                item = {
                    "url": url,
                    "depth": depth,
                    "title": title,
                    "relevance_score": round(relevance_score, 4),
                    "llm": llm_payload,
                    "saved_path": saved_path,
                    "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
                self._append_result(item)

            if depth < self.config.max_depth:
                links = _extract_links(html, url, self.config.max_links_per_page)
                ranked = _rank_links(query_tokens, links)
                for link in ranked[: self.config.top_k]:
                    link_url = link["url"]
                    if link_url not in self.visited:
                        queue.append((link_url, depth + 1))

    def _append_result(self, item: dict[str, Any]) -> None:
        self.results.append(item)
        with open(self.config.output_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")


def _build_config_from_args(args: argparse.Namespace) -> CrawlConfig:
    return CrawlConfig(
        start_url=args.url,
        query=args.query,
        max_depth=args.depth,
        max_items=args.num,
        top_k=args.top_k,
        relevance_threshold=args.threshold,
        llm_model=args.model,
        llm_base_url=args.base_url,
        output_path=args.output,
        fetcher=args.fetcher,
        save_pages=not args.no_save,
        pages_dir=args.pages_dir,
        headless=not args.headful,
        page_wait_ms=args.wait_ms,
    )


async def _run_cli(args: argparse.Namespace) -> None:
    config = _build_config_from_args(args)
    crawler = QueryCrawler(config)
    results = await crawler.crawl()
    print(json.dumps({"count": len(results), "results": results}, ensure_ascii=False, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="Query-focused crawler with LLM extraction.")
    parser.add_argument("--url", required=True, help="Start URL")
    parser.add_argument("--query", required=True, help="Search query")
    parser.add_argument("--depth", type=int, default=2, help="Max depth")
    parser.add_argument("--num", type=int, default=10, help="Max result items")
    parser.add_argument("--top-k", type=int, default=5, help="Top K links per page")
    parser.add_argument("--threshold", type=float, default=0.18, help="Relevance threshold")
    parser.add_argument("--model", default=os.getenv("CRAWL_LLM_MODEL", "gpt-4o-mini"))
    parser.add_argument("--base-url", default=os.getenv("CRAWL_LLM_BASE_URL"))
    parser.add_argument("--output", default="crawl/results.jsonl")
    parser.add_argument(
        "--fetcher",
        choices=["playwright", "httpx"],
        default=os.getenv("CRAWL_FETCHER", "playwright"),
        help="Fetcher backend (playwright handles JS/anti-bot better).",
    )
    parser.add_argument("--pages-dir", default="crawl/pages", help="Directory to save HTML pages")
    parser.add_argument("--no-save", action="store_true", help="Disable saving HTML pages")
    parser.add_argument("--headful", action="store_true", help="Run Playwright in headful mode")
    parser.add_argument("--wait-ms", type=int, default=1000, help="Extra wait time after navigation (ms)")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(_run_cli(args))


if __name__ == "__main__":
    main()
