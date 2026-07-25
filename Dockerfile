FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package*.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium

COPY . .
RUN mkdir -p /app/artifacts

EXPOSE 3000
CMD ["npm", "start"]
