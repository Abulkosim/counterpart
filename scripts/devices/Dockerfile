# One "device" for the two-device rig: its own disk, its own Counterpart
# checkout installed with install.sh, Claude Code, and the seed of a small repo.
# Built by scripts/devices/rig.sh from a staged context:
#   counterpart/   the files of this checkout, without node_modules
#   seed/          scripts/devices/repos
FROM node:24-slim
ARG CLAUDE_CODE_VERSION=2.1.326
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl procps \
  && rm -rf /var/lib/apt/lists/*
# install.sh installs pnpm with npm -g when it is missing; as the node user it
# could not write there, so it is put in place first.
RUN npm install -g pnpm@12.16.1 "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force
USER node
WORKDIR /home/node
COPY --chown=node:node counterpart /home/node/counterpart
RUN cd counterpart && ./install.sh
COPY --chown=node:node seed /home/node/seed
# The Claude Code config lives here. The login is mounted in at run time,
# read-only, and never baked into the image.
RUN mkdir -p /home/node/.claude-rig /home/node/project \
  && git config --global user.name "device" && git config --global user.email "device@example.invalid" \
  && git config --global init.defaultBranch main
# ENABLE_CLAUDEAI_MCP_SERVERS: the login would otherwise bring the account's
# own connectors into every session here. The rig wants Counterpart only.
ENV PATH=/home/node/.local/bin:$PATH \
    CLAUDE_CONFIG_DIR=/home/node/.claude-rig \
    ENABLE_CLAUDEAI_MCP_SERVERS=false \
    CPART_HOME=/home/node/.cpart \
    CPART_NO_BOOT=1
CMD ["sleep", "infinity"]
