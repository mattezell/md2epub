# md2epub, in three tiers. Pick with --target.
#
#   slim     conversion and email. Covers stay SVG, which Kindle will not show.
#   default  + Chromium and fonts: PNG covers, which is what a Kindle needs.
#   full     + the mermaid toolchain: diagrams as well.
#
#   docker build -t md2epub .                      # default
#   docker build --target slim -t md2epub:slim .
#   docker build --target full -t md2epub:full .

# ---------------------------------------------------------------- dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ------------------------------------------------------------------------ slim
FROM node:22-alpine AS slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
RUN addgroup -S md2epub && adduser -S -G md2epub -h /app md2epub
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
USER md2epub
EXPOSE 8787
# Answers before the app is configured, so an unconfigured container is still
# reported healthy rather than looking dead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]

# --------------------------------------------------------------------- default
# Chromium turns the drawn SVG cover into the PNG a Kindle will display. The
# fonts are not optional either: without them a title in Japanese, Arabic or
# emoji renders as empty boxes.
FROM slim AS default
USER root
RUN apk add --no-cache \
      chromium \
      font-noto \
      font-noto-cjk \
      font-noto-emoji \
      font-noto-arabic \
      ttf-dejavu \
    && fc-cache -f
ENV CHROME_PATH=/usr/bin/chromium-browser \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
USER md2epub

# ------------------------------------------------------------------------ full
# The mermaid toolchain is around half a gigabyte, which is why it is a tier of
# its own rather than the default.
FROM default AS full
USER root
RUN mkdir -p /app/tools/mermaid \
    && cd /app/tools/mermaid \
    && echo '{"name":"md2epub-mermaid-toolchain","private":true}' > package.json \
    && npm install --no-audit --no-fund --loglevel error @mermaid-js/mermaid-cli puppeteer \
    && npm cache clean --force \
    && chown -R md2epub:md2epub /app/tools
USER md2epub
