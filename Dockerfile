# Imagen base
FROM node:18-alpine

# Crea y entra al directorio de la app
WORKDIR /app

# Copia archivos necesarios
COPY package*.json ./

# Instala dependencias
RUN npm install --production

# Copia el resto de los archivos
COPY . .

# Expone el puerto (Fly usará el 8080 por defecto)
EXPOSE 8080

# Comando para iniciar tu servidor
CMD ["node", "server.js"]
