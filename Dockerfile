# syntax=docker/dockerfile:1

# --- Stage 1: build the React frontend -------------------------------------
FROM node:20-alpine AS web-build
WORKDIR /app
COPY web/package*.json web/
RUN cd web && npm install
COPY web/ web/
RUN cd web && npm run build

# --- Stage 2: production server ---------------------------------------------
FROM node:20-alpine
WORKDIR /app/server
ENV NODE_ENV=production
COPY server/package*.json ./
RUN npm install --omit=dev
COPY server/src ./src
COPY --from=web-build /app/server/public ./public

EXPOSE 3000
VOLUME ["/app/server/data"]
CMD ["node", "src/index.js"]
