#!/bin/sh
# Produces dist/artifact.html: index.html without the document skeleton, for hosts that wrap the page
# themselves (the Claude Artifact viewer). index.html itself is the standalone page (GitHub Pages, local).
cd "$(dirname "$0")"
mkdir -p dist
grep -v -E '^(<!doctype html>|<html lang="en">|</html>|<head>|</head>|<body>|</body>|<meta )' index.html > dist/artifact.html
echo "wrote dist/artifact.html"
