"""Tests for web_search topic inference."""

from deepagents_cli import tools


class _DummyTavilyClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def search(
        self,
        query: str,
        *,
        max_results: int,
        include_raw_content: bool,
        topic: str,
    ) -> dict[str, object]:
        self.calls.append(
            {
                "query": query,
                "max_results": max_results,
                "include_raw_content": include_raw_content,
                "topic": topic,
            }
        )
        return {"results": [], "query": query, "topic": topic}


def test_web_search_infers_finance_topic(monkeypatch) -> None:
    """Finance-ish market queries should default to finance."""
    dummy = _DummyTavilyClient()
    monkeypatch.setattr(tools, "tavily_client", dummy)

    result = tools.web_search(query="深度研究A股今天的走势", max_results=3)

    assert result["topic"] == "finance"
    assert dummy.calls[0]["topic"] == "finance"


def test_web_search_infers_news_topic(monkeypatch) -> None:
    """Time-sensitive but non-finance queries should default to news."""
    dummy = _DummyTavilyClient()
    monkeypatch.setattr(tools, "tavily_client", dummy)

    result = tools.web_search(query="today breaking updates on volcanos", max_results=3)

    assert result["topic"] == "news"
    assert dummy.calls[0]["topic"] == "news"


def test_web_search_respects_explicit_topic(monkeypatch) -> None:
    """If the caller sets topic explicitly, do not override."""
    dummy = _DummyTavilyClient()
    monkeypatch.setattr(tools, "tavily_client", dummy)

    result = tools.web_search(query="深度研究A股今天的走势", max_results=3, topic="news")

    assert result["topic"] == "news"
    assert dummy.calls[0]["topic"] == "news"

