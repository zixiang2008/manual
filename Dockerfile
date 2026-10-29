FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY public ./public
COPY data ./data
COPY config ./config
COPY scripts ./scripts
RUN mkdir -p /app/runtime /app/public/media && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=3000 AUDIT_LOG=/app/runtime/login-audit.ndjson
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node","server.mjs"]
