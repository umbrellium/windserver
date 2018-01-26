# Wind Server

This repo contains a repackaging of this demo server:
https://github.com/danwild/wind-js-server

This is a simple node.js application that exposes
[GRIB2](http://en.wikipedia.org/wiki/GRIB) wind forecast data (1 degree, 6
hourly from [NOAA](http://nomads.ncep.noaa.gov/)) as JSON via an HTTP endpoint.

## Changes

This project contains the following changes from the demo project linked to above:

* packages the server inside a Docker container
* add some machinery for deleting old files
* instrument the server a tiny bit with prometheus client
* clean up and reduce noisy log output
* add eslint and tidy code slightly

## Requirements

* Docker

## Running the server

Commands for running the server have been added as npm commands, so:

```bash
$ npm run server
```

The above command will build the docker image, and then start the server
running inside docker, binding the server to port 7000 on the host.


## Pushing to Docker

Again this has been added as an npm command that calls a bash script as it
happens:

```bash
$ npm run push
```

It builds the image, tags with the git SHA, and pushes to Docker hub
(provided you are logged in). It also tags latest build with `latest` but be
careful with this.

## Missing

* Test coverage of any sort
