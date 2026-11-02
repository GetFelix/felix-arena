# The built web client behind nginx, on port 8080. The release workflow builds
# web/dist once and puts it in the build context.
# Build from the repository root after `npm run build` in web/:
#   docker build -f docker/web.Dockerfile .

FROM docker.io/nginxinc/nginx-unprivileged:1.29-alpine
COPY web/dist /usr/share/nginx/html
