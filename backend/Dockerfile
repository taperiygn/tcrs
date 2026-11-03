FROM python:3.11-slim

WORKDIR /app
COPY . /app

ENV HOST=0.0.0.0
ENV PORT=8080
ENV TCRS_SITE_DIR=/app/frontend
ENV TCRS_DATA_DIR=/app/data

CMD ["python3", "backend/server.py"]
