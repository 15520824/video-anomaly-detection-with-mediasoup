FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY src ./src
COPY config.js ./
ENV NODE_ENV=production
CMD ["node", "src/index.js"]