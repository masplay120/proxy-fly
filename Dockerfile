# Imagen base ligera pero estable
FROM node:18-alpine

# Agregar librerías de compatibilidad necesarias para node-fetch y streaming
RUN apk add --no-cache libc6-compat

# Directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias primero (mejora cache de Docker)
COPY package*.json ./

# Instalar solo dependencias necesarias
RUN npm install --production

# Copiar el resto del proyecto
COPY . .

# Definir puerto de la app
ENV PORT=8080
EXPOSE 8080

# Comando de inicio
CMD ["node", "server.js"]
