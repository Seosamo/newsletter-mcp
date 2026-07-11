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
    PUBLIC_BASE_URL=https://migration.playmcp-endpoint.kakaocloud.io \
    OAUTH_ENABLED=true \
    OAUTH_ISSUER=https://dev-ekikfczn12akgdal.us.auth0.com/ \
    OAUTH_AUTHORIZATION_SERVERS=https://dev-ekikfczn12akgdal.us.auth0.com/ \
    OAUTH_JWKS_URL=https://dev-ekikfczn12akgdal.us.auth0.com/.well-known/jwks.json \
    OAUTH_AUDIENCE=https://tikitaka.playmcp-endpoint.kakaocloud.io/mcp \
    OAUTH_RESOURCE=https://tikitaka.playmcp-endpoint.kakaocloud.io/mcp \
    OAUTH_RESOURCE_METADATA_URL=https://migration.playmcp-endpoint.kakaocloud.io/.well-known/oauth-protected-resource/mcp \
    OAUTH_USER_ID_CLAIM=sub \
    OAUTH_ALLOWED_ALGORITHMS=RS256 \
    OAUTH_SCOPES_SUPPORTED=openid,profile \
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
