FROM node:24-bookworm-slim AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_BUILD_OUTPUT=standalone

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile

ARG NEXT_PUBLIC_HARNESS_PROFILE_AUTHORING_ENABLED=0
ENV NEXT_PUBLIC_HARNESS_PROFILE_AUTHORING_ENABLED=${NEXT_PUBLIC_HARNESS_PROFILE_AUTHORING_ENABLED}

RUN pnpm --filter ai-workflow-dashboard run build

FROM node:24-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/apps/dashboard/.next/standalone ./
COPY --from=builder /app/apps/dashboard/.next/static ./apps/dashboard/.next/static

EXPOSE 3001

CMD ["node", "apps/dashboard/server.js"]
