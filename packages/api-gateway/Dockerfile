FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY dist/ ./dist/

ENV NODE_ENV=production
ENV API_HOST=0.0.0.0
ENV API_PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
