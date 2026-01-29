#!/usr/bin/env python3
from __future__ import annotations

import http.server
import socketserver
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def main() -> None:
    port = 8080
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"Invalid port: {sys.argv[1]}", file=sys.stderr)
            sys.exit(2)

    with socketserver.TCPServer(("", port), NoCacheHandler) as httpd:
        print(f"Serving on http://0.0.0.0:{port} (no-cache headers enabled)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
