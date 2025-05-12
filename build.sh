#!/bin/bash
echo "Starting build process..."

# Install dependencies
npm install

# Build TypeScript code
npm run build

echo "Build completed successfully!"