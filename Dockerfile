FROM node:20-slim

# Install Chrome + required libraries
RUN apt-get update && apt-get install -y wget gnupg ca-certificates \
 && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /usr/share/keyrings/google-linux.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y google-chrome-stable fonts-liberation \
    libasound2 libatk-bridge2.0-0 libnss3 libxss1 libxcomposite1 libxdamage1 libxrandr2 \
    libgbm1 libgtk-3-0 libdrm2 libxshmfence1 \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm i --production

COPY . .

# Tell Puppeteer to use system Chrome and skip downloading its own Chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome

EXPOSE 3000
CMD ["node", "app.js"]
