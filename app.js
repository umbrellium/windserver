const express = require("express");
const moment = require("moment");
const request = require("request");
const fs = require("fs");
const Q = require("q");
const cors = require("cors");
const bunyan = require("bunyan");
const findRemoveSync = require("find-remove");
const prometheus = require("express-prom-bundle");
const metrics = prometheus({ includePath: true, includeMethod: true, promClient: { collectDefaultMetrics: {} } });

const app = express();
const port = process.env.PORT || 7000;
const baseDir = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl";
const logLevel = process.env.LOG_LEVEL || "info";

// create our logger
const log = bunyan.createLogger({
  name: "windserver",
  level: logLevel
});

const maxAge = 60 * 60 * 24 * 14; // 14 days in seconds

// metrics config
const retrieveCounter = new metrics.promClient.Counter({
  name: "windserver_retrievals",
  help: "counts whenever we go retrieve data"
});

const retrieveErrorCounter = new metrics.promClient.Counter({
  name: "windserver_retrieval_errors",
  help: "counts whenever we go retrieve data"
});

const fileRemovalCounter = new metrics.promClient.Counter({
  name: "windserver_removals",
  help: "counts when we remove an old file"
});

const filesGauge = new metrics.promClient.Gauge({
  name: "windserver_data_files",
  help: "gauge measuring number of files in data directory"
});

// add metrics middleware
app.use(metrics);

// cors config
var whitelist = process.env.WHITELIST ?
  process.env.WHITELIST.split(/\s*,\s*/) : [];

var corsOptions = {
  origin: function (origin, callback) {
    if (whitelist.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Forbidden by CORS'));
    }
  }
};

//app.use(cors(corsOptions));
app.use(cors());

app.listen(port, function () {
  log.info({ port: port, corsWhitelist: whitelist }, "starting server");
});

app.get("/", function (req, res) {
  res.send("hello wind-js-server.. go to /latest for wind data..");
});

app.get("/pulse", function (req, res) {
  res.set("Content-Type", "text/plain");
  res.send("ok");
});

app.get("/latest", function (req, res, next) {

  /**
   * Find and return the latest available 6 hourly pre-parsed JSON data
   *
   * @param targetMoment {Object} UTC moment
   */
  function sendLatest(targetMoment) {

    var stamp = moment(targetMoment).format("YYYYMMDD") +
      roundHours(moment(targetMoment).hour(), 6);
    var fileName = __dirname + "/json-data/" + stamp + ".json";
    log.debug({ fileName: fileName }, "attempt to send file");

    res.setHeader("Content-Type", "application/json");
    res.sendFile(fileName, {
      maxAge: 900000,
      immutable: true
    }, function (err) {
      if (err) {
        if (targetMoment.isBefore(moment().subtract(30, "days"))) {
          next(err);
        } else {
          log.debug({ err: err, stamp: stamp },
            "does not exist yet, trying previous interval");
          sendLatest(moment(targetMoment).subtract(6, "hours"));
        }
      }
    });
  }

  sendLatest(moment().utc());

});

app.get("/nearest", function (req, res, next) {

  var time = req.query.timeIso;
  var limit = req.query.searchLimit;
  var searchForwards = false;

  /**
   * Find and return the nearest available 6 hourly pre-parsed JSON data If
   * limit provided, searches backwards to limit, then forwards to limit before
   * failing.
   *
   * @param targetMoment {Object} UTC moment
   */
  function sendNearestTo(targetMoment) {

    if (limit && Math.abs(moment.utc(time).diff(targetMoment, "days")) >= limit) {
      if (!searchForwards) {
        searchForwards = true;
        sendNearestTo(moment(targetMoment).add(limit, "days"));
        return;
      } else {
        return next(new Error("No data within searchLimit"));
      }
    }

    var stamp = moment(targetMoment).format("YYYYMMDD") +
      roundHours(moment(targetMoment).hour(), 6);
    var fileName = __dirname + "/json-data/" + stamp + ".json";

    res.setHeader("Content-Type", "application/json");
    res.sendFile(fileName, {
      maxAge: 604800000,
      immutable: true
    }, function (err) {
      if (err) {
        var nextTarget = searchForwards ? moment(targetMoment).add(6, "hours") :
          moment(targetMoment).subtract(6, "hours");
        sendNearestTo(nextTarget);
      }
    });
  }

  if (time && moment(time).isValid()) {
    sendNearestTo(moment.utc(time));
  } else {
    return next(new Error("Invalid params, expecting: timeIso=ISO_TIME_STRING"));
  }
});

/**
 *
 * Ping for new data every 15 mins
 *
 */
setInterval(function () {
  run(moment.utc());
}, 900000);

/**
 *
 * @param targetMoment {Object} moment to check for new data
 */
function run(targetMoment) {
  removeOldFiles();
  countDataFiles();

  getGribData(targetMoment).then(function (response) {
    if (response.stamp) {
      convertGribToJson(response.stamp, response.targetMoment);
    }
  });
}

/**
 * Uses find-remove module to delete files older than our maxAge seconds.
 */
