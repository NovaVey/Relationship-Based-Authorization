# Multi-stage build for `authz serve` — see docs/CAPABILITY-GAPS.md's "A
# Dockerfile" section for why this exists: docker-compose.yml only ever
# brought up Postgres, never the service itself, and package.json's
# `bin: authz` is unpublished (the real npm package name is
# `relationship-based-authorization`; `authz` is squatted by an unrelated
# 2013 package) — so `npx authz` from a clean clone never worked. This
# image is the "run the built service, not the source" path that gap
# named.
#
# `node:22-bookworm-slim` (glibc, Debian), not `-alpine` — `z3-solver` (a
# real dependency: `tools/schema-verifier`'s SMT tier, not the HTTP
# service, but still a root `package.json` dependency `npm ci` installs
# regardless) ships prebuilt native/WASM binaries; alpine's musl libc is a
# common source of exactly this kind of native-dependency breakage that
# would only surface at container runtime, not at `npm run build` time.
# Deliberately not verified narrower than that here — see this repo's own
# "prove it, don't assert it" norm: DECISIONS.md should get an entry the
# day someone actually needs the smaller alpine image and confirms z3
# works there.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# Separate layer from the source copy below so `npm ci` is only re-run
# when package.json/package-lock.json actually change, not on every
# source edit — standard Docker layer-caching practice.
COPY package.json package-lock.json ./
RUN npm ci

# Everything `npm run build` touches (tsc -p tsconfig.build.json && node
# scripts/copy-migrations.mjs) and nothing else — not test/, docs/, or
# tools/, which the runtime image never needs and which would otherwise
# bust this layer's cache on every unrelated doc edit.
COPY tsconfig.json tsconfig.build.json ./
COPY scripts/copy-migrations.mjs scripts/copy-migrations.mjs
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# A second, independent `npm ci` — not a copy of the build stage's
# node_modules — so devDependencies (typescript, tsx, vitest, eslint...)
# never reach the runtime image at all, matching `npm run verify`'s own
# production/dev dependency split.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# `authz doctor` (applies migrations, exits 3 on an unreachable database —
# never a bare stack trace) then `authz serve`, exactly `npm start`'s own
# definition (package.json) — the same two-step chain `.github/workflows/
# ci.yml`'s own build job already exercises, not a new one invented here.
EXPOSE 3000
CMD ["npm", "start"]
