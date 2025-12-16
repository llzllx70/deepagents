#!/usr/bin/env python3
"""arXiv LLM Paper PDF Downloader.

Searches and downloads the latest LLM papers from arXiv including PDF files.
"""

import argparse
import os
import requests
from datetime import datetime


def download_pdf(url, filepath):
    """Download PDF file from URL."""
    try:
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        with open(filepath, 'wb') as f:
            f.write(response.content)
        return True
    except Exception as e:
        print(f"Error downloading PDF {url}: {e}")
        return False


def query_arxiv_download_pdf(query: str, max_papers: int = 10, download_dir: str = ".") -> str:
    """Query arXiv for papers and save them including PDF files.

    Parameters
    ----------
    query : str
        The search query string.
    max_papers : int
        The maximum number of papers to retrieve (default: 10).
    download_dir : str
        Directory to save paper information and PDFs.

    Returns:
        Status message.
    """
    try:
        import arxiv
    except ImportError:
        return "Error: arxiv package not installed. Install with: pip install arxiv"

    try:
        client = arxiv.Client()
        search = arxiv.Search(
            query=query, max_results=max_papers, sort_by=arxiv.SortCriterion.SubmittedDate
        )
        
        count = 0
        pdf_count = 0
        for paper in client.results(search):
            # Create filename from paper title
            safe_title = "".join(c for c in paper.title if c.isalnum() or c in (' ','.','(',')','-')).rstrip()
            filename = f"{safe_title[:100]}"  # Limit filename length
            
            # Save paper info
            info_filepath = os.path.join(download_dir, f"{filename}.txt")
            paper_info = f"""Title: {paper.title}

Authors: {', '.join(author.name for author in paper.authors)}

Abstract: {paper.summary}

Published: {paper.published}

Updated: {paper.updated}

DOI: {paper.doi if paper.doi else 'N/A'}

arXiv ID: {paper.get_short_id()}

Categories: {', '.join(paper.categories)}

URL: {paper.entry_id}

PDF URL: {paper.pdf_url}

----------------------------------------
"""
            
            with open(info_filepath, 'w', encoding='utf-8') as f:
                f.write(paper_info)
            
            # Download PDF
            if paper.pdf_url:
                pdf_filepath = os.path.join(download_dir, f"{filename}.pdf")
                if download_pdf(paper.pdf_url, pdf_filepath):
                    pdf_count += 1
            
            count += 1
        
        return f"Successfully downloaded {count} paper info files and {pdf_count} PDFs to {download_dir}"
        
    except Exception as e:
        return f"Error querying arXiv: {e}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Search and download LLM papers from arXiv including PDFs")
    parser.add_argument("query", type=str, help="Search query string")
    parser.add_argument(
        "--max-papers",
        type=int,
        default=10,
        help="Maximum number of papers to retrieve (default: 10)",
    )
    parser.add_argument(
        "--download-dir",
        type=str,
        default=".",
        help="Directory to save papers (default: current directory)",
    )

    args = parser.parse_args()

    # Print the results
    print(query_arxiv_download_pdf(args.query, max_papers=args.max_papers, download_dir=args.download_dir))


if __name__ == "__main__":
    main()