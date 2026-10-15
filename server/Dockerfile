# Orbit relay — container image for Coolify (or any Docker host).
FROM node:22-alpine

WORKDIR /app

# Install deps first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# The relay reads PORT; Coolify proxies TLS + WebSockets to this port.
ENV PORT=3000
EXPOSE 3000

# Lightweight health check Coolify can use.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "server.js"]
