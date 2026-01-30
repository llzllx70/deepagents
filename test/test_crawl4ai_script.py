import asyncio

from crawl4ai import AsyncWebCrawler, AdaptiveCrawler


def test_crawl4ai_nbc_business():
    async def run() -> None:
        async with AsyncWebCrawler() as crawler:
            result = await crawler.arun(
                # url="https://www.nbcnews.com/business",
                # url="https://www.sina.com.cn",
                url='https://zhipin.com/hangzhou/?seoRefer=index'
            )
            print(result.markdown)
            assert result is not None
            assert result.markdown

    asyncio.run(run())


def test_2():
    async def run() -> None:
        async with AsyncWebCrawler() as crawler:
            # Create an adaptive crawler (config is optional)
            adaptive = AdaptiveCrawler(crawler)

            # Start crawling with a query
            result = await adaptive.digest(
                # start_url="https://docs.python.org/3/",
                # query="async context managers"
                start_url = 'https://www.zhipin.com/hangzhou/?seoRefer=index',
                query = 'ai训练师',
                max_depth = 3
            )

            # View statistics
            adaptive.print_stats()

            # Get the most relevant content
            relevant_pages = adaptive.get_relevant_content(top_k=10)
            for page in relevant_pages:
                print(f"- {page['url']} (score: {page['score']:.2f})")

    asyncio.run(run())