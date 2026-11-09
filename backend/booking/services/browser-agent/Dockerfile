# browser-use 官方 Dockerfile 採 Python 3.12 + 系統 Chromium；這裡保留最小 runtime，服務層用 FastAPI。
FROM python:3.12-slim
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    IN_DOCKER=True
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# build context 是 backend/booking/services/browser-agent(與 Bun 服務無共用程式)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY src ./src
RUN useradd --create-home --uid 10001 agent \
 && mkdir -p /var/lib/browser-agent/artifacts \
 && chown -R agent:agent /app /var/lib/browser-agent
USER agent
# --app-dir src：讓 main.py 能以 `import joymap` 匯入同目錄的站點模組
CMD ["python", "-m", "uvicorn", "main:app", "--app-dir", "src", "--host", "0.0.0.0", "--port", "3010"]
