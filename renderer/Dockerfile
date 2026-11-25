FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY draw.py render.py speech.py service.py ./
USER 65534:65534
EXPOSE 9000
CMD ["python","service.py"]
