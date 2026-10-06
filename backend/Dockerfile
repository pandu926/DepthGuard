FROM rust:1.97.1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY backend ./backend
COPY contracts ./contracts
COPY docs ./docs
COPY proof/fixture-manifest.json ./proof/fixture-manifest.json
RUN --mount=type=cache,id=depthguard-core-target,target=/workspace/backend/target \
    cargo build --manifest-path backend/Cargo.toml --locked --release -j 2 -p depthguard-api -p depthguard-worker \
    && mkdir -p /out && cp backend/target/release/depthguard-api backend/target/release/depthguard-worker /out/
RUN --mount=type=cache,id=depthguard-native-target,target=/workspace/backend/native/target \
    cargo build --manifest-path backend/native/Cargo.toml --locked --release -j 2 \
    && cp backend/native/target/release/depthguard-native /out/
RUN --mount=type=cache,id=depthguard-sbf-target,target=/workspace/backend/sbf/target \
    cargo build --manifest-path backend/sbf/Cargo.toml --locked --release -j 2 \
    && cp backend/sbf/target/release/depthguard-sbf /out/
RUN python3 backend/scripts/fetch-fixtures.py

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 depthguard && useradd --uid 10001 --gid 10001 --no-create-home depthguard \
    && mkdir -p /var/lib/depthguard/artifacts && chown -R 10001:10001 /var/lib/depthguard
COPY --from=build /out/depthguard-api /usr/local/bin/
COPY --from=build /out/depthguard-worker /usr/local/bin/
COPY --from=build /out/depthguard-native /usr/local/bin/
COPY --from=build /out/depthguard-sbf /usr/local/bin/
COPY --from=build /workspace/proof/fixtures /opt/depthguard/fixtures
ENV NATIVE_HELPER_PATH=/usr/local/bin/depthguard-native SBF_HELPER_PATH=/usr/local/bin/depthguard-sbf SBF_FIXTURES_DIR=/opt/depthguard/fixtures
USER 10001:10001
EXPOSE 8800
CMD ["depthguard-api"]
