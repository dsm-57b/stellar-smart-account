# Step 1: Build Go API
FROM golang:1.24.4-bullseye AS api-build
ARG GIT_COMMIT

# Use direct Git access to avoid proxy issues
ENV GOPROXY=direct
ENV GONOSUMDB=*

WORKDIR /src/wallet-backend
COPY go.mod go.sum ./
RUN go mod download

# Copy the entire project after modules are cached
COPY . ./

# Upgrade Stellar deps _after_ the full source (and therefore final go.mod) is in place
# Remove specific commit pinning and use latest
RUN go get -u github.com/stellar/go@latest github.com/stellar/go-xdr@latest && \
    go mod tidy && \
    go mod download && \
    go build -o /bin/wallet-backend -ldflags "-X main.GitCommit=$GIT_COMMIT" .

# Use the official stellar/soroban-rpc image as the base
FROM stellar/soroban-rpc

# Install bash or sh
RUN apt-get update && apt-get install -y bash


# Step 2: Install Stellar Core and copy over app binary
FROM ubuntu:jammy AS core-build

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl wget gnupg apt-utils gpg && \
    curl -sSL https://apt.stellar.org/SDF.asc | gpg --dearmor >/etc/apt/trusted.gpg.d/SDF.gpg && \
    echo "deb https://apt.stellar.org jammy stable" >/etc/apt/sources.list.d/SDF.list && \
    echo "deb https://apt.stellar.org jammy testing" >/etc/apt/sources.list.d/SDF-testing.list && \
    echo "deb https://apt.stellar.org jammy unstable" >/etc/apt/sources.list.d/SDF-unstable.list

COPY --from=api-build /bin/wallet-backend /app/

EXPOSE 8001
WORKDIR /app
ENTRYPOINT ["./wallet-backend"]
