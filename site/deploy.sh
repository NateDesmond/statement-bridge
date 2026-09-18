#!/bin/sh
# Deploy site/ to Cloudflare Pages. Run from anywhere; cds into this dir.
set -e
cd "$(dirname "$0")/.."
# Project already exists; new Pages projects need wrangler 3.x (4.x routes them to Workers)
npx -y wrangler@3.114.0 pages deploy site --project-name=statementbridge --branch=main --commit-dirty=true
