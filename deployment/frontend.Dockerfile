FROM node:24-alpine AS build
WORKDIR /app
COPY Chat-UI/package.json Chat-UI/package-lock.json ./
# npm ci rejects the current lockfile because Windows npm left out an
# optional peer dependency (@emnapi/runtime) required by the Linux build.
# npm install reconciles that lockfile while creating the Linux image.
RUN npm install --no-audit --no-fund
COPY Chat-UI/ ./
RUN npm run build

FROM nginx:alpine
COPY deployment/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
