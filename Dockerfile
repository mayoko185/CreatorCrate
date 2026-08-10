# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim AS base

ENV COREPACK_HOME=/usr/local/share/corepack
ENV NODE_ENV=production

RUN corepack enable && corepack install --global pnpm@11.21.0

RUN groupadd -r creatorcrate && useradd -r -g creatorcrate creatorcrate

WORKDIR /app

FROM base AS deps

RUN apt-get update \
  && apt-get install --no-install-recommends --yes python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM deps AS test

ENV NODE_ENV=test
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY migrations ./migrations
COPY tests ./tests
COPY vitest.config.js ./
RUN pnpm test

FROM base AS runtime

COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY migrations ./migrations
COPY downloads ./downloads
RUN chown -R creatorcrate:creatorcrate /app

USER creatorcrate

# Phase 10.1A: verify the Sharp native dependency loads under the
# non-root runtime user before declaring the image ready.
RUN node -e "import('sharp').then(m => { const v = m.default.versions; if (!v.sharp || !v.vips) { process.exit(1); } console.log('sharp ' + v.sharp + ' vips ' + v.vips); })"

EXPOSE 3000

CMD ["node", "src/server.js"]
