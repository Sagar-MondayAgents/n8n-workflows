# Use Node.js Debian-based image for better compatibility
FROM node:20-bullseye-slim

# Install dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    build-essential \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1001 nodejs && \
    useradd -r -u 1001 -g nodejs -m nodejs

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --omit=dev --ignore-scripts

# Copy application code
COPY --chown=nodejs:nodejs . .

# Create required directories
RUN mkdir -p database workflows static && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Rebuild native modules for the current Node.js version
RUN npm rebuild better-sqlite3

# Run the prepare script
RUN npm run prepare

# Expose port
EXPOSE 3000

# Set environment
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1))" || exit 1

# Run the application
CMD ["npm", "run", "mcp:http"]