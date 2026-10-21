FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# Without DATABASE_URL the app keeps an embedded Postgres in DATA_DIR. Set DATABASE_URL to use a Postgres server instead.
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
