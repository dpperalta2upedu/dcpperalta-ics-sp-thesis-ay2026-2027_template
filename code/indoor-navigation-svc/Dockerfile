FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Copy requirements separately so dependency installs can be cached.
COPY requirements.txt ./

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies, including the MariaDB driver used at startup.
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application after dependencies are installed.
COPY . .

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/status' % os.getenv('PORT', '8000'))" || exit 1

# Run uvicorn server
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
