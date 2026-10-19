#!/usr/bin/env python3
"""SPARQL Data Navigator (GitHub Pages edition) - local static file server.

This app is fully client-side (see sparql.js - it queries the configured
SPARQL endpoint directly from the browser, no backend involved); this script
just serves the static files so you can try it at http://localhost:8000
before deploying it to GitHub Pages or any other static host. See README.md.

Run:
  python3 server.py [port]
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.dirname(os.path.abspath(__file__))

EXTRA_CONTENT_TYPES = {".json": "application/json"}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1]
        if ext in EXTRA_CONTENT_TYPES:
            return EXTRA_CONTENT_TYPES[ext]
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.address_string()} - {fmt % args}\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"SPARQL Data Navigator (static) running at http://localhost:{port}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
