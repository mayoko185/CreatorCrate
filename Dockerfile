# syntax=docker/dockerfile:1
FROM node:22.9.0-bookworm-slim AS base

ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

RUN groupadd -r creatorcrate && useradd -r -g creatorcrate creatorcrate

WORKDIR /app

FROM base AS deps

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod

FROM deps AS test

ENV NODE_ENV=test
COPY package.json pnpm-lock.yaml .npmrc ./
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
RUN chown -R creatorcrate:creatorcrate /app

USER creatorcrate

EXPOSE 3000

CMD ["node", "src/server.js"]
