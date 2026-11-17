# Local development image of the site. It is not an image for production.
#
#   docker compose up        the dev server on http://localhost:4321
#
# The versions follow `.nvmrc` and `packageManager` of `package.json`
# (`scripts/docker.spec.ts` checks it).
FROM oven/bun:1.4.4 AS bun

FROM node:24.22.3-bookworm-slim

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

ENV ASTRO_TELEMETRY_DISABLED=1

# The source is mounted at /app. The packages live in volumes, apart from the
# packages of the host. The folders exist here with the right owner, so that
# the volumes get it.
RUN mkdir -p /app/node_modules /app/apps/site/node_modules && chown -R node:node /app

USER node
WORKDIR /app
EXPOSE 4321

CMD ["sh", "-c", "bun install --frozen-lockfile && exec bun run dev --host 0.0.0.0"]
