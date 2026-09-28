# node:sqlite（member 台帳）が flag なしで使える版
FROM node:24-alpine
WORKDIR /app
COPY server.mjs parent-kind.mjs .
ENV PEERTABLE_PORT=8790 PEERTABLE_DATA=/data
EXPOSE 8790
CMD ["node", "server.mjs"]
