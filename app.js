var express = require("express");
var moment = require("moment");
var http = require("http");
var request = require("request");
var fs = require("fs");
var Q = require("q");
var cors = require("cors");
var bunyan = require("bunyan");

var app = express();
var port = process.env.PORT || 7000;
var baseDir = "http://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl";
var log = bunyan.createLogger({ name: "windserver" });

// cors config
var whitelist = process.env.WHITELIST ?
  process.env.WHITELIST.split(/\s*,\s*/) : [];

var corsOptions = {
  origin: function (origin, callback) {
    var originIsWhitelisted = whitelist.indexOf(origin) !== -1;
    callback(null, originIsWhitelisted);
  }
};

app.listen(port, function () {
  log.info({ port: port }, "starting server");
});

app.get("/", cors(corsOptions), function (req, res) {
  res.send("hello wind-js-server.. go to /latest for wind data..");
});

app.get("/alive", cors(corsOptions), function (req, res) {
  res.send("ok");
});

app.get("/latest", cors(corsOptions), function (req, res) {

  /**
   * Find and return the latest available 6 hourly pre-parsed JSON data
   *
   * @param targetMoment {Object} UTC moment
   */
  function sendLatest(targetMoment) {

    var stamp = moment(targetMoment).format("YYYYMMDD") + roundHours(moment(targetMoment).hour(), 6);
    var fileName = __dirname + "/json-data/" + stamp + ".json";

    res.setHeader("Content-Type", "application/json");
    res.sendFile(fileName, {}, function (err) {
      if (err) {
        log.error({ err: err, stamp: stamp }, "does not exist yet, trying previous interval");
        sendLatest(moment(targetMoment).subtract(6, "hours"));
      }
    });
  }

  sendLatest(moment().utc());

});

app.get("/nearest", cors(corsOptions), function (req, res, next) {

  var time = req.query.timeIso;
  var limit = req.query.searchLimit;
  var searchForwards = false;

  /**
   * Find and return the nearest available 6 hourly pre-parsed JSON data
   * If limit provided, searches backwards to limit, then forwards to limit before failing.
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
    res.sendFile(fileName, {}, function (err) {
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
var watchID = setInterval(function () {
  run(moment.utc());
}, 900000);

/**
 *
 * @param targetMoment {Object} moment to check for new data
 */
function run(targetMoment) {
  getGribData(targetMoment).then(function (response) {
    if (response.stamp) {
      convertGribToJson(response.stamp, response.targetMoment);
    }
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

    var stamp = moment(targetMoment).format("YYYYMMDD") + roundHours(moment(targetMoment).hour(), 6);
    request.get({
      url: baseDir,
      qs: {
        file: "gfs.t" + roundHours(moment(targetMoment).hour(), 6) + "z.pgrb2.1p00.f000",
        lev_10_m_above_ground: "on",
        lev_surface: "on",
        var_TMP: "on",
        var_UGRD: "on",
        var_VGRD: "on",
        leftlon: 0,
        rightlon: 360,
        toplat: 90,
        bottomlat: -90,
        dir: "/gfs." + stamp
      }

    }).on("error", function (err) {
      log.error({ err: err, stamp: stamp }, "unable to retrieve data");
      runQuery(moment(targetMoment).subtract(6, "hours"));
    }).on("response", function (response) {
      log.info({ status: response.statusCode, stamp: stamp });
      if (response.statusCode !== 200) {
        runQuery(moment(targetMoment).subtract(6, "hours"));
      } else {
        // don"t rewrite stamps
        if (!checkPath("json-data/" + stamp + ".json", false)) {
          log.debug({ stamp: stamp }, "piping data");

          // mk sure we"ve got somewhere to put output
          checkPath("grib-data", true);

          // pipe the file, resolve the valid time stamp
          var file = fs.createWriteStream("grib-data/" + stamp + ".f000");
          response.pipe(file);
          file.on("finish", function () {
            file.close();
            deferred.resolve({ stamp: stamp, targetMoment: targetMoment });
          });

        } else {
          log.info({ stamp: stamp }, "end reached, not looking further");
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
        log.info({ stamp: stamp }, "converted file");

        // don"t keep raw grib data
        exec("rm grib-data/*");

        // if we don"t have older stamp, try and harvest one
        var prevMoment = moment(targetMoment).subtract(6, "hours");
        var prevStamp = prevMoment.format("YYYYMMDD") + roundHours(prevMoment.hour(), 6);

        if (!checkPath("json-data/" + prevStamp + ".json", false)) {
          log.info({ stamp: stamp }, "attempting to harvest older data");
          run(prevMoment);
        } else {
          log.info({ stamp: stamp }, "got older no need to harvest further");
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
  process.exit();
});

// init harvest
run(moment.utc());
