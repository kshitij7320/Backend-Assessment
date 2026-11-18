FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts

COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

RUN npm run build

FROM node:22-alpine AS runtime

# Install docker-cli for sibling sandbox container execution and python3 for deterministic-double mode
RUN apk add --no-cache docker-cli python3

WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations

EXPOSE 3000

CMD ["node", "dist/main.js"]
