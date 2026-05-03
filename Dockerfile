FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# 1. Build stage
FROM base AS build
COPY . /usr/src/app
WORKDIR /usr/src/app
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm run build

# 2. Runner stage
FROM base AS runner
WORKDIR /usr/src/app

# Copy built assets from build stage
COPY --from=build /usr/src/app/backend/dist ./backend/dist
COPY --from=build /usr/src/app/frontend/dist ./frontend/dist

# Copy package manifests for production install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/

# Install only production dependencies for the backend
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile --filter backend

ENV PORT=3001
ENV NODE_ENV=production

EXPOSE 3001

CMD ["node", "backend/dist/server.js"]
