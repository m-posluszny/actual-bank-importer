FROM node:20-slim

# Create app directory
WORKDIR /app

# Install dependencies first (for caching)
COPY package.json ./
RUN npm install

# Copy the rest of your code
COPY . .

# Create the internal data directory for the API cache
RUN mkdir -p /app/actual-data

CMD ["node", "index.js"]