function removeOldFiles() {
  log.debug({ maxAge: maxAge }, "removing old files");

  // delete json files older than 2 weeks
  var result = findRemoveSync("json-data/", { age: { seconds: maxAge } });
  var files = Object.keys(result);

  if (files.length > 0) {
    fileRemovalCounter.inc(files.length);
    log.debug({ numFiles: files.length, age: maxAge }, "deleting old files");
  }
}

/**
 * Instrumentation that counts the number of data files currently in the
 * json-data directory, and sets a gauge accordingly.
 */
function countDataFiles() {
  log.debug("counting current data files");

  fs.readdir("./json-data", (err, files) => {
    if (err) {
      log.error(err);
    };

    filesGauge.set(files.length);
  });
}

/**
 *
 * Finds and returns the latest 6 hourly GRIB2 data from NOAAA
 *
 * @returns {*|promise}
 */
function getGribData(targetMoment) {

  var deferred = Q.defer();

  function runQuery(targetMoment) {

    // only go 2 weeks deep
    if (moment.utc().diff(targetMoment, "days") > 30) {
      log.info("reached limit, harvest complete or large gap in data");
      return;
    }

    var localDir = moment(targetMoment).format("YYYYMMDD") + roundHours(moment(targetMoment).hour(), 6);
    var requestDir = moment(targetMoment).format("YYYYMMDD") + "/" + roundHours(moment(targetMoment).hour(), 6);
    var filePath = "gfs.t" + roundHours(moment(targetMoment).hour(), 6) + "z.pgrb2.1p00.f000";

    request.get({
      url: baseDir,
      qs: {
        file: filePath,
        lev_10_m_above_ground: "on",
        lev_surface: "on",
        var_TMP: "on",
        var_UGRD: "on",
        var_VGRD: "on",
        leftlon: 0,
        rightlon: 360,
        toplat: 90,
        bottomlat: -90,
        dir: "/gfs." + requestDir
      }
    }).on("error", function (err) {
      retrieveErrorCounter.inc();
      log.error({ err: err, stamp: localDir }, "unable to retrieve data");
      runQuery(moment(targetMoment).subtract(6, "hours"));
    }).on("response", function (response) {
      log.debug({ status: response.statusCode, stamp: localDir }, "data retrieved");
      if (response.statusCode !== 200) {
        retrieveErrorCounter.inc();
        runQuery(moment(targetMoment).subtract(6, "hours"));
      } else {
        retrieveCounter.inc();
        // don"t rewrite stamps
        if (!checkPath("json-data/" + localDir + ".json", false)) {
          log.debug({ stamp: localDir }, "piping data");

          // mk sure we"ve got somewhere to put output
          checkPath("grib-data", true);

          // pipe the file, resolve the valid time stamp
          var file = fs.createWriteStream("grib-data/" + localDir + ".f000");
          response.pipe(file);
          file.on("finish", function () {
            file.close();
            deferred.resolve({ stamp: localDir, targetMoment: targetMoment });
          });
        } else {
          log.debug({ stamp: localDir }, "end reached, not looking further");
          deferred.resolve({ stamp: false, targetMoment: false });
        }
      }
    });

  }

  runQuery(targetMoment);
  return deferred.promise;
}

function convertGribToJson(stamp, targetMoment) {
  // mk sure we"ve got somewhere to put output
  checkPath("json-data", true);

  var exec = require("child_process").exec;

  exec("converter/bin/grib2json --data --output json-data/" +
    stamp + ".json --names --compact grib-data/" + stamp + ".f000",
    { maxBuffer: 500 * 1024 },
    function (error) {

      if (error) {
        log.error({ err: error });
      } else {
        log.debug({ stamp: stamp }, "converted file");

        // don"t keep raw grib data
        exec("rm grib-data/*");

        // if we don"t have older stamp, try and harvest one
        var prevMoment = moment(targetMoment).subtract(6, "hours");
        var prevStamp = prevMoment.format("YYYYMMDD") + roundHours(prevMoment.hour(), 6);

        if (!checkPath("json-data/" + prevStamp + ".json", false)) {
          log.debug({ stamp: stamp }, "fetching data");
          run(prevMoment);
        } else {
          log.debug({ stamp: stamp }, "end of harvest");
        }
      }
    });
}

/**
 *
 * Round hours to expected interval, e.g. we"re currently using 6 hourly interval
 * i.e. 00 || 06 || 12 || 18
 *
 * @param hours
 * @param interval
 * @returns {String}
 */
function roundHours(hours, interval) {
  if (interval > 0) {
    var result = (Math.floor(hours / interval) * interval);
    return result < 10 ? "0" + result.toString() : result;
  }
}

/**
 * Sync check if path or file exists
 *
 * @param path {string}
 * @param mkdir {boolean} create dir if doesn"t exist
 * @returns {boolean}
 */
function checkPath(path, mkdir) {
  try {
    fs.statSync(path);
    return true;
  } catch (e) {
    if (mkdir) {
      fs.mkdirSync(path);
    }
    return false;
  }
}

// add interrupt handler to try and exit cleanly on this signal
process.on("SIGINT", function () {
  log.info("shutting down server");
  process.exit();
});

// init harvest
run(moment.utc());
