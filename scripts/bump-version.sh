#!/bin/sh
# Stamps a fresh ?v= on every local script/style URL so Telegram's WebView cannot mix a new
# index.html with modules it cached from an older release. Run before each push.
set -e
cd "$(dirname "$0")/.."
version="${1:-$(date +%m%d-%H%M)}"
sed -i.bak -E "s#(from '\./[A-Za-z0-9_-]+\.js)(\?v=[^']*)?'#\1?v=${version}'#g" src/*.js
sed -i.bak -E \
  -e "s#((src|href)=\"\./[A-Za-z0-9_/.-]+\.(js|css))(\?v=[^\"]*)?\"#\1?v=${version}\"#g" \
  -e "s#(<span id=\"build\">)[^<]*(</span>)#\1v${version}\2#" \
  index.html
rm -f src/*.js.bak index.html.bak
echo "version ${version}"
