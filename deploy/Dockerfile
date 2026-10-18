# Build from the FIELDWORK directory:
# docker build -f deploy/Dockerfile -t fieldwork-local .
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000
WORKDIR /app

# Explicit runtime allowlist. No sessions, credentials, recordings or evidence.
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node public/ ./public/
RUN mkdir -p /app/.local && chown node:node /app/.local

USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
