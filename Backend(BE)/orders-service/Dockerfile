# Usa una imagen base de Maven para compilar el proyecto
FROM maven:3.3-jdk-8 AS builder
# Define el directorio de trabajo
WORKDIR /app

# Copia los archivos de proyecto a la imagen
COPY . .

# Ejecuta el comando de Maven para compilar y generar el .jar
RUN mvn clean install
#package -DskipTests

# Segunda etapa: crea una imagen más liviana para ejecutar el .jar
#FROM openjdk:17-jdk-slim

# Define el directorio de trabajo
#WORKDIR /app

# Copia el archivo .jar generado desde la etapa de compilación
#COPY --from=builder /app/target/*.jar app.jar

# Define el comando de ejecución del .jar
#CMD ["java", "-jar", "app.jar"]
