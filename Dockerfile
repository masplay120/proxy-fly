# Imagen base más estable
FROM node:18-slim

WORKDIR /app

# Copiar dependencias primero
COPY package*.json ./
RUN npm install --production

# Copiar el resto del proyecto
COPY . .

# Puerto expuesto
ENV PORT=8080
EXPOSE 8080

# Comando de arranque
CMD ["node", "server.js"]
