import asyncio
import os
from pathlib import Path

import pytest

from crawl.crawler import CrawlConfig, QueryCrawler

DEFAULT_TEST_URL = "https://www.zhipin.com/hangzhou/?seoRefer=index"
DEFAULT_TEST_QUERY = "llm算法工程师"


def test_query_crawler_httpx_smoke(tmp_path: Path) -> None:
    test_url = os.getenv("CRAWL_TEST_URL", "").strip() or DEFAULT_TEST_URL

    output_path = tmp_path / "results.jsonl"
    config = CrawlConfig(
        start_url=test_url,
        query=os.getenv("CRAWL_TEST_QUERY", DEFAULT_TEST_QUERY),
        max_depth=0,
        max_items=1,
        top_k=2,
        relevance_threshold=0.0,
        fetcher="httpx",
        save_pages=False,
        output_path=str(output_path),
    )

    crawler = QueryCrawler(config)
    results = asyncio.run(crawler.crawl())

    assert isinstance(results, list)
    assert output_path.exists()
    if results:
        item = results[0]
        assert "url" in item
        assert "title" in item


def main() -> None:
    test_url = os.getenv("CRAWL_TEST_URL", "").strip() or DEFAULT_TEST_URL

    output_path = Path(os.getenv("CRAWL_TEST_OUTPUT", "crawl/results.jsonl"))
    config = CrawlConfig(
        start_url=test_url,
        query=os.getenv("CRAWL_TEST_QUERY", DEFAULT_TEST_QUERY),
        max_depth=int(os.getenv("CRAWL_TEST_DEPTH", "0")),
        max_items=int(os.getenv("CRAWL_TEST_NUM", "1")),
        top_k=int(os.getenv("CRAWL_TEST_TOPK", "2")),
        relevance_threshold=float(os.getenv("CRAWL_TEST_THRESHOLD", "0.0")),
        fetcher=os.getenv("CRAWL_TEST_FETCHER", "httpx"),
        save_pages=_env_truthy("CRAWL_TEST_SAVE_PAGES"),
        output_path=str(output_path),
    )

    results = asyncio.run(QueryCrawler(config).crawl())
    print(f"Fetched {len(results)} result(s). Output: {output_path}")


if __name__ == "__main__":
    main()
