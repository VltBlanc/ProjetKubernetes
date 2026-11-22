FROM node:22-alpine

WORKDIR /server

COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

USER node
EXPOSE 3000

ENV PORT=3000
ENV STORE_URL=http://store:4000
ENV LEASE_MS=15000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q --spider "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["node", "server.js"]