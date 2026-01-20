FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN sed -i 's|http://ports.ubuntu.com/ubuntu-ports|http://mirrors.aliyun.com/ubuntu-ports|g' /etc/apt/sources.list

RUN apt-get update -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 \
    install -y --no-install-recommends --fix-missing \
    bash-completion \
    locales \
    ncurses-bin \
    ncurses-term \
    python3 \
    python-is-python3 \
    python3-pip \
    python3-venv \
    curl \
    wget \
    git \
    vim \
    fonts-noto-cjk \
    libcairo2 \
    libffi8 \
    libgdk-pixbuf-2.0-0 \
    libglib2.0-0 \
    libharfbuzz0b \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libxml2 \
    libxslt1.1 \
    ca-certificates \
    gnupg \
    lsb-release \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Ensure UTF-8 locale for proper CJK display in vim/terminal apps.
RUN locale-gen zh_CN.UTF-8 \
    && update-locale LANG=zh_CN.UTF-8
ENV LANG=zh_CN.UTF-8
ENV LC_ALL=zh_CN.UTF-8

# Provide common shell aliases in interactive bash.
RUN echo "alias ll='ls -alF'" >> /etc/bash.bashrc

# Node.js (NodeSource 20.x)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get update && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# uv
RUN pip3 install --no-cache-dir uv

COPY requirements_docker.txt /tmp/requirements_docker.txt

RUN python3 -m pip install --no-cache-dir -r /tmp/requirements_docker.txt

WORKDIR /workspace
CMD ["bash", "-lc", "sleep infinity"]
