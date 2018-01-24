FROM node:carbon-alpine

RUN apk add --no-cache --update \
  ca-certificates \
  openjdk8-jre \
  bash && \
  rm -rf /var/cache/apk/*

WORKDIR /usr/src/app

COPY package.json ./
COPY yarn.lock ./

RUN yarn install

ENV JAVA_HOME /usr/lib/jvm/java-1.8-openjdk/jre

COPY . .

RUN mkdir grib-data && mkdir json-data

EXPOSE 7000

CMD [ "node", "app.js" ]
