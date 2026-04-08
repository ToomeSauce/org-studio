# Stage 1: Install dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production=false

# Stage 2: Build the Next.js app
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Stage 3: Production image
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4501

# Copy full node_modules (custom server needs them)
COPY --from=deps /app/node_modules ./node_modules

# Copy built Next.js app
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public

# Copy custom server + runtime adapter + docs
COPY --from=builder /app/server.mjs ./server.mjs
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/docs ./docs
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts

# Create data directory
RUN mkdir -p data

EXPOSE 4501

CMD ["node", "server.mjs"]
