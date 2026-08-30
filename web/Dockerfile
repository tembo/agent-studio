# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# `--config.minimum-release-age=0` opts out of pnpm v10's 24h embargo on
# newly-published dependencies. The committed lockfile pins exact versions;
# lockfile diffs in PR review are the right place to vet recent packages.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile \
      --config.minimum-release-age=0 \
      --config.fetch-timeout=300000 \
      --config.fetch-retries=5

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM base AS runner
# Bake the release version into the image so the running app can report
# it (login footer) without a separate, drift-prone env var. The release
# workflow passes the git tag; empty on local/from-source builds, in
# which case the footer just omits the version.
ARG TAS_VERSION=
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    TAS_VERSION=${TAS_VERSION}
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Resolve Next's startup hook inside the stripped runner filesystem so a
# dangling pnpm dependency link fails the image build instead of production.
RUN node -e "require('./node_modules/next/dist/server/require-hook.js')"
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
