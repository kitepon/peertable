# node:sqlite（member 台帳）が flag なしで使える版
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
RUN apk add --no-cache 'ca-certificates>=20261020-r0' 'ca-certificates-bundle>=20261020-r0' \
    && update-ca-certificates \
    && node -e '\
      const {X509Certificate}=require("node:crypto"); \
      const bundle=require("node:fs").readFileSync("/etc/ssl/certs/ca-certificates.crt","utf8"); \
      for (const roots of [bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g),require("node:tls").rootCertificates]) { \
        const subjects=roots.map(pem=>new X509Certificate(pem).subject); \
        if (subjects.some(s=>/emSign ECC Root CA - G3|AAA Certificate Services/i.test(s)) || !subjects.some(s=>/emSign Root CA - G1/i.test(s))) throw new Error("room trust store requires the SEC-021 CA update"); \
      }'
WORKDIR /app
COPY server.mjs parent-kind.mjs ./
ENV PEERTABLE_PORT=8790 PEERTABLE_DATA=/data
EXPOSE 8790
CMD ["node", "server.mjs"]
