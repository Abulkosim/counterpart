# Counterpart in a container. By default it runs a relay:
#   docker build -t counterpart .
#   docker run -p 8080:8080 -v cpart-relay:/data -e CPART_RELAY_URL=wss://relay.example.com counterpart
# CPART_RELAY_URL is the address people will use. Put TLS in front of it.
# The image holds the same package `npm install -g` would: built and packed
# in the first stage, installed in the second.
FROM node:24-slim AS build
RUN npm install -g pnpm@12.16.1
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml LICENSE README.md SECURITY.md ./
COPY packages packages
COPY scripts/build.ts scripts/
RUN pnpm install --frozen-lockfile && npm pack --pack-destination /tmp

FROM node:24-slim
COPY --from=build /tmp/*.tgz /tmp/
RUN npm install -g /tmp/*.tgz && rm /tmp/*.tgz
ENV PORT=8080
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["cpart"]
CMD ["relay", "--host", "0.0.0.0", "--db", "/data/relay.db"]
