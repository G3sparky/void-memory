FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY public/ ./public/

ENV VOID_DATA_DIR=/app/data

EXPOSE 3410

CMD ["node", "dist/dashboard.js", "3410"]
