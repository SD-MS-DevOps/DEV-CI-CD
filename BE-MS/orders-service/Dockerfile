# Crea una imagen más liviana para ejecutar el .jar
FROM openjdk:18-jdk-alpine
#ARG JAR_FILE
#COPY ${JAR_FILE} app.jar
COPY staging/Package app.jar
CMD java -jar /app.jar $APP_ARGS
