FROM oven/bun:1

USER $USER

RUN mkdir /app
WORKDIR /app

COPY ./package.json /app/package.json
RUN bun install

COPY ./src /app/src
COPY ./public /app/public

CMD ["bun", "/app/src/index.ts"]
