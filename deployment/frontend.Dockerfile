FROM node:24-alpine AS build
WORKDIR /app
COPY Chat-UI/package.json Chat-UI/package-lock.json ./
RUN npm ci
COPY Chat-UI/ ./
RUN npm run build

FROM nginx:alpine
COPY deployment/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
