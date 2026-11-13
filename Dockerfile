# Counterpart in a container. By default it runs a relay:
#   docker build -t counterpart .
#   docker run -p 8080:8080 -v cpart-relay:/data -e CPART_RELAY_URL=wss://relay.example.com counterpart
# CPART_RELAY_URL is the address people will use. Put TLS in front of it.
FROM node:24-slim
RUN npm install -g pnpm@12.16.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages packages
RUN pnpm install --frozen-lockfile --prod
ENV PORT=8080
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["node", "packages/cli/src/main.ts"]
CMD ["relay", "--host", "0.0.0.0", "--db", "/data/relay.db"]
