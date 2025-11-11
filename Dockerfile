# Imagen base ligera
FROM node:18-alpine

# Crear directorio
WORKDIR /app

# Copiar dependencias
COPY package*.json ./
RUN npm install --production

# Copiar código
COPY . .

# Exponer puerto
EXPOSE 8080

# Iniciar app
CMD ["node", "server.js"]
