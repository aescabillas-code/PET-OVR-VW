FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000 8501
# Run either process with the command set in docker-compose.yml
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
