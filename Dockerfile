FROM node:22-alpine

WORKDIR /app

# Instalar dependencias primero (capa cacheada)
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar código fuente
COPY src/ ./src/

# Directorio para la base de datos (se monta como volumen en Fly.io)
RUN mkdir -p /data

ENV NODE_ENV=production
ENV DB_PATH=/data/prode.db
ENV PORT=3001

EXPOSE 3001

CMD ["node", "src/app.js"]
