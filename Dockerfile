FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY server.js ./
COPY index.html ./

EXPOSE 8080

CMD ["node", "server.js"]