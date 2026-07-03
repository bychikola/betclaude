FROM python:3.11-slim

WORKDIR /app

# System dependencies for WeasyPrint
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgdk-pixbuf2.0-0 \
    libffi-dev \
    shared-mime-info \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Source code
COPY src/ ./src/
COPY proto/ ./proto/

# Generate gRPC stubs (in production, pre-build these)
# RUN python -m grpc_tools.protoc \
#     -I./proto \
#     --python_out=./src/grpc_generated \
#     --grpc_python_out=./src/grpc_generated \
#     ./proto/analytics.proto

ENV ANALYTICS_HOST=0.0.0.0
ENV ANALYTICS_PORT=8000

EXPOSE 8000 50051

CMD ["python", "-m", "src.main"]
