FROM python:3.12-slim
WORKDIR /app
COPY server.py index.html login.html login.css login.js styles.css app.js sheet.js parser.js ./
COPY vendor ./vendor
COPY samples ./samples
ENV HOST=0.0.0.0 \
    PORT=8000 \
    TCRS_DATA_DIR=/data
VOLUME /data
EXPOSE 8000
# TCRS_PASSWORD must be supplied at run time:  docker run -e TCRS_PASSWORD=... -v tcrs-data:/data -p 8000:8000 tcrs
CMD ["python", "server.py"]
