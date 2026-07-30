# Stage 1: Install full deps (build needs devDeps like typescript/tailwind).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production=false

# Stage 2: Build the Next.js app.
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# #1112 PR 7 (2026-04-24): bake the build SHA into the bundle so the
# sidebar can show which commit is running. Workflow passes this as
# --build-arg BUILD_SHA=$SOURCE_SHA. Falls back to 'dev' for local builds.
ARG BUILD_SHA=dev
ENV NEXT_PUBLIC_BUILD_SHA=$BUILD_SHA
RUN npm run build

# Stage 3: Prod-only deps. Fresh install with --omit=dev so we don't drag
# devDependencies (puppeteer-core, typescript, eslint, vitest, tailwind,
# etc.) into the runtime image. Cuts image from ~280 MB to ~120 MB.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# Stage 4: Runtime image.
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4501
# Containers must listen outside loopback. Runtime startup requires
# ORG_STUDIO_API_KEY unless the operator deliberately opts into
# ALLOW_INSECURE_REMOTE=true on an isolated network.
ENV ORG_STUDIO_HOST=0.0.0.0

# Prod-only node_modules.
COPY --from=prod-deps /app/node_modules ./node_modules

# Built Next.js artifacts.
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public

# Custom server + runtime libs + docs.
COPY --from=builder /app/server.mjs ./server.mjs
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/docs ./docs
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts

RUN mkdir -p data

EXPOSE 4501

CMD ["node", "server.mjs"]
