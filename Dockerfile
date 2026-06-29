FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    MCP_ENDPOINT_PATH=/mcp \
    NEWSLETTER_MCP_DATA_DIR=/app/data \
    WEB_SEARCH_PROVIDER=noapi_google_search \
    NOAPI_GOOGLE_SEARCH_COMMAND=noapi-google-search-mcp \
    ENABLE_MOCK_PROVIDERS=false \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/noapi-google-search-mcp \
    && /opt/noapi-google-search-mcp/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/noapi-google-search-mcp/bin/pip install --no-cache-dir noapi-google-search-mcp \
    && ln -s /opt/noapi-google-search-mcp/bin/noapi-google-search-mcp /usr/local/bin/noapi-google-search-mcp \
    && /opt/noapi-google-search-mcp/bin/python -m playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/data ./data

USER node

EXPOSE 3000

CMD ["node", "dist/src/index.js"]
