# The stand-in identity provider (dev/idp.mjs). It signs in anyone who picks a
# name, so it is for trying the game, never for an exposed deployment.
# Build from the repository root: docker build -f docker/idp.Dockerfile .

FROM docker.io/library/node:24-alpine
WORKDIR /app
COPY dev/idp.mjs ./
USER node
EXPOSE 9400
CMD ["node", "/app/idp.mjs"]
