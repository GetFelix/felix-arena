# The seed job: creates the tenant, the arenas' streams and roles, and the
# tokens the broker and the sim read from /state (dev/seed.mjs).
# Build from the repository root: docker build -f docker/seed.Dockerfile .

FROM docker.io/library/node:24-alpine
WORKDIR /app
COPY dev/seed.mjs ./
# Root, so it can write /state whoever owns the volume.
CMD ["node", "/app/seed.mjs"]
