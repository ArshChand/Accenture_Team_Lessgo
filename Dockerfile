# One container, one URL: the Node backend serves the built React app and the
# API, and talks to the Python ML service on localhost inside the container.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ML service dependencies. xgboost-cpu is the same `xgboost` module without the
# ~300 MB of GPU libraries the default wheel pulls in.
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY ml-service/requirements.txt ml-service/requirements.txt
RUN sed 's/^xgboost/xgboost-cpu/' ml-service/requirements.txt > /tmp/requirements.txt \
 && pip install --no-cache-dir -r /tmp/requirements.txt

# Node dependencies for both workspaces, then the frontend build.
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY . .
RUN npm run build --workspace frontend

ENV NODE_ENV=production \
    PORT=7860 \
    STATIC_DIR=/app/frontend/dist \
    ML_SERVICE_URL=http://127.0.0.1:8000 \
    ALLOW_SIMULATION=true \
    SEED_ON_START=true

EXPOSE 7860
CMD ["bash", "scripts/start.sh"]
