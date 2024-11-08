# Crea una imagen más liviana para ejecutar el .jar
FROM openjdk:18-jdk-alpine
#ARG JAR_FILE
#COPY ${JAR_FILE} app.jar
COPY ./orders-service/orders-service-example-0.0.1-SNAPSHOT-spring-boot.jar app.jar
CMD java -jar /app.jar $APP_ARGS
