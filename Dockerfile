FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DENO_INSTALL=/root/.deno
ENV PATH="/root/.deno/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Official standalone yt-dlp binary (includes the yt-dlp EJS scripts).
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp \
    && chmod a+x /usr/local/bin/yt-dlp

# Deno is the recommended JS runtime for current YouTube extraction in yt-dlp.
RUN curl -fsSL https://deno.land/install.sh | sh

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "index.js"]
