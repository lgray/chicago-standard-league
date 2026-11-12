FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src src
COPY public public
RUN mkdir /data && chown node:node /data
ENV DATA_DIR=/data PORT=8080 NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
